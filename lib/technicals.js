// Standard technical-analysis formulas computed from real OHLC candle history.
// Signal thresholds follow common textbook conventions (documented inline).
// These are transparent, well-known formulas - not a reproduction of any
// specific vendor's proprietary methodology, so exact values may differ
// slightly from other platforms even when both are "correct."

function sma(arr, period, endIdx = arr.length - 1) {
  if (endIdx - period + 1 < 0) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) sum += arr[i];
  return sum / period;
}

function emaSeries(arr, period) {
  if (arr.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(null);
  let prev = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
const emaLast = (arr, period) => { const s = emaSeries(arr, period); const v = s[s.length - 1]; return v == null ? null : v; };

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gains += d; else losses -= d; }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}
const rsiLast = (closes, period = 14) => { const s = rsiSeries(closes, period); return s[s.length - 1]; };

function stochRsiLast(closes, period = 14) {
  const rsiArr = rsiSeries(closes, period).filter(v => v != null);
  if (rsiArr.length < period) return null;
  const recent = rsiArr.slice(-period);
  const cur = rsiArr[rsiArr.length - 1];
  const mn = Math.min(...recent), mx = Math.max(...recent);
  return mx === mn ? 0 : (cur - mn) / (mx - mn) * 100;
}

function stochastic(highs, lows, closes, kPeriod = 9, kSmooth = 3, dPeriod = 6) {
  const rawK = [];
  for (let i = kPeriod - 1; i < closes.length; i++) {
    const hh = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    rawK.push(hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100);
  }
  const kSeries = [];
  for (let i = kSmooth - 1; i < rawK.length; i++) kSeries.push(rawK.slice(i - kSmooth + 1, i + 1).reduce((a, b) => a + b, 0) / kSmooth);
  const dSeries = [];
  for (let i = dPeriod - 1; i < kSeries.length; i++) dSeries.push(kSeries.slice(i - dPeriod + 1, i + 1).reduce((a, b) => a + b, 0) / dPeriod);
  return { k: kSeries.length ? kSeries[kSeries.length - 1] : null, d: dSeries.length ? dSeries[dSeries.length - 1] : null };
}

function macdLast(closes) {
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const macdArr = closes.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i] - e26[i] : null).filter(v => v != null);
  const signalArr = emaSeries(macdArr, 9);
  const macd = macdArr.length ? macdArr[macdArr.length - 1] : null;
  const signal = signalArr.length ? signalArr[signalArr.length - 1] : null;
  return { macd, signal, hist: (macd != null && signal != null) ? macd - signal : null };
}

function atrLast(highs, lows, closes, period = 14) {
  const trs = [];
  for (let i = 1; i < highs.length; i++) trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  if (trs.length < period) return null;
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

function adxLast(highs, lows, closes, period = 14) {
  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < highs.length; i++) {
    const up = highs[i] - highs[i - 1], down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  if (tr.length < period * 2) return { adx: null, plusDI: null, minusDI: null };
  const wilder = arr => { let s = arr.slice(0, period).reduce((a, b) => a + b, 0); const out = [s]; for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); } return out; };
  const trSm = wilder(tr), plusSm = wilder(plusDM), minusSm = wilder(minusDM);
  const len = Math.min(trSm.length, plusSm.length, minusSm.length);
  const dx = [];
  let lastPlusDI = null, lastMinusDI = null;
  for (let i = 0; i < len; i++) {
    const plusDI = trSm[i] === 0 ? 0 : (plusSm[i] / trSm[i]) * 100;
    const minusDI = trSm[i] === 0 ? 0 : (minusSm[i] / trSm[i]) * 100;
    lastPlusDI = plusDI; lastMinusDI = minusDI;
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : Math.abs(plusDI - minusDI) / sum * 100);
  }
  if (dx.length < period) return { adx: null, plusDI: lastPlusDI, minusDI: lastMinusDI };
  let a = dx.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < dx.length; i++) a = (a * (period - 1) + dx[i]) / period;
  return { adx: a, plusDI: lastPlusDI, minusDI: lastMinusDI };
}

function cciLast(highs, lows, closes, period = 14) {
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  if (tp.length < period) return null;
  const recent = tp.slice(-period);
  const avg = recent.reduce((a, b) => a + b, 0) / period;
  const meanDev = recent.reduce((a, b) => a + Math.abs(b - avg), 0) / period;
  return meanDev === 0 ? 0 : (tp[tp.length - 1] - avg) / (0.015 * meanDev);
}

function williamsRLast(highs, lows, closes, period = 14) {
  if (closes.length < period) return null;
  const hh = Math.max(...highs.slice(-period)), ll = Math.min(...lows.slice(-period));
  return hh === ll ? -50 : (hh - closes[closes.length - 1]) / (hh - ll) * -100;
}

function ultimateOscLast(highs, lows, closes) {
  const periods = [7, 14, 28], weights = [4, 2, 1];
  if (closes.length < 29) return null;
  let num = 0, den = 0;
  for (let pi = 0; pi < periods.length; pi++) {
    const p = periods[pi];
    let bpSum = 0, trSum = 0;
    for (let i = closes.length - p; i < closes.length; i++) {
      const priorClose = closes[i - 1];
      bpSum += closes[i] - Math.min(lows[i], priorClose);
      trSum += Math.max(highs[i], priorClose) - Math.min(lows[i], priorClose);
    }
    num += weights[pi] * (trSum === 0 ? 0 : bpSum / trSum);
    den += weights[pi];
  }
  return (num / den) * 100;
}

// Simplified momentum proxy (not identical to any vendor's proprietary "Highs/Lows" calc,
// but a real, computed signal: current close vs the 14-period high/low midpoint average).
function highsLowsLast(highs, lows, closes, period = 14) {
  if (closes.length < period) return null;
  const n = highs.length;
  const mids = [];
  for (let i = n - period; i < n; i++) mids.push((highs[i] + lows[i]) / 2);
  const avgMid = mids.reduce((a, b) => a + b, 0) / period;
  return closes[closes.length - 1] - avgMid;
}

function pivotPoints(prevHigh, prevLow, prevClose) {
  const pp = (prevHigh + prevLow + prevClose) / 3;
  const range = prevHigh - prevLow;
  return {
    classic: { PP: pp, R1: 2 * pp - prevLow, S1: 2 * pp - prevHigh, R2: pp + range, S2: pp - range, R3: prevHigh + 2 * (pp - prevLow), S3: prevLow - 2 * (prevHigh - pp) },
    fibonacci: { PP: pp, R1: pp + 0.382 * range, S1: pp - 0.382 * range, R2: pp + 0.618 * range, S2: pp - 0.618 * range, R3: pp + range, S3: pp - range },
  };
}

const MA_PERIODS = [5, 10, 20, 50, 100, 200];

export function computeTechnicals(candles, symbol) {
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  const price = closes[closes.length - 1];
  const prev = candles[candles.length - 1];

  const movingAverages = MA_PERIODS.map(period => {
    const smaVal = closes.length >= period ? sma(closes, period) : null;
    const emaVal = closes.length >= period ? emaLast(closes, period) : null;
    return {
      period,
      sma: smaVal, smaSignal: smaVal == null ? null : (price > smaVal ? 'Buy' : 'Sell'),
      ema: emaVal, emaSignal: emaVal == null ? null : (price > emaVal ? 'Buy' : 'Sell'),
    };
  });

  const rsi = rsiLast(closes);
  const stoch = stochastic(highs, lows, closes);
  const stochRsi = stochRsiLast(closes);
  const macd = macdLast(closes);
  const atr = atrLast(highs, lows, closes);
  const adxRes = adxLast(highs, lows, closes);
  const cci = cciLast(highs, lows, closes);
  const williamsR = williamsRLast(highs, lows, closes);
  const uo = ultimateOscLast(highs, lows, closes);
  const highsLows = highsLowsLast(highs, lows, closes);

  const sig = (val, buyIf, sellIf) => val == null ? null : (buyIf(val) ? 'Buy' : sellIf(val) ? 'Sell' : 'Neutral');
  const oscillators = [
    { name: 'RSI(14)', value: rsi, signal: sig(rsi, v => v < 30, v => v > 70) },
    { name: 'STOCH(9,6)', value: stoch.k, signal: sig(stoch.k, v => v < 20, v => v > 80) },
    { name: 'STOCHRSI(14)', value: stochRsi, signal: sig(stochRsi, v => v < 20, v => v > 80) },
    { name: 'MACD(12,26)', value: macd.macd, signal: (macd.macd == null || macd.signal == null) ? null : (macd.macd > macd.signal ? 'Buy' : 'Sell') },
    { name: 'ATR(14)', value: atr, signal: null, note: 'volatility, not directional' },
    { name: 'ADX(14)', value: adxRes.adx, signal: (adxRes.adx == null) ? null : (adxRes.adx < 20 ? 'Neutral' : (adxRes.plusDI > adxRes.minusDI ? 'Buy' : 'Sell')) },
    { name: 'CCI(14)', value: cci, signal: sig(cci, v => v > 100, v => v < -100) },
    { name: "Williams %R(14)", value: williamsR, signal: sig(williamsR, v => v < -80, v => v > -20) },
    { name: 'UO', value: uo, signal: sig(uo, v => v < 30, v => v > 70) },
    { name: 'Highs/Lows(14)', value: highsLows, signal: highsLows == null ? null : (highsLows > 0 ? 'Buy' : 'Sell') },
  ];

  const tally = list => list.reduce((acc, s) => { if (s === 'Buy') acc.buy++; else if (s === 'Sell') acc.sell++; else if (s === 'Neutral') acc.neutral++; return acc; }, { buy: 0, sell: 0, neutral: 0 });
  const maTally = tally(movingAverages.flatMap(m => [m.smaSignal, m.emaSignal]).filter(Boolean));
  const indTally = tally(oscillators.map(o => o.signal).filter(Boolean));
  const overallTotal = maTally.buy + maTally.sell + indTally.buy + indTally.sell;
  const overallBuyPct = overallTotal ? (maTally.buy + indTally.buy) / overallTotal : 0.5;
  const overall = overallTotal === 0 ? 'Neutral'
    : overallBuyPct >= 0.75 ? 'Strong Buy' : overallBuyPct >= 0.55 ? 'Buy'
    : overallBuyPct <= 0.25 ? 'Strong Sell' : overallBuyPct <= 0.45 ? 'Sell' : 'Neutral';

  return {
    symbol, price, asOf: prev.date,
    movingAverages, oscillators,
    pivots: pivotPoints(prev.high, prev.low, prev.close),
    summary: { movingAverages: maTally, indicators: indTally, overall },
  };
}
