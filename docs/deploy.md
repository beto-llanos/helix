# Helix — Deployment guide

Production target:

- **Backend** (FastAPI + SSE) → Railway
- **Frontend** (Next.js 16) → Vercel
- **Database** → MongoDB Atlas (already provisioned)

## 1 · Backend → Railway

### 1.1 — Create the service

1. Go to https://railway.app → New Project → Deploy from GitHub repo
2. Pick `beto-llanos/helix`
3. Root Directory: **leave as `/`** (do NOT set to `backend/`; the agent module needs to be importable)
4. Railway detects `nixpacks.toml` + `Procfile` + `requirements.txt` and builds Python automatically

### 1.2 — Environment variables

In Railway → Variables, paste these (one per row):

```
GCP_SERVICE_ACCOUNT_JSON   = <paste the entire JSON of helix-agent service account>
GOOGLE_CLOUD_PROJECT       = indexacian-instantanea
GOOGLE_CLOUD_LOCATION      = us-central1
GEMINI_MODEL               = gemini-2.5-pro
EMBEDDING_MODEL            = text-embedding-004

MONGODB_URI                = mongodb+srv://...   (full Atlas SRV string)
MONGODB_DB                 = helix
MONGODB_VECTOR_INDEX       = vector_index

SHOPIFY_STORE_DOMAIN       = helix-dev-2fhzrwlb.myshopify.com
SHOPIFY_ADMIN_API_TOKEN    = shpua_...
SHOPIFY_API_VERSION        = 2025-01

FRONTEND_ORIGIN            = https://<your-vercel-url>.vercel.app,http://localhost:3000
```

For `GCP_SERVICE_ACCOUNT_JSON`: paste the **full JSON content** as the value, including the `-----BEGIN PRIVATE KEY-----` block with `\n` literal sequences. Railway's value field accepts multi-line JSON.

### 1.3 — First deploy

After saving env vars, Railway triggers a build. Watch logs:

- Expect: `Installing python311`, then `pip install`, then `uvicorn backend.main:app`
- Final log line: `Uvicorn running on http://0.0.0.0:<PORT>`

### 1.4 — Smoke-test the public backend

```bash
curl https://<railway-domain>.up.railway.app/api/health
# → {"status":"ok","service":"helix-backend","model":"gemini-2.5-pro"}

curl https://<railway-domain>.up.railway.app/api/missions
# → [] or list of missions (200 OK)
```

If the healthcheck returns 200, Gemini ADC is good (the bootstrap materialized the JSON correctly).

Trigger a mission and check it runs end-to-end against real Shopify + Mongo:

```bash
curl -X POST https://<railway-domain>.up.railway.app/api/missions \
  -H "Content-Type: application/json" \
  -d '{"brief":"Smoke test from prod"}'
```

Then `GET /api/missions/{id}` after ~25s — `status` should be `complete`.

### 1.5 — Verify SSE survives the proxy

```bash
curl -N https://<railway-domain>.up.railway.app/api/missions/<id>/stream
```

You should see `event: mission_start`, `event: reasoning_delta`, etc. flushing in real time, not buffered. `X-Accel-Buffering: no` plus `ping=15` in our SSE response should keep Railway's proxy happy.

## 2 · Frontend → Vercel

### 2.1 — Import the project

1. https://vercel.com → New Project → Import `beto-llanos/helix`
2. **Root Directory**: set to `frontend/`
3. Framework Preset: Next.js (auto-detected)
4. Build & Output Settings: defaults

### 2.2 — Environment variable

```
NEXT_PUBLIC_BACKEND_URL = https://<railway-domain>.up.railway.app
```

Set for Production, Preview, Development.

### 2.3 — Deploy

Vercel builds and assigns a URL like `https://helix-xyz.vercel.app`.

### 2.4 — Update backend CORS

Go back to Railway → Variables → edit `FRONTEND_ORIGIN`:

```
FRONTEND_ORIGIN = https://helix-xyz.vercel.app,http://localhost:3000
```

Railway redeploys automatically (~30s).

## 3 · End-to-end public demo test

1. Open `https://helix-xyz.vercel.app`
2. Verify metrics bar shows your existing missions (proves Mongo + CORS work)
3. Type a brief, click "Run mission"
4. Reasoning should stream live, tool calls render, Shopify card appears
5. Click "Open in Shopify admin" → real draft product visible

If anything breaks at this step, check in order:

| Symptom | Likely cause | Fix |
|---|---|---|
| CORS error in browser console | `FRONTEND_ORIGIN` doesn't include exact Vercel URL | Update env var, redeploy backend |
| Mission stays "running" forever, no events stream | SSE proxy buffering | Verify `X-Accel-Buffering: no` header present in response |
| `500` on POST /missions | Gemini auth failed | Check Railway logs; usually GCP_SERVICE_ACCOUNT_JSON malformed |
| Mission completes but Shopify product not created | Stale Shopify token | Re-run OAuth flow to get new `shpua_` token |

## 4 · After deploy is green

Then and only then: continue with Priority 2 (MongoDB MCP wire-up).
