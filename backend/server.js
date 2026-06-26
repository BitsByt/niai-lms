const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // cache 1 hour

app.use(cors());
app.use(express.json());

// ─── Helpers ────────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchHTML(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return cheerio.load(res.data);
}

// ─── Scrapers ────────────────────────────────────────────────────────────────

/**
 * Scrape learningpal.net/deped-matatag-textbooks/
 * Returns array of { title, grade, subject, url, source }
 */
async function scrapeLearningPal() {
  const ckey = 'learningpal';
  if (cache.has(ckey)) return cache.get(ckey);

  const $ = await fetchHTML('https://learningpal.net/deped-matatag-textbooks/');
  const books = [];

  // learningpal lists download links in anchor tags with post headings
  $('h2, h3, h4').each((_, el) => {
    const heading = $(el).text().trim();
    if (!heading || heading.length < 5) return;

    // find closest download link sibling/child
    const link =
      $(el).next('a').attr('href') ||
      $(el).find('a').attr('href') ||
      $(el).nextAll('a').first().attr('href') ||
      null;

    // try to infer grade from heading
    const gradeMatch = heading.match(/Grade\s*(\d+)/i);
    const grade = gradeMatch ? `Grade ${gradeMatch[1]}` : 'All levels';

    // infer subject
    const subjectMap = {
      Math: 'Mathematics', Science: 'Science', English: 'English',
      Filipino: 'Filipino', Araling: 'Araling Panlipunan',
      'Edukasyon sa Pagpapakatao': 'EsP', EPP: 'EPP/TLE', TLE: 'EPP/TLE',
      HELE: 'EPP/TLE', AP: 'Araling Panlipunan', ICT: 'Computer Studies',
      Computer: 'Computer Studies', MAPEH: 'MAPEH', Music: 'MAPEH',
      Arts: 'MAPEH', PE: 'MAPEH', Health: 'MAPEH',
    };
    let subject = 'General';
    for (const [kw, subj] of Object.entries(subjectMap)) {
      if (heading.toLowerCase().includes(kw.toLowerCase())) {
        subject = subj;
        break;
      }
    }

    if (link && link.startsWith('http')) {
      books.push({
        id: `lp-${books.length + 1}`,
        title: heading,
        grade,
        subject,
        url: link,
        source: 'LearningPal',
        cover: '',
      });
    }
  });

  // fallback: grab ALL external links that look like resources
  if (books.length < 3) {
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      if (
        text.length > 10 &&
        (href.includes('drive.google') ||
          href.includes('.pdf') ||
          href.includes('deped') ||
          href.includes('module'))
      ) {
        books.push({
          id: `lp-fb-${books.length + 1}`,
          title: text,
          grade: 'Various',
          subject: 'General',
          url: href,
          source: 'LearningPal',
          cover: '',
        });
      }
    });
  }

  cache.set(ckey, books);
  return books;
}

/**
 * Scrape depedlibre.com/deped-modules/
 */
async function scrapeDepedLibre() {
  const ckey = 'depedlibre';
  if (cache.has(ckey)) return cache.get(ckey);

  const $ = await fetchHTML('https://depedlibre.com/deped-modules/');
  const books = [];

  $('article, .entry, .post, .elementor-post').each((_, el) => {
    const title = $(el).find('h2, h3, .entry-title, .elementor-post__title').first().text().trim();
    const link = $(el).find('a').first().attr('href') || '';
    const excerpt = $(el).find('p, .entry-summary').first().text().trim();
    if (!title || !link) return;

    const gradeMatch = (title + excerpt).match(/Grade\s*(\d+)/i);
    const grade = gradeMatch ? `Grade ${gradeMatch[1]}` : 'Various';

    const subjectMap = {
      Math: 'Mathematics', Science: 'Science', English: 'English',
      Filipino: 'Filipino', Araling: 'Araling Panlipunan', EPP: 'EPP/TLE',
      HELE: 'EPP/TLE', Computer: 'Computer Studies', MAPEH: 'MAPEH',
    };
    let subject = 'General';
    for (const [kw, subj] of Object.entries(subjectMap)) {
      if (title.toLowerCase().includes(kw.toLowerCase())) { subject = subj; break; }
    }

    books.push({
      id: `dl-${books.length + 1}`,
      title,
      grade,
      subject,
      url: link,
      source: 'DepEd Libre',
      cover: $(el).find('img').first().attr('src') || '',
    });
  });

  cache.set(ckey, books);
  return books;
}

/**
 * Scrape teachpinas.com MATATAG curriculum guides
 */
async function scrapeTeachPinas() {
  const ckey = 'teachpinas';
  if (cache.has(ckey)) return cache.get(ckey);

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
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', name: 'NIAI LMS Scraper API', version: '1.0.0' });
});

// GET /api/books — returns all scraped books, merged + deduplicated
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

    // filter by query params
    let results = all;
    if (req.query.grade) {
      results = results.filter(b =>
        b.grade.toLowerCase().includes(req.query.grade.toLowerCase())
      );
    }
    if (req.query.subject) {
      results = results.filter(b =>
        b.subject.toLowerCase().includes(req.query.subject.toLowerCase())
      );
    }
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

// GET /api/books/sources — which sources are available
app.get('/api/books/sources', (req, res) => {
  res.json({
    sources: [
      { id: 'learningpal', name: 'LearningPal', url: 'https://learningpal.net/deped-matatag-textbooks/' },
      { id: 'depedlibre', name: 'DepEd Libre', url: 'https://depedlibre.com/deped-modules/' },
      { id: 'teachpinas', name: 'Teach Pinas', url: 'https://www.teachpinas.com/matatag-curriculum-guide-pdf-all-subjects/' },
    ],
  });
});

// POST /api/cache/clear — manually bust the cache (admin use)
app.post('/api/cache/clear', (req, res) => {
  cache.flushAll();
  res.json({ message: 'Cache cleared' });
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
