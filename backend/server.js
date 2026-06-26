const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors());
app.use(express.json());

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

const SUBJECT_MAP = {
  'mathematics': 'Mathematics', 'math': 'Mathematics',
  'science': 'Science',
  'english': 'English',
  'filipino': 'Filipino', 'wikang': 'Filipino',
  'araling panlipunan': 'Araling Panlipunan', 'ap ': 'Araling Panlipunan',
  'edukasyon sa pagpapakatao': 'EsP', 'esp': 'EsP',
  'epp': 'EPP/TLE', 'tle': 'EPP/TLE', 'hele': 'EPP/TLE',
  'computer': 'Computer Studies', 'ict': 'Computer Studies',
  'mapeh': 'MAPEH', 'music': 'MAPEH', 'arts': 'MAPEH', ' pe ': 'MAPEH', 'health': 'MAPEH',
};

function inferSubject(text) {
  const lower = ` ${text.toLowerCase()} `;
  for (const [kw, subj] of Object.entries(SUBJECT_MAP)) {
    if (lower.includes(kw)) return subj;
  }
  return 'General';
}

function inferGrade(text) {
  const m = text.match(/grade\s*(\d+)/i);
  if (m) return `Grade ${m[1]}`;
  if (/kinder/i.test(text)) return 'Kinder';
  return 'Various';
}

async function fetchHTML(url, timeout = 20000) {
  const res = await axios.get(url, { headers: HEADERS, timeout });
  return cheerio.load(res.data);
}

// ─── LearningPal: scrape multiple MATATAG pages ───────────────────────────────
async function scrapeLearningPal() {
  const ckey = 'learningpal';
  if (cache.has(ckey)) return cache.get(ckey);

  const urls = [
    'https://learningpal.net/deped-matatag-textbooks/',
    'https://learningpal.net/?s=matatag+module',
    'https://learningpal.net/?s=matatag+self+learning',
  ];

  const seen = new Set();
  const books = [];

  for (const url of urls) {
    try {
      const $ = await fetchHTML(url);

      // Grab articles / post listings
      $('article, .post, h2.entry-title, h3.entry-title, .elementor-post').each((_, el) => {
        const titleEl = $(el).is('article, .post, .elementor-post')
          ? $(el).find('h2, h3, .entry-title, .elementor-post__title').first()
          : $(el);
        const title = titleEl.text().trim();
        if (!title || title.length < 6) return;

        const link =
          titleEl.find('a').attr('href') ||
          $(el).find('a').first().attr('href') ||
          '';

        if (!link || !link.startsWith('http') || seen.has(link)) return;
        seen.add(link);

        const cover = $(el).find('img').first().attr('src') || '';

        books.push({
          id: `lp-${books.length + 1}`,
          title,
          grade: inferGrade(title),
          subject: inferSubject(title),
          url: link,
          source: 'LearningPal',
          cover,
        });
      });
    } catch (e) {
      console.warn(`LearningPal fetch failed for ${url}:`, e.message);
    }
  }

  cache.set(ckey, books);
  return books;
}

// ─── DepEd Libre: scrape modules pages ───────────────────────────────────────
async function scrapeDepedLibre() {
  const ckey = 'depedlibre';
  if (cache.has(ckey)) return cache.get(ckey);

  const urls = [
    'https://depedlibre.com/deped-modules/',
    'https://depedlibre.com/?s=matatag',
    'https://depedlibre.com/?s=self+learning+module',
  ];

  const seen = new Set();
  const books = [];

  for (const url of urls) {
    try {
      const $ = await fetchHTML(url);

      $('article, .post, .elementor-post').each((_, el) => {
        const title = $(el).find('h2, h3, .entry-title, .elementor-post__title').first().text().trim();
        const link = $(el).find('a').first().attr('href') || '';
        if (!title || !link || seen.has(link)) return;
        seen.add(link);

        const cover = $(el).find('img').first().attr('src') || '';

        books.push({
          id: `dl-${books.length + 1}`,
          title,
          grade: inferGrade(title),
          subject: inferSubject(title),
          url: link,
          source: 'DepEd Libre',
          cover,
        });
      });
    } catch (e) {
      console.warn(`DepEd Libre fetch failed for ${url}:`, e.message);
    }
  }

  cache.set(ckey, books);
  return books;
}

// ─── Teach Pinas: curriculum guides + modules ────────────────────────────────
async function scrapeTeachPinas() {
  const ckey = 'teachpinas';
  if (cache.has(ckey)) return cache.get(ckey);

  const urls = [
    'https://www.teachpinas.com/matatag-curriculum-guide-pdf-all-subjects/',
    'https://www.teachpinas.com/?s=matatag+module',
    'https://www.teachpinas.com/?s=self+learning+module',
  ];

  const seen = new Set();
  const books = [];

  for (const url of urls) {
    try {
      const $ = await fetchHTML(url);

      // Grab direct PDF/Drive links with meaningful text
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim();
        if (
          text.length > 8 &&
          !seen.has(href) &&
          (href.includes('.pdf') || href.includes('drive.google') || href.includes('docs.google'))
        ) {
          seen.add(href);
          books.push({
            id: `tp-${books.length + 1}`,
            title: text,
            grade: inferGrade(text),
            subject: inferSubject(text),
            url: href,
            source: 'Teach Pinas',
            cover: '',
          });
        }
      });

      // Also grab post listings
      $('article, .post, .elementor-post').each((_, el) => {
        const title = $(el).find('h2, h3, .entry-title').first().text().trim();
        const link = $(el).find('a').first().attr('href') || '';
        if (!title || !link || seen.has(link)) return;
        seen.add(link);

        books.push({
          id: `tp-${books.length + 1}`,
          title,
          grade: inferGrade(title),
          subject: inferSubject(title),
          url: link,
          source: 'Teach Pinas',
          cover: $(el).find('img').first().attr('src') || '',
        });
      });
    } catch (e) {
      console.warn(`Teach Pinas fetch failed for ${url}:`, e.message);
    }
  }

  cache.set(ckey, books);
  return books;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', name: 'NIAI LMS Scraper API', version: '1.1.0' });
});

app.get('/api/books', async (req, res) => {
  try {
    const [lp, dl, tp] = await Promise.allSettled([
      scrapeLearningPal(),
      scrapeDepedLibre(),
      scrapeTeachPinas(),
    ]);

    const all = [
      ...(lp.status === 'fulfilled' ? lp.value : []),
      ...(dl.status === 'fulfilled' ? dl.value : []),
      ...(tp.status === 'fulfilled' ? tp.value : []),
    ];

    // Deduplicate by URL
    const seenUrls = new Set();
    const deduped = all.filter(b => {
      if (!b.url || b.url === '#' || seenUrls.has(b.url)) return false;
      seenUrls.add(b.url);
      return true;
    });

    let results = deduped;
    if (req.query.grade) results = results.filter(b => b.grade.toLowerCase().includes(req.query.grade.toLowerCase()));
    if (req.query.subject) results = results.filter(b => b.subject.toLowerCase().includes(req.query.subject.toLowerCase()));
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      results = results.filter(b =>
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

app.get('/api/books/sources', (req, res) => {
  res.json({
    sources: [
      { id: 'learningpal', name: 'LearningPal', url: 'https://learningpal.net' },
      { id: 'depedlibre', name: 'DepEd Libre', url: 'https://depedlibre.com' },
      { id: 'teachpinas', name: 'Teach Pinas', url: 'https://www.teachpinas.com' },
    ],
  });
});

app.post('/api/cache/clear', (req, res) => {
  cache.flushAll();
  res.json({ message: 'Cache cleared' });
});

app.get('/api/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Missing url param' });
  try {
    const response = await axios.get(target, { headers: HEADERS, responseType: 'stream', timeout: 20000 });
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    response.data.pipe(res);
  } catch (err) {
    res.status(502).json({ error: 'Proxy failed', detail: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`NIAI LMS API running on port ${PORT}`));
