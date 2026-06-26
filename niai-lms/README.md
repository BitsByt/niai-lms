# NIAI LMS — MATATAG Learning Resource Scraper

A two-part system:
- **Backend** (`/backend`) — Node.js Express API that scrapes DepEd resource sites and serves them as JSON
- **Frontend** (`/frontend`) — Standalone HTML page (no framework) that displays the books

---

## 🚀 Deploy Backend to Render

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial NIAI LMS commit"
# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/niai-lms.git
git push -u origin main
```

### Step 2 — Deploy on Render

1. Go to https://render.com and sign in
2. Click **New → Web Service**
3. Connect your GitHub repo
4. Set these settings:
   - **Root directory**: `backend`
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Region**: Singapore (closest to PH)
   - **Plan**: Free
5. Click **Create Web Service**

Render will give you a URL like: `https://niai-lms-api.onrender.com`

### Step 3 — Update the frontend

Open `frontend/index.html` and find this line near the bottom:

```js
const API = localStorage.getItem('niai_api_url') || 'https://niai-lms-api.onrender.com';
```

Replace `https://niai-lms-api.onrender.com` with your actual Render URL.

---

## 🌐 Host the Frontend

**Option A — GitHub Pages (free, easiest)**
1. Put `frontend/index.html` in a GitHub repo
2. Go to repo Settings → Pages → Deploy from branch → `main` / `root`
3. Your LMS is live at `https://YOUR_USERNAME.github.io/niai-lms/`

**Option B — Netlify Drop (even easier)**
1. Go to https://netlify.com/drop
2. Drag and drop the `frontend/` folder
3. Done — instant live URL

**Option C — Host on your school server / intranet**
Just copy `index.html` to any web server. It's a single file.

---

## 📡 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check |
| GET | `/api/books` | All scraped books |
| GET | `/api/books?q=math` | Search by keyword |
| GET | `/api/books?grade=Grade+8` | Filter by grade |
| GET | `/api/books?subject=Mathematics` | Filter by subject |
| GET | `/api/books/sources` | List scraped sources |
| POST | `/api/cache/clear` | Force re-scrape |
| GET | `/api/proxy?url=...` | Proxy a resource URL (for PDF embedding) |

---

## 🔎 Sources & how deep each one digs

The original version only read one listing page per site (~23 books total). It now
crawls two levels for most sources: a listing/archive page (often paginated) to find
article links, then follows a bounded number of those articles to pull out the real
download links (PDF / Google Drive / Docs / SharePoint) instead of just the article URL.

| Source | What it does |
|---|---|
| **LearningPal** | Single long-form MATATAG textbooks article + paginated crawl of its "Deped Matatag Files" and "Deped Files" categories, with article-level expansion |
| **DepEd Libre** | Modules index page + homepage links to grade-level roundup pages, with article-level expansion |
| **Teach Pinas** | Single curriculum-guide page with direct PDF/Drive links |
| **DepEd Official** (`deped.gov.ph/matatagcurriculumk147`) | Official curriculum guide table — small but authoritative, every link is a real government PDF |
| **DepEd CIDHub** (Google Sites, official Region CAR hub) | Curated list of official MATATAG curriculum/learning-material hub links |
| **DepEd Tambayan** | Paginated crawl of its "matatag curriculum" label archive, with article-level expansion to recover individual "Resource Name - DOWNLOAD" links |

Tunables live at the top of `backend/server.js`:

```js
const MAX_PAGES_PER_SOURCE = 2;       // how many archive/category pages to paginate through
const MAX_ARTICLES_TO_EXPAND = 8;     // how many landing pages to follow for real download links
const ARTICLE_FETCH_CONCURRENCY = 3;  // parallel requests while expanding articles
const MAX_BOOKS_PER_SOURCE = 80;      // hard cap per source
const REQUEST_TIMEOUT = 7000;         // per-HTTP-request timeout
const SCRAPE_DEADLINE = 18000;        // hard ceiling per source for the /api/books request itself
```

The first version of the deep crawl had no ceiling on total request time, which made
requests on Render's free tier hang far longer than expected. Two safety nets now
prevent that:

- **`SCRAPE_DEADLINE`** — each source races against an 18s clock. If it's not done in
  time, that request gets back whatever's cached (or an empty list on a truly cold
  start) instead of waiting indefinitely. The scrape keeps running in the background
  and still populates the cache, so the *next* request benefits.
- **In-flight de-duplication** — if two requests hit an empty cache around the same
  time, the second one reuses the first one's in-progress scrape instead of starting
  a redundant second crawl (which is exactly the kind of pile-up that can grind a
  free-tier instance to a halt).

Raise the tunables back up if you move off Render's free plan. Check the Render
**Logs** tab if a request ever feels unusually slow — `/api/books` logs how long the
scrape phase took, which tells you whether it's a slow source or something else
(failed deploy, cold start, etc).

These third-party sites (LearningPal, DepEd Libre, DepEd Tambayan) are content
aggregators, not DepEd itself — their HTML structure can change without notice, which
will silently shrink what gets returned from that source until the selectors are
updated. The DepEd Official and CIDHub sources are the most stable since they're
maintained by DepEd directly.

---

## ➕ Adding More Sources

Open `backend/server.js` and add a new scraper function following the same pattern as
`scrapeLearningPal()` or the simpler `scrapeTeachPinas()`. Then add it to the
`Promise.allSettled` array in the `/api/books` route and to `/api/books/sources`.

---

## ⚠️ Notes

- The Free tier on Render spins down after 15 min of inactivity. First load may take ~30 seconds to wake up. Upgrade to Starter ($7/mo) to avoid this.
- Cache is set to 1 hour — books won't re-scrape on every request.
- Call `POST /api/cache/clear` to force a fresh scrape anytime (the *next* `/api/books` call after clearing will be the slow 20–40s one, not the clear call itself).
