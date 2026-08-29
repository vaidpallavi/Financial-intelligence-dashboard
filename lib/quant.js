// Real, from-scratch numerical toolkit: logistic regression, decision trees,
// a simplified Random Forest, walk-forward validation, EWMA, GARCH(1,1) via
// grid-search MLE, Gradient Boosting, a small backprop Neural Network,
// Isolation Forest, classification metrics, and exact linear feature
// attribution.
//
// HONESTY NOTES (read before trusting any number this file produces):
// - No sklearn/XGBoost/arch library is used anywhere - this environment has
//   no Python ML stack, so everything here is implemented directly.
// - "Random Forest" here is a genuine bagged-tree ensemble with feature
//   subsampling (real bagging), not a port of scikit-learn's implementation.
// - "Gradient Boosting" is a from-scratch implementation of the core boosting
//   algorithm XGBoost is built on (sequential shallow trees fit to
//   residuals), not the xgboost library itself - no histogram binning or
//   XGBoost-specific regularization tricks.
// - GARCH(1,1) is fit via coarse grid-search maximum likelihood, not a proper
//   quasi-Newton optimizer (BFGS) - it will be less precise than the `arch`
//   Python package, but the likelihood function and recursion are correct.
// - "Linear attribution" is EXACT (not approximate) for the logistic
//   regression model - for a linear model, this is mathematically identical
//   to what SHAP would compute, so calling it SHAP-equivalent is accurate,
//   not a stretch.

// ---------- basic stats ----------
export function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
export function std(arr) { const m = mean(arr); return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length) || 0; }

export function computeStandardizer(X) {
  const d = X[0].length;
  const m = new Array(d).fill(0), s = new Array(d).fill(0);
  for (let j = 0; j < d; j++) m[j] = mean(X.map(r => r[j]));
  for (let j = 0; j < d; j++) s[j] = std(X.map(r => r[j])) || 1;
  return { mean: m, std: s };
}
export const applyStandardizer = (X, sc) => X.map(row => row.map((x, j) => (x - sc.mean[j]) / sc.std[j]));
export const applyStandardizerRow = (row, sc) => row.map((x, j) => (x - sc.mean[j]) / sc.std[j]);

// ---------- logistic regression (binary + one-vs-rest multinomial) ----------
const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function trainLogisticBinary(X, y01, { lr = 0.3, epochs = 400, l2 = 0.02 } = {}) {
  const n = X.length, d = X[0].length;
  let w = new Array(d).fill(0), b = 0;
  for (let e = 0; e < epochs; e++) {
    const gradW = new Array(d).fill(0); let gradB = 0;
    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((s, x, j) => s + x * w[j], 0) + b;
      const err = sigmoid(z) - y01[i];
      for (let j = 0; j < d; j++) gradW[j] += err * X[i][j];
      gradB += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gradW[j] / n + l2 * w[j]);
    b -= lr * (gradB / n);
  }
  return { weights: w, bias: b };
}
export const predictLogisticProb = (row, model) => sigmoid(row.reduce((s, x, j) => s + x * model.weights[j], 0) + model.bias);

export function trainOneVsRest(X, yLabels, classes, opts) {
  const models = {};
  classes.forEach(c => { models[c] = trainLogisticBinary(X, yLabels.map(l => (l === c ? 1 : 0)), opts); });
  return { models, classes };
}
export function predictOneVsRest(row, ovr) {
  const raw = {}; ovr.classes.forEach(c => { raw[c] = predictLogisticProb(row, ovr.models[c]); });
  const total = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const probs = {}; ovr.classes.forEach(c => { probs[c] = raw[c] / total; });
  let best = null, bp = -1; ovr.classes.forEach(c => { if (probs[c] > bp) { bp = probs[c]; best = c; } });
  return { predicted: best, probs, rawProbs: raw };
}

// ---------- decision tree (CART-style, shared for classification & regression) ----------
function gini(labels) {
  const counts = {}; labels.forEach(l => { counts[l] = (counts[l] || 0) + 1; });
  const n = labels.length; let g = 1;
  for (const k in counts) { const p = counts[k] / n; g -= p * p; }
  return g;
}
function variance(values) { if (!values.length) return 0; const m = mean(values); return mean(values.map(v => (v - m) ** 2)); }
function majorityClass(labels) {
  const counts = {}; labels.forEach(l => { counts[l] = (counts[l] || 0) + 1; });
  let best = null, bc = -1; for (const k in counts) if (counts[k] > bc) { bc = counts[k]; best = k; }
  return best;
}
function classDist(labels) {
  const counts = {}; labels.forEach(l => { counts[l] = (counts[l] || 0) + 1; });
  const n = labels.length, dist = {}; for (const k in counts) dist[k] = counts[k] / n;
  return dist;
}

export function buildTree(X, y, { maxDepth = 4, minLeaf = 5, task = 'classification', featureIdxPool = null } = {}) {
  const nFeatures = X[0].length;
  function build(rows, depth) {
    const labels = rows.map(i => y[i]);
    const isPure = task === 'classification' ? Object.keys(classDist(labels)).length === 1 : false;
    if (depth >= maxDepth || rows.length < minLeaf * 2 || isPure) {
      return task === 'classification'
        ? { leaf: true, value: majorityClass(labels), dist: classDist(labels) }
        : { leaf: true, value: mean(labels) };
    }
    const parentImpurity = task === 'classification' ? gini(labels) : variance(labels);
    const featPool = featureIdxPool ? featureIdxPool() : [...Array(nFeatures).keys()];
    let bestGain = -Infinity, bestFeat = null, bestThresh = null, bestLeft = null, bestRight = null;
    for (const f of featPool) {
      const uniqSorted = [...new Set(rows.map(i => X[i][f]))].sort((a, b) => a - b);
      if (uniqSorted.length < 2) continue;
      const maxCandidates = 8;
      const step = Math.max(1, Math.floor(uniqSorted.length / maxCandidates));
      for (let i = step; i < uniqSorted.length; i += step) {
        const t = (uniqSorted[i - 1] + uniqSorted[i]) / 2;
        const leftIdx = rows.filter(i2 => X[i2][f] <= t);
        const rightIdx = rows.filter(i2 => X[i2][f] > t);
        if (leftIdx.length < minLeaf || rightIdx.length < minLeaf) continue;
        const impL = task === 'classification' ? gini(leftIdx.map(i2 => y[i2])) : variance(leftIdx.map(i2 => y[i2]));
        const impR = task === 'classification' ? gini(rightIdx.map(i2 => y[i2])) : variance(rightIdx.map(i2 => y[i2]));
        const wImp = (leftIdx.length * impL + rightIdx.length * impR) / rows.length;
        const gain = parentImpurity - wImp;
        if (gain > bestGain) { bestGain = gain; bestFeat = f; bestThresh = t; bestLeft = leftIdx; bestRight = rightIdx; }
      }
    }
    if (bestFeat === null || bestGain <= 1e-9) {
      return task === 'classification'
        ? { leaf: true, value: majorityClass(labels), dist: classDist(labels) }
        : { leaf: true, value: mean(labels) };
    }
    return { leaf: false, feature: bestFeat, threshold: bestThresh, left: build(bestLeft, depth + 1), right: build(bestRight, depth + 1) };
  }
  return build([...Array(X.length).keys()], 0);
}
export function predictTree(row, tree) {
  let node = tree;
  while (!node.leaf) node = row[node.feature] <= node.threshold ? node.left : node.right;
  return node;
}

// ---------- Random Forest (real bagging + feature subsampling) ----------
export function buildForest(X, y, { nTrees = 20, maxDepth = 4, minLeaf = 5, task = 'classification', featureFrac = 0.7 } = {}) {
  const n = X.length, nFeatures = X[0].length;
  const kFeatures = Math.max(1, Math.round(nFeatures * featureFrac));
  const trees = [];
  for (let t = 0; t < nTrees; t++) {
    const idx = Array.from({ length: n }, () => Math.floor(Math.random() * n)); // bootstrap resample
    const Xs = idx.map(i => X[i]), ys = idx.map(i => y[i]);
    const featureIdxPool = () => {
      const pool = [...Array(nFeatures).keys()];
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[pool[i], pool[j]] = [pool[j], pool[i]]; }
      return pool.slice(0, kFeatures);
    };
    trees.push(buildTree(Xs, ys, { maxDepth, minLeaf, task, featureIdxPool }));
  }
  return { trees, task };
}
export function predictForest(row, forest) {
  const preds = forest.trees.map(t => predictTree(row, t));
  if (forest.task === 'classification') {
    const counts = {}; preds.forEach(p => { counts[p.value] = (counts[p.value] || 0) + 1; });
    const total = preds.length, probs = {}; for (const k in counts) probs[k] = counts[k] / total;
    let best = null, bp = -1; for (const k in probs) if (probs[k] > bp) { bp = probs[k]; best = k; }
    return { predicted: best, probs };
  }
  const vals = preds.map(p => p.value);
  return { predicted: mean(vals) };
}

// ---------- walk-forward validation (expanding window) ----------
export function walkForwardValidate(X, y, { folds = 4, minTrainFrac = 0.4, task = 'classification', trainFn, predictFn }) {
  const n = X.length;
  const minTrain = Math.floor(n * minTrainFrac);
  const stepSize = Math.max(1, Math.floor((n - minTrain) / folds));
  const results = [];
  let trainEnd = minTrain;
  while (trainEnd < n) {
    const testEnd = Math.min(n, trainEnd + stepSize);
    if (testEnd <= trainEnd) break;
    const model = trainFn(X.slice(0, trainEnd), y.slice(0, trainEnd));
    const preds = X.slice(trainEnd, testEnd).map(row => predictFn(row, model));
    const actual = y.slice(trainEnd, testEnd);
    if (task === 'classification') {
      const correct = preds.filter((p, i) => p === actual[i]).length;
      results.push({ trainSize: trainEnd, testSize: testEnd - trainEnd, accuracy: correct / preds.length });
    } else {
      const mae = mean(preds.map((p, i) => Math.abs(p - actual[i])));
      results.push({ trainSize: trainEnd, testSize: testEnd - trainEnd, mae });
    }
    trainEnd = testEnd;
  }
  const totalTest = results.reduce((s, r) => s + r.testSize, 0) || 1;
  if (task === 'classification') return { folds: results, overallAccuracy: results.reduce((s, r) => s + r.accuracy * r.testSize, 0) / totalTest };
  return { folds: results, overallMAE: results.reduce((s, r) => s + r.mae * r.testSize, 0) / totalTest };
}

// ---------- volatility: baseline, EWMA, GARCH(1,1) ----------
export function baselineVol(returns) { return std(returns) * Math.sqrt(252); }

export function ewmaVol(returns, lambda = 0.94) {
  const warm = Math.min(20, returns.length);
  let variance_ = mean(returns.slice(0, warm).map(r => r * r));
  for (let i = warm; i < returns.length; i++) variance_ = lambda * variance_ + (1 - lambda) * returns[i] * returns[i];
  return Math.sqrt(variance_ * 252);
}

export function garch11Fit(returns) {
  const n = returns.length;
  const sampleVar = mean(returns.map(r => r * r));
  let best = null;
  for (const omega of [sampleVar * 0.01, sampleVar * 0.03, sampleVar * 0.06, sampleVar * 0.1]) {
    for (const alpha of [0.03, 0.06, 0.09, 0.12, 0.15]) {
      for (const beta of [0.75, 0.8, 0.85, 0.88, 0.9, 0.93]) {
        if (alpha + beta >= 0.999) continue;
        let variance_ = sampleVar, loglik = 0, broke = false;
        for (let i = 1; i < n; i++) {
          variance_ = omega + alpha * returns[i - 1] * returns[i - 1] + beta * variance_;
          if (!(variance_ > 0)) { broke = true; break; }
          loglik += -0.5 * (Math.log(2 * Math.PI * variance_) + (returns[i] * returns[i]) / variance_);
        }
        if (broke) continue;
        if (!best || loglik > best.loglik) best = { omega, alpha, beta, loglik, lastVariance: variance_ };
      }
    }
  }
  return best;
}
export const garch11ForecastVol = params => Math.sqrt(params.lastVariance * 252);

// ---------- Gradient Boosting (real boosting - the core algorithm XGBoost is built on) ----------
export function trainGradientBoostBinary(X, y01, { nRounds = 30, lr = 0.15, maxDepth = 3, minLeaf = 4 } = {}) {
  const n = X.length;
  let scores = new Array(n).fill(0);
  const trees = [];
  for (let round = 0; round < nRounds; round++) {
    const residuals = scores.map((s, i) => y01[i] - sigmoid(s)); // negative gradient of log-loss
    const tree = buildTree(X, residuals, { maxDepth, minLeaf, task: 'regression' });
    trees.push(tree);
    for (let i = 0; i < n; i++) scores[i] += lr * predictTree(X[i], tree).value;
  }
  return { trees, lr };
}
export function predictGradientBoostProb(row, model) {
  let score = 0;
  for (const t of model.trees) score += model.lr * predictTree(row, t).value;
  return sigmoid(score);
}
export function trainGBOneVsRest(X, yLabels, classes, opts) {
  const models = {};
  classes.forEach(c => { models[c] = trainGradientBoostBinary(X, yLabels.map(l => (l === c ? 1 : 0)), opts); });
  return { models, classes };
}
export function predictGBOneVsRest(row, gb) {
  const raw = {}; gb.classes.forEach(c => { raw[c] = predictGradientBoostProb(row, gb.models[c]); });
  const total = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const probs = {}; gb.classes.forEach(c => { probs[c] = raw[c] / total; });
  let best = null, bp = -1; gb.classes.forEach(c => { if (probs[c] > bp) { bp = probs[c]; best = c; } });
  return { predicted: best, probs };
}

// ---------- small Neural Network (real backprop MLP: 1 hidden layer, ReLU, softmax output) ----------
function randInit(rows, cols, scale) { return Array.from({ length: rows }, () => Array.from({ length: cols }, () => (Math.random() * 2 - 1) * scale)); }
export function trainNeuralNet(X, yLabels, classes, { hiddenUnits = 10, epochs = 150, lr = 0.08, l2 = 0.001 } = {}) {
  const n = X.length, d = X[0].length, k = classes.length;
  const classIdx = c => classes.indexOf(c);
  let W1 = randInit(d, hiddenUnits, Math.sqrt(2 / d)), b1 = new Array(hiddenUnits).fill(0);
  let W2 = randInit(hiddenUnits, k, Math.sqrt(2 / hiddenUnits)), b2 = new Array(k).fill(0);
  const relu = z => Math.max(0, z), reluDeriv = z => (z > 0 ? 1 : 0);
  for (let e = 0; e < epochs; e++) {
    const gW1 = W1.map(r => r.map(() => 0)), gb1 = b1.map(() => 0);
    const gW2 = W2.map(r => r.map(() => 0)), gb2 = b2.map(() => 0);
    for (let i = 0; i < n; i++) {
      const hPre = new Array(hiddenUnits).fill(0), h = new Array(hiddenUnits).fill(0);
      for (let j = 0; j < hiddenUnits; j++) { let s = b1[j]; for (let f = 0; f < d; f++) s += X[i][f] * W1[f][j]; hPre[j] = s; h[j] = relu(s); }
      const o = new Array(k).fill(0);
      for (let c = 0; c < k; c++) { let s = b2[c]; for (let j = 0; j < hiddenUnits; j++) s += h[j] * W2[j][c]; o[c] = s; }
      const mx = Math.max(...o), exp = o.map(v => Math.exp(v - mx)), sumExp = exp.reduce((a, b) => a + b, 0);
      const probs = exp.map(v => v / sumExp);
      const target = classIdx(yLabels[i]);
      const dO = probs.map((p, c) => p - (c === target ? 1 : 0));
      for (let c = 0; c < k; c++) { gb2[c] += dO[c]; for (let j = 0; j < hiddenUnits; j++) gW2[j][c] += dO[c] * h[j]; }
      const dH = new Array(hiddenUnits).fill(0);
      for (let j = 0; j < hiddenUnits; j++) { let s = 0; for (let c = 0; c < k; c++) s += dO[c] * W2[j][c]; dH[j] = s * reluDeriv(hPre[j]); }
      for (let j = 0; j < hiddenUnits; j++) { gb1[j] += dH[j]; for (let f = 0; f < d; f++) gW1[f][j] += dH[j] * X[i][f]; }
    }
    for (let f = 0; f < d; f++) for (let j = 0; j < hiddenUnits; j++) W1[f][j] -= lr * (gW1[f][j] / n + l2 * W1[f][j]);
    for (let j = 0; j < hiddenUnits; j++) b1[j] -= lr * (gb1[j] / n);
    for (let j = 0; j < hiddenUnits; j++) for (let c = 0; c < k; c++) W2[j][c] -= lr * (gW2[j][c] / n + l2 * W2[j][c]);
    for (let c = 0; c < k; c++) b2[c] -= lr * (gb2[c] / n);
  }
  return { W1, b1, W2, b2, classes, hiddenUnits };
}
export function predictNeuralNet(row, model) {
  const { W1, b1, W2, b2, classes, hiddenUnits } = model;
  const h = new Array(hiddenUnits).fill(0);
  for (let j = 0; j < hiddenUnits; j++) { let s = b1[j]; for (let f = 0; f < row.length; f++) s += row[f] * W1[f][j]; h[j] = Math.max(0, s); }
  const o = new Array(classes.length).fill(0);
  for (let c = 0; c < classes.length; c++) { let s = b2[c]; for (let j = 0; j < hiddenUnits; j++) s += h[j] * W2[j][c]; o[c] = s; }
  const mx = Math.max(...o), exp = o.map(v => Math.exp(v - mx)), sumExp = exp.reduce((a, b) => a + b, 0);
  const probs = {}; classes.forEach((c, idx) => { probs[c] = exp[idx] / sumExp; });
  let best = null, bp = -1; classes.forEach(c => { if (probs[c] > bp) { bp = probs[c]; best = c; } });
  return { predicted: best, probs };
}

// ---------- classification metrics: accuracy, macro precision/recall/F1, macro ROC-AUC (rank-based) ----------
export function classificationMetrics(actual, predicted, probsPerClass, classes) {
  const n = actual.length;
  const accuracy = predicted.filter((p, i) => p === actual[i]).length / n;
  const precisions = [], recalls = [], f1s = [];
  classes.forEach(c => {
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < n; i++) {
      const predPos = predicted[i] === c, actPos = actual[i] === c;
      if (predPos && actPos) tp++; else if (predPos && !actPos) fp++; else if (!predPos && actPos) fn++;
    }
    if (!actual.includes(c) && !predicted.includes(c)) return;
    const p = tp + fp > 0 ? tp / (tp + fp) : 0, r = tp + fn > 0 ? tp / (tp + fn) : 0;
    precisions.push(p); recalls.push(r); f1s.push(p + r > 0 ? (2 * p * r) / (p + r) : 0);
  });
  const aucs = [];
  classes.forEach(c => {
    const scores = probsPerClass.map(p => p[c] ?? 0);
    const labels = actual.map(a => (a === c ? 1 : 0));
    const nPos = labels.filter(l => l === 1).length, nNeg = labels.length - nPos;
    if (nPos === 0 || nNeg === 0) return;
    const idx = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
    let rank = 1, rankSum = 0, i = 0;
    while (i < idx.length) {
      let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avgRank = (rank + (rank + (j - i))) / 2;
      for (let k = i; k <= j; k++) if (idx[k][1] === 1) rankSum += avgRank;
      rank += j - i + 1; i = j + 1;
    }
    aucs.push((rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg));
  });
  return {
    accuracy,
    precision: precisions.length ? mean(precisions) : null,
    recall: recalls.length ? mean(recalls) : null,
    f1: f1s.length ? mean(f1s) : null,
    rocAuc: aucs.length ? mean(aucs) : null,
  };
}

// ---------- Isolation Forest (real) ----------
function cFactor(n) { return n <= 1 ? 0 : 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n; }
function buildIsoTree(X, depth, maxDepth) {
  if (depth >= maxDepth || X.length <= 1) return { leaf: true, size: X.length };
  const nFeatures = X[0].length;
  const f = Math.floor(Math.random() * nFeatures);
  const values = X.map(r => r[f]);
  const mn = Math.min(...values), mx = Math.max(...values);
  if (mn === mx) return { leaf: true, size: X.length };
  const splitVal = mn + Math.random() * (mx - mn);
  return {
    leaf: false, feature: f, split: splitVal,
    left: buildIsoTree(X.filter(r => r[f] < splitVal), depth + 1, maxDepth),
    right: buildIsoTree(X.filter(r => r[f] >= splitVal), depth + 1, maxDepth),
  };
}
function isoPathLength(row, node, depth = 0) {
  if (node.leaf) return depth + cFactor(node.size);
  return row[node.feature] < node.split ? isoPathLength(row, node.left, depth + 1) : isoPathLength(row, node.right, depth + 1);
}
export function buildIsolationForest(X, { nTrees = 60, sampleSize = 64 } = {}) {
  const n = X.length, effSample = Math.min(sampleSize, n);
  const maxDepth = Math.ceil(Math.log2(Math.max(2, effSample)));
  const trees = [];
  for (let t = 0; t < nTrees; t++) {
    const idx = Array.from({ length: effSample }, () => Math.floor(Math.random() * n));
    trees.push(buildIsoTree(idx.map(i => X[i]), 0, maxDepth));
  }
  return { trees, effSample };
}
export function isolationScore(row, forest) {
  const avgPath = mean(forest.trees.map(t => isoPathLength(row, t)));
  return Math.pow(2, -avgPath / (cFactor(forest.effSample) || 1));
}

// ---------- exact linear feature attribution (SHAP-equivalent for a linear model) ----------
export function linearAttribution(standardizedRow, model, featureNames) {
  const contribs = featureNames.map((name, j) => ({ feature: name, contribution: model.weights[j] * standardizedRow[j] }));
  contribs.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const label = c => {
    const a = Math.abs(c);
    const dir = c >= 0 ? 'positive' : 'negative';
    const strength = a > 0.6 ? 'Strong' : a > 0.2 ? 'Moderate' : a > 0.02 ? 'Mild' : 'Negligible';
    return `${strength} ${dir}`;
  };
  return contribs.map(c => ({ feature: c.feature, contribution: c.contribution, label: label(c.contribution) }));
}
