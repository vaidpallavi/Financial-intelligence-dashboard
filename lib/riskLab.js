import { getHistory } from './markets.js';
import * as Q from './quant.js';

// ============================================================================
// Risk Lab - real portfolio analytics (return, vol, beta, Sharpe, max
// drawdown, historical VaR/CVaR, correlations, concentration) and Monte
// Carlo simulation via HISTORICAL BOOTSTRAP (resampling real joint daily
// return vectors, not simulated Gaussian paths). Bootstrap is used
// deliberately instead of GBM+Cholesky: it preserves real fat tails, skew,
// and cross-asset correlation without assuming returns are normally
// distributed, which they empirically are not.
// ============================================================================

const RISK_FREE_RATE = 0.065; // approx short-term INR risk-free rate - update if it materially changes
const BENCHMARK = '^NSEI';

async function fetchAlignedReturns(symbols) {
  const uniqueSymbols = [...new Set([...symbols, BENCHMARK])];
  const histories = await Promise.all(uniqueSymbols.map(s => getHistory(s, '1y', '1d').catch(e => ({ error: e.message, symbol: s }))));
  const failed = [];
  const seriesBySymbol = {};
  uniqueSymbols.forEach((s, i) => {
    const h = histories[i];
    if (h.error || !h.candles?.length) { failed.push(s); return; }
    seriesBySymbol[s] = h.candles;
  });
  if (failed.length) {
    const missingRequested = symbols.filter(s => failed.includes(s));
    if (missingRequested.length) throw new Error(`Could not fetch live history for: ${missingRequested.join(', ')}`);
  }

  const dateKey = iso => iso.slice(0, 10);
  const retMaps = {};
  for (const s in seriesBySymbol) {
    const candles = seriesBySymbol[s];
    const m = {};
    for (let i = 1; i < candles.length; i++) m[dateKey(candles[i].date)] = (candles[i].close - candles[i - 1].close) / candles[i - 1].close;
    retMaps[s] = m;
  }
  // inner join across all symbols + benchmark - only keep dates present everywhere (honest, no fabricated fill-ins)
  const allDates = Object.keys(retMaps[BENCHMARK] || {});
  const commonDates = allDates.filter(d => symbols.every(s => d in (retMaps[s] || {})));
  if (commonDates.length < 40) throw new Error(`Only ${commonDates.length} aligned trading days available across this portfolio - need at least 40 for meaningful risk metrics.`);
  commonDates.sort();

  const returns = {};
  symbols.forEach(s => { returns[s] = commonDates.map(d => retMaps[s][d]); });
  const benchmarkReturns = commonDates.map(d => retMaps[BENCHMARK][d]);
  return { dates: commonDates, returns, benchmarkReturns };
}

function portfolioDailyReturns(holdings, returns, nDays) {
  const out = new Array(nDays).fill(0);
  for (let t = 0; t < nDays; t++) {
    let r = 0;
    holdings.forEach(h => { r += h.weight * returns[h.symbol][t]; });
    out[t] = r;
  }
  return out;
}

function maxDrawdown(dailyReturns) {
  let value = 1, peak = 1, maxDD = 0;
  for (const r of dailyReturns) {
    value *= 1 + r;
    if (value > peak) peak = value;
    const dd = (value - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD; // negative number, e.g. -0.18 = -18%
}

function historicalVaRCVaR(dailyReturns, confidence) {
  const sorted = [...dailyReturns].sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor((1 - confidence) * sorted.length) - 1);
  const varValue = sorted[idx];
  const tail = sorted.slice(0, idx + 1);
  const cvarValue = tail.length ? Q.mean(tail) : varValue;
  return { var: varValue, cvar: cvarValue };
}

export async function analyzePortfolio(holdingsInput) {
  // holdingsInput: [{ symbol, amountINR }]
  const totalAmount = holdingsInput.reduce((s, h) => s + h.amountINR, 0);
  if (totalAmount <= 0) throw new Error('Portfolio amounts must sum to more than zero.');
  const holdings = holdingsInput.map(h => ({ symbol: h.symbol, amountINR: h.amountINR, weight: h.amountINR / totalAmount }));
  const symbols = holdings.map(h => h.symbol);

  const { dates, returns, benchmarkReturns } = await fetchAlignedReturns(symbols);
  const nDays = dates.length;
  const portRet = portfolioDailyReturns(holdings, returns, nDays);

  const cumulative = portRet.reduce((acc, r) => acc * (1 + r), 1);
  const periodYears = nDays / 252;
  const annualizedReturn = Math.pow(cumulative, 1 / periodYears) - 1;
  const annualizedVol = Q.std(portRet) * Math.sqrt(252);
  const sharpe = annualizedVol > 0 ? (annualizedReturn - RISK_FREE_RATE) / annualizedVol : null;

  const covPB = Q.mean(portRet.map((r, i) => (r - Q.mean(portRet)) * (benchmarkReturns[i] - Q.mean(benchmarkReturns))));
  const varB = Q.mean(benchmarkReturns.map(r => (r - Q.mean(benchmarkReturns)) ** 2));
  const beta = varB > 0 ? covPB / varB : null;

  const mdd = maxDrawdown(portRet);
  const var95 = historicalVaRCVaR(portRet, 0.95);
  const var99 = historicalVaRCVaR(portRet, 0.99);

  const correlationMatrix = {};
  symbols.forEach(a => {
    correlationMatrix[a] = {};
    symbols.forEach(b => {
      if (a === b) { correlationMatrix[a][b] = 1; return; }
      const ra = returns[a], rb = returns[b];
      const ma = Q.mean(ra), mb = Q.mean(rb);
      const cov = Q.mean(ra.map((v, i) => (v - ma) * (rb[i] - mb)));
      const sa = Q.std(ra), sb = Q.std(rb);
      correlationMatrix[a][b] = sa > 0 && sb > 0 ? cov / (sa * sb) : 0;
    });
  });

  const hhi = holdings.reduce((s, h) => s + h.weight * h.weight, 0);
  const effectiveNAssets = hhi > 0 ? 1 / hhi : holdings.length;

  return {
    totalAmountINR: totalAmount,
    holdings: holdings.map(h => ({ symbol: h.symbol, amountINR: h.amountINR, weightPct: h.weight * 100 })),
    dataPoints: nDays, dateRange: { from: dates[0], to: dates[dates.length - 1] },
    metrics: {
      annualizedReturnPct: annualizedReturn * 100, annualizedVolPct: annualizedVol * 100,
      sharpeRatio: sharpe, beta,
      maxDrawdownPct: mdd * 100,
      var95Pct: var95.var * 100, cvar95Pct: var95.cvar * 100,
      var99Pct: var99.var * 100, cvar99Pct: var99.cvar * 100,
    },
    concentration: { herfindahlIndex: hhi, effectiveNumberOfAssets: effectiveNAssets, nHoldings: holdings.length },
    correlationMatrix,
    riskFreeRateUsed: RISK_FREE_RATE,
    _internal: { holdings, returns, portRet }, // reused by Monte Carlo without refetching
  };
}

/**
 * Monte Carlo via historical bootstrap: repeatedly sample a random HISTORICAL
 * day's full joint return vector (same day for every asset, preserving real
 * cross-asset correlation for that day) and compound it forward.
 */
export function runMonteCarlo(analysis, { horizonDays = 252, nSims = 2000, targetReturnPct = 10 } = {}) {
  const { holdings, returns } = analysis._internal;
  const nDays = returns[holdings[0].symbol].length;
  const initialValue = analysis.totalAmountINR;
  const targetValue = initialValue * (1 + targetReturnPct / 100);

  const terminalValues = new Array(nSims);
  const pathDrawdowns = new Array(nSims);
  const sampleCount = Math.min(nSims, 5000); // hard ceiling so this can never accidentally hang the server
  for (let s = 0; s < sampleCount; s++) {
    let value = 1, peak = 1, worstDD = 0;
    for (let d = 0; d < horizonDays; d++) {
      const dayIdx = Math.floor(Math.random() * nDays);
      let dayReturn = 0;
      holdings.forEach(h => { dayReturn += h.weight * returns[h.symbol][dayIdx]; });
      value *= 1 + dayReturn;
      if (value > peak) peak = value;
      const dd = (value - peak) / peak;
      if (dd < worstDD) worstDD = dd;
    }
    terminalValues[s] = value * initialValue;
    pathDrawdowns[s] = worstDD;
  }
  const tv = terminalValues.slice(0, sampleCount).sort((a, b) => a - b);
  const pctile = p => tv[Math.max(0, Math.min(tv.length - 1, Math.floor(p * tv.length)))];
  const ddSorted = [...pathDrawdowns.slice(0, sampleCount)].sort((a, b) => a - b);

  return {
    horizonDays, simulations: sampleCount, initialValue, targetValue, targetReturnPct,
    terminal: { p5: pctile(0.05), median: pctile(0.5), p95: pctile(0.95), expected: Q.mean(tv) },
    probabilityOfLoss: tv.filter(v => v < initialValue).length / sampleCount,
    probabilityOfTarget: tv.filter(v => v >= targetValue).length / sampleCount,
    drawdownDistribution: { p50: ddSorted[Math.floor(0.5 * sampleCount)] * 100, p95worst: ddSorted[Math.floor(0.05 * sampleCount)] * 100, mean: Q.mean(ddSorted) * 100 },
    methodology: 'Historical bootstrap: each simulated day randomly resamples one real historical joint daily return across all holdings (preserving actual correlation and fat tails), compounded forward - not a Gaussian/GBM simulation.',
  };
}
