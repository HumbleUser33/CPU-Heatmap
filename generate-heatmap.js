#!/usr/bin/env node
// Usage: node generate-heatmap.js <capframex.json> [output.html]

const fs = require('fs');
const path = require('path');

// ── Args ──────────────────────────────────────────────────────
const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: node generate-heatmap.js <capframex.json> [output.html]');
  process.exit(1);
}
const outputFile = process.argv[3] || inputFile.replace(/\.json$/i, '-heatmap.html');

// ── Parse JSON ────────────────────────────────────────────────
let raw = fs.readFileSync(inputFile, 'utf8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const data = JSON.parse(raw);

const info = data.Info;
const run = data.Runs[0];
const sd2 = run.SensorData2;
const timeIntervals = sd2.BetweenMeasureTime.Values;

// ══════════════════════════════════════════════════════════════
// HELPER: build histogram for one series of values
// ══════════════════════════════════════════════════════════════
function buildHistogram(values, timeIntervals, bucketMin, bucketMax, step) {
  const numBuckets = Math.round((bucketMax - bucketMin) / step) + 1;
  const hist = new Array(numBuckets).fill(0);
  for (let i = 0; i < values.length; i++) {
    const idx = Math.round((values[i] - bucketMin) / step);
    const clamped = Math.max(0, Math.min(numBuckets - 1, idx));
    hist[clamped] += timeIntervals[i];
  }
  return hist;
}

// ══════════════════════════════════════════════════════════════
// 1. THREAD LOAD (16 threads, 0-100%, step 1)
// ══════════════════════════════════════════════════════════════
const threadLoadRows = [];
for (const [key, sensor] of Object.entries(sd2)) {
  if (sensor.Type !== 'Load') continue;
  const match = sensor.Name.match(/Core #(\d+)\s+Thread #(\d+)/);
  if (!match) continue;
  threadLoadRows.push({
    name: sensor.Name.trim(),
    coreNum: parseInt(match[1]),
    threadNum: parseInt(match[2]),
    values: sensor.Values,
    sortKey: parseInt(match[1]) * 10 + parseInt(match[2]),
  });
}
threadLoadRows.sort((a, b) => a.sortKey - b.sortKey);

// Compute weighted average load per thread
const totalTime = timeIntervals.reduce((a, b) => a + b, 0);
for (const t of threadLoadRows) {
  t.avgLoad = Math.round(t.values.reduce((sum, v, j) => sum + v * timeIntervals[j], 0) / totalTime * 10) / 10;
}

const threadLoadChart = {
  title: 'CPU Thread Load',
  unit: '%',
  bucketMin: 0, bucketMax: 100, step: 1,
  rows: threadLoadRows.map(t => ({
    label: `Core ${t.coreNum} T${t.threadNum}`,
    name: t.name,
    hist: buildHistogram(t.values, timeIntervals, 0, 100, 1),
    avgLoad: t.avgLoad,
  })),
};

// ══════════════════════════════════════════════════════════════
// 2. CORE FREQUENCY (8 cores, MHz, step 10)
// ══════════════════════════════════════════════════════════════
const clockRows = [];
for (const [key, sensor] of Object.entries(sd2)) {
  if (sensor.Type !== 'Clock') continue;
  const match = sensor.Name.match(/Core #(\d+)$/);
  if (!match) continue;
  clockRows.push({
    name: sensor.Name.trim(),
    coreNum: parseInt(match[1]),
    values: sensor.Values,
  });
}
clockRows.sort((a, b) => a.coreNum - b.coreNum);

// Determine range across all cores
let clockAllVals = clockRows.flatMap(r => r.values);
const clockMin = Math.floor(Math.min(...clockAllVals) / 100) * 100; // round down to 100
const clockMax = Math.ceil(Math.max(...clockAllVals) / 100) * 100;  // round up to 100
const clockStep = 10;

const coreFreqChart = {
  title: 'Core Frequency',
  unit: 'MHz',
  bucketMin: clockMin, bucketMax: clockMax, step: clockStep,
  rows: clockRows.map(c => ({
    label: `Core ${c.coreNum}`,
    name: c.name,
    hist: buildHistogram(c.values, timeIntervals, clockMin, clockMax, clockStep),
  })),
};

// ══════════════════════════════════════════════════════════════
// 3. L3 CACHE HIT RATE (single row, 0-100%, step 1)
// ══════════════════════════════════════════════════════════════
const l3Sensor = Object.values(sd2).find(s => s.Name && s.Name.includes('L3 Hit Rate'));
let l3Chart = null;
if (l3Sensor) {
  l3Chart = {
    title: 'L3 Cache Hit Rate',
    unit: '%',
    bucketMin: 0, bucketMax: 100, step: 1,
    rows: [{
      label: 'L3 Hit Rate',
      name: l3Sensor.Name,
      hist: buildHistogram(l3Sensor.Values, timeIntervals, 0, 100, 1),
    }],
  };
} else {
  console.warn('  ⚠ No L3 Hit Rate sensor found — skipping chart');
}

// ══════════════════════════════════════════════════════════════
// 4. CPU POWER (single row, Watts, step 0.5)
// ══════════════════════════════════════════════════════════════
const pwrSensor = Object.values(sd2).find(s => s.Type === 'Power' && s.Name && s.Name.includes('CPU'));
let cpuPowerChart = null;
if (pwrSensor) {
  const pwrVals = pwrSensor.Values;
  const pwrMin = Math.floor(Math.min(...pwrVals) / 5) * 5;  // round down to 5W
  const pwrMax = Math.ceil(Math.max(...pwrVals) / 5) * 5;   // round up to 5W
  const pwrStep = 0.5;
  cpuPowerChart = {
    title: 'CPU Package Power',
    unit: 'W',
    bucketMin: pwrMin, bucketMax: pwrMax, step: pwrStep,
    rows: [{
      label: 'CPU Power',
      name: pwrSensor.Name,
      hist: buildHistogram(pwrVals, timeIntervals, pwrMin, pwrMax, pwrStep),
    }],
  };
} else {
  console.warn('  ⚠ No CPU Power sensor found — skipping chart');
}

// ══════════════════════════════════════════════════════════════
// 5. DRAM BANDWIDTH (single row, GB/s, step 0.1)
// ══════════════════════════════════════════════════════════════
const dramSensor = Object.values(sd2).find(s => s.Name && s.Name.includes('DRAM Bandwidth'));
let dramBwChart = null;
if (dramSensor) {
  const dramVals = dramSensor.Values;
  const dramMin = Math.floor(Math.min(...dramVals));
  const dramMax = Math.ceil(Math.max(...dramVals));
  const dramStep = 0.1;
  dramBwChart = {
    title: 'DRAM Bandwidth',
    unit: 'GB/s',
    bucketMin: dramMin, bucketMax: dramMax, step: dramStep,
    rows: [{
      label: 'DRAM BW',
      name: dramSensor.Name,
      hist: buildHistogram(dramVals, timeIntervals, dramMin, dramMax, dramStep),
    }],
  };
} else {
  console.warn('  ⚠ No DRAM Bandwidth sensor found — skipping chart');
}

// ══════════════════════════════════════════════════════════════
// Compute globalMax per chart, round values
// ══════════════════════════════════════════════════════════════
const allCharts = [threadLoadChart, coreFreqChart, l3Chart, cpuPowerChart, dramBwChart].filter(Boolean);

for (const chart of allCharts) {
  let gmax = 0;
  for (const row of chart.rows) {
    for (const v of row.hist) if (v > gmax) gmax = v;
    // round to 4 decimals
    row.hist = row.hist.map(v => Math.round(v * 10000) / 10000);
  }
  chart.globalMax = Math.round(gmax * 10000) / 10000;
}

// ══════════════════════════════════════════════════════════════
// Build embedded data — structured for dashboard layout
// ══════════════════════════════════════════════════════════════

// Group thread load rows by core for interleaving
const loadByCore = {};
for (const row of threadLoadChart.rows) {
  const coreMatch = row.label.match(/Core (\d+)/);
  if (!coreMatch) continue;
  const cn = parseInt(coreMatch[1]);
  if (!loadByCore[cn]) loadByCore[cn] = [];
  loadByCore[cn].push(row);
}

// Build interleaved core groups: [freq, loadT1, loadT2] per core
const coreGroups = [];
for (const freqRow of coreFreqChart.rows) {
  const cn = freqRow.label.match(/Core (\d+)/);
  if (!cn) continue;
  const coreNum = parseInt(cn[1]);
  const loadRows = loadByCore[coreNum] || [];
  coreGroups.push({ coreNum, freqRow, loadRows });
}

const embedded = {
  info: {
    gameName: info.GameName,
    processor: info.Processor,
    gpu: info.GPU,
    duration: Math.round(totalTime * 10) / 10,
  },
  freq: {
    unit: coreFreqChart.unit,
    bucketMin: coreFreqChart.bucketMin,
    bucketMax: coreFreqChart.bucketMax,
    step: coreFreqChart.step,
    globalMax: coreFreqChart.globalMax,
  },
  load: {
    unit: threadLoadChart.unit,
    bucketMin: threadLoadChart.bucketMin,
    bucketMax: threadLoadChart.bucketMax,
    step: threadLoadChart.step,
    globalMax: threadLoadChart.globalMax,
  },
  coreGroups: coreGroups.map(g => ({
    coreNum: g.coreNum,
    freqRow: { label: g.freqRow.label, name: g.freqRow.name, hist: g.freqRow.hist },
    loadRows: g.loadRows.map(r => ({ label: r.label, name: r.name, hist: r.hist, avgLoad: r.avgLoad })),
  })),
  power: cpuPowerChart ? {
    unit: cpuPowerChart.unit,
    bucketMin: cpuPowerChart.bucketMin,
    bucketMax: cpuPowerChart.bucketMax,
    step: cpuPowerChart.step,
    globalMax: cpuPowerChart.globalMax,
    hist: cpuPowerChart.rows[0].hist,
    name: cpuPowerChart.rows[0].name,
  } : null,
  l3: l3Chart ? {
    unit: l3Chart.unit,
    bucketMin: l3Chart.bucketMin,
    bucketMax: l3Chart.bucketMax,
    step: l3Chart.step,
    globalMax: l3Chart.globalMax,
    hist: l3Chart.rows[0].hist,
    name: l3Chart.rows[0].name,
  } : null,
  dram: dramBwChart ? {
    unit: dramBwChart.unit,
    bucketMin: dramBwChart.bucketMin,
    bucketMax: dramBwChart.bucketMax,
    step: dramBwChart.step,
    globalMax: dramBwChart.globalMax,
    hist: dramBwChart.rows[0].hist,
    name: dramBwChart.rows[0].name,
  } : null,
};

// ══════════════════════════════════════════════════════════════
// Generate HTML — combined dashboard layout
// ══════════════════════════════════════════════════════════════
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CPU Heatmap — ${embedded.info.gameName}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1a1a2e;
    color: #e0e0e0;
    font-family: 'Segoe UI', Consolas, monospace;
    padding: 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  h1 { text-align: center; margin-bottom: 5px; font-size: 36px; color: #fff; }
  .subtitle { text-align: center; margin-bottom: 20px; font-size: 22px; color: #888; }

  /* ── Grid: [pwr-labels][pwr-bar][core-labels][center][l3-vlabel][l3-bar][dram-vlabel][dram-bar][dram-labels] */
  .dashboard {
    display: grid;
    grid-template-columns: 45px 50px 50px 38px minmax(0,1fr) 28px 50px 28px 50px 50px;
    grid-template-rows: auto 1fr auto;
    gap: 0;
    max-width: 1200px;
    width: 100%;
    overflow: hidden;
    background: #16213e;
    border-radius: 10px;
    padding: 20px;
  }

  /* ── Top freq axis ─── col 4 row 1 */
  .top-axis { grid-column: 5; grid-row: 1; position: relative; height: 32px; margin-bottom: 4px; }
  .top-axis span { position: absolute; transform: translateX(-50%); font-size: 18px; color: #7ab8f5; white-space: nowrap; }

  /* ── Power scale labels (left) ─── col 1 row 2 */
  .power-scale {
    grid-column: 1; grid-row: 2;
    display: flex; flex-direction: column; justify-content: space-between;
    align-items: flex-end; padding-right: 3px;
    font-size: 16px; color: #f5a0a0; text-align: center;
  }
  .power-scale span { left: 0; right: 0; text-align: center; }

  /* ── Power bar ─── col 2 row 2 */
  .power-col {
    grid-column: 2; grid-row: 2;
    display: flex; flex-direction: column-reverse;
    border-radius: 4px; overflow: hidden; margin-right: 1px;
    background: rgba(190,65,65,0.30);
  }
  .power-col .vcell { flex: 1; min-height: 0; }

  /* ── Core labels ─── col 3 row 2 */
  .core-labels { grid-column: 3; grid-row: 2; display: flex; flex-direction: column; }
  .core-label-group {
    display: flex; flex-direction: column; justify-content: start;
    align-items: flex-end; padding-right: 5px;
  }
  .cl-core { font-size: 20px; color: #ccc; font-weight: bold; line-height: 27px; }
  .cl-thread { font-size: 16px; color: #999; line-height: 27px; margin-top: 0; }

  /* ── Avg load squares ─── col 4 row 2 */
  .avg-load-col { grid-column: 4; grid-row: 2; display: flex; flex-direction: column; padding-left: 2px; }
  .avg-load-group { margin-bottom: 3px; }
  .avg-load-spacer { height: 26px; margin-bottom: 1px; }
  .avg-load-square {
    width: 36px; height: 26px; margin-bottom: 1px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: bold; color: #fff;
    border-radius: 2px;
    text-shadow: 0 0 3px rgba(0,0,0,0.8);
  }

  /* ── Center body ─── col 4 row 2 */
  .center-body { grid-column: 5; grid-row: 2; display: flex; flex-direction: column; }
  .hbar { display: flex; overflow: hidden; border-radius: 2px; }
  .hbar.freq-bar { background: rgba(30,60,130,0.50); }
  .hbar.load-bar { background: rgba(25,90,40,0.40); }
  .hcell { flex: 1; min-width: 0; }
  .core-group { margin-bottom: 3px; }
  .core-group .hbar { height: 26px; margin-bottom: 1px; }

  /* ── L3 vertical label ─── col 5 row 2 */
  .l3-vlabel {
    grid-column: 6; grid-row: 2;
    writing-mode: vertical-rl; text-orientation: mixed;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; color: #c4a8e0; font-weight: bold;
    transform: rotate(180deg);
    padding: 0 1px;
  }
  /* ── L3 outer wrapper ─── col 6 row 2 */
  .l3-outer {
    grid-column: 7; grid-row: 2;
    position: relative;
  }
  .l3-scale-label {
    position: absolute; left: 50%; transform: translateX(-50%);
    font-size: 18px; color: #c4a8e0; white-space: nowrap;
  }
  /* ── L3 bar ─── */
  .l3-col {
    display: flex; flex-direction: column-reverse;
    border-radius: 4px; overflow: hidden;
    background: rgba(80,30,120,0.45);
    height: 100%;
  }
  .l3-col .vcell { flex: 1; min-height: 0; }

  /* ── DRAM vertical label ─── col 7 row 2 */
  .dram-vlabel {
    grid-column: 8; grid-row: 2;
    writing-mode: vertical-rl; text-orientation: mixed;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; color: #c0a0e0; font-weight: bold;
    transform: rotate(180deg);
    margin-left: 4px; padding: 0 1px;
  }
  /* ── DRAM bar ─── col 8 row 2 */
  .dram-col {
    grid-column: 9; grid-row: 2;
    display: flex; flex-direction: column-reverse;
    border-radius: 4px; overflow: hidden;
    background: rgba(140,100,200,0.30);
  }
  .dram-col .vcell { flex: 1; min-height: 0; }

  /* ── DRAM scale labels (right) ─── col 9 row 2 */
  .dram-scale {
    grid-column: 10; grid-row: 2;
    display: flex; flex-direction: column; justify-content: space-between;
    align-items: flex-start; padding-left: 3px;
    font-size: 16px; color: #c0a0e0; text-align: center;
  }
  .dram-scale span { left: 0; right: 0; text-align: center; }

  /* ── Bottom axes row ─── row 3 */
  .bottom-axis { grid-column: 5; grid-row: 3; position: relative; height: 32px; margin-top: 4px; }
  .bottom-axis span { position: absolute; transform: translateX(-50%); font-size: 18px; color: #8fd48f; white-space: nowrap; }
  .bottom-spacer { grid-column: 1 / 5; grid-row: 3; }
  .bottom-right-spacer { grid-column: 6 / 11; grid-row: 3; }

  /* ── Legend ──────────────────────────────────────── */
  .legend-bar {
    display: flex; align-items: center; justify-content: center;
    gap: 14px; margin-top: 16px; font-size: 20px; color: #aaa; flex-wrap: wrap;
  }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-swatch { width: 20px; height: 20px; border-radius: 3px; border: 1px solid #555; }
  .legend-gradient-wrap { display: flex; align-items: center; gap: 6px; margin-left: 20px; }
  .legend-gradient { border-radius: 3px; }

  /* ── Tooltip ────────────────────────────────────── */
  .tooltip {
    position: fixed; background: rgba(0,0,0,0.92); color: #fff;
    padding: 8px 14px; border-radius: 4px; font-size: 18px;
    pointer-events: none; display: none; z-index: 999;
    border: 1px solid #444;
  }
</style>
</head>
<body>

<h1>CPU Sensor Heatmap</h1>
<div class="subtitle">${embedded.info.gameName} | ${embedded.info.processor} | ${embedded.info.gpu} | ${embedded.info.duration} sec</div>

<div class="dashboard" id="dashboard"></div>
<div class="legend-bar" id="legend"></div>
<div class="tooltip" id="tooltip"></div>

<script>
const DATA = ${JSON.stringify(embedded)};

function heatColor(value, max) {
  if (max === 0 || value === 0) return 'rgba(0,0,0,0)';
  const t = value / max;
  let r, g, b;
  if (t < 0.5) { const u = t/0.5; r = Math.round(u*255); g = Math.round(180-u*15); b = 0; }
  else { const u = (t-0.5)/0.5; r = Math.round(255-u*35); g = Math.round(165-u*145); b = 0; }
  return 'rgba('+r+','+g+','+b+','+(0.3+0.7*t)+')';
}

function formatVal(v, unit, step) {
  if (step >= 1) return Math.round(v) + ' ' + unit;
  return v.toFixed(step < 0.1 ? 2 : 1) + ' ' + unit;
}

function niceAxisLabels(bMin, bMax, count) {
  const range = bMax - bMin;
  const rawStep = range / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const ns = [1,2,5,10].map(m => m*mag).find(c => c >= rawStep) || mag*10;
  const labels = [];
  for (let v = Math.ceil(bMin/ns)*ns; v <= bMax; v += ns)
    labels.push({ value: v, pct: (v-bMin)/range*100 });
  return labels;
}

// ── Vertical scale labels (evenly spaced) ──────────
function makeVScale(cssClass, bMin, bMax, unit, step, count, opts) {
  opts = opts || {};
  const div = document.createElement('div');
  div.className = cssClass;
  const labels = niceAxisLabels(bMin, bMax, count);
  for (let i = labels.length - 1; i >= 0; i--) {
    const s = document.createElement('span');
    if (opts.multiLine) {
      s.innerHTML = Math.round(labels[i].value) + '<br>' + unit;
      s.style.display = 'inline-block';
      s.style.textAlign = 'center';
      s.style.lineHeight = '1.1';
    } else {
      s.textContent = formatVal(labels[i].value, unit, step);
    }
    s.style.position = 'absolute';
    s.style.bottom = labels[i].pct + '%';
    s.style.transform = 'translateY(50%)';
    div.appendChild(s);
  }
  div.style.position = 'relative';
  return div;
}

const tooltip = document.getElementById('tooltip');
function wireTooltip(el) {
  el.addEventListener('mouseover', function(e) {
    const c = e.target;
    if (c.dataset.val && parseFloat(c.dataset.val) > 0) {
      tooltip.style.display = 'block';
      tooltip.innerHTML = c.dataset.name + '<br>@ ' + c.dataset.bv + ' : ' + c.dataset.val + 's';
    }
  });
  el.addEventListener('mousemove', function(e) {
    tooltip.style.left = (e.clientX+12)+'px'; tooltip.style.top = (e.clientY-30)+'px';
  });
  el.addEventListener('mouseout', function() { tooltip.style.display = 'none'; });
}

function makeHBar(hist, globalMax, chartInfo, cssClass) {
  const bar = document.createElement('div');
  bar.className = 'hbar ' + cssClass;
  for (let i = 0; i < hist.length; i++) {
    const cell = document.createElement('div');
    cell.className = 'hcell';
    cell.style.backgroundColor = heatColor(hist[i], globalMax);
    const bv = chartInfo.bucketMin + i * chartInfo.step;
    cell.dataset.name = chartInfo.rowName || '';
    cell.dataset.bv = formatVal(bv, chartInfo.unit, chartInfo.step);
    cell.dataset.val = hist[i].toFixed(3);
    bar.appendChild(cell);
  }
  wireTooltip(bar);
  return bar;
}

function makeVCol(hist, globalMax, chartInfo, cssClass) {
  const col = document.createElement('div');
  col.className = cssClass;
  for (let i = 0; i < hist.length; i++) {
    const cell = document.createElement('div');
    cell.className = 'vcell';
    cell.style.backgroundColor = heatColor(hist[i], globalMax);
    const bv = chartInfo.bucketMin + i * chartInfo.step;
    cell.dataset.name = chartInfo.name || '';
    cell.dataset.bv = formatVal(bv, chartInfo.unit, chartInfo.step);
    cell.dataset.val = hist[i].toFixed(3);
    col.appendChild(cell);
  }
  wireTooltip(col);
  return col;
}

function makeAxis(cssClass, bMin, bMax, unit, step, count, color) {
  const div = document.createElement('div');
  div.className = cssClass;
  let labels = niceAxisLabels(bMin, bMax, count);

  // Anti-overlap: ensure minimum percentage gap between adjacent labels
  if (labels.length > 2) {
    const minGap = 8;
    const kept = [labels[0]];
    for (let i = 1; i < labels.length - 1; i++) {
      if (labels[i].pct - kept[kept.length - 1].pct >= minGap) {
        kept.push(labels[i]);
      }
    }
    const last = labels[labels.length - 1];
    if (kept.length > 1 && last.pct - kept[kept.length - 1].pct < minGap) {
      kept.pop(); // remove second-to-last if too close to last
    }
    kept.push(last);
    labels = kept;
  }

  for (let idx = 0; idx < labels.length; idx++) {
    const l = labels[idx];
    const s = document.createElement('span');
    s.style.color = color;
    s.textContent = formatVal(l.value, unit, step);
    s.style.left = l.pct + '%';
    // Edge labels: clamp alignment to stay within bar boundaries
    if (l.pct <= 2) {
      s.style.transform = 'translateX(0)';       // left-align at start
    } else if (l.pct >= 98) {
      s.style.transform = 'translateX(-100%)';   // right-align at end
    }
    // else: CSS default translateX(-50%) centers the label
    div.appendChild(s);
  }
  return div;
}

// ══════════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════════
(function() {
  const db = document.getElementById('dashboard');

  // ── Row 1: Top freq axis (col 4) ──
  const topAx = makeAxis('top-axis', DATA.freq.bucketMin, DATA.freq.bucketMax,
    DATA.freq.unit, DATA.freq.step, 8, '#7ab8f5');
  db.appendChild(topAx);

  // ── Row 2: Power scale (col 1) ──
  if (DATA.power) {
    db.appendChild(makeVScale('power-scale', DATA.power.bucketMin, DATA.power.bucketMax,
      DATA.power.unit, DATA.power.step, 10, { multiLine: true }));
    db.appendChild(makeVCol(DATA.power.hist, DATA.power.globalMax, DATA.power, 'power-col'));
  } else {
    db.appendChild(document.createElement('div'));
    db.appendChild(document.createElement('div'));
  }

  // ── Row 2: Core labels (col 3) + Center body (col 4) ──
  const coreLabelsCol = document.createElement('div');
  coreLabelsCol.className = 'core-labels';
  const center = document.createElement('div');
  center.className = 'center-body';

  for (const group of DATA.coreGroups) {
    const gDiv = document.createElement('div');
    gDiv.className = 'core-group';

    // Frequency bar
    gDiv.appendChild(makeHBar(group.freqRow.hist, DATA.freq.globalMax, {
      bucketMin: DATA.freq.bucketMin, bucketMax: DATA.freq.bucketMax,
      step: DATA.freq.step, unit: DATA.freq.unit, rowName: group.freqRow.name
    }, 'freq-bar'));

    // Load bars
    for (const lr of group.loadRows) {
      gDiv.appendChild(makeHBar(lr.hist, DATA.load.globalMax, {
        bucketMin: DATA.load.bucketMin, bucketMax: DATA.load.bucketMax,
        step: DATA.load.step, unit: DATA.load.unit, rowName: lr.name
      }, 'load-bar'));
    }
    center.appendChild(gDiv);

    // Core label group: C1 / Th1 / Th2
    const lbl = document.createElement('div');
    lbl.className = 'core-label-group';
    const totalRows = 1 + group.loadRows.length;
    lbl.style.height = (totalRows * 27 + 3) + 'px';

    const cTxt = document.createElement('span');
    cTxt.className = 'cl-core';
    cTxt.textContent = 'C' + group.coreNum;
    lbl.appendChild(cTxt);

    for (let t = 0; t < group.loadRows.length; t++) {
      const tTxt = document.createElement('span');
      tTxt.className = 'cl-thread';
      tTxt.textContent = 'Th' + (t + 1);
      lbl.appendChild(tTxt);
    }
    coreLabelsCol.appendChild(lbl);
  }

  db.appendChild(coreLabelsCol);

  // ── Row 2: Avg load squares (col 4) ──
  const avgLoadCol = document.createElement('div');
  avgLoadCol.className = 'avg-load-col';
  for (const group of DATA.coreGroups) {
    const grpDiv = document.createElement('div');
    grpDiv.className = 'avg-load-group';
    // Spacer for freq row
    const spacer = document.createElement('div');
    spacer.className = 'avg-load-spacer';
    grpDiv.appendChild(spacer);
    for (const lr of group.loadRows) {
      const sq = document.createElement('div');
      sq.className = 'avg-load-square';
      const pct = lr.avgLoad;
      sq.textContent = Math.round(pct) + '%';
      sq.style.backgroundColor = pct > 0 ? heatColor(pct, 100) : 'rgba(0,180,0,0.35)';
      grpDiv.appendChild(sq);
    }
    avgLoadCol.appendChild(grpDiv);
  }
  db.appendChild(avgLoadCol);

  db.appendChild(center);

  // ── Row 2: L3 vertical label (col 5) + L3 bar (col 6) ──
  if (DATA.l3) {
    const l3VL = document.createElement('div');
    l3VL.className = 'l3-vlabel';
    l3VL.textContent = 'L3 Cache Hit Rate';
    db.appendChild(l3VL);
    const l3Outer = document.createElement('div');
    l3Outer.className = 'l3-outer';
    l3Outer.appendChild(makeVCol(DATA.l3.hist, DATA.l3.globalMax, DATA.l3, 'l3-col'));
    const l3Top = document.createElement('span');
    l3Top.className = 'l3-scale-label';
    l3Top.textContent = '100%';
    l3Top.style.top = '-24px';
    l3Outer.appendChild(l3Top);
    const l3Bot = document.createElement('span');
    l3Bot.className = 'l3-scale-label';
    l3Bot.textContent = '0%';
    l3Bot.style.bottom = '-24px';
    l3Outer.appendChild(l3Bot);
    db.appendChild(l3Outer);
  } else {
    db.appendChild(document.createElement('div'));
    db.appendChild(document.createElement('div'));
  }

  // ── Row 2: DRAM vertical label (col 7) + DRAM bar (col 8) + DRAM scale (col 9) ──
  if (DATA.dram) {
    const dVL = document.createElement('div');
    dVL.className = 'dram-vlabel';
    dVL.textContent = 'DRAM Bandwidth';
    db.appendChild(dVL);
    db.appendChild(makeVCol(DATA.dram.hist, DATA.dram.globalMax, DATA.dram, 'dram-col'));
    db.appendChild(makeVScale('dram-scale', DATA.dram.bucketMin, DATA.dram.bucketMax,
      DATA.dram.unit, DATA.dram.step, 6, { multiLine: true }));
  } else {
    db.appendChild(document.createElement('div'));
    db.appendChild(document.createElement('div'));
    db.appendChild(document.createElement('div'));
  }

  // ── Row 3: Bottom axis ──
  const bSpacer = document.createElement('div');
  bSpacer.className = 'bottom-spacer';
  db.appendChild(bSpacer);
  db.appendChild(makeAxis('bottom-axis', DATA.load.bucketMin, DATA.load.bucketMax,
    DATA.load.unit, DATA.load.step, 10, '#8fd48f'));
  const brSpacer = document.createElement('div');
  brSpacer.className = 'bottom-right-spacer';
  db.appendChild(brSpacer);

  // ── Legend ──
  const legend = document.getElementById('legend');
  const items = [
    { color: 'rgba(30,60,130,0.70)', label: 'Frequency (MHz)' },
    { color: 'rgba(25,90,40,0.60)', label: 'Thread Load (%)' },
  ];
  if (DATA.power) items.push({ color: 'rgba(190,65,65,0.55)', label: 'CPU Power (W)' });
  if (DATA.l3) items.push({ color: 'rgba(80,30,120,0.65)', label: 'L3 Hit Rate (%)' });
  if (DATA.dram) items.push({ color: 'rgba(140,100,200,0.55)', label: 'DRAM BW (GB/s)' });

  for (const it of items) {
    const li = document.createElement('div'); li.className = 'legend-item';
    const sw = document.createElement('div'); sw.className = 'legend-swatch';
    sw.style.backgroundColor = it.color; li.appendChild(sw);
    const txt = document.createElement('span'); txt.textContent = it.label; li.appendChild(txt);
    legend.appendChild(li);
  }
  const gw = document.createElement('div'); gw.className = 'legend-gradient-wrap';
  const gMin = document.createElement('span'); gMin.textContent = '0s'; gw.appendChild(gMin);
  const canvas = document.createElement('canvas'); canvas.className = 'legend-gradient';
  canvas.width = 140; canvas.height = 14;
  const ctx = canvas.getContext('2d');
  for (let x = 0; x < 140; x++) { ctx.fillStyle = heatColor(x/139, 1); ctx.fillRect(x,0,1,14); }
  gw.appendChild(canvas);
  const gMax = document.createElement('span'); gMax.textContent = 'max'; gw.appendChild(gMax);
  legend.appendChild(gw);
})();
</script>
</body>
</html>`;

fs.writeFileSync(outputFile, html, 'utf8');
console.log('Done! Generated: ' + outputFile);
