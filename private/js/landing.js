'use strict';

const shell = document.getElementById('gemini-shell');
const openBtn = document.getElementById('btn-gemini-chat');
const closeBtn = document.getElementById('gemini-close');
const form = document.getElementById('gemini-form');
const input = document.getElementById('gemini-input');
const messages = document.getElementById('gemini-messages');
const statusEl = document.getElementById('gemini-status');
const sendBtn = document.getElementById('gemini-send');



(async () => {
  try {
    const session = await fetch('/session-check').then(r => r.json());
    if (!session.loggedIn) {
      window.location.href = '/';
      return;
    }
    document.getElementById('session-user').textContent = session.username.split('.')[0].toProperCase(); // Show the first name (username before the dot)
    const heroName = document.getElementById('hero-username');
    if (heroName) heroName.textContent = session.username.split('.')[0].toProperCase(); // Show first name in hero section, properly capitalized
    loadProductionSparkline();
    loadSalesSparkline();
    loadWarehouseSparkline();
    loadLogisticsSparkline();
    checkSapAvailability();
    setInterval(checkSapAvailability, 60000);
  } catch {
    window.location.href = '/';
  }
})();

async function checkSapAvailability() {
  const dot = document.getElementById('sap-dot');
  if (!dot) return;
  try {
    const res = await fetch('/api/sap/availability').then(r => r.json());
    dot.className = 'hero-pill-dot ' + (res.reachable ? 'hero-pill-dot--ok' : 'hero-pill-dot--error');
  } catch {
    dot.className = 'hero-pill-dot hero-pill-dot--error';
  }
}

async function loadSalesSparkline() {
  try {
    const res = await fetch('/api/sap/sales-sparkline').then(r => r.json());
    if (!res.success || !res.data) return;

    const { thisTotal, pctChange, dailyValues } = res.data;

    const svg     = document.getElementById('sales-spark-svg');
    const deltaEl = document.getElementById('sales-spark-delta');
    const valueEl = document.getElementById('sales-spark-value');
    const wrap    = document.getElementById('sales-spark');
    if (!svg || !deltaEl || !valueEl || !wrap) return;

    // Format £ value
    const fmtSales = n => {
      if (n >= 1000000) return `£${(n / 1000000).toFixed(2)}M`;
      if (n >= 10000)   return `£${(n / 1000).toFixed(1)}k`;
      return `£${Math.round(n).toLocaleString('en-GB')}`;
    };
    valueEl.textContent = fmtSales(thisTotal) + ' MTD';

    const W = 280, H = 28, padY = 3;
    const n   = dailyValues.length;
    const max = Math.max(...dailyValues, 1);

    const pts = dailyValues.map((v, i) => [
      n < 2 ? W / 2 : (i / (n - 1)) * W,
      H - padY - ((v / max) * (H - padY * 2)),
    ]);

    const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    const fillD = `${lineD} L${W},${H} L0,${H} Z`;

    const isUp   = pctChange === null || pctChange >= 0;
    const isFlat = pctChange !== null && Math.abs(pctChange) < 0.1;
    const col    = isFlat ? '#8DA3BE' : isUp ? '#059669' : '#DC2626';

    svg.innerHTML = `
      <defs>
        <linearGradient id="sssg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="${col}" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${fillD}" fill="url(#sssg)"/>
      <path d="${lineD}" fill="none" stroke="${col}" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round"/>`;

    const sign   = (!isFlat && isUp && pctChange > 0) ? '+' : '';
    const pctStr = pctChange === null ? '—' : `${sign}${pctChange}%`;
    deltaEl.textContent = `${pctStr} vs last month`;
    deltaEl.className   = `dept-spark-delta dept-spark-delta--${isFlat ? 'flat' : isUp ? 'up' : 'down'}`;
    deltaEl.style.opacity = '1';

    wrap.style.display = '';   // reveal the spark section now data is ready
  } catch (_) {}
}

async function loadProductionSparkline() {
  try {
    const res = await fetch('/api/productionnexus/landing-sparkline').then(r => r.json());
    if (!res.success) return;
    const { values, thisWeek, pctChange } = res.data;

    const svg     = document.getElementById('pn-spark-svg');
    const deltaEl = document.getElementById('pn-spark-delta');
    const valueEl = document.getElementById('pn-spark-value');
    if (!svg || !deltaEl || !valueEl) return;

    // Format metres: 1,234 M or 12.4k M
    const fmtM = n => (n >= 10000
      ? (n / 1000).toFixed(1) + 'k M'
      : n.toLocaleString('en-GB') + ' M');
    valueEl.textContent = fmtM(thisWeek) + ' this week';

    const W = 280, H = 28, padY = 3;
    const n   = values.length;
    const max = Math.max(...values, 1);

    const pts = values.map((v, i) => [
      (i / (n - 1)) * W,
      H - padY - ((v / max) * (H - padY * 2)),
    ]);

    const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    const fillD = `${lineD} L${W},${H} L0,${H} Z`;

    const isUp   = pctChange === null || pctChange >= 0;
    const isFlat = pctChange !== null && Math.abs(pctChange) < 0.1;
    const col    = isFlat ? '#8DA3BE' : isUp ? '#2563EB' : '#DC2626';

    svg.innerHTML = `
      <defs>
        <linearGradient id="pnsg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="${col}" stop-opacity="0.15"/>
          <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${fillD}" fill="url(#pnsg)"/>
      <path d="${lineD}" fill="none" stroke="${col}" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round"/>`;

    const sign   = (!isFlat && isUp && pctChange > 0) ? '+' : '';
    const pctStr = pctChange === null ? '—' : `${sign}${pctChange}%`;
    deltaEl.textContent = `${pctStr} vs last week`;
    deltaEl.className = `dept-spark-delta dept-spark-delta--${isFlat ? 'flat' : isUp ? 'up' : 'down'}`;
    deltaEl.style.opacity = '1';
  } catch (_) {}
}

async function loadWarehouseSparkline() {
  try {
    const res = await fetch('/api/palletmain/landing-sparkline').then(r => r.json());
    if (!res.success || !res.data) return;

    const { dailyValues, thisWeek, pctChange, overduePicksheets } = res.data;

    const svg     = document.getElementById('wh-spark-svg');
    const deltaEl = document.getElementById('wh-spark-delta');
    const valueEl = document.getElementById('wh-spark-value');
    const wrap    = document.getElementById('wh-spark');
    if (!svg || !deltaEl || !valueEl || !wrap) return;

    valueEl.textContent = `${thisWeek} pallet${thisWeek !== 1 ? 's' : ''} this week`;

    const W = 280, H = 28, padY = 3;
    const n   = dailyValues.length;
    const max = Math.max(...dailyValues, 1);

    const pts = dailyValues.map((v, i) => [
      n < 2 ? W / 2 : (i / (n - 1)) * W,
      H - padY - ((v / max) * (H - padY * 2)),
    ]);

    const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    const fillD = `${lineD} L${W},${H} L0,${H} Z`;

    const isFlat = pctChange !== null && Math.abs(pctChange) < 0.1;
    const isUp   = pctChange === null || pctChange >= 0;
    const col    = isFlat ? '#8DA3BE' : isUp ? '#7C3AED' : '#DC2626';

    svg.innerHTML = `
      <defs>
        <linearGradient id="whsg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="${col}" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${fillD}" fill="url(#whsg)"/>
      <path d="${lineD}" fill="none" stroke="${col}" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round"/>`;

    if (overduePicksheets > 0) {
      deltaEl.textContent = `⚠ ${overduePicksheets} overdue`;
      deltaEl.className   = 'dept-spark-delta dept-spark-delta--down';
    } else {
      const sign   = (!isFlat && isUp && pctChange > 0) ? '+' : '';
      const pctStr = pctChange === null ? '—' : `${sign}${pctChange}%`;
      deltaEl.textContent = `${pctStr} vs last week`;
      deltaEl.className   = `dept-spark-delta dept-spark-delta--${isFlat ? 'flat' : isUp ? 'up' : 'down'}`;
    }
    deltaEl.style.opacity = '1';

    wrap.style.display = '';
  } catch (_) {}
}

async function loadLogisticsSparkline() {
  try {
    const res = await fetch('/api/deliverymain/landing-sparkline').then(r => r.json());
    if (!res.success || !res.data) return;

    const { dailyValues, onTimeRate, pctChange } = res.data;

    const svg     = document.getElementById('log-spark-svg');
    const deltaEl = document.getElementById('log-spark-delta');
    const valueEl = document.getElementById('log-spark-value');
    const wrap    = document.getElementById('log-spark');
    if (!svg || !deltaEl || !valueEl || !wrap) return;

    if (onTimeRate === null || dailyValues.length < 2) {
      valueEl.textContent = 'No data yet';
      wrap.style.display = '';
      return;
    }

    valueEl.textContent = `${onTimeRate}% on time`;

    const W = 280, H = 28, padY = 3;
    const n = dailyValues.length;

    const pts = dailyValues.map((v, i) => [
      (i / (n - 1)) * W,
      H - padY - ((v / 100) * (H - padY * 2)),
    ]);

    const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    const fillD = `${lineD} L${W},${H} L0,${H} Z`;

    const isFlat = pctChange !== null && Math.abs(pctChange) < 1;
    const isUp   = pctChange === null || pctChange >= 0;
    const col    = isFlat ? '#8DA3BE' : isUp ? '#0891B2' : '#DC2626';

    svg.innerHTML = `
      <defs>
        <linearGradient id="logsg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="${col}" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${fillD}" fill="url(#logsg)"/>
      <path d="${lineD}" fill="none" stroke="${col}" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round"/>`;

    if (pctChange !== null && !isFlat) {
      const sign = isUp ? '+' : '';
      deltaEl.textContent = `${sign}${pctChange}pp vs last week`;
    } else {
      deltaEl.textContent = isFlat ? 'stable vs last week' : '';
    }
    deltaEl.className   = `dept-spark-delta dept-spark-delta--${isFlat ? 'flat' : isUp ? 'up' : 'down'}`;
    deltaEl.style.opacity = '1';

    wrap.style.display = '';
  } catch (_) {}
}


openBtn.addEventListener('click', () => {
  shell.classList.remove('hidden');
  input.focus();
});

closeBtn.addEventListener('click', () => {
  shell.classList.add('hidden');
  statusEl.textContent = '';
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  const question = input.value.trim();
  if (!question) return;

  appendMessage(question, 'user');
  input.value = '';
  statusEl.textContent = 'Waiting for Gemini...';
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/gemini/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
    }

    appendMessage(data.answer || 'No response returned.', 'assistant');
    statusEl.textContent = '';
  } catch (err) {
    appendMessage('Sorry, it appears I am currently unavailable. Please try again later.', 'assistant');
    statusEl.textContent = 'Request failed';
    console.log('Gemini API error:', err.message);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

function appendMessage(text, role) {
  const row = document.createElement('div');
  row.className = `gemini-row gemini-row--${role}`;

  const bubble = document.createElement('div');
  bubble.className = `gemini-bubble gemini-bubble--${role}`;
  bubble.textContent = text;

  row.appendChild(bubble);
  messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
}


// Source - https://stackoverflow.com/a/5574446
// Posted by Tuan
// Retrieved 2026-05-08, License - CC BY-SA 2.5

String.prototype.toProperCase = function () {
    return this.replace(/\w\S*/g, function(txt){return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();});
};
