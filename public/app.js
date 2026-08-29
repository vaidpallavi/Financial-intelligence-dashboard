'use strict';
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const fmt = n => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dlBlob = (filename, content, mime) => {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
};

let charts = {};
function chart(id) {
  if (!charts[id]) charts[id] = echarts.init(document.getElementById(id), 'dark');
  return charts[id];
}
window.addEventListener('resize', () => Object.values(charts).forEach(c => c.resize()));

// ---------------- Clock ----------------
function istMinutes() {
  const now = new Date();
  return (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440; // IST offset
}
function isIndiaMarketOpen() { const t = istMinutes(); return t >= 555 && t < 930; } // NSE/BSE equities: 9:15am-3:30pm IST
function isIndiaCommodityMarketOpen() { const t = istMinutes(); return t >= 540 && t < 1410; } // MCX commodities: ~9:00am-11:30pm IST
function tickClock() {
  const now = new Date();
  $('#clock').textContent = now.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Kolkata' });
  const t = istMinutes();
  $('#sessionState').textContent = isIndiaMarketOpen() ? 'NSE/BSE Open' : isIndiaCommodityMarketOpen() ? 'MCX Commodity Hours' : (t >= 1170 || t < 30) ? 'US markets active' : 'After hours';
}
setInterval(tickClock, 1000); tickClock();

// ---------------- Auth ----------------
$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});
async function fetchAuthed(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) { window.location.href = '/login.html'; throw new Error('Session expired'); }
  return res;
}

// ---------------- Market rendering ----------------
function mkiCard(item) {
  const up = (item.changePct ?? 0) >= 0;
  const asOfShort = item.asOf ? new Date(item.asOf).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;
  return `<div class="mki">
    <div class="sym">${escapeHtml(item.name || item.symbol)}</div>
    <div class="val">${fmt(item.price)}</div>
    <div class="chg ${up ? 'up' : 'dn'}">${item.changePct != null ? (up ? '▲' : '▼') + ' ' + item.changePct.toFixed(2) + '%' : '—'}</div>
    ${asOfShort ? `<div style="font-size:9px;color:var(--ink3);font-family:var(--mono)">as of ${asOfShort}</div>` : ''}
  </div>`;
}
function fillGrid(id, items) { $('#' + id).innerHTML = items.map(mkiCard).join(''); }
function pillHtml(label, stale) {
  return `<span class="pill ${stale ? 'stale' : 'live'}">${stale ? '⚠ stale — ' : '● live — '}${label}</span>`;
}
function errorCard(msg) {
  return `<div style="grid-column:1/-1;color:var(--red);font-size:12px;font-family:var(--mono)">⚠ ${escapeHtml(msg)}</div>`;
}

let latestSnapshot = null;

async function loadSnapshot() {
  $('#pills').innerHTML = `<span class="pill">Refreshing…</span>`;
  const res = await fetchAuthed('/api/markets/snapshot');
  const snap = await res.json();
  latestSnapshot = snap;

  if (!snap.india.error) { fillGrid('idxIndia', snap.india.items); fillGrid('bothIndia', snap.india.items.slice(0, 4)); }
  else { $('#idxIndia').innerHTML = errorCard(snap.india.error); $('#bothIndia').innerHTML = errorCard(snap.india.error); }

  if (!snap.global.error) { fillGrid('idxGlobal', snap.global.items); fillGrid('bothGlobal', snap.global.items.slice(0, 4)); }
  else { $('#idxGlobal').innerHTML = errorCard(snap.global.error); $('#bothGlobal').innerHTML = errorCard(snap.global.error); }

  if (!snap.bullion.error) {
    const b = snap.bullion;
    $('#bullionIndiaTbl').innerHTML = `<thead><tr><th>Form</th><th>Purity</th><th>Per</th><th>Rate (INR)</th><th>As of</th></tr></thead>
      <tbody>${b.rows.map(r => `<tr><td>${r.label}</td><td style="color:var(--ink3)">${r.purity}</td><td style="color:var(--ink3)">${r.per}</td><td style="color:var(--gold);font-weight:700">₹${fmt(r.inr)}</td><td style="color:var(--ink3);font-size:10px">${r.asOf ? new Date(r.asOf).toLocaleTimeString('en-IN') : '—'}</td></tr>`).join('')}</tbody>`;
    const srcNote = (b.basis.sources?.gold === 'stooq-fallback' || b.basis.sources?.silver === 'stooq-fallback') ? ' (Yahoo unavailable for one leg — used Stooq spot as fallback.)' : '';
    const goldAsOf = b.basis.asOf?.gold ? new Date(b.basis.asOf.gold).toLocaleTimeString('en-IN') : '—';
    $('#bullionBasis').innerHTML = `Live basis: gold $${b.basis.goldUsdOz.toFixed(2)}/oz (quote as of ${goldAsOf}) × USD/INR ₹${b.basis.usdinr.toFixed(2)} ÷ 31.1035 × 10, + ${b.basis.dutyGstPct}% duty/GST. Recomputed every refresh.${srcNote}<br>
      <span style="color:var(--ink3)">This is derived from COMEX gold futures + USD/INR, which trade almost continuously (~23h/day globally) — not tied to NSE/BSE equity hours. It will differ from MCX's own gold futures print, since MCX (India's commodity exchange) has no free public data feed — same category of gap as NSE F&amp;O, needs a paid vendor or broker API for exact parity.</span>`;
  } else {
    $('#bullionIndiaTbl').innerHTML = `<tr><td style="color:var(--red);font-family:var(--sans);padding:14px">⚠ ${escapeHtml(snap.bullion.error)}</td></tr>`;
    $('#bullionBasis').textContent = '';
  }

  if (!snap.commodities.error) {
    $('#commTbl').innerHTML = `<thead><tr><th>Contract</th><th>Unit</th><th>Price</th><th>Chg%</th></tr></thead>
      <tbody>${snap.commodities.items.map(c => `<tr><td>${c.name}${c.source==='stooq-fallback' ? ' <span class="hbdg" style="font-size:9px">stooq</span>' : ''}</td><td style="color:var(--ink3)">${c.unit}</td><td>$${fmt(c.price)}</td><td style="color:${c.changePct>=0?'var(--green)':c.changePct<0?'var(--red)':'var(--ink3)'}">${c.changePct!=null?c.changePct.toFixed(2)+'%':'—'}</td></tr>`).join('')}</tbody>`;
  } else {
    $('#commTbl').innerHTML = `<tr><td style="color:var(--red);font-family:var(--sans);padding:14px">⚠ ${escapeHtml(snap.commodities.error)}</td></tr>`;
  }

  if (!snap.fx.error) fillGrid('fxGrid', snap.fx.items.map(f => ({ name: f.name, price: f.price, changePct: f.changePct })));
  else $('#fxGrid').innerHTML = errorCard(snap.fx.error);

  if (!snap.crypto.error) {
    const inr = snap.crypto.items;
    fillGrid('cryptoIndia', inr.map(c => ({ name: c.symbol + '/INR', price: c.price, changePct: c.change24hPct })));
    fillGrid('cryptoGlobal', inr.map(c => ({ name: c.symbol, price: c.price, changePct: c.change24hPct })));
  } else {
    $('#cryptoIndia').innerHTML = errorCard(snap.crypto.error);
    $('#cryptoGlobal').innerHTML = errorCard(snap.crypto.error);
  }

  if (!snap.news.error && snap.news.items) renderNews(snap.news.items);
  else if (snap.news.error) $('#newsCard').innerHTML = `<p class="note" style="color:var(--red)">⚠ ${escapeHtml(snap.news.error)}</p>`;

  $('#pills').innerHTML = [
    pillHtml('Yahoo Finance + Stooq fallback', snap.india.stale || snap.commodities.stale),
    pillHtml('CoinGecko (crypto)', snap.crypto.stale),
    pillHtml('Frankfurter (FX table)', false),
    [snap.india, snap.global, snap.commodities, snap.bullion, snap.fx, snap.crypto].some(s => s.error) ? `<span class="pill stale">⚠ one or more feeds failed — see panel</span>` : '',
    `<span class="pill">as of ${new Date(snap.serverTime).toLocaleTimeString('en-IN')}</span>`,
  ].join('');

  buildBaseCharts();

  // The Morning Brief (Gold Momentum, Oil/WTI, NIFTY Bias, Global Cues, etc.)
  // reads from latestSnapshot, which this function just refreshed - but
  // renderMorningBrief() was previously only called once at page load and
  // after manually running an agent/regime/risk analysis, never inside the
  // automatic 15s/30s refresh loop. That meant those cells silently froze at
  // whatever they showed on first load even though live snapshot data kept
  // updating underneath. Recompute the brief every time a snapshot lands.
  renderMorningBrief();
}

function renderNews(items) {
  $('#newsCard').innerHTML = items.slice(0, 10).map(n => `
    <div style="padding:9px 0;border-bottom:1px solid var(--line)">
      <a href="${escapeHtml(n.link)}" target="_blank" rel="noopener" style="color:var(--ink);text-decoration:none;font-weight:600;font-size:12.5px">${escapeHtml(n.title)}</a>
      <div style="font-size:11px;color:var(--ink3);margin-top:3px">${escapeHtml(n.source)} · ${n.pubDate ? new Date(n.pubDate).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) : ''}</div>
    </div>`).join('');
}

// ---------------- Charts ----------------
async function buildBaseCharts() {
  drawCandle('chartNifty', '^NSEI');
  drawCandle('chartBtc', 'BTC-USD');
  drawGoldLine();
  loadNiftyFairValue();
  loadIndexFutures();
}
async function loadNiftyFairValue() {
  const el = $('#niftyFairValue'); if (!el) return;
  try {
    const res = await fetchAuthed('/api/markets/nifty-fair-value');
    const d = await res.json();
    if (d.error) { el.innerHTML = `<span style="color:var(--red)">⚠ ${escapeHtml(d.error)}</span>`; return; }
    const diff = d.fairValue - d.spot;
    el.innerHTML = `
      <div style="display:flex;gap:18px;flex-wrap:wrap">
        <div><div class="note">Spot</div><div style="font-family:var(--mono);font-weight:700;font-size:15px">${fmt(d.spot)}</div></div>
        <div><div class="note">Fair Value</div><div style="font-family:var(--mono);font-weight:700;font-size:15px;color:${diff>=0?'var(--green)':'var(--red)'}">${fmt(d.fairValue)}</div></div>
        <div><div class="note">Basis</div><div style="font-family:var(--mono);font-weight:700;font-size:15px">${diff>=0?'+':''}${diff.toFixed(2)}</div></div>
        <div><div class="note">Expiry (near-month)</div><div style="font-family:var(--mono);font-size:13px">${escapeHtml(d.expiryDate)} (${d.daysToExpiry}d)</div></div>
      </div>
      <p class="note" style="margin-top:8px">Theoretical cost-of-carry value using an assumed ${(d.assumedRate*100).toFixed(1)}% rate and ${(d.assumedDividendYield*100).toFixed(1)}% dividend yield — not the live traded NSE futures price (that needs a broker API integration; see README).</p>`;
  } catch (e) { el.innerHTML = `<span style="color:var(--red)">⚠ ${escapeHtml(e.message)}</span>`; }
}
async function loadIndexFutures() {
  try {
    const res = await fetchAuthed('/api/markets/index-futures');
    const d = await res.json();
    if (!d.error) fillGrid('indexFuturesGrid', d.items);
  } catch (e) { console.warn('index futures failed', e); }
}
async function drawCandle(elId, symbol) {
  try {
    const res = await fetchAuthed(`/api/markets/history?symbol=${encodeURIComponent(symbol)}&range=1mo&interval=1d`);
    const data = await res.json();
    if (data.error || !data.candles?.length) {
      document.getElementById(elId).innerHTML = `<div style="color:var(--red);font-size:12px;font-family:var(--mono);padding:12px">⚠ ${escapeHtml(data.error || 'No candle data returned')}</div>`;
      return;
    }
    const candles = data.candles;
    const ch = chart(elId);
    ch.setOption({
      backgroundColor: 'transparent',
      grid: { left: 55, right: 16, top: 16, bottom: 30 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: candles.map(c => new Date(c.date).toLocaleDateString('en-IN',{month:'short',day:'numeric'})), axisLabel: { color: '#5c6472', fontSize: 10 }, axisLine: { lineStyle: { color: '#232833' } } },
      yAxis: { scale: true, axisLabel: { color: '#5c6472', fontSize: 10 }, splitLine: { lineStyle: { color: '#1a1f29' } } },
      series: [{ type: 'candlestick', data: candles.map(c => [c.open, c.close, c.low, c.high]),
        itemStyle: { color: '#33c17f', color0: '#ef5350', borderColor: '#33c17f', borderColor0: '#ef5350' } }],
    });
  } catch (e) {
    console.warn('chart failed', symbol, e);
    const el = document.getElementById(elId);
    if (el) el.innerHTML = `<div style="color:var(--red);font-size:12px;font-family:var(--mono);padding:12px">⚠ ${escapeHtml(e.message)}</div>`;
  }
}
async function drawGoldLine() {
  try {
    const res = await fetchAuthed(`/api/markets/history?symbol=${encodeURIComponent('GC=F')}&range=1mo&interval=1d`);
    const data = await res.json();
    const el = document.getElementById('chartGoldLine');
    if (data.error || !data.candles?.length) { el.innerHTML = `<div style="color:var(--red);font-size:12px;font-family:var(--mono);padding:12px">⚠ ${escapeHtml(data.error || 'No data')}</div>`; return; }
    const ch = chart('chartGoldLine');
    ch.setOption({
      backgroundColor: 'transparent',
      grid: { left: 55, right: 16, top: 16, bottom: 30 },
      tooltip: { trigger: 'axis', formatter: p => `$${p[0].value.toFixed(2)}/oz` },
      xAxis: { type: 'category', data: data.candles.map(c => new Date(c.date).toLocaleDateString('en-IN',{month:'short',day:'numeric'})), axisLabel: { color: '#5c6472', fontSize: 10 } },
      yAxis: { scale: true, axisLabel: { color: '#5c6472', fontSize: 10, formatter: v => '$'+v }, splitLine: { lineStyle: { color: '#1a1f29' } } },
      series: [{ type: 'line', data: data.candles.map(c => c.close), smooth: true, symbol: 'none',
        lineStyle: { color: '#d4a537', width: 2 },
        areaStyle: { color: { type: 'linear', x:0,y:0,x2:0,y2:1, colorStops: [{offset:0,color:'rgba(212,165,55,.25)'},{offset:1,color:'rgba(212,165,55,0)'}] } } }],
    });
  } catch (e) { console.warn('gold line chart failed', e); }
}
function drawFlow(sectors, flows) {
  const ch = chart('chartFlow');
  ch.setOption({
    backgroundColor: 'transparent',
    grid: { left: 70, right: 30, top: 10, bottom: 20 },
    tooltip: { formatter: p => `${p[0].name}: ₹${p[0].value} Cr` },
    xAxis: { type: 'value', axisLabel: { color: '#5c6472', fontSize: 10 }, splitLine: { lineStyle: { color: '#1a1f29' } } },
    yAxis: { type: 'category', data: sectors, axisLabel: { color: '#9aa3b2', fontSize: 10 } },
    series: [{ type: 'bar', data: flows, itemStyle: { color: p => p.value >= 0 ? '#5b9bf0' : '#ef5350' } }],
  });
}
function drawAllocPie(rows) {
  const byType = {};
  rows.forEach(r => { byType[r.type] = (byType[r.type] || 0) + (+r.amountINR || 0); });
  const ch = chart('chartAllocPie');
  ch.setOption({
    backgroundColor: 'transparent',
    tooltip: { formatter: p => `${p.name}: ₹${(p.value/100000).toFixed(1)}L (${p.percent}%)` },
    legend: { bottom: 0, textStyle: { color: '#9aa3b2', fontSize: 11 } },
    series: [{ type: 'pie', radius: ['35%','65%'], data: Object.entries(byType).map(([name,value]) => ({ name, value })),
      label: { color: '#e9ebef', fontSize: 11 },
      itemStyle: { borderColor: '#0a0d12', borderWidth: 2 },
      color: ['#5b9bf0','#a488f0','#d4a537','#33c17f','#ef5350','#d4a537'] }],
  });
}

// ---------------- Ticker tape ----------------
function buildTape() {
  if (!latestSnapshot) return;
  const items = [
    ...(latestSnapshot.india.items || []).slice(0, 4),
    ...(latestSnapshot.global.items || []).slice(0, 4),
    ...(latestSnapshot.crypto.items || []).slice(0, 4).map(c => ({ name: c.symbol, changePct: c.change24hPct, price: c.price })),
  ];
  $('#tapeTrack').innerHTML = items.map(i => {
    const up = (i.changePct ?? 0) >= 0;
    return `<span>${escapeHtml(i.name)} <b class="${up?'up':'dn'}">${fmt(i.price)} ${up?'▲':'▼'}${i.changePct!=null?i.changePct.toFixed(2):'—'}%</b></span>`;
  }).join('');
}

// ---------------- Currency converter ----------------
async function loadConverter() {
  const res = await fetchAuthed('/api/convert');
  const { rates } = await res.json();
  window.__rates = rates || {};
  const codes = Object.keys(rates || {}).sort();
  $('#ccTarget').innerHTML = codes.map(c => `<option value="${c}">${c}</option>`).join('');
  if (codes.includes('USD')) $('#ccTarget').value = 'USD';
  renderCcGrid();
  convertOne();
}
function renderCcGrid() {
  const amt = parseFloat($('#ccAmount').value) || 0;
  const rates = window.__rates || {};
  $('#ccGrid').innerHTML = Object.entries(rates).map(([code, rate]) => `
    <div class="ccitem"><div class="code">${code}</div><div class="val">${(amt * rate).toLocaleString('en-US',{maximumFractionDigits:2})}</div></div>`).join('');
}
function convertOne() {
  const amt = parseFloat($('#ccAmount').value) || 0;
  const code = $('#ccTarget').value;
  const rate = (window.__rates || {})[code];
  $('#ccResult').textContent = rate ? `${code} ${(amt * rate).toLocaleString('en-US',{maximumFractionDigits:2})}` : '—';
}
$('#ccAmount').addEventListener('input', () => { renderCcGrid(); convertOne(); });
$('#ccTarget').addEventListener('change', convertOne);

// ---------------- Tabs ----------------
$$('.tab').forEach(btn => btn.addEventListener('click', () => {
  $$('.tab').forEach(b => b.classList.remove('active'));
  $$('.tabpanel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  $(`.tabpanel[data-panel="${btn.dataset.tab}"]`).classList.add('active');
  setTimeout(() => Object.values(charts).forEach(c => c.resize()), 60);
}));

// ---------------- Forecast chip (shared by every worker) ----------------
function forecastChip(f) {
  if (!f) return '';
  const viewColor = f.view === 'bullish' ? 'var(--green)' : f.view === 'bearish' ? 'var(--red)' : 'var(--ink2)';
  return `<div style="margin-top:10px;padding:8px 10px;background:var(--panel2);border:1px solid var(--line2);border-radius:6px;font-size:11.5px">
    <span style="color:var(--ink3);text-transform:uppercase;font-size:9px;font-family:var(--mono);letter-spacing:.05em">Forecast · ${escapeHtml(f.horizon||'')}</span>
    <div style="margin-top:3px"><b style="color:${viewColor};text-transform:capitalize">${escapeHtml(f.view||'—')}</b> → target <b style="font-family:var(--mono)">${escapeHtml(f.target||'—')}</b> ${f.confidence!=null?`<span style="color:var(--ink3)">(${f.confidence}% confidence)</span>`:''}</div>
    ${f.rationale ? `<div style="color:var(--ink2);margin-top:2px">${escapeHtml(f.rationale)}</div>` : ''}
  </div>`;
}

// ---------------- Worker-specific structured renderers ----------------
const RENDERERS = {
  w1: d => !d ? '' : `
    ${(d.picks||[]).map(p => `
    <div style="background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <b>${escapeHtml(p.name)}</b> <span style="color:var(--ink3);font-size:10px">${escapeHtml(p.ticker||'')} · ${escapeHtml(p.market||'')}</span>
      </div>
      <div style="font-size:10px;color:var(--ink3);text-transform:uppercase;font-family:var(--mono);margin-bottom:3px">Evidence</div>
      <div style="font-size:11px;color:var(--ink2);display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;margin-bottom:6px">
        <span>P/E: <b>${escapeHtml(p.evidence?.pe ?? '—')}</b></span>
        <span>Revenue growth: <b>${escapeHtml(p.evidence?.revenueGrowthPct ?? '—')}</b></span>
        <span>Profit margin: <b>${escapeHtml(p.evidence?.profitMarginPct ?? '—')}</b></span>
        <span>Regime: <b>${escapeHtml(p.evidence?.technicalRegime ?? '—')}</b></span>
      </div>
      <div style="font-size:9px;color:var(--ink3);margin-bottom:6px">Source: ${escapeHtml(p.evidence?.sourceTimestamp ?? 'unknown')}</div>
      <div style="font-size:12px;margin-bottom:6px">${escapeHtml(p.verdict||'')}</div>
      <div style="font-size:11px"><span style="color:var(--green)">E: ${escapeHtml(p.entry)}</span> · <span style="color:var(--red)">T: ${escapeHtml(p.target12m)}</span> · <span style="color:var(--gold)">SL: ${escapeHtml(p.stopLoss)}</span></div>
    </div>`).join('')}
    ${d.avoid ? `<div class="note" style="margin-top:8px">⚠ Avoid: <b>${escapeHtml(d.avoid.name)}</b> — ${escapeHtml(d.avoid.reason)}</div>` : ''}`,
  w2: d => !d ? '' : `
    <p style="font-size:12px;color:var(--ink2);margin-bottom:8px">${escapeHtml(d.moneyFlow||'')}</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="mc" style="background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px 10px">
        <div class="l" style="font-size:10px;color:var(--ink3);font-family:var(--mono)">GOLD — ${escapeHtml(d.gold?.action||'')}</div>
        <div style="font-family:var(--mono);font-weight:700">${escapeHtml(d.gold?.targetEntry||'—')}</div>
        <div class="note">${escapeHtml(d.gold?.rationale||'')}</div>
      </div>
      <div class="mc" style="background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px 10px">
        <div class="l" style="font-size:10px;color:var(--ink3);font-family:var(--mono)">BTC</div>
        <div style="font-family:var(--mono)">E: ${escapeHtml(d.btc?.entry||'—')} · T: ${escapeHtml(d.btc?.target||'—')} · SL: ${escapeHtml(d.btc?.stopLoss||'—')}</div>
        <div class="note">${escapeHtml(d.btc?.rationale||'')}</div>
      </div>
    </div>`,
  w3: d => !d ? '' : `<div class="note">${(d.allocations||[]).length} instruments allocated · Sharpe ≈ ${escapeHtml(d.sharpeEstimate ?? '—')} · Max drawdown ≈ ${escapeHtml(d.maxDrawdownPct ?? '—')}%. See the Investment Allocation Report table below.</div>`,
  w4: d => !d ? '' : `
    <div style="font-size:12px;color:var(--ink2)"><b>NIFTY:</b> ${escapeHtml(d.nifty?.trend||'')} · RSI ${escapeHtml(d.nifty?.rsiZone||'—')} · ${escapeHtml(d.nifty?.pattern||'')}</div>
    <div style="font-size:11px;color:var(--ink3);margin-top:4px">Supports: ${(d.nifty?.supports||[]).map(escapeHtml).join(', ')||'—'} · Resistances: ${(d.nifty?.resistances||[]).map(escapeHtml).join(', ')||'—'}</div>
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line);font-size:12px"><b>${escapeHtml(d.stock?.name||'Stock')}:</b> ${escapeHtml(d.stock?.setup||'')}<br>
    E: <span style="color:var(--green)">${escapeHtml(d.stock?.entry||'—')}</span> · T1: <span style="color:var(--red)">${escapeHtml(d.stock?.target1||'—')}</span> · T2: <span style="color:var(--red)">${escapeHtml(d.stock?.target2||'—')}</span> · SL: <span style="color:var(--gold)">${escapeHtml(d.stock?.stopLoss||'—')}</span></div>
    ${(d.opportunities||[]).length ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line)">
      <div style="font-size:10px;color:var(--ink3);text-transform:uppercase;font-family:var(--mono);margin-bottom:4px">3-6 Month Opportunities</div>
      ${d.opportunities.map(o => `<div style="font-size:11.5px;margin-bottom:4px"><b>${escapeHtml(o.name)}</b> <span style="color:var(--ink3);font-size:10px">${escapeHtml(o.ticker||'')}</span> — ${escapeHtml(o.thesis)} <span style="color:var(--green)">E:${escapeHtml(o.entry)}</span> <span style="color:var(--red)">T:${escapeHtml(o.target)}</span></div>`).join('')}
    </div>` : ''}`,
  w5: d => !d ? '' : `<ul style="margin:0;padding-left:16px;font-size:12px;color:var(--ink2);line-height:1.7">
    ${(d.bullets||[]).map(b => `<li><span style="color:${b.impact==='high'?'var(--red)':b.impact==='med'?'var(--gold)':'var(--green)'}">●</span> <b>${escapeHtml(b.headline)}</b> — ${escapeHtml(b.note)} ${b.date?`<span style="color:var(--ink3);font-size:9px;font-family:var(--mono)">(${escapeHtml(b.date)})</span>`:''}</li>`).join('')}
    </ul>`,
  w6: d => !d ? '' : `<div class="note">${(d.leaders||[]).length} leaders analyzed. See the Political Statements table below.</div>`,
};

// ---------------- Workers ----------------
let roster = [];
let workerOutputs = {};

async function loadRoster() {
  const res = await fetchAuthed('/api/agent/roster');
  roster = await res.json();
  const colors = { w1:'#5b9bf0', w2:'#33c17f', w3:'#a488f0', w4:'#d4a537', w5:'#ef5350', w6:'#d4a537' };
  $('#workers').innerHTML = roster.map(w => `
    <div class="wcard" id="card-${w.id}">
      <div class="wcard-hd">
        <div class="wcard-num">${w.id.toUpperCase()}</div>
        <div class="wcard-title" style="color:${colors[w.id]}">${w.title.replace(/^Worker 0\d - /, '')}</div>
        <div class="wcard-tag">${w.tag}</div>
      </div>
      <div class="wcard-body" id="body-${w.id}">Idle — click Run to dispatch with default brief.</div>
      <div class="wcard-ft">
        <button class="btn" data-task="${w.id}">Custom task…</button>
        <div style="display:flex;gap:6px">
          <button class="btn" data-dl="${w.id}" title="Download PDF report" disabled>📄 PDF</button>
          <button class="btn primary" data-run="${w.id}">Run</button>
        </div>
      </div>
      ${(w.id === 'w1' || w.id === 'w2') ? `
      <div class="techpanel" id="techpanel-${w.id}">
        <div class="techchips" id="techchips-${w.id}"></div>
        <div class="techsearch">
          <input type="text" id="techsearch-${w.id}" placeholder="Type a stock, crypto, or metal name…" autocomplete="off"/>
          <div class="techsuggest" id="techsuggest-${w.id}"></div>
        </div>
        <div class="techresult" id="techresult-${w.id}"></div>
      </div>` : ''}
    </div>`).join('');

  $$('[data-run]').forEach(b => b.addEventListener('click', () => runWorker(b.dataset.run)));
  $$('[data-task]').forEach(b => b.addEventListener('click', () => openModal(b.dataset.task)));
  $$('[data-dl]').forEach(b => b.addEventListener('click', () => downloadWorkerPdf(b.dataset.dl)));
  mountTechPanel('w1');
  mountTechPanel('w2');
}

// ---------------- Technical indicator panels (Worker 1 / Worker 2) ----------------
async function mountTechPanel(workerId) {
  const chipsEl = $(`#techchips-${workerId}`);
  if (!chipsEl) return;
  try {
    const res = await fetchAuthed('/api/markets/quick-picks');
    const picks = await res.json();
    chipsEl.innerHTML = picks.map(p => `<span class="techchip" data-sym="${escapeHtml(p.symbol)}" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>`).join('');
    chipsEl.querySelectorAll('.techchip').forEach(c => c.addEventListener('click', () => loadTechnical(workerId, c.dataset.sym, c.dataset.name)));
  } catch (e) { console.warn('quick picks failed', e); }

  const input = $(`#techsearch-${workerId}`);
  const suggestBox = $(`#techsuggest-${workerId}`);
  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) { suggestBox.classList.remove('open'); return; }
    debounceTimer = setTimeout(async () => {
      try {
        const res = await fetchAuthed(`/api/markets/search?q=${encodeURIComponent(q)}`);
        const results = await res.json();
        if (!results.length) { suggestBox.innerHTML = `<div style="color:var(--ink3)">No matches</div>`; suggestBox.classList.add('open'); return; }
        suggestBox.innerHTML = results.map(r => `<div data-sym="${escapeHtml(r.symbol)}" data-name="${escapeHtml(r.name)}">${escapeHtml(r.name)} <span style="color:var(--ink3)">${escapeHtml(r.symbol)} · ${escapeHtml(r.type)}</span></div>`).join('');
        suggestBox.classList.add('open');
        suggestBox.querySelectorAll('[data-sym]').forEach(el => el.addEventListener('click', () => {
          input.value = el.dataset.name; suggestBox.classList.remove('open');
          loadTechnical(workerId, el.dataset.sym, el.dataset.name);
        }));
      } catch (e) { console.warn('search failed', e); }
    }, 350);
  });
  document.addEventListener('click', e => { if (!e.target.closest(`#techpanel-${workerId}`)) suggestBox.classList.remove('open'); });
}

const techState = {}; // workerId -> { symbol, name, tech } - used by PDF export
async function loadTechnical(workerId, symbol, name) {
  const box = $(`#techresult-${workerId}`);
  box.innerHTML = `<span class="note">Loading indicators for ${escapeHtml(name)}…</span>`;
  try {
    const res = await fetchAuthed(`/api/markets/technicals?symbol=${encodeURIComponent(symbol)}`);
    const tech = await res.json();
    if (!res.ok) throw new Error(tech.error || 'Failed to compute indicators');
    techState[workerId] = { symbol, name, tech };
    renderTechnical(workerId, name, tech);
  } catch (e) {
    box.innerHTML = `<span style="color:var(--red)">⚠ ${escapeHtml(e.message)}</span>`;
  }
}

function renderTechnical(workerId, name, tech) {
  const box = $(`#techresult-${workerId}`);
  const overallColor = tech.summary.overall.includes('Buy') ? 'var(--green)' : tech.summary.overall.includes('Sell') ? 'var(--red)' : 'var(--ink2)';
  box.innerHTML = `
    <div class="hdr">
      <div><b>${escapeHtml(name)}</b> <span style="color:var(--ink3);font-size:10px;font-family:var(--mono)">${escapeHtml(tech.symbol)}</span></div>
      <div class="px">${fmt(tech.price)}</div>
    </div>
    <div style="margin-bottom:8px"><span class="sigbdg big" style="background:transparent;border:1px solid ${overallColor};color:${overallColor}">${escapeHtml(tech.summary.overall)}</span>
      <span class="note" style="margin-left:6px">MA ${tech.summary.movingAverages.buy}B/${tech.summary.movingAverages.sell}S · Indicators ${tech.summary.indicators.buy}B/${tech.summary.indicators.sell}S/${tech.summary.indicators.neutral}N</span></div>
    <div class="chart" style="height:140px" id="techchart-${workerId}"></div>
    <table class="techtbl"><thead><tr><th>MA</th><th>Simple</th><th></th><th>Exp</th><th></th></tr></thead>
    <tbody>${tech.movingAverages.map(m => `<tr><td>MA${m.period}</td><td>${m.sma!=null?fmt(m.sma):'—'}</td><td>${m.smaSignal?`<span class="sigbdg ${m.smaSignal}">${m.smaSignal}</span>`:''}</td><td>${m.ema!=null?fmt(m.ema):'—'}</td><td>${m.emaSignal?`<span class="sigbdg ${m.emaSignal}">${m.emaSignal}</span>`:''}</td></tr>`).join('')}</tbody></table>
    <table class="techtbl"><thead><tr><th>Indicator</th><th>Value</th><th>Signal</th></tr></thead>
    <tbody>${tech.oscillators.map(o => `<tr><td>${escapeHtml(o.name)}</td><td>${o.value!=null?o.value.toFixed(2):'—'}</td><td>${o.signal?`<span class="sigbdg ${o.signal}">${o.signal}</span>`:o.note?`<span class="note">${escapeHtml(o.note)}</span>`:'—'}</td></tr>`).join('')}</tbody></table>
    <table class="techtbl"><thead><tr><th>Pivot</th><th>Classic</th><th>Fibonacci</th></tr></thead>
    <tbody>${['R3','R2','R1','PP','S1','S2','S3'].map(k => `<tr><td>${k}</td><td>${fmt(tech.pivots.classic[k])}</td><td>${fmt(tech.pivots.fibonacci[k])}</td></tr>`).join('')}</tbody></table>
    <p class="note" style="margin-top:6px">Computed live from ${tech.candles.length >= 200 ? '1y' : 'available'} daily history using standard TA formulas — signals are rule-based, not identical to any specific vendor's proprietary methodology.</p>
    <button class="btn sm" style="margin-top:8px;font-size:11px;padding:5px 10px" data-opt-sym="${escapeHtml(tech.symbol)}" data-opt-worker="${workerId}">Show Option Chain</button>
    <div id="optresult-${workerId}" style="margin-top:8px"></div>`;

  box.querySelector('[data-opt-sym]')?.addEventListener('click', e => loadOptionChain(workerId, e.target.dataset.optSym));

  const ch = chart(`techchart-${workerId}`);
  ch.setOption({
    backgroundColor: 'transparent',
    grid: { left: 50, right: 12, top: 8, bottom: 20 },
    xAxis: { type: 'category', data: tech.candles.map(c => new Date(c.date).toLocaleDateString('en-IN',{month:'short',day:'numeric'})), axisLabel: { color: '#5c6472', fontSize: 9, interval: 9 } },
    yAxis: { scale: true, axisLabel: { color: '#5c6472', fontSize: 9 }, splitLine: { lineStyle: { color: '#1a1f29' } } },
    series: [{ type: 'line', data: tech.candles.map(c => c.close), smooth: true, symbol: 'none', lineStyle: { color: '#5b9bf0', width: 2 } }],
  });
}

const OPTIONS_PROXY = { 'GC=F': 'GLD', 'SI=F': 'SLV', 'CL=F': 'USO', 'HG=F': 'CPER', 'PL=F': 'PPLT' };
async function loadOptionChain(workerId, requestedSymbol) {
  const el = $(`#optresult-${workerId}`);
  const symbol = OPTIONS_PROXY[requestedSymbol] || requestedSymbol;
  const proxyNote = OPTIONS_PROXY[requestedSymbol] ? `<div class="note">${escapeHtml(requestedSymbol)} itself has no listed retail options — showing ${escapeHtml(symbol)} (the closest tracking ETF) instead.</div>` : '';
  el.innerHTML = `<span class="note">Loading option chain for ${escapeHtml(symbol)}…</span>`;
  if (symbol.startsWith('^')) {
    el.innerHTML = `<span style="color:var(--red)">⚠ Indices like ${escapeHtml(symbol)} have no directly listed retail options on free data sources.</span><p class="note" style="margin-top:4px">For NIFTY/BANKNIFTY options specifically you'd need NSE data via a broker API (Zerodha Kite / Upstox) — see README. Try a US stock (AAPL), or GLD/SLV as gold/silver proxies instead.</p>`;
    return;
  }
  try {
    const res = await fetchAuthed(`/api/markets/options?symbol=${encodeURIComponent(symbol)}`);
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || 'No option chain available');
    const strikes = [...new Set([...d.calls.map(c => c.strike), ...d.puts.map(p => p.strike)])].sort((a, b) => a - b);
    const rows = strikes.map(k => ({ k, c: d.calls.find(x => x.strike === k), p: d.puts.find(x => x.strike === k) }));
    const nearMoney = rows.filter(r => Math.abs(r.k - d.underlyingPrice) / d.underlyingPrice < 0.15);
    el.innerHTML = `
      ${proxyNote}
      <div class="note">Underlying: ${fmt(d.underlyingPrice)} · Expiry: ${escapeHtml(d.expiry)} (${d.expiryDates.length} expiries available)</div>
      <table class="techtbl"><thead><tr><th>Call OI</th><th>Call LTP</th><th>Strike</th><th>Put LTP</th><th>Put OI</th></tr></thead>
      <tbody>${nearMoney.map(r => `<tr style="${Math.abs(r.k-d.underlyingPrice)<0.01*d.underlyingPrice?'background:var(--panel2)':''}">
        <td>${r.c?.openInterest ?? '—'}</td><td style="color:var(--green)">${r.c?.lastPrice!=null?fmt(r.c.lastPrice):'—'}</td>
        <td style="font-weight:700">${fmt(r.k)}</td>
        <td style="color:var(--red)">${r.p?.lastPrice!=null?fmt(r.p.lastPrice):'—'}</td><td>${r.p?.openInterest ?? '—'}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch (e) {
    el.innerHTML = `<span style="color:var(--red)">⚠ ${escapeHtml(e.message)}</span><p class="note" style="margin-top:4px">Free options data only exists for US-listed stocks/ETFs. NSE-listed options (NIFTY, BANKNIFTY, individual NSE stocks) need a broker API (Zerodha Kite / Upstox) — see README. Try a US ticker like AAPL, or GLD/SLV as gold/silver options proxies.</p>`;
  }
}

const PDF_TABLE_SPEC = {
  w1: { title: 'Fundamental Research', cols: ['Company','Ticker','Mkt','P/E','Rev Growth','Margin','Entry','12M Target','Stop-Loss'],
        rows: d => (d?.picks||[]).map(p => [p.name,p.ticker,p.market,p.evidence?.pe,p.evidence?.revenueGrowthPct,p.evidence?.profitMarginPct,p.entry,p.target12m,p.stopLoss]) },
  w2: { title: 'Markets & Bullion Desk', cols: ['Instrument','Action/Entry','Target','Stop-Loss','Rationale'],
        rows: d => d ? [
          ['Gold', d.gold?.action||'—', d.gold?.targetEntry||'—', '—', d.gold?.rationale||''],
          ['Bitcoin', d.btc?.entry||'—', d.btc?.target||'—', d.btc?.stopLoss||'—', d.btc?.rationale||''],
        ] : [] },
  w3: { title: 'Allocation & Risk Engine', cols: ['Instrument','Type','Mkt','Conv%','Amount (INR)','Upside%','Entry','Exit','Stop-Loss','Horizon'],
        rows: d => (d?.allocations||[]).map(r => [r.name,r.type,r.market,r.conviction,fmt(r.amountINR),r.upsidePct,r.entry,r.exit,r.stopLoss,r.horizon]),
        extraTable: d => (d?.ipos||[]).length ? { title: 'IPO Watchlist', cols: ['Company','Sector','Timeline','Financial Health','Market Position','News','Conv%','Risk Flags','₹ Rec.','Verdict'],
          rows: d.ipos.map(r => [r.name,r.sector,r.listingTimeline,r.financialHealth,r.marketPosition,r.newsSentiment,r.conviction,r.riskFlags,fmt(r.recommendedAmountINR),r.verdict]) } : null },
  w4: { title: 'Charting & Trends', cols: ['Item','Detail'],
        rows: d => d ? [
          ['NIFTY trend', d.nifty?.trend||'—'], ['NIFTY RSI', d.nifty?.rsiZone||'—'],
          ['Supports', (d.nifty?.supports||[]).join(', ')], ['Resistances', (d.nifty?.resistances||[]).join(', ')],
          [d.stock?.name||'Stock', d.stock?.setup||'—'], ['Entry / T1 / T2 / SL', `${d.stock?.entry||'—'} / ${d.stock?.target1||'—'} / ${d.stock?.target2||'—'} / ${d.stock?.stopLoss||'—'}`],
        ] : [] },
  w5: { title: 'Global Intelligence Monitor', cols: ['Category','Impact','Headline','Note'],
        rows: d => (d?.bullets||[]).map(b => [b.category,b.impact,b.headline,b.note]) },
  w6: { title: 'Political Analytics Engine', cols: ['Leader','Country','Impact','Call','Entry','Exit','Suggested INR'],
        rows: d => (d?.leaders||[]).map(l => [l.leader,l.country,l.impactLevel,l.investCall,l.entry,l.exit,fmt(l.amountINR)]) },
};

async function downloadWorkerPdf(id) {
  const out = workerOutputs[id];
  if (!out) return;
  const btn = document.querySelector(`[data-dl="${id}"]`);
  const origLabel = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Writing report…';

  try {
    const res = await fetchAuthed(`/api/agent/${id}/report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ out }),
    });
    const reportData = await res.json();
    if (!res.ok) throw new Error(reportData.error || 'Report generation failed');
    buildPdf(id, out, reportData.report);
  } catch (e) {
    alert('Could not generate the detailed report: ' + e.message + '\n\nDownloading a shorter summary PDF instead.');
    buildPdf(id, out, null);
  } finally {
    btn.disabled = false; btn.textContent = origLabel;
  }
}

const PAGE_BOTTOM = 275, PAGE_LEFT = 14, PAGE_WIDTH = 182;

function ensureRoom(doc, y, needed) {
  if (y + needed > PAGE_BOTTOM) { doc.addPage(); return 18; }
  return y;
}

function writeNarrativeSection(doc, y, heading, bodyLines) {
  y = ensureRoom(doc, y, 14);
  doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.setTextColor(20);
  doc.text(heading, PAGE_LEFT, y); y += 6;
  doc.setFontSize(9.5); doc.setFont(undefined, 'normal'); doc.setTextColor(50);
  for (const raw of bodyLines) {
    const isBullet = /^[-•]\s/.test(raw);
    const text = raw.replace(/^[-•]\s/, isBullet ? '• ' : '');
    const wrapped = doc.splitTextToSize(text, isBullet ? PAGE_WIDTH - 6 : PAGE_WIDTH);
    y = ensureRoom(doc, y, wrapped.length * 5 + 2);
    doc.text(wrapped, isBullet ? PAGE_LEFT + 4 : PAGE_LEFT, y);
    y += wrapped.length * 5 + 2;
  }
  return y + 4;
}

function parseNarrative(report) {
  const sections = {};
  let current = null;
  for (const line of (report || '').split('\n')) {
    const m = line.match(/^##\s*(.+)/);
    if (m) { current = m[1].trim(); sections[current] = []; continue; }
    if (current && line.trim()) sections[current].push(line.trim());
  }
  return sections;
}

function downloadWorkerPdf_buildTableSpec() { return PDF_TABLE_SPEC; } // kept for readability of the section below

function buildPdf(id, out, report) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const w = roster.find(r => r.id === id);
  const spec = PDF_TABLE_SPEC[id];
  let y = 20;

  doc.setFontSize(18); doc.setFont(undefined, 'bold'); doc.setTextColor(20);
  doc.text(w?.title || id.toUpperCase(), PAGE_LEFT, y); y += 7;
  doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(120);
  doc.text(`Chief Finance Wiz — Detailed Analysis Report · Generated ${new Date().toLocaleString('en-IN')}`, PAGE_LEFT, y); y += 9;
  doc.setTextColor(20);

  if (out.headline) {
    doc.setFontSize(12); doc.setFont(undefined, 'italic');
    const lines = doc.splitTextToSize(out.headline, PAGE_WIDTH);
    doc.text(lines, PAGE_LEFT, y); y += lines.length * 5.5 + 6;
    doc.setFont(undefined, 'normal');
  }

  // Overall Buy/Sell/Watch signal banner
  if (out.forecast) {
    const view = (out.forecast.view || 'neutral').toLowerCase();
    const bannerColor = view === 'bullish' ? [51, 193, 127] : view === 'bearish' ? [239, 83, 80] : [154, 163, 178];
    doc.setFillColor(...bannerColor); doc.rect(PAGE_LEFT, y, PAGE_WIDTH, 9, 'F');
    doc.setTextColor(255); doc.setFontSize(10); doc.setFont(undefined, 'bold');
    doc.text(`${(out.forecast.view || 'NEUTRAL').toUpperCase()} — target ${out.forecast.target || '—'} (${out.forecast.horizon || ''}, ${out.forecast.confidence ?? '—'}% confidence)`, PAGE_LEFT + 3, y + 6.2);
    doc.setTextColor(20); doc.setFont(undefined, 'normal');
    y += 14;
  }

  // Structured data table (fast-scan reference)
  if (spec && out.data) {
    const rows = spec.rows(out.data);
    if (rows.length) {
      doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.text('Summary Table', PAGE_LEFT, y); y += 5;
      doc.autoTable({ startY: y, head: [spec.cols], body: rows, styles: { fontSize: 7.5 }, headStyles: { fillColor: [17,21,28] }, margin: { left: PAGE_LEFT, right: PAGE_LEFT } });
      y = doc.lastAutoTable.finalY + 8;
    }
    const extra = spec.extraTable?.(out.data);
    if (extra) {
      if (y > 230) { doc.addPage(); y = 20; }
      doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.text(extra.title, PAGE_LEFT, y); y += 5;
      doc.autoTable({ startY: y, head: [extra.cols], body: extra.rows, styles: { fontSize: 7 }, headStyles: { fillColor: [17,21,28] }, margin: { left: PAGE_LEFT, right: PAGE_LEFT } });
      y = doc.lastAutoTable.finalY + 8;
    }
  }

  // Chart image, if one is currently rendered for this worker
  const chartCandidates = { w1: `techchart-${id}`, w2: `techchart-${id}`, w3: 'chartAllocPie', w4: 'chartNifty', w5: 'chartFlow', w6: null };
  const chartId = chartCandidates[id];
  if (chartId && charts[chartId]) {
    try {
      const img = charts[chartId].getDataURL({ pixelRatio: 2, backgroundColor: '#11151c' });
      y = ensureRoom(doc, y, 78);
      doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.text('Chart', PAGE_LEFT, y); y += 5;
      doc.addImage(img, 'PNG', PAGE_LEFT, y, PAGE_WIDTH, 70);
      y += 76;
    } catch (e) { console.warn('chart embed failed', e); }
  }

  // Long-form narrative (market context, per-instrument reasoning, buy/watch lists, risks)
  if (report) {
    const sections = parseNarrative(report);
    const order = ['Market Context', 'Instrument-by-Instrument Analysis', 'Buy List', 'Watch / Avoid List', 'Risk Factors', 'Forecast Rationale'];
    for (const heading of order) {
      if (sections[heading]?.length) y = writeNarrativeSection(doc, y, heading, sections[heading]);
    }
    // Any section headings the model used that weren't in our expected list
    for (const heading of Object.keys(sections)) {
      if (!order.includes(heading) && sections[heading]?.length) y = writeNarrativeSection(doc, y, heading, sections[heading]);
    }
  } else {
    y = writeNarrativeSection(doc, y, 'Note', ['Detailed narrative generation was unavailable for this download - the summary table and forecast above reflect the live dashboard output.']);
  }

  // Forecast rationale box (short version, always present as a quick-reference footer)
  if (out.forecast?.rationale) {
    y = ensureRoom(doc, y, 24);
    doc.setFillColor(245, 240, 225); doc.rect(PAGE_LEFT, y, PAGE_WIDTH, 20, 'F');
    doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(20);
    doc.text(`Quick Forecast Reference (${out.forecast.horizon || ''})`, PAGE_LEFT + 4, y + 6);
    doc.setFont(undefined, 'normal');
    const ratLines = doc.splitTextToSize(out.forecast.rationale, PAGE_WIDTH - 8);
    doc.text(ratLines, PAGE_LEFT + 4, y + 12);
    y += 24;
  }

  const pageCount = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(7.5); doc.setTextColor(150);
    doc.text('Generated by Chief Finance Wiz — for research/demo purposes, not licensed investment advice.', PAGE_LEFT, 293);
    doc.text(`Page ${p} of ${pageCount}`, 190, 293, { align: 'right' });
  }

  doc.save(`${id}_detailed_report_${new Date().toISOString().slice(0,10)}.pdf`);
}

// Returns true/false so callers (like runAllAgents) can tell whether this
// worker actually succeeded, instead of assuming success just because
// runWorker() itself didn't throw (it never does - it always catches its
// own errors so the individual card can show them inline).
async function runWorker(id, customTask) {
  const body = $('#body-' + id);
  body.textContent = 'Running…';
  try {
    const res = await fetchAuthed(`/api/agent/${id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customTask, context: workerOutputs }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'Worker failed');
    workerOutputs[id] = out;
    $(`[data-dl="${id}"]`).disabled = !out.data;

    if (out.parseError) {
      body.innerHTML = `<span style="color:var(--red)">⚠ ${escapeHtml(out.parseError)}</span><div class="note" style="margin-top:6px;max-height:120px;overflow-y:auto;white-space:pre-wrap">${escapeHtml((out.raw||'').slice(0,600))}</div>`;
    } else {
      const renderer = RENDERERS[id];
      const warningHtml = (out.evidenceWarnings && out.evidenceWarnings.length)
        ? `<div style="background:var(--red-dim);border:1px solid var(--red);border-radius:6px;padding:8px 10px;margin-bottom:8px;font-size:11px;color:var(--red)">⚠ Backend verification: ${out.evidenceWarnings.map(escapeHtml).join(' ')}</div>`
        : '';
      body.innerHTML = `${warningHtml}<div style="font-weight:600;margin-bottom:8px">${escapeHtml(out.headline||'')}</div>${renderer ? renderer(out.data) : ''}${forecastChip(out.forecast)}`;
    }

    if (id === 'w3') {
      if (out.data?.allocations) { renderInvestTable(out.data.allocations); drawAllocPie(out.data.allocations); }
      else renderInvestTable(null, out.parseError);
      if (out.data?.ipos) renderIpoTable(out.data.ipos);
      else if (out.parseError) renderIpoTable(null, out.parseError);
    }
    if (id === 'w6') {
      if (out.data?.leaders) renderPolTable(out.data.leaders);
      else renderPolTable(null, out.parseError);
    }
    if (id === 'w5' && out.data?.flows) {
      drawFlow(Object.keys(out.data.flows), Object.values(out.data.flows).map(Number));
    }

    if (out.headline) pushChat('cfw', `${roster.find(w=>w.id===id)?.title}: ${out.headline}`);
    renderMorningBrief();
    return true;
  } catch (e) {
    body.innerHTML = `<span style="color:var(--red)">⚠ ${escapeHtml(e.message)}</span>`;
    return false;
  }
}

async function runAllAgents() {
  const btn = $('#runAllBtn'), status = $('#runAllStatus');
  btn.disabled = true;
  try {
    status.textContent = 'Running W1 + W2 (research + markets)…';
    const r12 = await Promise.all([runWorker('w1'), runWorker('w2')]);
    status.textContent = 'Running W3 (allocation, using W1/W2 output)…';
    const r3 = await runWorker('w3');
    status.textContent = 'Running W4 + W5 + W6 (charts, intel, politics)…';
    const r456 = await Promise.all([runWorker('w4'), runWorker('w5'), runWorker('w6')]);

    // runWorker() catches its own errors so each card can show its own
    // message inline - that also meant a failed worker was previously
    // invisible here, and this status line always claimed full success even
    // when e.g. Worker 1 had actually failed. Check the results explicitly
    // instead of assuming "didn't throw" means "succeeded."
    const results = { w1: r12[0], w2: r12[1], w3: r3, w4: r456[0], w5: r456[1], w6: r456[2] };
    const failed = Object.entries(results).filter(([, ok]) => !ok).map(([id]) => id.toUpperCase());

    if (failed.length) {
      status.innerHTML = `<span style="color:var(--red)">⚠ ${6 - failed.length}/6 agents ran at ${new Date().toLocaleTimeString('en-IN')} — ${failed.join(', ')} failed (see the failing card${failed.length>1?'s':''} above for details).</span>`;
      pushChat('cfw', `${6 - failed.length} of 6 agents reported in; ${failed.join(', ')} hit an error — check ${failed.length>1?'their cards':'its card'} above.`);
    } else {
      status.textContent = `✔ All 6 agents ran at ${new Date().toLocaleTimeString('en-IN')}`;
      pushChat('cfw', 'All six agents have reported in. Review the Investment Allocation and Political Statements tables below, plus each agent\'s forecast.');
    }
  } catch (e) {
    status.innerHTML = `<span style="color:var(--red)">⚠ ${escapeHtml(e.message)}</span>`;
  }
  btn.disabled = false;
}
$('#runAllBtn').addEventListener('click', runAllAgents);

let investRows = [], polRows = [];
function renderInvestTable(rows, parseError) {
  if (parseError && !rows) {
    $('#investTbl tbody').innerHTML = `<tr><td colspan="12" style="text-align:center;padding:20px;color:var(--red)">⚠ ${escapeHtml(parseError)}</td></tr>`;
    return;
  }
  investRows = rows || [];
  if (!investRows.length) return;
  $('#investTbl tbody').innerHTML = investRows.map((r, i) => `
    <tr><td>${i+1}</td><td>${escapeHtml(r.name)}<br><span style="color:var(--ink3);font-size:10px">${escapeHtml(r.ticker||'')}</span></td>
    <td>${escapeHtml(r.type)}</td><td>${escapeHtml(r.market)}</td><td>${r.conviction}%</td>
    <td>₹${fmt(r.amountINR)}</td><td style="color:${r.upsidePct>=0?'var(--green)':'var(--red)'}">${r.upsidePct>=0?'+':''}${r.upsidePct}%</td>
    <td style="color:var(--green)">${escapeHtml(r.entry)}</td><td style="color:var(--red)">${escapeHtml(r.exit)}</td>
    <td style="color:var(--gold)">${escapeHtml(r.stopLoss)}</td><td>${escapeHtml(r.horizon)}</td>
    <td style="font-family:var(--sans);font-size:11.5px;color:var(--ink2)">${escapeHtml(r.rationale)}</td></tr>`).join('');
  const tot = investRows.reduce((s,r)=>s+(+r.amountINR||0),0);
  $('#investFoot').innerHTML = `<div class="fc"><div class="l">Total</div><div class="v">₹${(tot/100000).toFixed(1)}L</div></div>
    <div class="fc"><div class="l">Instruments</div><div class="v">${investRows.length}</div></div>`;
}
let ipoRows = [];
function renderIpoTable(rows, parseError) {
  if (parseError && !rows) {
    $('#ipoTbl tbody').innerHTML = `<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--red)">⚠ ${escapeHtml(parseError)}</td></tr>`;
    return;
  }
  ipoRows = rows || [];
  if (!ipoRows.length) return;
  const verdictColor = v => v === 'invest' ? 'var(--green)' : v === 'avoid' ? 'var(--red)' : 'var(--gold)';
  $('#ipoTbl tbody').innerHTML = ipoRows.map(r => `
    <tr><td><b>${escapeHtml(r.name)}</b></td><td>${escapeHtml(r.sector)}</td>
    <td style="font-family:var(--sans);font-size:11px">${escapeHtml(r.listingTimeline)}</td>
    <td style="font-family:var(--sans);font-size:11px">${escapeHtml(r.financialHealth)}</td>
    <td style="font-family:var(--sans);font-size:11px">${escapeHtml(r.marketPosition)}</td>
    <td style="font-family:var(--sans);font-size:11px">${escapeHtml(r.newsSentiment)}</td>
    <td>${r.conviction}%</td>
    <td style="font-family:var(--sans);font-size:11px;color:var(--red)">⚠ ${escapeHtml(r.riskFlags)}</td>
    <td style="color:var(--gold)">₹${fmt(r.recommendedAmountINR)}</td>
    <td><span class="sigbdg big" style="background:transparent;border:1px solid ${verdictColor(r.verdict)};color:${verdictColor(r.verdict)};text-transform:uppercase">${escapeHtml(r.verdict)}</span></td></tr>`).join('');
  const tot = ipoRows.reduce((s,r)=>s+(+r.recommendedAmountINR||0),0);
  $('#ipoFoot').innerHTML = `<div class="fc"><div class="l">IPOs analyzed</div><div class="v">${ipoRows.length}</div></div>
    <div class="fc"><div class="l">Total recommended</div><div class="v">₹${(tot/100000).toFixed(1)}L</div></div>
    <div class="fc"><div class="l">Flagged avoid/watch</div><div class="v" style="color:var(--gold)">${ipoRows.filter(r=>r.verdict!=='invest').length}</div></div>`;
}
function renderPolTable(rows, parseError) {
  if (parseError && !rows) {
    $('#polTbl tbody').innerHTML = `<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--red)">⚠ ${escapeHtml(parseError)}</td></tr>`;
    return;
  }
  polRows = rows || [];
  if (!polRows.length) return;
  const freshCutoff = Date.now() - 3 * 86400000;
  $('#polTbl tbody').innerHTML = polRows.map(r => {
    const d = r.statementDate ? new Date(r.statementDate) : null;
    const isStale = d && !isNaN(d) && d.getTime() < freshCutoff;
    const dateTag = r.statementDate ? `<span style="color:${isStale?'var(--gold)':'var(--ink3)'};font-size:9px;font-family:var(--mono)">${isStale?'⚠ ':''}${escapeHtml(r.statementDate)}</span>` : '';
    return `
    <tr><td>${escapeHtml(r.leader)}<br><span style="color:var(--ink3);font-size:10px">${escapeHtml(r.country)}</span> ${dateTag}</td>
    <td style="font-family:var(--sans);font-size:11.5px;max-width:220px">${escapeHtml(r.statement)}</td>
    <td style="font-family:var(--sans);font-size:11.5px">${escapeHtml(r.immediateImpact)}</td>
    <td style="font-family:var(--sans);font-size:11.5px">${escapeHtml(r.futureConsequence)}</td>
    <td style="color:var(--blue)">${escapeHtml(r.affectedSectors)}</td>
    <td style="color:${r.impactLevel==='high'?'var(--red)':r.impactLevel==='med'?'var(--gold)':'var(--green)'}">${escapeHtml(r.impactLevel)}</td>
    <td style="font-family:var(--sans);font-size:11.5px">${escapeHtml(r.investCall)}</td>
    <td style="color:var(--green)">${escapeHtml(r.entry)}</td><td style="color:var(--red)">${escapeHtml(r.exit)}</td>
    <td style="color:var(--gold)">₹${fmt(r.amountINR)}</td></tr>`;
  }).join('');
  $('#polFoot').innerHTML = `<div class="fc"><div class="l">Leaders tracked</div><div class="v">${polRows.length}</div></div>`;
}

function exportCsv(filename, rows, cols) {
  if (!rows.length) return alert('Run the worker first — no data to export yet.');
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g,'""')}"`).join(','))].join('\n');
  dlBlob(filename, csv, 'text/csv');
}
$('#exportInvestBtn').addEventListener('click', () => exportCsv('cfw_investment.csv', investRows, ['name','ticker','type','market','conviction','amountINR','upsidePct','entry','exit','stopLoss','horizon','rationale']));
$('#exportPolBtn').addEventListener('click', () => exportCsv('cfw_political.csv', polRows, ['leader','country','role','statement','immediateImpact','futureConsequence','affectedSectors','impactLevel','investCall','entry','exit','amountINR']));
$('#exportIpoBtn').addEventListener('click', () => exportCsv('cfw_ipo_watchlist.csv', ipoRows, ['name','sector','listingTimeline','financialHealth','marketPosition','newsSentiment','conviction','riskFlags','recommendedAmountINR','verdict']));

// ---------------- Task modal ----------------
let modalWorkerId = null;
function openModal(id) { modalWorkerId = id; $('#modalTitle').textContent = `Dispatch ${id.toUpperCase()}`; $('#modalInput').value = ''; $('#modalBg').classList.add('open'); }
function closeModal() { $('#modalBg').classList.remove('open'); }
$('#modalClose').addEventListener('click', closeModal);
$('#modalCancel').addEventListener('click', closeModal);
$('#modalSend').addEventListener('click', () => { const t = $('#modalInput').value.trim(); closeModal(); if (t) runWorker(modalWorkerId, t); });

// ---------------- Chat ----------------
function pushChat(who, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + (who === 'you' ? 'you' : 'cfw');
  div.innerHTML = `<div class="lbl">${who === 'you' ? 'You' : 'Chief Finance Wiz'}</div><div class="bubble">${escapeHtml(text)}</div>`;
  $('#chat').appendChild(div);
  $('#chat').scrollTop = $('#chat').scrollHeight;
}
$('#chatForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#chatInput');
  const msg = input.value.trim(); if (!msg) return;
  pushChat('you', msg); input.value = '';
  pushChat('cfw', '…thinking…');
  try {
    const res = await fetchAuthed('/api/agent/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg, context: workerOutputs }) });
    const data = await res.json();
    $('#chat').lastChild.remove();
    pushChat('cfw', res.ok ? data.text : `⚠ ${data.error}`);
  } catch (err) { $('#chat').lastChild.remove(); pushChat('cfw', '⚠ ' + err.message); }
});


// ---------------- Worker 07: Market Risk & Regime Intelligence (no LLM calls - real quant/ML) ----------------
function fmtPct(v) { return v == null ? '—' : (v * 100).toFixed(1) + '%'; }
function regimeColor(regime) {
  if (!regime) return 'var(--ink3)';
  if (regime.includes('Bullish')) return 'var(--green)';
  if (regime.includes('Bearish')) return 'var(--red)';
  return 'var(--gold)';
}

let lastRegimeResult = null;

async function runRegimeAnalysis() {
  const btn = $('#runRegimeBtn'), el = $('#regimeResult');
  btn.disabled = true; btn.textContent = 'Training models on live data…';
  el.innerHTML = `<p class="note"><span class="spin" style="display:inline-block;width:10px;height:10px;border:2px solid var(--line2);border-top-color:var(--gold);border-radius:50%;animation:spin .7s linear infinite;margin-right:6px"></span>Fetching a year of NIFTY + USD/INR + gold + global futures history, engineering features, training logistic regression + Random Forest, walk-forward validating, fitting GARCH(1,1), running Isolation Forest…</p>`;
  try {
    const res = await fetchAuthed('/api/intelligence/regime');
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Regime analysis failed');
    lastRegimeResult = d;
    $('#compareModelsBtn').disabled = false;
    renderRegimeResult(d);
    renderMorningBrief();
  } catch (e) {
    el.innerHTML = `<span style="color:var(--red)">⚠ ${escapeHtml(e.message)}</span>`;
  }
  btn.disabled = false; btn.textContent = 'Run Regime Analysis';
}

function renderRegimeResult(d) {
  const r = d.regime, v = d.volatility, a = d.anomaly;
  const rc = regimeColor(r.current);
  $('#regimeResult').innerHTML = `
    <div style="display:flex;gap:24px;flex-wrap:wrap;padding:14px;background:var(--panel2);border:1px solid var(--line2);border-radius:8px;margin-bottom:12px">
      <div><div class="note">Current Regime</div><div style="font-size:20px;font-weight:700;color:${rc}">${escapeHtml(r.current)}</div></div>
      <div><div class="note">Probability</div><div style="font-size:20px;font-weight:700;font-family:var(--mono)">${fmtPct(r.probability)}</div></div>
      <div><div class="note">Volatility Forecast</div><div style="font-size:20px;font-weight:700;color:${v.label==='High'?'var(--red)':v.label==='Medium'?'var(--gold)':'var(--green)'}">${escapeHtml(v.label)}</div></div>
      <div><div class="note">Trained on</div><div style="font-size:14px;font-family:var(--mono);padding-top:4px">${d.dataPoints} trading days</div></div>
    </div>
    ${a.detected ? `<div style="padding:10px 14px;background:var(--red-dim);border:1px solid var(--red);border-radius:8px;margin-bottom:12px;font-size:12px">
      <b style="color:var(--red)">⚠️ Unusual market conditions detected</b> (Isolation Forest anomaly score ${a.score.toFixed(2)}, threshold ${a.threshold})<br>
      ${a.abnormalFeatures.length ? 'Abnormal factors: ' + a.abnormalFeatures.map(f => `${escapeHtml(f.feature)} (z=${f.zScore.toFixed(1)})`).join(', ') : ''}
    </div>` : `<p class="note" style="margin-bottom:12px">No unusual market conditions detected (Isolation Forest score ${a.score.toFixed(2)}, threshold ${a.threshold}).</p>`}

    <div class="card-hd">Top Drivers (exact linear attribution — SHAP-equivalent for this model)</div>
    <table class="tbl" style="width:100%;margin-bottom:14px"><thead><tr><th>Factor</th><th>Contribution</th></tr></thead>
    <tbody>${r.topDrivers.map(t => `<tr><td>${escapeHtml(t.feature)}</td><td style="color:${t.contribution>=0?'var(--red)':'var(--green)'}">${escapeHtml(t.label)} (${t.contribution.toFixed(2)})</td></tr>`).join('')}</tbody></table>

    <div class="card-hd">Volatility Forecast — Method Comparison (walk-forward out-of-sample MAE, lower is better)</div>
    <table class="tbl" style="width:100%;margin-bottom:14px"><thead><tr><th>Method</th><th>Current Forecast</th><th>OOS MAE</th></tr></thead>
    <tbody>${['baseline','ewma','garch','randomForest'].map(k => {
      const labels = {baseline:'Historical Average (baseline)', ewma:'EWMA (RiskMetrics)', garch:'GARCH(1,1)', randomForest:'Random Forest'};
      const isBest = k === v.bestMethod;
      return `<tr style="${isBest?'background:var(--panel2)':''}"><td>${labels[k]}${isBest?' <span class="hbdg">best OOS</span>':''}</td><td>${v.allForecasts[k]!=null?fmtPct(v.allForecasts[k]):'—'}</td><td>${v.walkForwardMAE[k]!=null?fmtPct(v.walkForwardMAE[k]):'—'}</td></tr>`;
    }).join('')}</tbody></table>

    <div class="card-hd">Model Comparison — Regime Classifier (walk-forward)</div>
    <table class="tbl" style="width:100%"><thead><tr><th>Model</th><th>OOS Accuracy</th><th>Live Prediction</th></tr></thead>
    <tbody>
      <tr style="${r.comparison.recommendedModel==='logistic'?'background:var(--panel2)':''}"><td>Logistic Regression (explainable)${r.comparison.recommendedModel==='logistic'?' <span class="hbdg">shown above</span>':''}</td><td>${fmtPct(r.comparison.logistic.walkForwardAccuracy)}</td><td>${escapeHtml(r.comparison.logistic.livePredicted)} (${fmtPct(r.comparison.logistic.liveProbability)})</td></tr>
      <tr style="${r.comparison.recommendedModel==='randomForest'?'background:var(--panel2)':''}"><td>Random Forest${r.comparison.recommendedModel==='randomForest'?' <span class="hbdg">more accurate</span>':''}</td><td>${fmtPct(r.comparison.randomForest.walkForwardAccuracy)}</td><td>${escapeHtml(r.comparison.randomForest.livePredicted)} (${fmtPct(r.comparison.randomForest.liveProbability)})</td></tr>
    </tbody></table>
    <p class="note" style="margin-top:6px">${escapeHtml(r.comparison.note)}</p>
    <p class="note" style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px">${escapeHtml(d.methodology.note)}</p>`;
}

async function runModelComparison() {
  const btn = $('#compareModelsBtn'), el = $('#modelCompareResult');
  btn.disabled = true; btn.textContent = 'Training 4 models × 4 walk-forward folds…';
  el.innerHTML = `<p class="note">Running Naive / Logistic / Neural Network / Gradient Boosting, each walk-forward validated (~2-3 seconds)…</p>`;
  try {
    const res = await fetchAuthed('/api/intelligence/model-comparison');
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Model comparison failed');
    const order = ['Naive','Logistic','NN','Gradient Boosting'];
    el.innerHTML = `
      <div class="card-hd">Model Comparison — ${d.testSamples} pooled out-of-sample predictions</div>
      <table class="tbl" style="width:100%"><thead><tr><th>Model</th><th>Accuracy</th><th>Precision</th><th>Recall</th><th>F1</th><th>ROC-AUC</th></tr></thead>
      <tbody>${order.map(name => {
        const m = d.models[name];
        return `<tr><td><b>${escapeHtml(name)}</b></td><td>${fmtPct(m.accuracy)}</td><td>${m.precision!=null?m.precision.toFixed(2):'—'}</td><td>${m.recall!=null?m.recall.toFixed(2):'—'}</td><td>${m.f1!=null?m.f1.toFixed(2):'—'}</td><td>${m.rocAuc!=null?m.rocAuc.toFixed(2):'—'}</td></tr>`;
      }).join('')}</tbody></table>
      <p class="note" style="margin-top:8px">${escapeHtml(d.note)}</p>`;
  } catch (e) {
    el.innerHTML = `<span style="color:var(--red)">⚠ ${escapeHtml(e.message)}</span>`;
  }
  btn.disabled = false; btn.textContent = 'Compare ML Models (Naive / Logistic / NN / Gradient Boosting)';
}

$('#runRegimeBtn').addEventListener('click', runRegimeAnalysis);
$('#compareModelsBtn').addEventListener('click', runModelComparison);

// ---------------- Risk Lab (real portfolio metrics + Monte Carlo, no LLM) ----------------
let riskHoldings = [];

function mountRiskSearch() {
  const input = $('#riskSymbolInput');
  const suggestBox = $('#riskSuggest');
  let debounceTimer = null, resolvedSymbol = null, resolvedName = null;
  input.addEventListener('input', () => {
    resolvedSymbol = null;
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) { suggestBox.classList.remove('open'); return; }
    debounceTimer = setTimeout(async () => {
      try {
        const res = await fetchAuthed(`/api/markets/search?q=${encodeURIComponent(q)}`);
        const results = await res.json();
        if (!results.length) { suggestBox.innerHTML = `<div style="color:var(--ink3)">No matches</div>`; suggestBox.classList.add('open'); return; }
        suggestBox.innerHTML = results.map(r => `<div data-sym="${escapeHtml(r.symbol)}" data-name="${escapeHtml(r.name)}">${escapeHtml(r.name)} <span style="color:var(--ink3)">${escapeHtml(r.symbol)}</span></div>`).join('');
        suggestBox.classList.add('open');
        suggestBox.querySelectorAll('[data-sym]').forEach(el => el.addEventListener('click', () => {
          input.value = el.dataset.name; resolvedSymbol = el.dataset.sym; resolvedName = el.dataset.name;
          suggestBox.classList.remove('open');
        }));
      } catch (e) { console.warn('risk search failed', e); }
    }, 350);
  });
  document.addEventListener('click', e => { if (!e.target.closest('#riskSymbolInput') && !e.target.closest('#riskSuggest')) suggestBox.classList.remove('open'); });

  $('#riskAddBtn').addEventListener('click', () => {
    const amount = parseFloat($('#riskAmountInput').value);
    if (!resolvedSymbol) { alert('Pick a symbol from the search suggestions first.'); return; }
    if (!(amount > 0)) { alert('Enter a positive amount.'); return; }
    riskHoldings.push({ symbol: resolvedSymbol, name: resolvedName, amountINR: amount });
    resolvedSymbol = null; input.value = ''; $('#riskAmountInput').value = '100000';
    renderRiskHoldings();
  });
}

function renderRiskHoldings() {
  const el = $('#riskHoldingsList');
  if (!riskHoldings.length) { el.innerHTML = `<p class="note">No holdings added yet.</p>`; return; }
  const total = riskHoldings.reduce((s, h) => s + h.amountINR, 0);
  el.innerHTML = `<table class="tbl" style="width:100%"><thead><tr><th>Symbol</th><th>Amount</th><th>Weight</th><th></th></tr></thead>
    <tbody>${riskHoldings.map((h, i) => `<tr><td>${escapeHtml(h.name)} <span style="color:var(--ink3);font-size:10px">${escapeHtml(h.symbol)}</span></td><td>₹${fmt(h.amountINR)}</td><td>${(h.amountINR/total*100).toFixed(1)}%</td><td><button class="btn sm" style="font-size:10px;padding:3px 8px" onclick="riskRemoveHolding(${i})">Remove</button></td></tr>`).join('')}</tbody></table>`;
}
window.riskRemoveHolding = function (i) { riskHoldings.splice(i, 1); renderRiskHoldings(); };

let lastRiskLabResult = null;
$('#riskAnalyzeBtn').addEventListener('click', async () => {
  if (riskHoldings.length < 2) { alert('Add at least 2 holdings for meaningful correlation/diversification metrics.'); return; }
  const btn = $('#riskAnalyzeBtn'), el = $('#riskResult');
  btn.disabled = true; btn.textContent = 'Fetching history & running Monte Carlo…';
  el.innerHTML = `<p class="note">Fetching a year of history per holding, computing risk metrics, running Monte Carlo simulation…</p>`;
  try {
    const res = await fetchAuthed('/api/risk-lab/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        holdings: riskHoldings.map(h => ({ symbol: h.symbol, amountINR: h.amountINR })),
        monteCarlo: { horizonDays: parseInt($('#riskHorizon').value) || 252, targetReturnPct: parseFloat($('#riskTarget').value) || 10 },
      }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Risk analysis failed');
    lastRiskLabResult = d;
    renderRiskResult(d);
    renderMorningBrief();
  } catch (e) {
    el.innerHTML = `<span style="color:var(--red)">⚠ ${escapeHtml(e.message)}</span>`;
  }
  btn.disabled = false; btn.textContent = 'Run Risk Analysis';
});

function renderRiskResult(d) {
  const m = d.metrics, mc = d.monteCarlo, c = d.concentration;
  const symbols = d.holdings.map(h => h.symbol);
  $('#riskResult').innerHTML = `
    <div class="card-hd">Portfolio Risk Metrics <span class="note">(${d.dataPoints} trading days, ${d.dateRange.from} to ${d.dateRange.to})</span></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:14px">
      ${[
        ['Annualized Return', m.annualizedReturnPct.toFixed(1)+'%', m.annualizedReturnPct>=0],
        ['Annualized Volatility', m.annualizedVolPct.toFixed(1)+'%', null],
        ['Sharpe Ratio', m.sharpeRatio!=null?m.sharpeRatio.toFixed(2):'—', m.sharpeRatio>=0],
        ['Beta (vs NIFTY)', m.beta!=null?m.beta.toFixed(2):'—', null],
        ['Max Drawdown', m.maxDrawdownPct.toFixed(1)+'%', false],
        ['VaR (95%, 1D)', m.var95Pct.toFixed(2)+'%', false],
        ['CVaR (95%, 1D)', m.cvar95Pct.toFixed(2)+'%', false],
        ['Effective # Assets', c.effectiveNumberOfAssets.toFixed(1)+' of '+c.nHoldings, null],
      ].map(([label,val,positive]) => `<div style="background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px"><div class="note">${label}</div><div style="font-family:var(--mono);font-weight:700;font-size:15px;color:${positive===true?'var(--green)':positive===false?'var(--red)':'var(--ink)'}">${val}</div></div>`).join('')}
    </div>

    <div class="card-hd">Correlation Matrix</div>
    <table class="tbl" style="width:100%;margin-bottom:14px"><thead><tr><th></th>${symbols.map(s=>`<th>${escapeHtml(s)}</th>`).join('')}</tr></thead>
    <tbody>${symbols.map(a => `<tr><td><b>${escapeHtml(a)}</b></td>${symbols.map(b => { const v=d.correlationMatrix[a][b]; const c2=a===b?'var(--ink3)':v>0.5?'var(--red)':v<-0.3?'var(--green)':'var(--ink)'; return `<td style="color:${c2}">${v.toFixed(2)}</td>`; }).join('')}</tr>`).join('')}</tbody></table>

    <div class="card-hd">Monte Carlo Simulation — ${mc.simulations} paths, ${mc.horizonDays} trading days</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:10px">
      ${[
        ['Expected Terminal Value', '₹'+fmt(mc.terminal.expected), null],
        ['5th Percentile', '₹'+fmt(mc.terminal.p5), false],
        ['Median', '₹'+fmt(mc.terminal.median), null],
        ['95th Percentile', '₹'+fmt(mc.terminal.p95), true],
        ['Probability of Loss', (mc.probabilityOfLoss*100).toFixed(1)+'%', false],
        ['Probability of Target ('+mc.targetReturnPct+'%)', (mc.probabilityOfTarget*100).toFixed(1)+'%', true],
        ['Expected Max Drawdown', mc.drawdownDistribution.mean.toFixed(1)+'%', false],
        ['Worst-case (95th %ile) Drawdown', mc.drawdownDistribution.p95worst.toFixed(1)+'%', false],
      ].map(([label,val,positive]) => `<div style="background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px"><div class="note">${label}</div><div style="font-family:var(--mono);font-weight:700;font-size:14px;color:${positive===true?'var(--green)':positive===false?'var(--red)':'var(--ink)'}">${val}</div></div>`).join('')}
    </div>
    <div class="chart" id="chartMonteCarlo" style="height:160px"></div>
    <p class="note" style="margin-top:8px">${escapeHtml(mc.methodology)}</p>`;

  const ch = chart('chartMonteCarlo');
  const labels = ['5th percentile', 'Median', 'Expected', '95th percentile'];
  const values = [mc.terminal.p5, mc.terminal.median, mc.terminal.expected, mc.terminal.p95];
  ch.setOption({
    backgroundColor: 'transparent',
    grid: { left: 100, right: 40, top: 10, bottom: 20 },
    tooltip: { formatter: p => `₹${fmt(p[0].value)}` },
    xAxis: { type: 'value', axisLabel: { color: '#5c6472', fontSize: 9, formatter: v => '₹'+(v/100000).toFixed(1)+'L' }, splitLine: { lineStyle: { color: '#1a1f29' } } },
    yAxis: { type: 'category', data: labels, axisLabel: { color: '#9aa3b2', fontSize: 10 } },
    series: [{ type: 'bar', data: values, itemStyle: { color: (p) => labels[p.dataIndex]==='95th percentile' ? '#33c17f' : labels[p.dataIndex]==='5th percentile' ? '#ef5350' : '#5b9bf0' },
      label: { show: true, position: 'right', formatter: p => '₹'+fmt(p.value), color: '#9aa3b2', fontSize: 10 },
      markLine: { silent: true, symbol: 'none', lineStyle: { color: '#e9ebef', type: 'dashed' }, label: { formatter: 'Initial: ₹'+fmt(mc.initialValue), color: '#9aa3b2', fontSize: 9 }, data: [{ xAxis: mc.initialValue }] } }],
  });
}
mountRiskSearch();

// ---------------- Morning Investment Committee Brief (aggregates existing session data - no new computation) ----------------
function renderMorningBrief() {
  const grid = $('#morningBriefGrid');
  if (!grid) return;

  const regime = lastRegimeResult;
  const niftyIdx = latestSnapshot?.india?.items?.find(i => i.symbol === '^NSEI');
  const globalItems = latestSnapshot?.global?.items || [];
  const globalNegCount = globalItems.filter(i => (i.changePct ?? 0) < 0).length;
  const globalCue = globalItems.length ? (globalNegCount > globalItems.length / 2 ? 'Negative' : 'Positive') : '—';
  const usdinr = latestSnapshot?.fx?.items?.find(f => f.symbol === 'USDINR=X');
  const usdinrStance = usdinr ? (usdinr.changePct >= 0 ? 'Risk-off (Rupee weaker)' : 'Risk-on (Rupee stronger)') : '—';
  const gold = latestSnapshot?.commodities?.items?.find(c => c.symbol === 'GC=F');
  const goldMomentum = gold ? (gold.changePct >= 0 ? 'Positive' : 'Negative') : '—';
  const oil = latestSnapshot?.commodities?.items?.find(c => c.symbol === 'CL=F');
  const newsCount = latestSnapshot?.news?.items?.length ?? 0;

  const forecasts = Object.values(workerOutputs).map(o => o.forecast?.view).filter(Boolean);
  const bullCount = forecasts.filter(v => v === 'bullish').length, bearCount = forecasts.filter(v => v === 'bearish').length;
  const aiConsensus = forecasts.length === 0 ? 'Not yet run' : bullCount > bearCount ? 'Constructive' : bearCount > bullCount ? 'Reduce aggressive exposure' : 'Mixed / neutral';

  const cards = [
    ['Market Regime', regime ? regime.regime.current : 'Not yet run', regime ? regimeColor(regime.regime.current) : 'var(--ink3)'],
    ['NIFTY Bias', niftyIdx ? (niftyIdx.changePct >= 0 ? 'Constructive' : 'Cautious') + ` (${niftyIdx.changePct?.toFixed(2)}%)` : '—', niftyIdx ? (niftyIdx.changePct>=0?'var(--green)':'var(--red)') : 'var(--ink3)'],
    ['Global Cues', globalCue, globalCue === 'Negative' ? 'var(--red)' : globalCue === 'Positive' ? 'var(--green)' : 'var(--ink3)'],
    ['USD/INR', usdinrStance, usdinrStance.includes('Risk-off') ? 'var(--red)' : usdinrStance.includes('Risk-on') ? 'var(--green)' : 'var(--ink3)'],
    ['Gold Momentum', goldMomentum, goldMomentum === 'Positive' ? 'var(--green)' : 'var(--red)'],
    ['Oil (WTI)', oil ? `$${fmt(oil.price)} (${oil.changePct>=0?'+':''}${oil.changePct?.toFixed(1)}%)` : '—', 'var(--ink)'],
    ['Overnight News', newsCount + ' items', 'var(--ink)'],
    ['Portfolio Risk', lastRiskLabResult ? `Sharpe ${lastRiskLabResult.metrics.sharpeRatio?.toFixed(2) ?? '—'}` : 'Not yet run', 'var(--ink)'],
    ['Options Signal', 'Not available (needs broker API — see README)', 'var(--ink3)'],
    ['AI Consensus', aiConsensus, aiConsensus==='Constructive'?'var(--green)':aiConsensus==='Reduce aggressive exposure'?'var(--red)':'var(--ink3)'],
  ];
  grid.innerHTML = cards.map(([label, val, color]) => `<div style="background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px"><div class="note">${label}</div><div style="font-weight:700;font-size:13px;color:${color};margin-top:2px">${escapeHtml(String(val))}</div></div>`).join('');
}

$('#briefEvidenceBtn').addEventListener('click', () => { $('#card-w1')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
$('#briefAskBtn').addEventListener('click', () => { $('#chatInput')?.focus(); $('#chatInput')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
$('#briefStressBtn').addEventListener('click', () => { $('#riskAnalyzeBtn')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
$('#briefReportBtn').addEventListener('click', () => {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let y = 18;
  doc.setFontSize(16); doc.setFont(undefined, 'bold'); doc.text('Chief Finance Wiz — Morning Intelligence Brief', 14, y); y += 6;
  doc.setFontSize(9); doc.setFont(undefined, 'normal'); doc.setTextColor(120);
  doc.text(`Generated ${new Date().toLocaleString('en-IN')}`, 14, y); y += 10;
  doc.setTextColor(20);

  const rows = [];
  document.querySelectorAll('#morningBriefGrid > div').forEach(card => {
    const label = card.querySelector('.note')?.textContent || '';
    const val = card.children[1]?.textContent || '';
    rows.push([label, val]);
  });
  doc.autoTable({ startY: y, head: [['Metric', 'Value']], body: rows, styles: { fontSize: 9 }, headStyles: { fillColor: [17,21,28] }, margin: { left: 14, right: 14 } });
  y = doc.lastAutoTable.finalY + 10;

  const workerRows = Object.entries(workerOutputs).filter(([, o]) => o.headline).map(([id, o]) => [id.toUpperCase(), o.headline, o.forecast ? `${o.forecast.view} → ${o.forecast.target}` : '—']);
  if (workerRows.length) {
    if (y > 240) { doc.addPage(); y = 18; }
    doc.setFontSize(11); doc.setFont(undefined, 'bold'); doc.text('Agent Summaries', 14, y); y += 5;
    doc.autoTable({ startY: y, head: [['Worker', 'Headline', 'Forecast']], body: workerRows, styles: { fontSize: 8 }, headStyles: { fillColor: [17,21,28] }, margin: { left: 14, right: 14 } });
  }
  doc.setFontSize(8); doc.setTextColor(140);
  doc.text('Generated by Chief Finance Wiz — for research/demo purposes, not licensed investment advice.', 14, 290);
  doc.save(`morning_brief_${new Date().toISOString().slice(0,10)}.pdf`);
});

// ---------------- Init ----------------
$('#refreshBtn').addEventListener('click', () => loadSnapshot().then(buildTape));
function scheduleNextRefresh() {
  const delay = (isIndiaMarketOpen() || isIndiaCommodityMarketOpen()) ? 15000 : 30000;
  setTimeout(async () => { await loadSnapshot(); buildTape(); scheduleNextRefresh(); }, delay);
}
async function init() {
  pushChat('cfw', `Good day. I'm online and pulling live data now — indices, bullion, FX, and crypto refresh every 15 seconds while NSE/BSE is open (every 30s otherwise). Click "Run all 6 agents now" on the left to get a full real-time briefing, or run agents individually below.`);
  await loadSnapshot(); // now also calls renderMorningBrief() internally, and on every subsequent refresh
  buildTape();
  await loadConverter();
  await loadRoster();
  scheduleNextRefresh();
}
init();
