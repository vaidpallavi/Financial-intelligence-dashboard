import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

import { getIndicesIndia, getIndicesGlobal, getCommodities, getIndiaBullion, getFx, getHistory, getQuote, searchSymbols, QUICK_PICKS, getIndexFutures, niftyFuturesFairValue, getOptionsChain } from './lib/markets.js';
import { computeMarketRegimeIntelligence, compareRegimeModels } from './lib/regime.js';
import { analyzePortfolio, runMonteCarlo } from './lib/riskLab.js';
import { getEvidencePool, formatEvidenceForPrompt, EVIDENCE_WATCHLIST } from './lib/fundamentals.js';
import { cachedFetch } from './lib/cache.js';
import { computeTechnicals } from './lib/technicals.js';
import { getCrypto } from './lib/crypto.js';
import { getRatesFromINR } from './lib/fx.js';
import { getNews } from './lib/news.js';
import { callClaude } from './lib/anthropic.js';
import { buildWorkerPrompt, buildReportPrompt, WORKERS } from './lib/workers.js';
import { extractJsonObject } from './lib/jsonExtract.js';
import { checkPassword, issueSessionCookie, clearSessionCookie, requireAuthApi, requireAuthPage } from './lib/auth.js';
import { checkAndIncrementSpendGuard, spendGuardStatus } from './lib/spendGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: (process.env.ALLOWED_ORIGINS || '*').split(','), credentials: true }));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

// Slows down brute-force password guessing on /api/login specifically.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });

// ---------- Auth ----------
app.post('/api/login', loginLimiter, (req, res) => {
  try {
    const { password } = req.body || {};
    if (!checkPassword(password)) return res.status(401).json({ error: 'Incorrect password.' });
    issueSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/logout', (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

// Everything below this line requires a valid session cookie.
// Login page and its own assets are served BEFORE this guard, further down.
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next(); // already handled above, but keeps this guard safe if reordered
  return requireAuthApi(req, res, next);
});

// Protects both your Anthropic quota and the free upstream data APIs from abuse.
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true });
app.use('/api', apiLimiter);

const agentLimiter = rateLimit({ windowMs: 60 * 1000, max: 12 }); // Claude calls cost money - tighter limit
app.use('/api/agent', agentLimiter);

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(err.status || 502).json({ error: err.message || 'Upstream data source failed' });
});

// ---------- Live market data (no Claude involved - pure data feeds) ----------
app.get('/api/markets/india-indices', wrap(async (req, res) => res.json(await getIndicesIndia())));
app.get('/api/markets/global-indices', wrap(async (req, res) => res.json(await getIndicesGlobal())));
app.get('/api/markets/commodities', wrap(async (req, res) => res.json(await getCommodities())));
app.get('/api/markets/bullion-india', wrap(async (req, res) => res.json(await getIndiaBullion())));
app.get('/api/markets/fx', wrap(async (req, res) => res.json(await getFx())));
app.get('/api/markets/history', wrap(async (req, res) => {
  const { symbol, range = '1mo', interval = '1d' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol query param required' });
  res.json(await getHistory(symbol, range, interval));
}));
app.get('/api/crypto', wrap(async (req, res) => res.json(await getCrypto(req.query.vs || 'usd'))));
app.get('/api/convert', wrap(async (req, res) => res.json(await getRatesFromINR())));
app.get('/api/news', wrap(async (req, res) => res.json(await getNews())));
app.get('/api/markets/search', wrap(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 1) return res.json([]);
  res.json(await searchSymbols(q));
}));
app.get('/api/markets/quick-picks', (req, res) => res.json(QUICK_PICKS));
app.get('/api/markets/technicals', wrap(async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol query param required' });
  const [hist, quote] = await Promise.all([
    getHistory(symbol, '1y', '1d'),
    getQuote(symbol).catch(() => null),
  ]);
  if (!hist.candles?.length) return res.status(502).json({ error: `No historical data available for ${symbol}` });
  const tech = computeTechnicals(hist.candles, symbol);
  res.json({ ...tech, quote, candles: hist.candles.slice(-60) }); // last 60 candles for a mini chart
}));

// ---------- Worker 07: Market Risk & Regime Intelligence - pure quant/ML, NO Claude calls ----------
// Cached for 5 minutes: retraining on every click would be wasteful (it refetches
// a year of history for 4 symbols and retrains 6+ models) and the underlying
// regime doesn't meaningfully change minute-to-minute anyway.
app.get('/api/intelligence/regime', wrap(async (req, res) => {
  const { data } = await cachedFetch('intelligence:regime', 300, computeMarketRegimeIntelligence);
  res.json(data);
}));
app.get('/api/intelligence/model-comparison', wrap(async (req, res) => {
  const { data } = await cachedFetch('intelligence:model-comparison', 300, compareRegimeModels);
  res.json(data);
}));

// ---------- Risk Lab: portfolio analytics + Monte Carlo - pure quant, NO Claude calls ----------
app.post('/api/risk-lab/analyze', wrap(async (req, res) => {
  const { holdings, monteCarlo } = req.body || {};
  if (!Array.isArray(holdings) || !holdings.length) return res.status(400).json({ error: 'holdings array required, e.g. [{"symbol":"RELIANCE.NS","amountINR":500000}]' });
  for (const h of holdings) {
    if (!h.symbol || !(h.amountINR > 0)) return res.status(400).json({ error: 'Each holding needs a symbol and a positive amountINR' });
  }
  const analysis = await analyzePortfolio(holdings);
  const mc = runMonteCarlo(analysis, {
    horizonDays: monteCarlo?.horizonDays || 252,
    nSims: monteCarlo?.nSims || 2000,
    targetReturnPct: monteCarlo?.targetReturnPct ?? 10,
  });
  const { _internal, ...cleanAnalysis } = analysis; // strip the raw return series before sending to the client
  res.json({ ...cleanAnalysis, monteCarlo: mc });
}));

app.get('/api/markets/index-futures', wrap(async (req, res) => res.json(await getIndexFutures())));
app.get('/api/markets/nifty-fair-value', wrap(async (req, res) => {
  const india = await getIndicesIndia();
  const nifty = india.items.find(i => i.symbol === '^NSEI');
  if (!nifty?.price) return res.status(502).json({ error: 'NIFTY spot price unavailable' });
  res.json({ spot: nifty.price, ...niftyFuturesFairValue(nifty.price) });
}));
app.get('/api/markets/options', wrap(async (req, res) => {
  const { symbol, expiry } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol query param required' });
  res.json(await getOptionsChain(symbol, expiry));
}));

// One combined snapshot endpoint - lets the frontend refresh everything in a single round trip.
app.get('/api/markets/snapshot', wrap(async (req, res) => {
  const [india, global, commodities, bullion, fx, crypto, news] = await Promise.allSettled([
    getIndicesIndia(), getIndicesGlobal(), getCommodities(), getIndiaBullion(), getFx(), getCrypto('inr'), getNews(),
  ]);
  const val = s => (s.status === 'fulfilled' ? s.value : { error: s.reason?.message || 'failed' });
  res.json({
    india: val(india), global: val(global), commodities: val(commodities),
    bullion: val(bullion), fx: val(fx), crypto: val(crypto), news: val(news),
    serverTime: new Date().toISOString(),
  });
}));

// ---------- Agent endpoints (these call Claude, server-side key only, and are spend-guarded) ----------
app.get('/api/agent/roster', (req, res) => res.json(WORKERS.map(w => ({ id: w.id, title: w.title, tag: w.tag }))));
app.get('/api/agent/spend-status', (req, res) => res.json(spendGuardStatus()));

app.post('/api/agent/chat', wrap(async (req, res) => {
  const { message, context } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });
  checkAndIncrementSpendGuard();
  const liveData = await gatherLiveDataFor('cfw');
  const { system } = buildWorkerPrompt({ id: 'cfw', title: 'Chief Finance Wiz' }, liveData, null, context);
  const text = await callClaude({ system, messages: [{ role: 'user', content: message }], maxTokens: 2200 });
  res.json({ text });
}));

app.post('/api/agent/:workerId', wrap(async (req, res) => {
  const worker = WORKERS.find(w => w.id === req.params.workerId);
  if (!worker) return res.status(404).json({ error: 'Unknown worker id' });

  const { customTask, context } = req.body || {};

  // For evidence-based workers (currently just Worker 1), fetch the evidence
  // pool BEFORE spending a Claude call. If it comes back completely empty
  // (e.g. Yahoo's fundamentals auth handshake failed for every symbol), the
  // worker's own instructions make the task impossible - it's told to
  // recommend 3 real picks but forbidden from discussing any company not in
  // the pool. Sending that prompt anyway just burns spend-guard budget and
  // returns a confusing result (empty picks, or hallucinated ones that trip
  // every evidence-verification warning) that looks like "the worker is
  // broken" rather than "the underlying data source is down right now."
  let evidencePool = null;
  if (worker.evidenceBased) {
    evidencePool = await getEvidencePool();
    if (!evidencePool.items.length) {
      return res.status(502).json({
        error: `Fundamentals data is unavailable right now (Yahoo Finance fundamentals lookup failed for all ${evidencePool.failures.length} watchlist symbols) - Worker 1 needs at least some real evidence to run, so it did not call the AI. This is usually a temporary upstream Yahoo auth issue; try again in a minute.`,
      });
    }
  }

  checkAndIncrementSpendGuard(); // throws a 429 once the daily cap is hit - protects your bill
  const liveData = await gatherLiveDataFor(worker.id);
  let { system, user } = buildWorkerPrompt(worker, liveData, customTask, context);

  if (worker.evidenceBased) {
    user = `EVIDENCE POOL (real data, fetched moments ago - you may ONLY discuss companies listed here):\n${formatEvidenceForPrompt(evidencePool)}\n\n${user}`;
  }

  const baseTokens = worker.maxTokens || 1800;
  const effectiveTokens = worker.useWebSearch ? baseTokens + 2000 : baseTokens; // web search consumes budget on tool-use turns before the final JSON
  let text = await callClaude({ system, messages: [{ role: 'user', content: user }], maxTokens: effectiveTokens, useWebSearch: !!worker.useWebSearch });
  let parsed = extractJsonObject(text);

  // A parse failure happened despite the brevity rules (LLMs don't always obey on the
  // first try) - one automatic retry with a sharper reminder, rather than surfacing
  // a failure immediately. Covers both truncation and any other malformed-JSON case.
  if (!parsed.ok) {
    const retrySystem = system + `\n\nIMPORTANT: your previous attempt did not produce valid, complete JSON (reason: ${parsed.reason}). This time: output ONLY the JSON object, nothing else - no explanation, no apology, no markdown. If needed, cut every array to AT MOST HALF the count previously specified and shorten every string field further. A complete, valid, smaller JSON object is far more useful than a bigger one that fails to parse.`;
    text = await callClaude({ system: retrySystem, messages: [{ role: 'user', content: user }], maxTokens: effectiveTokens, useWebSearch: !!worker.useWebSearch });
    parsed = extractJsonObject(text);
  }

  // Worker 6 (political analytics) is instructed to prioritize statements
  // from the last 2-3 days, but an LLM with web search will sometimes settle
  // for the same familiar, older stories even when fresher ones exist -
  // "not updating even after some time" is exactly what that looks like from
  // the outside. If EVERY leader it returned is stale (>3 days old, and not
  // today's date, which would indicate a missing/unparsed statementDate), do
  // one automatic retry with a pointed reminder to use different search terms,
  // mirroring the malformed-JSON retry above.
  if (worker.id === 'w6' && parsed.ok) {
    const leaders = parsed.value.data?.leaders || [];
    const now = Date.now();
    const staleCutoffMs = 3 * 86400000;
    const allStale = leaders.length > 0 && leaders.every(l => {
      const d = l.statementDate ? new Date(l.statementDate) : null;
      return !d || isNaN(d) || (now - d.getTime()) > staleCutoffMs;
    });
    if (allStale) {
      const retrySystem = system + `\n\nIMPORTANT: every statement in your previous attempt was more than 3 days old - that's stale for this dashboard. Before writing the final JSON, run at least one NEW search using different, more specific terms than you likely used before (e.g. a different leader/policymaker by name, the word "breaking", "this week", or today's exact date given above) and prioritize whatever genuinely recent statements you find. Only fall back to an older stance if you have already tried different search terms and there is truly nothing fresher - in that case keep the honest older statementDate rather than relabeling it as recent.`;
      const retryText = await callClaude({ system: retrySystem, messages: [{ role: 'user', content: user }], maxTokens: effectiveTokens, useWebSearch: !!worker.useWebSearch });
      const retryParsed = extractJsonObject(retryText);
      if (retryParsed.ok) { text = retryText; parsed = retryParsed; }
    }
  }

  // Hallucination guardrail: for evidence-based workers, check every recommended
  // company was actually in the evidence pool we gave it. This does not "fix"
  // the model's output - it flags what wasn't backend-verified, so the frontend
  // can show a warning instead of silently trusting an unverified pick.
  let evidenceWarnings = [];
  if (worker.evidenceBased && parsed.ok && evidencePool) {
    const knownSymbols = new Set(evidencePool.items.map(f => f.symbol));
    const knownNames = new Set(evidencePool.items.map(f => f.name.toLowerCase()));
    (parsed.value.data?.picks || []).forEach(p => {
      const symOk = p.ticker && [...knownSymbols].some(s => p.ticker.includes(s.replace('.NS', '')));
      const nameOk = p.name && [...knownNames].some(n => n.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(n));
      if (!symOk && !nameOk) evidenceWarnings.push(`"${p.name}" was not found in the fetched evidence pool - its figures could not be backend-verified.`);
    });
  }

  res.json({
    workerId: worker.id,
    raw: text,
    headline: parsed.ok ? parsed.value.headline : null,
    data: parsed.ok ? parsed.value.data : null,
    forecast: parsed.ok ? parsed.value.forecast : null,
    parseError: parsed.ok ? null : parsed.reason,
    evidenceWarnings: evidenceWarnings.length ? evidenceWarnings : undefined,
    liveDataUsed: liveData.summary,
  });
}));

app.post('/api/agent/:workerId/report', wrap(async (req, res) => {
  const worker = WORKERS.find(w => w.id === req.params.workerId);
  if (!worker) return res.status(404).json({ error: 'Unknown worker id' });
  const { out } = req.body || {};
  if (!out || (!out.data && !out.headline)) return res.status(400).json({ error: 'No worker output supplied - run the worker first.' });

  checkAndIncrementSpendGuard();
  const liveData = await gatherLiveDataFor(worker.id);
  const { system, user } = buildReportPrompt(worker, out, liveData);
  const text = await callClaude({ system, messages: [{ role: 'user', content: user }], maxTokens: 3500, useWebSearch: !!worker.useWebSearch });
  res.json({ report: text });
}));

async function gatherLiveDataFor() {
  const [bullionR, indiaR, globalR, cryptoR, futuresR, regimeR] = await Promise.allSettled([
    getIndiaBullion(), getIndicesIndia(), getIndicesGlobal(), getCrypto('inr'), getIndexFutures(),
    cachedFetch('intelligence:regime', 300, computeMarketRegimeIntelligence),
  ]);
  const ok = r => (r.status === 'fulfilled' ? r.value : null);
  const bullion = ok(bullionR), india = ok(indiaR), global = ok(globalR), crypto = ok(cryptoR), futures = ok(futuresR);
  const regime = ok(regimeR)?.data;
  const nifty = india?.items?.find(i => i.symbol === '^NSEI');
  const btc = crypto?.items?.find(i => i.id === 'bitcoin');
  const gold24k = bullion?.rows?.find(r => r.label === '24K Gold')?.inr;

  const lines = [];
  if (gold24k) lines.push(`Gold 24K (India, live-derived): Rs ${Math.round(gold24k).toLocaleString('en-IN')}/10g`);
  if (bullion) lines.push(`Basis: COMEX gold $${bullion.basis.goldUsdOz.toFixed(2)}/oz, USD/INR Rs${bullion.basis.usdinr.toFixed(2)}`);
  if (nifty) {
    lines.push(`NIFTY 50 (cash/spot): ${nifty.price?.toFixed(2)} (${nifty.changePct >= 0 ? '+' : ''}${nifty.changePct?.toFixed(2)}%)`);
    try {
      const fv = niftyFuturesFairValue(nifty.price);
      lines.push(`NIFTY futures theoretical fair value (cost-of-carry, near-month expiry ${fv.expiryDate}): ${fv.fairValue.toFixed(2)} - NOT the live traded NSE futures price (that needs a broker API), use as an approximate basis only`);
    } catch {}
  }
  if (futures?.items?.length) lines.push(`Global index FUTURES (live, real): ${futures.items.map(f => `${f.name} ${f.price?.toFixed(1)} (${f.changePct >= 0 ? '+' : ''}${f.changePct?.toFixed(2)}%)`).join(', ')} - factor futures basis/contango into calls`);
  if (btc) lines.push(`BTC/INR: Rs ${Math.round(btc.price).toLocaleString('en-IN')} (24h ${btc.change24hPct >= 0 ? '+' : ''}${btc.change24hPct?.toFixed(2)}%)`);
  if (regime) {
    lines.push(`QUANT REGIME MODEL (Worker 07, computed from real logistic regression - not this LLM's own judgement): Current regime = ${regime.regime.current} (${(regime.regime.probability*100).toFixed(0)}% probability). Top driver: ${regime.regime.topDrivers[0]?.feature} (${regime.regime.topDrivers[0]?.label}). Volatility forecast: ${regime.volatility.label}. Anomaly detected: ${regime.anomaly.detected ? 'YES - ' + regime.anomaly.abnormalFeatures.map(f=>f.feature).join(', ') : 'no'}. Treat this as a genuine data input, not a suggestion you can override without reason.`);
  }
  lines.push(`Server timestamp: ${new Date().toISOString()}`);

  return { summary: lines.join('\n'), bullion, india, global, crypto, regime };
}

// ---------- Static frontend ----------
// Login page and its assets are public. Everything else requires a session.
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/index.html', requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('*', requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Chief Finance Wiz backend running on http://localhost:${PORT}`);
  const missing = ['ANTHROPIC_API_KEY', 'SITE_PASSWORD', 'AUTH_SECRET'].filter(k => !process.env[k] || !process.env[k].trim());
  if (missing.length) {
    console.warn(`⚠ Missing/empty required .env values: ${missing.join(', ')}. Login and/or agents will not work until these are set and the server is restarted.`);
  } else {
    console.log('✔ SITE_PASSWORD and AUTH_SECRET are set. (Remember: any .env edit requires restarting the server to take effect.)');
  }
});
