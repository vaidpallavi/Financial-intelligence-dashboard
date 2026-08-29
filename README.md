# Chief Finance Wiz

**A live, multi-agent financial intelligence dashboard.** Six specialist AI agents — fundamental research, markets & bullion, quant allocation, technicals, geopolitical intelligence, and political-statement analytics — report to a master orchestrator on top of real, live market data.
## 🚀 Live Demo

### [▶ Launch Chief Finance Wiz](https://financial-intelligence-dashboard-8qbo.onrender.com)

> The dashboard may take a few seconds to start on the first visit if the Render service is sleeping.

## 🎥 UI Preview

### Chief Finance Wiz Dashboard Walkthrough


https://github.com/user-attachments/assets/c77796f1-a5ef-4ae0-a029-d4b57cea26c3


[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/backend-Express-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Claude API](https://img.shields.io/badge/AI-Claude%20API-D97757?logo=anthropic&logoColor=white)](https://www.anthropic.com)


---

## Contents

- [Overview](#overview)
- [Live demo access](#live-demo-access)
- [Features](#features)
- [Architecture](#architecture)
- [Data sources](#data-sources)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [API reference](#api-reference)
- [Project structure](#project-structure)
- [Deployment](#deployment)
- [Design decisions](#design-decisions)


---

## Overview

Chief Finance Wiz is a self-hosted trading and research dashboard that pairs **live market data** (Indian and global indices, bullion, FX, crypto, news) with **six purpose-built AI agents**, each scoped to a specific domain and constrained to only reason over data the backend actually fetched — not data the model recalls or invents.

It's built as a portfolio piece to demonstrate full-stack engineering with a live LLM integration: real-time data pipelines, prompt/schema design, hallucination guardrails, cost controls on a metered API, and a production deployment — not just a chatbot wrapper.

## Live demo access

This app calls a paid LLM API for agent analysis, so the deployed instance sits behind a password and a hard daily spend cap — **anyone can review the code here; running it live requires credentials.**

If you're an interviewer or reviewer and would like a live walkthrough or temporary access, reach out and I'll share the URL and password directly.

## Features

| Agent | Focus | Notes |
|---|---|---|
| **Worker 01 — Fundamental Research** | Stock picks with P/E, growth, margins | *Evidence-based*: every figure it cites is backend-verified against real Yahoo Finance fundamentals; it's contractually forbidden from discussing a company outside that fetched pool |
| **Worker 02 — Markets & Bullion Desk** | Indices, gold/silver/crude, India retail bullion pricing | India gold/silver rates are **computed live** from futures + live USD/INR + duty/GST, never hardcoded |
| **Worker 03 — Allocation & Risk Engine** | Portfolio allocation, Markowitz/Sharpe-style reasoning | Web search-enabled for current macro context |
| **Worker 04 — Charting & Trends** | RSI, MACD, technical regime | |
| **Worker 05 — Global Intelligence Monitor** | 24/7 geopolitics & macro | Web search-enabled |
| **Worker 06 — Political Analytics Engine** | Recent political statements → market consequences | Web search-enabled, with an automatic freshness retry if returned statements are stale |

Plus:
- **Morning Intelligence Brief** — a live-refreshing summary panel (market regime, NIFTY bias, gold/oil momentum, overnight news count) aggregated from whatever's been run so far in the session, with one-click PDF export.
- **Live market rates** — India/global indices, commodities, FX, and crypto, auto-refreshing every 15s while NSE/BSE is open (30s otherwise).
- **Market scanner** across ~340 Indian and global tickers.
- **Risk Lab** — walk-forward-style stress testing on demand.
- **Investment committee chat** — ask follow-up questions with full context from every agent that's already run.
- **Downloadable PDF reports**, both per-agent and portfolio-wide.

## Architecture

```
┌─────────────┐      HTTPS       ┌──────────────────────┐      ┌───────────────────┐
│  Browser    │ ───────────────▶ │  Express server       │ ───▶ │  Yahoo Finance      │
│  (vanilla   │                  │  (signed-cookie auth,  │      │  CoinGecko          │
│   JS SPA)   │ ◀─────────────── │   spend-guarded routes) │      │  Frankfurter (FX)   │
└─────────────┘                  │                          │ ──▶ │  RSS news feeds     │
                                  │  lib/workers.js           │      └───────────────────┘
                                  │  (6 agent personas +       │
                                  │   prompt/schema builder)     │
                                  └───────────────┬───────────────┘
                                                  │
                                                  ▼
                                        ┌──────────────────┐
                                        │  Anthropic Claude  │
                                        │  API (server-side   │
                                        │  only, web search    │
                                        │  tool for 3 agents)    │
                                        └──────────────────┘
```

A **hybrid monolith**, deliberately: Express serves both the API and the static frontend from one process. No CORS complexity, no separate deploy pipeline, and the Anthropic API key never has to cross a public network boundary.

## Data sources

| Data | Source | Notes |
|---|---|---|
| Indian indices (NIFTY, SENSEX, BANK NIFTY, VIX) | Yahoo Finance | Free, no key |
| Global indices (S&P 500, NASDAQ, FTSE, Nikkei, Hang Seng, DAX, CAC, Shanghai) | Yahoo Finance | Free, no key |
| Gold / Silver / Copper / Platinum / Crude | Yahoo Finance futures | India retail rate calculated live from this + live USD/INR + duty/GST |
| Crypto | CoinGecko | Free, no key, native INR pricing |
| FX / currency converter | Frankfurter (ECB) | ~30 major currencies |
| News | Live RSS — Economic Times, LiveMint, Business Standard, Moneycontrol, WSJ | |
| Worker analysis, political analytics, chat | Anthropic Claude API | Server-side only, spend-guarded |
| NSE F&O options chain | *Not included* | No compliant free source exists; would require a broker API (Kite Connect / Upstox) |

## Tech stack

- **Backend:** Node.js, Express, `node-cache` (stale-fallback caching), `rss-parser`, `cookie-parser`, `express-rate-limit`
- **Frontend:** Vanilla JS (no framework), TradingView Lightweight Charts, WebSocket-driven tickers
- **AI:** Anthropic Claude API, server-side web search tool for time-sensitive agents
- **Auth:** HMAC-signed, `HttpOnly` session cookies — no database, no third-party auth provider
- **Deployment:** Render.com / Railway.app

## Getting started

### Prerequisites
- Node.js ≥ 18 — check with `node -v`
- An [Anthropic API key](https://console.anthropic.com)

### Install

```bash
git clone <this-repo-url>
cd cfw-dashboard
npm install
cp .env.example .env
```

Fill in `.env` (see [Environment variables](#environment-variables) below — at minimum you need `ANTHROPIC_API_KEY`, `SITE_PASSWORD`, and `AUTH_SECRET`).

### Run

```bash
npm start        # production
npm run dev       # auto-restarts on save, for active development
```

Open **http://localhost:3001**, log in with your `SITE_PASSWORD`, and you're in.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Your Claude API key. Server-side only — never sent to the browser. |
| `ANTHROPIC_MODEL` | | Which Claude model the agents use. Defaults to `claude-sonnet-5`. |
| `SITE_PASSWORD` | ✅ | Password required to reach the dashboard at all. |
| `AUTH_SECRET` | ✅ | Long random string used to sign session cookies. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `DAILY_CLAUDE_CALL_LIMIT` | | Hard cap on agent calls per day, across all visitors combined. Defaults to `50`. Resets at UTC midnight. |
| `NEWSAPI_KEY` | | Optional, only needed for news beyond the free RSS feeds already wired in. |
| `PORT` | | Local port. Defaults to `3001`; overridden automatically by most hosts in production. |
| `ALLOWED_ORIGINS` | | Comma-separated origins allowed to call the API in production. |

`.env` is git-ignored and never committed — only `.env.example` (with placeholder values) is tracked.

## API reference

All routes are prefixed `/api`. Everything except `/login` requires a valid session cookie.

| Method | Route | Description |
|---|---|---|
| `POST` | `/login` | Authenticate with `SITE_PASSWORD`, sets session cookie |
| `POST` | `/logout` | Clears the session |
| `GET` | `/markets/india-indices` · `/global-indices` · `/commodities` · `/bullion-india` · `/fx` | Live market data pulls |
| `GET` | `/markets/history` | Historical OHLC for charting |
| `GET` | `/markets/snapshot` | Aggregated snapshot used for the auto-refresh loop |
| `GET` | `/markets/technicals` · `/index-futures` · `/nifty-fair-value` | Derived market analytics |
| `GET` | `/crypto` | Live crypto prices (CoinGecko) |
| `GET` | `/convert` | Currency conversion rates |
| `GET` | `/news` | Aggregated RSS news |
| `GET` | `/intelligence/regime` · `/model-comparison` | Market regime intelligence |
| `POST` | `/risk-lab/analyze` | On-demand stress test |
| `GET` | `/agent/roster` | List of the 6 agents |
| `GET` | `/agent/spend-status` | Current daily Claude spend-guard usage |
| `POST` | `/agent/:workerId` | Run a single agent (`w1`–`w6`) |
| `POST` | `/agent/:workerId/report` | Generate a detailed PDF report for one agent |
| `POST` | `/agent/chat` | Ask the Investment Committee a question, with full multi-agent context |

## Project structure

```
cfw-dashboard/
├── server.js                Express app: auth, routes, static hosting
├── lib/
│   ├── auth.js               Signed-cookie login/session (no DB)
│   ├── spendGuard.js           Hard daily cap on Claude calls
│   ├── cache.js                 Shared cache with stale-fallback
│   ├── markets.js                 Yahoo Finance: indices, commodities, FX, bullion calc
│   ├── fundamentals.js              Evidence pool for Worker 1 (P/E, growth, margins)
│   ├── crypto.js                     CoinGecko integration
│   ├── fx.js                           Frankfurter currency converter
│   ├── news.js                          Live RSS aggregation
│   ├── anthropic.js                      Server-side Claude proxy (+ web search tool)
│   ├── jsonExtract.js                     Robust JSON extraction from LLM output
│   └── workers.js                          The 6 agent personas + prompt/schema builder
├── public/
│   ├── login.html            Password gate (public)
│   ├── index.html              Dashboard shell (requires session)
│   ├── style.css                 Visual design
│   └── app.js                       Frontend logic
├── docs/
│   └── screenshot.png       Dashboard preview shown above
├── .env.example
└── package.json
```

## Deployment

### Render.com (recommended)
1. Connect this repo → **New → Web Service**.
2. Build command: `npm install` · Start command: `npm start`.
3. Add every variable from `.env.example` under **Environment**, set `ALLOWED_ORIGINS` to your Render URL, and `NODE_ENV=production` (makes session cookies `secure`, i.e. HTTPS-only).
4. Deploy — you'll get a URL like `https://cfw-dashboard.onrender.com`.

The URL itself can be shared freely; the `SITE_PASSWORD` should not be.

> Free tier instances sleep after inactivity and take ~30s to wake on the next request — worth knowing before a live walkthrough, or upgrade to an always-on plan.

### Railway.app
Same pattern — connect the repo, set the same environment variables in Railway's dashboard, deploy.

## Design decisions

A few choices worth calling out, since they reflect real engineering trade-offs rather than defaults:

- **Hybrid monolith over split frontend/backend** — one fewer moving part, no CORS surface, and the API key never crosses a public boundary.
- **Password + daily spend cap, not just "don't share the link"** — defense in depth. The app should stay safe to leave public even if the link leaks or the repo is found, since a metered LLM API is a real liability if left open.
- **Evidence pools over free-form generation** — Worker 1 is only allowed to discuss companies the backend actually fetched real fundamentals for. This is enforced with a backend guardrail that flags any recommendation not traceable to fetched data, rather than trusting the model's output at face value.
- **Last-known-good caching over bare try/catch** — a flaky upstream API (Yahoo Finance's fundamentals endpoint in particular, which requires a fragile cookie/crumb handshake) shouldn't make the whole dashboard look broken. Staleness is tracked and surfaced explicitly rather than silently shown as current.
- **Explicit scope limits** — NSE F&O chain, full global currency coverage, and a Bloomberg-grade news feed are intentionally out of scope, since no free/compliant source exists for them. Being upfront about that is more credible than quietly faking it.
  

---

*Built as a personal project to explore live financial data pipelines and multi-agent LLM system design. Not licensed investment advice.*
