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
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchHTML(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  return cheerio.load(res.data);
}

// ── Subject inference ────────────────────────────────────────────────────────
const SUBJECT_MAP = [
  [/math|plus|world|numero|matematika/i, 'Mathematics'],
  [/science|biology|physics|chemistry|breaking through/i, 'Science'],
  [/english|conversations|pillars|reading|literacy/i, 'English'],
  [/filipino|sanghaya|talaghay|wika|panitikan|pagbasa/i, 'Filipino'],
  [/araling|AP\b|asya|daigdig|ekonomiks|kasaysayan|lahing|sibika/i, 'Araling Panlipunan'],
  [/hele|epp|tle|home.*economics|community/i, 'EPP/TLE'],
  [/computer|ict|technology|programming|digital/i, 'Computer Studies'],
  [/mapeh|music|arts|pe\b|health|physical/i, 'MAPEH'],
  [/esp|edukasyon sa pagpapakatao|good manners|gmrc|values/i, 'EsP'],
];

function inferSubject(text) {
  for (const [re, subj] of SUBJECT_MAP) {
    if (re.test(text)) return subj;
  }
  return 'General';
}

function inferGrade(text) {
  const m = text.match(/grade\s*(\d+)/i) || text.match(/g(\d+)\b/i) || text.match(/\b(kinder|kindergarten)\b/i);
  if (!m) return 'Various';
  if (/kinder/i.test(m[0])) return 'Kinder';
  return `Grade ${m[1]}`;
}

let bookIdCounter = 1;
function makeBook(title, url, source, extra = {}) {
  if (!title || !url || title.length < 5) return null;
  return {
    id: `${source.toLowerCase().replace(/\s+/g,'-')}-${bookIdCounter++}`,
    title: title.trim(),
    author: extra.author || '',
    subject: extra.subject || inferSubject(title),
    grade: extra.grade || inferGrade(title),
    cover: extra.cover || '',
    url,
    source,
    progress: 0,
  };
}

// ── Deduplicate by title similarity ─────────────────────────────────────────
function dedup(books) {
  const seen = new Set();
  return books.filter(b => {
    const key = b.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SCRAPERS
// ════════════════════════════════════════════════════════════════════════════

// 1. LearningPal — main MATATAG textbooks page + sub-pages
async function scrapeLearningPal() {
  const ckey = 'learningpal_v3';
  if (cache.has(ckey)) return cache.get(ckey);
  const books = [];

  const urls = [
    'https://learningpal.net/deped-matatag-textbooks/',
    'https://learningpal.net/deped-modules/',
    'https://learningpal.net/teachers-guide/',
    'https://learningpal.net/learners-materials/',
  ];

  for (const url of urls) {
    try {
      const $ = await fetchHTML(url);

      // Grab article/post cards
      $('article, .post, .elementor-post, .jeg_post').each((_, el) => {
        const title = $(el).find('h2,h3,h4,.entry-title,.jeg_post_title').first().text().trim();
        const link  = $(el).find('a').first().attr('href') || '';
        const cover = $(el).find('img').first().attr('src') || '';
        const b = makeBook(title, link, 'LearningPal', { cover });
        if (b) books.push(b);
      });

      // Also grab any direct download anchors
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim();
        if (
          text.length > 10 &&
          (href.includes('drive.google') || href.endsWith('.pdf') || href.includes('bit.ly') || href.includes('docs.google'))
        ) {
          const b = makeBook(text, href, 'LearningPal');
          if (b) books.push(b);
        }
      });
    } catch (e) { console.warn('LearningPal sub-page failed:', url, e.message); }
  }

  const result = dedup(books);
  cache.set(ckey, result);
  return result;
}

// 2. DepEd Libre — modules + curriculum guides
async function scrapeDepedLibre() {
  const ckey = 'depedlibre_v3';
  if (cache.has(ckey)) return cache.get(ckey);
  const books = [];

  const urls = [
    'https://depedlibre.com/deped-modules/',
    'https://depedlibre.com/matatag-curriculum-guide/',
    'https://depedlibre.com/deped-matatag-textbooks/',
    'https://depedlibre.com/teachers-guide/',
    'https://depedlibre.com/learners-materials/',
  ];

  for (const url of urls) {
    try {
      const $ = await fetchHTML(url);
      $('article, .post, .elementor-post, .entry').each((_, el) => {
        const title = $(el).find('h2,h3,h4,.entry-title').first().text().trim();
        const link  = $(el).find('a').first().attr('href') || '';
        const cover = $(el).find('img').first().attr('src') || '';
        const b = makeBook(title, link, 'DepEd Libre', { cover });
        if (b) books.push(b);
      });
    } catch (e) { console.warn('DepEdLibre failed:', url, e.message); }
  }

  const result = dedup(books);
  cache.set(ckey, result);
  return result;
}

// 3. Teach Pinas — CGs, BOW, modules
async function scrapeTeachPinas() {
  const ckey = 'teachpinas_v3';
  if (cache.has(ckey)) return cache.get(ckey);
  const books = [];

  const urls = [
    'https://www.teachpinas.com/matatag-curriculum-guide-pdf-all-subjects/',
    'https://www.teachpinas.com/category/learning-materials/',
    'https://www.teachpinas.com/category/teachers-guide/',
    'https://www.teachpinas.com/category/modules/',
  ];

  for (const url of urls) {
    try {
      const $ = await fetchHTML(url);
      $('article, .post, h2, h3').each((_, el) => {
        const title = $(el).is('h2,h3') ? $(el).text().trim() : $(el).find('h2,h3,.entry-title').first().text().trim();
        const link  = $(el).is('h2,h3') ? $(el).find('a').attr('href') || $(el).closest('article').find('a').first().attr('href') || '' : $(el).find('a').first().attr('href') || '';
        const cover = $(el).find('img').first().attr('src') || '';
        const b = makeBook(title, link, 'Teach Pinas', { cover });
        if (b) books.push(b);
      });
    } catch (e) { console.warn('TeachPinas failed:', url, e.message); }
  }

  const result = dedup(books);
  cache.set(ckey, result);
  return result;
}

// 4. DepEd Tambayan
async function scrapeDepedTambayan() {
  const ckey = 'tambayan_v3';
  if (cache.has(ckey)) return cache.get(ckey);
  const books = [];

  const urls = [
    'https://depedtambayan.net/category/learning-materials/',
    'https://depedtambayan.net/category/teachers-guide/',
    'https://depedtambayan.net/category/modules/',
    'https://depedtambayan.net/matatag-curriculum/',
  ];

  for (const url of urls) {
    try {
      const $ = await fetchHTML(url);
      $('article, .post').each((_, el) => {
        const title = $(el).find('h2,h3,.entry-title').first().text().trim();
        const link  = $(el).find('a').first().attr('href') || '';
        const cover = $(el).find('img').first().attr('src') || '';
        const b = makeBook(title, link, 'DepEd Tambayan', { cover });
        if (b) books.push(b);
      });
    } catch (e) { console.warn('Tambayan failed:', url, e.message); }
  }

  const result = dedup(books);
  cache.set(ckey, result);
  return result;
}

// 5. DepEd Click
async function scrapeDepedClick() {
  const ckey = 'depedclick_v3';
  if (cache.has(ckey)) return cache.get(ckey);
  const books = [];

  const urls = [
    'https://www.depedclick.com/category/learning-materials/',
    'https://www.depedclick.com/category/modules/',
    'https://www.depedclick.com/matatag/',
  ];

  for (const url of urls) {
    try {
      const $ = await fetchHTML(url);
      $('article, .post').each((_, el) => {
        const title = $(el).find('h2,h3,.entry-title').first().text().trim();
        const link  = $(el).find('a').first().attr('href') || '';
        const cover = $(el).find('img').first().attr('src') || '';
        const b = makeBook(title, link, 'DepEd Click', { cover });
        if (b) books.push(b);
      });
    } catch (e) { console.warn('DepEdClick failed:', url, e.message); }
  }

  const result = dedup(books);
  cache.set(ckey, result);
  return result;
}

// 6. Scribd public DepEd docs (MATATAG search)
async function scrapeScribd() {
  const ckey = 'scribd_v3';
  if (cache.has(ckey)) return cache.get(ckey);
  const books = [];

  try {
    const $ = await fetchHTML('https://www.scribd.com/search?query=MATATAG+curriculum+module+DepEd&content_type=documents');
    $('a[href*="/document/"], a[href*="/doc/"]').each((_, el) => {
      const title = $(el).text().trim() || $(el).attr('title') || '';
      const href  = 'https://www.scribd.com' + ($(el).attr('href') || '');
      const b = makeBook(title, href, 'Scribd');
      if (b) books.push(b);
    });
  } catch (e) { console.warn('Scribd failed:', e.message); }

  const result = dedup(books);
  cache.set(ckey, result);
  return result;
}

// 7. Hardcoded MATATAG C&E books (from the screenshot — these are real titles)
function getCEBooks() {
  const ckey = 'ce_books';
  if (cache.has(ckey)) return cache.get(ckey);
  const books = [
    { title: '(MATATAG) HELE 5: Life Skills for Home and Community Building', author: 'Jennifer D. Valdez', subject: 'EPP/TLE', grade: 'Grade 5' },
    { title: '(MATATAG) HELE 4: Life Skills for Home and Community Building', author: 'Roberto Abella', subject: 'EPP/TLE', grade: 'Grade 4' },
    { title: '(MATATAG) Asya at Daigdig: Araling Panlipunan', author: 'Michael J. Ditchella', subject: 'Araling Panlipunan', grade: 'Grade 7' },
    { title: '(MATATAG) PILLARS 5: Progressively Integrated Literature Learning and Reading Series', author: 'Catherine S. Bucu-Flores', subject: 'English', grade: 'Grade 5' },
    { title: '(MATATAG) PILLARS 6: Progressively Integrated Literature Learning and Reading Series', author: '', subject: 'English', grade: 'Grade 6' },
    { title: '(MATATAG) CONVERSATIONS 8: A Worktext on English Language Arts', author: 'Maria Cequeria', subject: 'English', grade: 'Grade 8' },
    { title: '(MATATAG) CONVERSATIONS 9: A Worktext on English Language Arts', author: 'Rosanna Borja', subject: 'English', grade: 'Grade 9' },
    { title: '(MATATAG) CONVERSATIONS 10: A Worktext on English Language Arts', author: 'Jessie S. Barrot', subject: 'English', grade: 'Grade 10' },
    { title: '(MATATAG) Breaking Through Science Grade 5', author: 'Michael Anthony Mantela', subject: 'Science', grade: 'Grade 5' },
    { title: '(MATATAG) Breaking Through Science Grade 8', author: 'Sol Saranay Baguio', subject: 'Science', grade: 'Grade 8' },
    { title: '(MATATAG) Sanghaya 5: Wika at Panitikang Filipino', author: 'Laya C. Mangahis', subject: 'Filipino', grade: 'Grade 5' },
    { title: '(MATATAG) Math World 6 – Third Edition', author: 'Laya C. Bennagen', subject: 'Mathematics', grade: 'Grade 6' },
    { title: '(MATATAG) Math PLUS 9: Practical and Updated Second Edition', author: 'Fidel R. Nomenzo', subject: 'Mathematics', grade: 'Grade 9' },
    { title: '(MATATAG) Math PLUS 10: Practical and Updated Second Edition', author: '', subject: 'Mathematics', grade: 'Grade 10' },
    { title: '(MATATAG) Talaghay 8: Pag-unawa at Pagsulat', author: '', subject: 'Filipino', grade: 'Grade 8' },
    { title: '(MATATAG) Talaghay 9: Pag-unawa at Pagsulat', author: '', subject: 'Filipino', grade: 'Grade 9' },
    { title: '(MATATAG) Ekonomiks 9: Ikalawang Edisyon', author: 'Patricia R. Natter', subject: 'Araling Panlipunan', grade: 'Grade 9' },
    { title: '(MATATAG) Lahing Dakila 6: Araling Panlipunan', author: '', subject: 'Araling Panlipunan', grade: 'Grade 6' },
    // Curriculum Guides per subject/grade
    { title: 'MATATAG Curriculum Guide – Mathematics Grade 1', author: 'DepEd', subject: 'Mathematics', grade: 'Grade 1' },
    { title: 'MATATAG Curriculum Guide – Mathematics Grade 4', author: 'DepEd', subject: 'Mathematics', grade: 'Grade 4' },
    { title: 'MATATAG Curriculum Guide – Mathematics Grade 7', author: 'DepEd', subject: 'Mathematics', grade: 'Grade 7' },
    { title: 'MATATAG Curriculum Guide – Science Grade 4', author: 'DepEd', subject: 'Science', grade: 'Grade 4' },
    { title: 'MATATAG Curriculum Guide – Science Grade 7', author: 'DepEd', subject: 'Science', grade: 'Grade 7' },
    { title: 'MATATAG Curriculum Guide – English Grade 1', author: 'DepEd', subject: 'English', grade: 'Grade 1' },
    { title: 'MATATAG Curriculum Guide – English Grade 4', author: 'DepEd', subject: 'English', grade: 'Grade 4' },
    { title: 'MATATAG Curriculum Guide – English Grade 7', author: 'DepEd', subject: 'English', grade: 'Grade 7' },
    { title: 'MATATAG Curriculum Guide – Filipino Grade 1', author: 'DepEd', subject: 'Filipino', grade: 'Grade 1' },
    { title: 'MATATAG Curriculum Guide – Filipino Grade 4', author: 'DepEd', subject: 'Filipino', grade: 'Grade 4' },
    { title: 'MATATAG Curriculum Guide – Filipino Grade 7', author: 'DepEd', subject: 'Filipino', grade: 'Grade 7' },
    { title: 'MATATAG Curriculum Guide – Araling Panlipunan Grade 4', author: 'DepEd', subject: 'Araling Panlipunan', grade: 'Grade 4' },
    { title: 'MATATAG Curriculum Guide – Araling Panlipunan Grade 7', author: 'DepEd', subject: 'Araling Panlipunan', grade: 'Grade 7' },
    { title: 'MATATAG Curriculum Guide – EPP/TLE Grade 4', author: 'DepEd', subject: 'EPP/TLE', grade: 'Grade 4' },
    { title: 'MATATAG Curriculum Guide – EPP/TLE Grade 7', author: 'DepEd', subject: 'EPP/TLE', grade: 'Grade 7' },
    { title: 'MATATAG Curriculum Guide – EsP Grade 1', author: 'DepEd', subject: 'EsP', grade: 'Grade 1' },
    { title: 'MATATAG Curriculum Guide – EsP Grade 4', author: 'DepEd', subject: 'EsP', grade: 'Grade 4' },
    { title: 'MATATAG Curriculum Guide – EsP Grade 7', author: 'DepEd', subject: 'EsP', grade: 'Grade 7' },
    { title: 'MATATAG Curriculum Guide – MAPEH Grade 4', author: 'DepEd', subject: 'MAPEH', grade: 'Grade 4' },
    { title: 'MATATAG Curriculum Guide – MAPEH Grade 7', author: 'DepEd', subject: 'MAPEH', grade: 'Grade 7' },
    { title: 'MATATAG Budget of Works – Mathematics Grade 7 (Trimester)', author: 'DepEd', subject: 'Mathematics', grade: 'Grade 7' },
    { title: 'MATATAG Budget of Works – Mathematics Grade 8 (Trimester)', author: 'DepEd', subject: 'Mathematics', grade: 'Grade 8' },
    { title: 'MATATAG Budget of Works – Science Grade 7 (Trimester)', author: 'DepEd', subject: 'Science', grade: 'Grade 7' },
    { title: 'MATATAG Budget of Works – English Grade 7 (Trimester)', author: 'DepEd', subject: 'English', grade: 'Grade 7' },
    { title: 'MATATAG Budget of Works – Filipino Grade 7 (Trimester)', author: 'DepEd', subject: 'Filipino', grade: 'Grade 7' },
    { title: 'MATATAG Lesson Exemplars – Grade 7 All Subjects', author: 'DepEd CIDHub', subject: 'General', grade: 'Grade 7' },
    { title: 'MATATAG Lesson Exemplars – Grade 8 All Subjects', author: 'DepEd CIDHub', subject: 'General', grade: 'Grade 8' },
    { title: 'MATATAG Lesson Exemplars – Grade 4 All Subjects', author: 'DepEd CIDHub', subject: 'General', grade: 'Grade 4' },
    { title: 'MATATAG Lesson Exemplars – Grade 1 All Subjects', author: 'DepEd CIDHub', subject: 'General', grade: 'Grade 1' },
    { title: 'MATATAG Pretest Materials – Grade 7', author: 'DepEd', subject: 'General', grade: 'Grade 7' },
    { title: 'MATATAG Pretest Materials – Grade 4', author: 'DepEd', subject: 'General', grade: 'Grade 4' },
  ].map((b, i) => ({
    id: `ce-${i + 1}`,
    ...b,
    url: 'https://sites.google.com/deped.gov.ph/cidhubdatabase/matatag-curriculum',
    source: 'C&E / DepEd Official',
    cover: '',
    progress: 0,
  }));

  cache.set(ckey, books);
  return books;
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ status: 'ok', name: 'NIAI LMS Scraper API', version: '2.0.0' });
});

app.get('/api/books', async (req, res) => {
  try {
    const [lp, dl, tp, tb, dc, sc] = await Promise.allSettled([
      scrapeLearningPal(),
      scrapeDepedLibre(),
      scrapeTeachPinas(),
      scrapeDepedTambayan(),
      scrapeDepedClick(),
      scrapeScribd(),
    ]);

    const scraped = [
      ...(lp.status === 'fulfilled' ? lp.value : []),
      ...(dl.status === 'fulfilled' ? dl.value : []),
      ...(tp.status === 'fulfilled' ? tp.value : []),
      ...(tb.status === 'fulfilled' ? tb.value : []),
      ...(dc.status === 'fulfilled' ? dc.value : []),
      ...(sc.status === 'fulfilled' ? sc.value : []),
    ];

    // Always include C&E hardcoded books + scraped, deduped globally
    let all = dedup([...getCEBooks(), ...scraped]);

    // Remove junk: too-short titles, navigation items, etc.
    all = all.filter(b =>
      b.title.length > 8 &&
      b.url.startsWith('http') &&
      !/^(home|about|contact|privacy|terms|login|search|category|tag)/i.test(b.title)
    );

    // Apply query filters
    if (req.query.grade)   all = all.filter(b => b.grade.toLowerCase().includes(req.query.grade.toLowerCase()));
    if (req.query.subject) all = all.filter(b => b.subject.toLowerCase().includes(req.query.subject.toLowerCase()));
    if (req.query.source)  all = all.filter(b => b.source.toLowerCase().includes(req.query.source.toLowerCase()));
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      all = all.filter(b =>
        b.title.toLowerCase().includes(q) ||
        b.subject.toLowerCase().includes(q) ||
        b.grade.toLowerCase().includes(q) ||
        (b.author || '').toLowerCase().includes(q)
      );
    }

    res.json({ count: all.length, books: all });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Scrape failed', detail: err.message });
  }
});

app.get('/api/books/sources', (req, res) => {
  res.json({
    sources: [
      { id: 'learningpal',  name: 'LearningPal',       url: 'https://learningpal.net' },
      { id: 'depedlibre',   name: 'DepEd Libre',        url: 'https://depedlibre.com' },
      { id: 'teachpinas',   name: 'Teach Pinas',        url: 'https://www.teachpinas.com' },
      { id: 'tambayan',     name: 'DepEd Tambayan',     url: 'https://depedtambayan.net' },
      { id: 'depedclick',   name: 'DepEd Click',        url: 'https://www.depedclick.com' },
      { id: 'scribd',       name: 'Scribd',             url: 'https://www.scribd.com' },
      { id: 'ce',           name: 'C&E / DepEd Official', url: 'https://sites.google.com/deped.gov.ph/cidhubdatabase/matatag-curriculum' },
    ],
  });
});

app.post('/api/cache/clear', (req, res) => {
  cache.flushAll();
  bookIdCounter = 1;
  res.json({ message: 'Cache cleared — next request will re-scrape all sources' });
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
app.listen(PORT, () => console.log(`NIAI LMS API v2 running on port ${PORT} — scraping 7 sources`));