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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SUBJECT_PATTERNS = [
  [/\bmath(ematics)?\b/i, 'Mathematics'],
  [/\bscience\b/i, 'Science'],
  [/\benglish\b/i, 'English'],
  [/\bfilipino\b/i, 'Filipino'],
  [/\bwikang\s+filipino\b/i, 'Filipino'],
  [/\baraling\s+panlipunan\b/i, 'Araling Panlipunan'],
  [/\bmakabansa\b/i, 'Araling Panlipunan'],
  [/\bedukasyon\s+sa\s+pagpapakatao\b/i, 'EsP'],
  [/\b(esp|gmrc)\b/i, 'EsP'],
  [/\b(epp|tle|hele)\b/i, 'EPP/TLE'],
  [/\b(computer|ict)\b/i, 'Computer Studies'],
  [/\bmapeh\b/i, 'MAPEH'],
  [/\b(music|arts|physical\s+education|health)\b/i, 'MAPEH'],
  [/curriculum\s+guide/i, 'Curriculum Guide'],
  [/\b(dll|daily\s+lesson\s+log)\b/i, 'Lesson Log'],
  [/\b(lesson\s+exemplar|las|learning\s+activity)\b/i, 'Lesson Material'],
  [/\bpowerpoint\b/i, 'PowerPoint Lesson'],
  [/\bperiodical\s+test\b/i, 'Periodical Test'],
  [/\bsummative\s+test\b/i, 'Summative Test'],
  [/\b(self.learning\s+module|slm)\b/i, 'Self-Learning Module'],
];

const GRADE_PATTERNS = [
  [/\bkinder(garten)?\b/i, 'Kinder'],
  [/\bgrade\s*(\d+)\b/i, null], // handled specially
  [/\bgr\.?\s*(\d+)\b/i, null],
  [/\bg(\d+)\b/i, null],
];

function inferSubject(text) {
  for (const [pattern, subject] of SUBJECT_PATTERNS) {
    if (pattern.test(text)) return subject;
  }
  return 'General';
}

function inferGrade(text) {
  if (/kinder(garten)?/i.test(text)) return 'Kinder';
  const m = text.match(/grade\s*(\d+)/i) || text.match(/gr\.?\s*(\d+)/i);
  if (m) return `Grade ${m[1]}`;
  if (/grades?\s*1[–-]12/i.test(text)) return 'All Grades';
  return 'Various';
}

async function fetchHTML(url, timeout = 18000) {
  const res = await axios.get(url, { headers: HEADERS, timeout });
  return cheerio.load(res.data);
}

function makeBook(idx, prefix, title, url, grade, subject, cover, source) {
  return {
    id: `${prefix}-${idx}`,
    title: title.trim(),
    grade: grade || inferGrade(title),
    subject: subject || inferSubject(title),
    url,
    source,
    cover: cover || '',
  };
}

// ─── Scraper: DepEd Click (Blogger) ──────────────────────────────────────────
// Scrapes MATATAG label pages for each grade level
async function scrapeDepedClick() {
  const ckey = 'depedclick';
  if (cache.has(ckey)) return cache.get(ckey);

  // Blogger label URLs for each MATATAG grade label
  const labelUrls = [
    'https://www.deped-click.com/search/label/GRADE%201%20MATATAG',
    'https://www.deped-click.com/search/label/GRADE%202%20MATATAG',
    'https://www.deped-click.com/search/label/GRADE%203%20MATATAG',
    'https://www.deped-click.com/search/label/GRADE%204%20MATATAG',
    'https://www.deped-click.com/search/label/GRADE%205%20MATATAG',
    'https://www.deped-click.com/search/label/GRADE%206%20MATATAG',
    'https://www.deped-click.com/search/label/GRADE%207%20MATATAG',
    'https://www.deped-click.com/search/label/GRADE%208%20MATATAG',
    'https://www.deped-click.com/search/label/GRADE%209%20MATATAG',
    'https://www.deped-click.com/search/label/GRADE%2010%20MATATAG',
    'https://www.deped-click.com/search/label/MATATAG%20Materials',
  ];

  const seen = new Set();
  const books = [];

  for (const url of labelUrls) {
    try {
      const $ = await fetchHTML(url);
      $('h3.post-title, h2.post-title, .post-title, article h2, article h3').each((_, el) => {
        const anchor = $(el).find('a').first();
        const title = anchor.text().trim();
        const link = anchor.attr('href') || '';
        if (!title || !link || seen.has(link)) return;
        // Skip non-MATATAG content
        if (!/matatag|module|dll|exemplar|lesson|curriculum|slm|periodical|summative|powerpoint/i.test(title)) return;
        seen.add(link);

        const cover = $(el).closest('article, .post-outer')
          .find('img').first().attr('src') || '';

        books.push(makeBook(books.length + 1, 'dc', title, link, inferGrade(title), inferSubject(title), cover, 'DepEd Click'));
      });
    } catch (e) {
      console.warn(`DepEd Click fetch failed for ${url}:`, e.message);
    }
  }

  cache.set(ckey, books);
  return books;
}

// ─── Scraper: DepEd Tambayan ──────────────────────────────────────────────────
async function scrapeDepedTambayan() {
  const ckey = 'depedtambayan';
  if (cache.has(ckey)) return cache.get(ckey);

  const urls = [
    'https://depedtambayan.net/?s=matatag+module',
    'https://depedtambayan.net/?s=matatag+self+learning',
    'https://depedtambayan.net/?s=matatag+lesson+exemplar',
  ];

  const seen = new Set();
  const books = [];

  for (const url of urls) {
    try {
      const $ = await fetchHTML(url);
      $('article, .post').each((_, el) => {
        const titleEl = $(el).find('h2, h3, .entry-title').first();
        const title = titleEl.text().trim();
        const link = titleEl.find('a').attr('href') || $(el).find('a').first().attr('href') || '';
        if (!title || !link || seen.has(link)) return;
        seen.add(link);
        const cover = $(el).find('img').first().attr('src') || '';
        books.push(makeBook(books.length + 1, 'dt', title, link, inferGrade(title), inferSubject(title), cover, 'DepEd Tambayan'));
      });
    } catch (e) {
      console.warn(`DepEd Tambayan fetch failed for ${url}:`, e.message);
    }
  }

  cache.set(ckey, books);
  return books;
}

// ─── Scraper: LearningPal ─────────────────────────────────────────────────────
async function scrapeLearningPal() {
  const ckey = 'learningpal';
  if (cache.has(ckey)) return cache.get(ckey);

  const urls = [
    'https://learningpal.net/deped-matatag-textbooks/',
    'https://learningpal.net/?s=matatag+module',
    'https://learningpal.net/?s=matatag+lesson+exemplar',
    'https://learningpal.net/?s=self+learning+module',
  ];

  const seen = new Set();
  const books = [];

  for (const url of urls) {
    try {
      const $ = await fetchHTML(url);
      $('article, .post, h2.entry-title, .elementor-post').each((_, el) => {
        const titleEl = $(el).is('h2') ? $(el) : $(el).find('h2, h3, .entry-title, .elementor-post__title').first();
        const title = titleEl.text().trim();
        const link = titleEl.find('a').attr('href') || $(el).find('a').first().attr('href') || '';
        if (!title || title.length < 8 || !link.startsWith('http') || seen.has(link)) return;
        seen.add(link);
        const cover = $(el).find('img').first().attr('src') || '';
        books.push(makeBook(books.length + 1, 'lp', title, link, inferGrade(title), inferSubject(title), cover, 'LearningPal'));
      });
    } catch (e) {
      console.warn(`LearningPal fetch failed for ${url}:`, e.message);
    }
  }

  cache.set(ckey, books);
  return books;
}

// ─── Scraper: DepEd Libre ─────────────────────────────────────────────────────
async function scrapeDepedLibre() {
  const ckey = 'depedlibre';
  if (cache.has(ckey)) return cache.get(ckey);

  const urls = [
    'https://depedlibre.com/?s=matatag+module',
    'https://depedlibre.com/?s=matatag+self+learning',
    'https://depedlibre.com/?s=matatag+lesson',
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
        books.push(makeBook(books.length + 1, 'dl', title, link, inferGrade(title), inferSubject(title), cover, 'DepEd Libre'));
      });
    } catch (e) {
      console.warn(`DepEd Libre fetch failed for ${url}:`, e.message);
    }
  }

  cache.set(ckey, books);
  return books;
}

// ─── Scraper: Teach Pinas ─────────────────────────────────────────────────────
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

      // Grab post cards
      $('article, .post, .elementor-post').each((_, el) => {
        const title = $(el).find('h2, h3, .entry-title').first().text().trim();
        const link = $(el).find('a').first().attr('href') || '';
        if (!title || !link || seen.has(link)) return;
        seen.add(link);
        const cover = $(el).find('img').first().attr('src') || '';
        books.push(makeBook(books.length + 1, 'tp', title, link, inferGrade(title), inferSubject(title), cover, 'Teach Pinas'));
      });

      // Also grab direct PDF/Drive links
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim();
        if (
          text.length > 8 &&
          !seen.has(href) &&
          (href.includes('.pdf') || href.includes('drive.google') || href.includes('docs.google'))
        ) {
          seen.add(href);
          books.push(makeBook(books.length + 1, 'tp', text, href, inferGrade(text), inferSubject(text), '', 'Teach Pinas'));
        }
      });
    } catch (e) {
      console.warn(`Teach Pinas fetch failed for ${url}:`, e.message);
    }
  }

  cache.set(ckey, books);
  return books;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', name: 'NIAI LMS Scraper API', version: '2.0.0' });
});

app.get('/api/books', async (req, res) => {
  try {
    const results = await Promise.allSettled([
      scrapeDepedClick(),
      scrapeDepedTambayan(),
      scrapeLearningPal(),
      scrapeDepedLibre(),
      scrapeTeachPinas(),
    ]);

    const all = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);

    // Global deduplication by URL
    const seenUrls = new Set();
    const deduped = all.filter(b => {
      if (!b.url || b.url === '#' || seenUrls.has(b.url)) return false;
      seenUrls.add(b.url);
      return true;
    });

    // Apply filters
    let filtered = deduped;
    if (req.query.grade) {
      filtered = filtered.filter(b => b.grade.toLowerCase().includes(req.query.grade.toLowerCase()));
    }
    if (req.query.subject) {
      filtered = filtered.filter(b => b.subject.toLowerCase().includes(req.query.subject.toLowerCase()));
    }
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      filtered = filtered.filter(b =>
        b.title.toLowerCase().includes(q) ||
        b.subject.toLowerCase().includes(q) ||
        b.grade.toLowerCase().includes(q)
      );
    }

    res.json({ count: filtered.length, books: filtered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Scrape failed', detail: err.message });
  }
});

app.get('/api/books/sources', (req, res) => {
  res.json({
    sources: [
      { id: 'depedclick',    name: 'DepEd Click',    url: 'https://www.deped-click.com' },
      { id: 'depedtambayan', name: 'DepEd Tambayan', url: 'https://depedtambayan.net' },
      { id: 'learningpal',   name: 'LearningPal',    url: 'https://learningpal.net' },
      { id: 'depedlibre',    name: 'DepEd Libre',    url: 'https://depedlibre.com' },
      { id: 'teachpinas',    name: 'Teach Pinas',    url: 'https://www.teachpinas.com' },
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
app.listen(PORT, () => console.log(`NIAI LMS API v2.0 running on port ${PORT}`));
