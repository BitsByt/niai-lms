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

## ➕ Adding More Sources

Open `backend/server.js` and add a new scraper function following the same pattern as `scrapeLearningPal()`. Then add it to the `Promise.allSettled` array in the `/api/books` route.

Suggested sources to add:
- `sites.google.com/deped.gov.ph/cidhubdatabase/matatag-curriculum`
- `depedtambayan.net`
- `www.teachpinas.com`

---

## ⚠️ Notes

- The Free tier on Render spins down after 15 min of inactivity. First load may take ~30 seconds to wake up. Upgrade to Starter ($7/mo) to avoid this.
- Cache is set to 1 hour — books won't re-scrape on every request.
- Call `POST /api/cache/clear` to force a fresh scrape anytime.
