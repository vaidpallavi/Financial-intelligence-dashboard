import { getHistory } from './markets.js';
import * as Q from './quant.js';

// ============================================================================
// Market Risk & Regime Intelligence - "Worker 07"
// Unlike the other six workers, this one makes ZERO Claude/LLM calls. Every
// number here comes from real statistical/ML computation on live price
// history, run in this Node backend. That is a deliberate design choice: it
// gives the other agents a genuinely evidence-based signal to reference,
// with no hallucination risk, because there's no LLM in the numeric path.
// ============================================================================

const REGIME_CLASSES = ['Bullish', 'Bearish', 'Sideways', 'High-Volatility Bullish', 'High-Volatility Bearish'];
const FEATURE_NAMES = ['1D return', 'Rolling 10D volatility', 'RSI(14), centered', 'MACD histogram', 'MA5-MA20 spread', 'Volume z-score', 'USD/INR move', 'Gold move', 'Global futures move'];

// ---------- local technical-indicator helpers (self-contained; see lib/technicals.js for the fuller versions used elsewhere on the dashboard) ----------
function smaAt(arr, period, end) { if (end - period + 1 < 0) return null; let s = 0; for (let i = end - period + 1; i <= end; i++) s += arr[i]; return s / period; }
function emaSeries(arr, period) {
  if (arr.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(null);
  let prev = Q.mean(arr.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < arr.length; i++) { prev = arr[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
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

function labelRow(row, volPercentile) {
  const highVol = volPercentile > 0.66;
  if (highVol) return row.ret5 >= 0 ? 'High-Volatility Bullish' : 'High-Volatility Bearish';
  if (Math.abs(row.ret5) < 0.005) return 'Sideways';
  return row.ret5 > 0 ? 'Bullish' : 'Bearish';
}

/**
 * Single shared feature-engineering pipeline, used by BOTH the main regime
 * analysis and the model-comparison table, so the two displays can never
 * silently drift onto different feature sets.
 */
async function prepareTrainingData() {
  const [nifty, usdinr, gold, global_] = await Promise.all([
    getHistory('^NSEI', '1y', '1d'),
    getHistory('USDINR=X', '1y', '1d'),
    getHistory('GC=F', '1y', '1d'),
    getHistory('ES=F', '1y', '1d'),
  ]);
  const dateKey = iso => iso.slice(0, 10);
  const retMap = candles => {
    const m = {};
    for (let i = 1; i < candles.length; i++) m[dateKey(candles[i].date)] = (candles[i].close - candles[i - 1].close) / candles[i - 1].close;
    return m;
  };
  const usdinrRet = retMap(usdinr.candles), goldRet = retMap(gold.candles), globalRet = retMap(global_.candles);

  const candles = nifty.candles;
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume || 0);
  const rsi = rsiSeries(closes, 14);
  const ema12 = emaSeries(closes, 12), ema26 = emaSeries(closes, 26);
  const macdLine = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null);
  const macdSignalArr = emaSeries(macdLine.filter(v => v != null), 9);
  let sigPtr = 0; const macdSignal = macdLine.map(v => { if (v == null) return null; return macdSignalArr[sigPtr++] ?? null; });

  const rows = [];
  const WARMUP = 26;
  for (let i = WARMUP; i < candles.length - 5; i++) {
    const dk = dateKey(candles[i].date);
    if (!(dk in usdinrRet) || !(dk in goldRet) || !(dk in globalRet)) continue; // honest inner join - no fabricated cross-asset values
    if (rsi[i] == null || macdLine[i] == null || macdSignal[i] == null) continue;

    const trailingRets = []; for (let k = i - 9; k <= i; k++) trailingRets.push((closes[k] - closes[k - 1]) / closes[k - 1]);
    const vol10 = Q.std(trailingRets) * Math.sqrt(252);
    const ma5 = smaAt(closes, 5, i), ma20 = smaAt(closes, 20, i);
    const volWindow = volumes.slice(Math.max(0, i - 19), i + 1);
    const volZ = volWindow.length > 1 ? (volumes[i] - Q.mean(volWindow)) / (Q.std(volWindow) || 1) : 0;
    const ret5 = (closes[i] - closes[i - 5]) / closes[i - 5];
    const fwdRets = []; for (let k = i + 1; k <= i + 5; k++) fwdRets.push((closes[k] - closes[k - 1]) / closes[k - 1]);
    const fwdVol5d = Q.std(fwdRets) * Math.sqrt(252);

    rows.push({
      date: dk,
      x: [(closes[i] - closes[i - 1]) / closes[i - 1], vol10, (rsi[i] - 50) / 50, macdLine[i] - macdSignal[i], (ma5 - ma20) / ma20, volZ, usdinrRet[dk], goldRet[dk], globalRet[dk]],
      ret5, vol10, fwdVol5d, price: closes[i],
    });
  }
  if (rows.length < 60) {
    throw new Error(`Not enough aligned history to train the regime model (only ${rows.length} days usable after aligning NIFTY with USD/INR, gold, and global futures - need at least 60). This improves as more trading days accumulate.`);
  }
  const sortedVol = [...rows.map(r => r.vol10)].sort((a, b) => a - b);
  const percentileOf = v => sortedVol.filter(x => x <= v).length / sortedVol.length;
  const y = rows.map(r => labelRow(r, percentileOf(r.vol10)));
  const X = rows.map(r => r.x);
  const presentClasses = REGIME_CLASSES.filter(c => y.includes(c));
  return { rows, X, y, presentClasses, candleCount: candles.length, percentileOf };
}

export async function computeMarketRegimeIntelligence() {
  const { rows, X, y, presentClasses, candleCount, percentileOf } = await prepareTrainingData();

  const trainLogistic = (Xt, yt) => {
    const sc = Q.computeStandardizer(Xt);
    return { sc, ovr: Q.trainOneVsRest(Q.applyStandardizer(Xt, sc), yt, presentClasses, { epochs: 250, lr: 0.4 }) };
  };
  const predictLogistic = (row, model) => Q.predictOneVsRest(Q.applyStandardizerRow(row, model.sc), model.ovr).predicted;
  const trainRF = (Xt, yt) => Q.buildForest(Xt, yt, { nTrees: 25, maxDepth: 4, minLeaf: 4, task: 'classification' });
  const predictRF = (row, model) => Q.predictForest(row, model).predicted;

  const wfLogistic = Q.walkForwardValidate(X, y, { folds: 4, minTrainFrac: 0.45, task: 'classification', trainFn: trainLogistic, predictFn: predictLogistic });
  const wfRF = Q.walkForwardValidate(X, y, { folds: 4, minTrainFrac: 0.45, task: 'classification', trainFn: trainRF, predictFn: predictRF });

  const finalLogistic = trainLogistic(X, y);
  const finalRF = trainRF(X, y);
  const latestX = X[X.length - 1];
  const liveLogistic = Q.predictOneVsRest(Q.applyStandardizerRow(latestX, finalLogistic.sc), finalLogistic.ovr);
  const liveRF = Q.predictForest(latestX, finalRF);
  const attribution = Q.linearAttribution(Q.applyStandardizerRow(latestX, finalLogistic.sc), finalLogistic.ovr.models[liveLogistic.predicted], FEATURE_NAMES);

  const closesForRet = rows.map(r => r.price);
  const dailyReturns = closesForRet.slice(1).map((c, i) => (c - closesForRet[i]) / closesForRet[i]);
  const fwdVolTargets = rows.map(r => r.fwdVol5d);
  const volCompare = walkForwardVolCompare(dailyReturns, fwdVolTargets, X);
  const finalGarch = Q.garch11Fit(dailyReturns);
  const finalRFVol = Q.buildForest(X, fwdVolTargets, { nTrees: 20, maxDepth: 4, task: 'regression' });
  const currentVolForecasts = {
    baseline: Q.baselineVol(dailyReturns), ewma: Q.ewmaVol(dailyReturns),
    garch: finalGarch ? Q.garch11ForecastVol(finalGarch) : null,
    randomForest: Q.predictForest(latestX, finalRFVol).predicted,
  };
  const volMethodMAEs = { baseline: volCompare.baselineMAE, ewma: volCompare.ewmaMAE, garch: volCompare.garchMAE, randomForest: volCompare.rfMAE };
  const bestVolMethod = Object.entries(volMethodMAEs).filter(([, v]) => v != null).sort((a, b) => a[1] - b[1])[0]?.[0] || 'ewma';
  const recommendedVolForecast = currentVolForecasts[bestVolMethod];
  const volPctile = percentileOf(recommendedVolForecast != null ? recommendedVolForecast : Q.mean(rows.map(r => r.vol10)));
  const volLabel = volPctile > 0.7 ? 'High' : volPctile > 0.35 ? 'Medium' : 'Low';

  const anomalyWindow = rows.slice(-90);
  const anomalyX = anomalyWindow.map(r => r.x);
  const isoForest = Q.buildIsolationForest(anomalyX, { nTrees: 60, sampleSize: Math.min(64, anomalyX.length) });
  const latestAnomalyScore = Q.isolationScore(anomalyX[anomalyX.length - 1], isoForest);
  const anomalyThreshold = 0.62;
  const isAnomalous = latestAnomalyScore > anomalyThreshold;
  const abnormalFeatures = [];
  if (isAnomalous) {
    FEATURE_NAMES.forEach((name, j) => {
      const col = anomalyX.map(r => r[j]);
      const m = Q.mean(col), s = Q.std(col) || 1;
      const z = (latestX[j] - m) / s;
      if (Math.abs(z) > 1.8) abnormalFeatures.push({ feature: name, zScore: z });
    });
    abnormalFeatures.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  }

  const recommendedModel = wfRF.overallAccuracy > wfLogistic.overallAccuracy + 0.03 ? 'randomForest' : 'logistic';

  return {
    dataPoints: rows.length, candlesFetched: candleCount,
    regime: {
      current: liveLogistic.predicted, probability: liveLogistic.probs[liveLogistic.predicted],
      topDrivers: attribution.slice(0, 4),
      comparison: {
        logistic: { walkForwardAccuracy: wfLogistic.overallAccuracy, livePredicted: liveLogistic.predicted, liveProbability: liveLogistic.probs[liveLogistic.predicted] },
        randomForest: { walkForwardAccuracy: wfRF.overallAccuracy, livePredicted: liveRF.predicted, liveProbability: liveRF.probs[liveRF.predicted] },
        recommendedModel,
        note: recommendedModel === 'randomForest'
          ? 'Random Forest generalized meaningfully better out-of-sample (walk-forward), but the regime/probability above uses logistic regression because its feature attribution is exact and explainable - RF is more of a black box here.'
          : 'Logistic regression matched or beat Random Forest out-of-sample here, so the explainable model is also the more accurate one in this run.',
      },
    },
    volatility: { currentForecast: recommendedVolForecast, label: volLabel, bestMethod: bestVolMethod, allForecasts: currentVolForecasts, walkForwardMAE: volMethodMAEs },
    anomaly: { detected: isAnomalous, score: latestAnomalyScore, threshold: anomalyThreshold, abnormalFeatures },
    methodology: {
      classesUsed: presentClasses, walkForwardFolds: wfLogistic.folds.length,
      note: 'Logistic regression and Random Forest are implemented from scratch in this backend (no sklearn/XGBoost available in this Node environment). GARCH(1,1) is fit via grid-search MLE, not a full quasi-Newton optimizer. Feature attribution is exact for the logistic model (mathematically equivalent to SHAP for a linear model). Regime labels used for training are derived from a rule-based heuristic on trailing volatility/return (weak supervision), not hand-labeled ground truth.',
    },
  };
}

function walkForwardVolCompare(returns, targetVol5d, X, folds = 4, minTrainFrac = 0.45) {
  const n = returns.length;
  const minTrain = Math.floor(n * minTrainFrac);
  const stepSize = Math.max(1, Math.floor((n - minTrain) / folds));
  const errors = { baseline: [], ewma: [], garch: [], rf: [] };
  let trainEnd = minTrain;
  while (trainEnd < n) {
    const testEnd = Math.min(n, trainEnd + stepSize);
    if (testEnd <= trainEnd) break;
    const trainReturns = returns.slice(0, trainEnd);
    const baselineForecast = Q.baselineVol(trainReturns);
    const ewmaForecast = Q.ewmaVol(trainReturns);
    const garchParams = Q.garch11Fit(trainReturns);
    const garchForecast = garchParams ? Q.garch11ForecastVol(garchParams) : baselineForecast;
    const rfModel = Q.buildForest(X.slice(0, trainEnd), targetVol5d.slice(0, trainEnd), { nTrees: 15, maxDepth: 4, task: 'regression' });
    for (let i = trainEnd; i < testEnd && i < targetVol5d.length; i++) {
      const actual = targetVol5d[i];
      errors.baseline.push(Math.abs(baselineForecast - actual));
      errors.ewma.push(Math.abs(ewmaForecast - actual));
      errors.garch.push(Math.abs(garchForecast - actual));
      errors.rf.push(Math.abs(Q.predictForest(X[i], rfModel).predicted - actual));
    }
    trainEnd = testEnd;
  }
  const mae = k => (errors[k].length ? Q.mean(errors[k]) : null);
  return { baselineMAE: mae('baseline'), ewmaMAE: mae('ewma'), garchMAE: mae('garch'), rfMAE: mae('rf') };
}

/**
 * Model comparison table: Naive baseline, Logistic Regression, Neural Network,
 * and Gradient Boosting (XGBoost-style boosting), evaluated walk-forward with
 * pooled out-of-sample predictions, reporting Accuracy/Precision/Recall/F1/ROC-AUC.
 */
export async function compareRegimeModels() {
  const { X, y, presentClasses } = await prepareTrainingData();
  const n = X.length;
  const minTrain = Math.floor(n * 0.45);
  const stepSize = Math.max(1, Math.floor((n - minTrain) / 4));
  const pooled = { naive: [], logistic: [], nn: [], gb: [] };
  let trainEnd = minTrain;
  while (trainEnd < n) {
    const testEnd = Math.min(n, trainEnd + stepSize);
    if (testEnd <= trainEnd) break;
    const Xtrain = X.slice(0, trainEnd), ytrain = y.slice(0, trainEnd);
    const Xtest = X.slice(trainEnd, testEnd), ytest = y.slice(trainEnd, testEnd);

    const freq = {}; ytrain.forEach(l => { freq[l] = (freq[l] || 0) + 1; });
    const naiveProbs = {}; presentClasses.forEach(c => { naiveProbs[c] = (freq[c] || 0) / ytrain.length; });
    let naiveBest = null, nb = -1; presentClasses.forEach(c => { if (naiveProbs[c] > nb) { nb = naiveProbs[c]; naiveBest = c; } });

    const sc = Q.computeStandardizer(Xtrain);
    const XtrainS = Q.applyStandardizer(Xtrain, sc);
    const ovr = Q.trainOneVsRest(XtrainS, ytrain, presentClasses, { epochs: 250, lr: 0.4 });
    const nn = Q.trainNeuralNet(XtrainS, ytrain, presentClasses, { hiddenUnits: 10, epochs: 150, lr: 0.08 });
    const gb = Q.trainGBOneVsRest(Xtrain, ytrain, presentClasses, { nRounds: 30, lr: 0.15, maxDepth: 3, minLeaf: 4 });

    for (let i = 0; i < Xtest.length; i++) {
      const row = Xtest[i], rowS = Q.applyStandardizerRow(row, sc), actual = ytest[i];
      pooled.naive.push({ actual, predicted: naiveBest, probs: naiveProbs });
      const lp = Q.predictOneVsRest(rowS, ovr); pooled.logistic.push({ actual, predicted: lp.predicted, probs: lp.probs });
      const np = Q.predictNeuralNet(rowS, nn); pooled.nn.push({ actual, predicted: np.predicted, probs: np.probs });
      const gp = Q.predictGBOneVsRest(row, gb); pooled.gb.push({ actual, predicted: gp.predicted, probs: gp.probs });
    }
    trainEnd = testEnd;
  }
  const summarize = arr => Q.classificationMetrics(arr.map(x => x.actual), arr.map(x => x.predicted), arr.map(x => x.probs), presentClasses);
  return {
    testSamples: pooled.naive.length, classesUsed: presentClasses,
    models: {
      Naive: summarize(pooled.naive),
      Logistic: summarize(pooled.logistic),
      NN: summarize(pooled.nn),
      'Gradient Boosting': summarize(pooled.gb),
    },
    note: 'All four models are evaluated on the SAME pooled out-of-sample (walk-forward) predictions for a fair comparison - none of these numbers come from training-set accuracy. "Gradient Boosting" here is a from-scratch implementation of the core boosting algorithm XGBoost uses (sequential shallow trees fit to residuals), not the xgboost library itself.',
  };
}
