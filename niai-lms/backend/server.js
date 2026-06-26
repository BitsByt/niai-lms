const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // cache 1 hour

app.use(cors());
app.use(express.json());

// ─── Tunables ───────────────────────────────────────────────────────────────
// These bound how "deep" each scraper digs so a cold scrape can't run forever
// on Render's free tier (single small instance, shared CPU). Raise them if
// you upgrade off the free plan — these were dialed back after the first
// version proved too heavy and made requests hang.
const MAX_PAGES_PER_SOURCE = 2;       // how many archive/category pages to paginate through
const MAX_ARTICLES_TO_EXPAND = 8;     // how many landing pages we follow to find real download links
const ARTICLE_FETCH_CONCURRENCY = 3;  // parallel requests when following landing pages
const MAX_BOOKS_PER_SOURCE = 80;      // hard cap so one chatty source can't dominate the list
const REQUEST_TIMEOUT = 7000;         // per-HTTP-request timeout — fail fast rather than hang
const SCRAPE_DEADLINE = 18000;        // hard ceiling per source for the /api/books route itself

// ─── Helpers ────────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchHTML(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: REQUEST_TIMEOUT });
  return cheerio.load(res.data);
}

// Run fn(item) over items with at most `limit` in flight at once.
// Failures are swallowed (caller's fn should handle its own fallback).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx]);
      } catch (e) {
        results[idx] = null;
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Race a scraper promise against a hard deadline. The scraper keeps running
// in the background and still populates the cache when it finishes (so the
// *next* request benefits), but this request never waits past `ms`.
function withDeadline(promise, ms, fallback = []) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      () => { clearTimeout(timer); resolve(fallback); }
    );
  });
}

// Prevents the same source from being scraped multiple times concurrently
// (e.g. two people loading the page back-to-back before the cache fills in),
// which is exactly the kind of pile-up that can make a free-tier instance
// grind to a halt.
const inflight = new Map();
function dedupeInflight(key, startFn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = startFn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const SUBJECT_KEYWORDS = [
  ['Mathematics', 'Mathematics'], ['Math', 'Mathematics'],
  ['Science', 'Science'], ['English', 'English'], ['Filipino', 'Filipino'],
  ['Araling Panlipunan', 'Araling Panlipunan'], ['Araling', 'Araling Panlipunan'], ['AP', 'Araling Panlipunan'],
  ['Edukasyon sa Pagpapakatao', 'EsP'], ['EsP', 'EsP'],
  ['EPP/TLE', 'EPP/TLE'], ['EPP', 'EPP/TLE'], ['TLE', 'EPP/TLE'], ['HELE', 'EPP/TLE'],
  ['ICT', 'Computer Studies'], ['Computer', 'Computer Studies'],
  ['MAPEH', 'MAPEH'], ['Music', 'MAPEH'], ['Arts', 'MAPEH'], ['PE', 'MAPEH'], ['Health', 'MAPEH'],
  ['GMRC', 'GMRC/Values Education'], ['Values Education', 'GMRC/Values Education'],
  ['Makabansa', 'Makabansa'], ['Reading and Literacy', 'Reading and Literacy'],
  ['Reading', 'Reading and Literacy'], ['Literacy', 'Reading and Literacy'], ['Language', 'Language'],
];

function inferSubject(text = '') {
  const lower = text.toLowerCase();
  for (const [kw, subj] of SUBJECT_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return subj;
  }
  return 'General';
}

function inferGrade(text = '') {
  if (/kinder(garten)?/i.test(text)) return 'Kinder';
  const m = text.match(/Grade\s*(\d+)/i);
  if (m) return `Grade ${m[1]}`;
  return 'Various';
}

function looksLikeResourceLink(href = '') {
  return (
    /\.pdf(\?|#|$)/i.test(href) ||
    /\.docx?(\?|#|$)/i.test(href) ||
    /\.pptx?(\?|#|$)/i.test(href) ||
    /\.xlsx?(\?|#|$)/i.test(href) ||
    /drive\.google\.com/i.test(href) ||
    /docs\.google\.com/i.test(href) ||
    /sharepoint\.com/i.test(href) ||
    /tinyurl\.com/i.test(href) ||
    /bit\.ly/i.test(href)
  );
}

// ─── Scrapers ────────────────────────────────────────────────────────────────

/**
 * LearningPal — combines the long-form MATATAG textbooks article with a
 * multi-page crawl of its "Deped Matatag Files" / "Deped Files" categories.
 * For every article discovered in the category archives we follow the link
 * and pull out the *actual* download links inside (Drive/PDF/etc.) instead
 * of just the landing-page URL, falling back to the landing page if a post
 * doesn't expose a direct link.
 */
function scrapeLearningPal() {
  const ckey = 'learningpal';
  if (cache.has(ckey)) return Promise.resolve(cache.get(ckey));
  return dedupeInflight(ckey, async () => {

  const books = [];
  const seen = new Set();
  const push = (title, link, grade, subject, cover = '') => {
    if (books.length >= MAX_BOOKS_PER_SOURCE) return;
    if (!title || !link || !link.startsWith('http')) return;
    const key = link.split('?')[0].split('#')[0];
    if (seen.has(key)) return;
    seen.add(key);
    books.push({
      id: `lp-${books.length + 1}`,
      title: title.trim().slice(0, 200),
      grade: grade || inferGrade(title),
      subject: subject || inferSubject(title),
      url: link,
      source: 'LearningPal',
      cover,
    });
  };

  // Single long-form article with headings + nearby download links
  try {
    const $ = await fetchHTML('https://learningpal.net/deped-matatag-textbooks/');
    $('h2, h3, h4').each((_, el) => {
      const heading = $(el).text().trim();
      if (!heading || heading.length < 5) return;
      const link =
        $(el).next('a').attr('href') ||
        $(el).find('a').attr('href') ||
        $(el).nextAll('a').first().attr('href') ||
        null;
      if (link) push(heading, link);
    });
  } catch (e) { /* keep going even if this page is unreachable */ }

  // Crawl category archives (paginated) to discover many more article links
  const categoryUrls = [
    'https://learningpal.net/category/deped-matatag-files/',
    'https://learningpal.net/category/deped-files/',
  ];
  const articleLinks = [];
  const articleSeen = new Set();

  for (const baseUrl of categoryUrls) {
    for (let page = 1; page <= MAX_PAGES_PER_SOURCE; page++) {
      const pageUrl = page === 1 ? baseUrl : `${baseUrl}page/${page}/`;
      let $;
      try {
        $ = await fetchHTML(pageUrl);
      } catch (e) {
        break; // no more pages, or site hiccup — stop paginating this category
      }
      const found = $('h2 a, h3 a, .elementor-post__title a, article a.elementor-post__thumbnail__link');
      if (found.length === 0) break;
      found.each((_, el) => {
        const title = $(el).text().trim() || $(el).attr('title') || '';
        const href = $(el).attr('href') || '';
        if (!title || !href.startsWith('http')) return;
        const key = href.split('?')[0];
        if (articleSeen.has(key)) return;
        articleSeen.add(key);
        articleLinks.push({ title, url: href });
      });
    }
  }

  // Follow a bounded number of article links to extract the real download targets
  const toExpand = articleLinks.slice(0, MAX_ARTICLES_TO_EXPAND);
  await mapWithConcurrency(toExpand, ARTICLE_FETCH_CONCURRENCY, async (a) => {
    try {
      const $$ = await fetchHTML(a.url);
      let foundAny = false;
      $$('a[href]').each((_, el) => {
        const href = $$(el).attr('href') || '';
        const text = $$(el).text().trim();
        if (!looksLikeResourceLink(href) && !/download/i.test(text)) return;
        if (!href.startsWith('http')) return;
        foundAny = true;
        const label = text && text.length > 4 && !/^download/i.test(text) ? `${a.title} — ${text}` : a.title;
        push(label, href, inferGrade(a.title), inferSubject(a.title));
      });
      if (!foundAny) push(a.title, a.url, inferGrade(a.title), inferSubject(a.title));
    } catch (e) {
      push(a.title, a.url, inferGrade(a.title), inferSubject(a.title));
    }
  });

  // Anything past the expansion budget still gets listed as a landing-page link
  for (const a of articleLinks.slice(MAX_ARTICLES_TO_EXPAND)) {
    push(a.title, a.url, inferGrade(a.title), inferSubject(a.title));
  }

  cache.set(ckey, books);
    return books;
  });
}

/**
 * DepEd Libre — same "dig deeper" treatment: the modules index page and the
 * homepage both link out to grade-level roundup pages; we follow those pages
 * and pull the real "Download here!" targets out of them.
 */
function scrapeDepedLibre() {
  const ckey = 'depedlibre';
  if (cache.has(ckey)) return Promise.resolve(cache.get(ckey));
  return dedupeInflight(ckey, async () => {

  const books = [];
  const seen = new Set();
  const push = (title, link, grade, subject, cover = '') => {
    if (books.length >= MAX_BOOKS_PER_SOURCE) return;
    if (!title || !link || !link.startsWith('http')) return;
    const key = link.split('?')[0].split('#')[0];
    if (seen.has(key)) return;
    seen.add(key);
    books.push({
      id: `dl-${books.length + 1}`,
      title: title.trim().slice(0, 200),
      grade: grade || inferGrade(title),
      subject: subject || inferSubject(title),
      url: link,
      source: 'DepEd Libre',
      cover,
    });
  };

  const landingPages = [];

  try {
    const $ = await fetchHTML('https://depedlibre.com/deped-modules/');
    $('article, .entry, .post, .elementor-post').each((_, el) => {
      const title = $(el).find('h2, h3, .entry-title, .elementor-post__title').first().text().trim();
      const link = $(el).find('a').first().attr('href') || '';
      const cover = $(el).find('img').first().attr('src') || '';
      if (!title || !link) return;
      landingPages.push({ title, url: link, cover });
    });
  } catch (e) { /* ignore */ }

  try {
    const $ = await fetchHTML('https://depedlibre.com/');
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      if (
        text.length > 6 &&
        href.includes('depedlibre.com') &&
        /matatag|grade-\d|deped-modules|curriculum/i.test(href)
      ) {
        landingPages.push({ title: text, url: href, cover: '' });
      }
    });
  } catch (e) { /* ignore */ }

  const ddSeen = new Set();
  const uniqueLanding = landingPages.filter((p) => {
    const k = p.url.split('?')[0];
    if (ddSeen.has(k)) return false;
    ddSeen.add(k);
    return true;
  });

  const toExpand = uniqueLanding.slice(0, MAX_ARTICLES_TO_EXPAND);
  await mapWithConcurrency(toExpand, ARTICLE_FETCH_CONCURRENCY, async (p) => {
    try {
      const $$ = await fetchHTML(p.url);
      let foundAny = false;
      $$('a[href]').each((_, el) => {
        const href = $$(el).attr('href') || '';
        const text = $$(el).text().trim();
        if (!looksLikeResourceLink(href) && !/download/i.test(text)) return;
        if (!href.startsWith('http')) return;
        foundAny = true;
        const label = text && text.length > 4 && !/^download/i.test(text) ? `${p.title} — ${text}` : p.title;
        push(label, href, inferGrade(p.title), inferSubject(p.title), p.cover);
      });
      if (!foundAny) push(p.title, p.url, inferGrade(p.title), inferSubject(p.title), p.cover);
    } catch (e) {
      push(p.title, p.url, inferGrade(p.title), inferSubject(p.title), p.cover);
    }
  });

  for (const p of uniqueLanding.slice(MAX_ARTICLES_TO_EXPAND)) {
    push(p.title, p.url, inferGrade(p.title), inferSubject(p.title), p.cover);
  }

  cache.set(ckey, books);
    return books;
  });
}

/**
 * Teach Pinas MATATAG curriculum guides — already a single page of direct
 * PDF/Drive links, so a one-level scrape is enough here.
 */
function scrapeTeachPinas() {
  const ckey = 'teachpinas';
  if (cache.has(ckey)) return Promise.resolve(cache.get(ckey));
  return dedupeInflight(ckey, async () => {

  const $ = await fetchHTML('https://www.teachpinas.com/matatag-curriculum-guide-pdf-all-subjects/');
  const books = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (
      text.length > 8 &&
      (href.includes('.pdf') || href.includes('drive.google') || href.includes('docs.google'))
    ) {
      const gradeMatch = text.match(/Grade\s*(\d+)|Kinder/i);
      const grade = gradeMatch
        ? gradeMatch[0].includes('Kinder') ? 'Kinder' : `Grade ${gradeMatch[1]}`
        : 'Various';

      books.push({
        id: `tp-${books.length + 1}`,
        title: text,
        grade,
        subject: 'Curriculum Guide',
        url: href,
        source: 'Teach Pinas',
        cover: '',
      });
    }
  });

  cache.set(ckey, books);
    return books;
  });
}

/**
 * Official DepEd MATATAG curriculum guide table (deped.gov.ph). Small but
 * authoritative — every row is a real government-published PDF.
 */
function scrapeDepedOfficial() {
  const ckey = 'deped-official';
  if (cache.has(ckey)) return Promise.resolve(cache.get(ckey));
  return dedupeInflight(ckey, async () => {

  const books = [];
  try {
    const $ = await fetchHTML('https://www.deped.gov.ph/matatagcurriculumk147/');

    $('table tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const title = $(cells[0]).text().trim();
      const link = $(row).find('a[href]').first().attr('href') || '';
      if (!title || !link) return;
      books.push({
        id: `do-${books.length + 1}`,
        title: `MATATAG Curriculum Guide — ${title}`,
        grade: 'K, 1, 4, 7',
        subject: inferSubject(title),
        url: link.startsWith('http') ? link : `https://www.deped.gov.ph${link}`,
        source: 'DepEd Official',
        cover: '',
      });
    });

    // Fallback if the table markup changes: grab any anchor literally labelled "Download"
    if (books.length === 0) {
      $('a[href]').each((_, el) => {
        const text = $(el).text().trim();
        const href = $(el).attr('href') || '';
        if (!/^download$/i.test(text) || !href) return;
        const title = $(el).closest('tr').find('td').first().text().trim() || 'MATATAG Curriculum Guide';
        books.push({
          id: `do-${books.length + 1}`,
          title: `MATATAG Curriculum Guide — ${title}`,
          grade: 'K, 1, 4, 7',
          subject: inferSubject(title),
          url: href.startsWith('http') ? href : `https://www.deped.gov.ph${href}`,
          source: 'DepEd Official',
          cover: '',
        });
      });
    }
  } catch (e) { /* ignore — other sources still return results */ }

  cache.set(ckey, books);
    return books;
  });
}

/**
 * DepEd Region CAR "CIDHub" Google Site — a small but official curated list
 * of MATATAG curriculum/learning-material hub links (Drive folders, etc.).
 */
function scrapeCIDHub() {
  const ckey = 'cidhub';
  if (cache.has(ckey)) return Promise.resolve(cache.get(ckey));
  return dedupeInflight(ckey, async () => {

  const books = [];
  try {
    const $ = await fetchHTML('https://sites.google.com/deped.gov.ph/cidhubdatabase/matatag-curriculum');
    $('a[href]').each((_, el) => {
      const text = $(el).text().trim();
      let href = $(el).attr('href') || '';
      if (!text || text.length < 8) return;
      if (!/click here|view and download|download/i.test(text)) return;

      // Google Sites wraps outbound links as /url?q=<encoded target>
      const m = href.match(/[?&]q=([^&]+)/);
      if (m) href = decodeURIComponent(m[1]);
      if (!href.startsWith('http')) return;

      books.push({
        id: `ch-${books.length + 1}`,
        title: text.replace(/^CLICK HERE TO\s*/i, '').trim() || 'MATATAG Curriculum Resource',
        grade: 'Various',
        subject: 'Curriculum',
        url: href,
        source: 'DepEd CIDHub (Official)',
        cover: '',
      });
    });
  } catch (e) { /* ignore */ }

  cache.set(ckey, books);
    return books;
  });
}

/**
 * DepEd Tambayan — a Blogger site with a large "matatag curriculum" label
 * archive. We page through the label (following the "Older Posts" link)
 * and then follow a bounded number of posts to pull out the real
 * "<Resource Name> - DOWNLOAD" links that live inside each post body.
 */
function scrapeDepedTambayan() {
  const ckey = 'depedtambayan';
  if (cache.has(ckey)) return Promise.resolve(cache.get(ckey));
  return dedupeInflight(ckey, async () => {

  const books = [];
  const seen = new Set();
  const push = (title, link, grade, subject) => {
    if (books.length >= MAX_BOOKS_PER_SOURCE) return;
    if (!title || !link || !link.startsWith('http')) return;
    const key = link.split('?')[0].split('#')[0];
    if (seen.has(key)) return;
    seen.add(key);
    books.push({
      id: `dt-${books.length + 1}`,
      title: title.trim().slice(0, 200),
      grade: grade || inferGrade(title),
      subject: subject || inferSubject(title),
      url: link,
      source: 'DepEd Tambayan',
      cover: '',
    });
  };

  let nextUrl = 'https://www.depedtambayanph.net/search/label/matatag%20curriculum';
  const postLinks = [];

  for (let page = 0; page < MAX_PAGES_PER_SOURCE && nextUrl; page++) {
    let $;
    try {
      $ = await fetchHTML(nextUrl);
    } catch (e) {
      break;
    }

    $('h3.post-title a, h2.post-title a, .post-title a').each((_, el) => {
      const title = $(el).text().trim();
      const href = $(el).attr('href') || '';
      if (title && href.startsWith('http')) postLinks.push({ title, url: href });
    });

    nextUrl = $('a.blog-pager-older-link').attr('href') || null;
  }

  const ddSeen = new Set();
  const uniquePosts = postLinks.filter((p) => {
    const k = p.url.split('?')[0];
    if (ddSeen.has(k)) return false;
    ddSeen.add(k);
    return true;
  });

  const toExpand = uniquePosts.slice(0, MAX_ARTICLES_TO_EXPAND);
  await mapWithConcurrency(toExpand, ARTICLE_FETCH_CONCURRENCY, async (p) => {
    try {
      const $$ = await fetchHTML(p.url);
      let foundAny = false;
      $$('.post-body a[href], article a[href]').each((_, el) => {
        const href = $$(el).attr('href') || '';
        const text = $$(el).text().trim();
        if (!looksLikeResourceLink(href) && !/download/i.test(text)) return;
        if (!href.startsWith('http')) return;
        foundAny = true;
        // DepEd Tambayan posts often write "Resource Name - DOWNLOAD" as one line —
        // try to recover that line as a more specific title than the post title.
        const lineText = $$(el).parent().text().trim().replace(/\s+/g, ' ');
        const title =
          lineText.length > 8 && lineText.length < 160
            ? lineText.replace(/-?\s*DOWNLOAD\s*$/i, '').trim()
            : p.title;
        push(title || p.title, href, inferGrade(p.title), inferSubject(p.title));
      });
      if (!foundAny) push(p.title, p.url, inferGrade(p.title), inferSubject(p.title));
    } catch (e) {
      push(p.title, p.url, inferGrade(p.title), inferSubject(p.title));
    }
  });

  for (const p of uniquePosts.slice(MAX_ARTICLES_TO_EXPAND)) {
    push(p.title, p.url, inferGrade(p.title), inferSubject(p.title));
  }

  cache.set(ckey, books);
    return books;
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', name: 'NIAI LMS Scraper API', version: '2.0.0' });
});

// GET /api/books — returns all scraped books, merged + deduplicated
app.get('/api/books', async (req, res) => {
  const startedAt = Date.now();
  try {
    const settled = await Promise.allSettled([
      withDeadline(scrapeLearningPal(), SCRAPE_DEADLINE),
      withDeadline(scrapeDepedLibre(), SCRAPE_DEADLINE),
      withDeadline(scrapeTeachPinas(), SCRAPE_DEADLINE),
      withDeadline(scrapeDepedOfficial(), SCRAPE_DEADLINE),
      withDeadline(scrapeCIDHub(), SCRAPE_DEADLINE),
      withDeadline(scrapeDepedTambayan(), SCRAPE_DEADLINE),
    ]);
    console.log(`[api/books] scrape phase took ${Date.now() - startedAt}ms`);

    let all = [];
    for (const r of settled) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) all = all.concat(r.value);
    }

    // De-dupe across sources (same resource often gets reposted by multiple sites)
    const seenGlobal = new Set();
    all = all.filter((b) => {
      const key = `${b.title.toLowerCase().replace(/\s+/g, ' ').trim()}|${b.grade}`;
      if (seenGlobal.has(key)) return false;
      seenGlobal.add(key);
      return true;
    });

    let results = all;
    if (req.query.grade) {
      results = results.filter((b) =>
        b.grade.toLowerCase().includes(req.query.grade.toLowerCase())
      );
    }
    if (req.query.subject) {
      results = results.filter((b) =>
        b.subject.toLowerCase().includes(req.query.subject.toLowerCase())
      );
    }
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      results = results.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.subject.toLowerCase().includes(q) ||
          b.grade.toLowerCase().includes(q)
      );
    }

    res.json({ count: results.length, books: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Scrape failed', detail: err.message });
  }
});

// GET /api/books/sources — which sources are available
app.get('/api/books/sources', (req, res) => {
  res.json({
    sources: [
      { id: 'learningpal', name: 'LearningPal', url: 'https://learningpal.net/category/deped-matatag-files/' },
      { id: 'depedlibre', name: 'DepEd Libre', url: 'https://depedlibre.com/deped-modules/' },
      { id: 'teachpinas', name: 'Teach Pinas', url: 'https://www.teachpinas.com/matatag-curriculum-guide-pdf-all-subjects/' },
      { id: 'deped-official', name: 'DepEd Official', url: 'https://www.deped.gov.ph/matatagcurriculumk147/' },
      { id: 'cidhub', name: 'DepEd CIDHub (Official)', url: 'https://sites.google.com/deped.gov.ph/cidhubdatabase/matatag-curriculum' },
      { id: 'depedtambayan', name: 'DepEd Tambayan', url: 'https://www.depedtambayanph.net/search/label/matatag%20curriculum' },
    ],
  });
});

// POST /api/cache/clear — manually bust the cache (admin use)
app.post('/api/cache/clear', (req, res) => {
  cache.flushAll();
  res.json({ message: 'Cache cleared. The next /api/books call will re-crawl from scratch and may take 20-40s.' });
});

// GET /api/proxy?url=... — proxy a resource URL so PDFs can be embedded
// (avoids CORS issues on the frontend)
app.get('/api/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Missing url param' });

  try {
    const response = await axios.get(target, {
      headers: HEADERS,
      responseType: 'stream',
      timeout: 20000,
    });
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    response.data.pipe(res);
  } catch (err) {
    res.status(502).json({ error: 'Proxy failed', detail: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`NIAI LMS API running on port ${PORT}`));
