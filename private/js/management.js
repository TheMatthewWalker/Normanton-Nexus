const BASE = '/api/performance';

let rawValueData = [];
let rawOtifData = [];

// store charts to avoid duplicates
let charts = {};

function format(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}


function setDefaultDates() {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), 1);

    document.getElementById("dateFrom").value = format(start);
    document.getElementById("dateTo").value = format(today);
}



function monthName(month) {
  return [
    '',
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ][month];
}

function currencyCell(value) {
  return value
    ? '£' + Math.round(value).toLocaleString('en-GB')
    : '£-';
}

// TOGGLE FOR ORDERBOOK GROUPS — recursively collapses descendants so that a
// re-expand always starts from a clean, fully-collapsed state. Previously,
// collapsing a parent while a child group was left expanded only hid the
// direct children — the grandchildren (still lacking the .ob-hidden class)
// stayed visible even though their own parent row had just been hidden.
// Every group row must carry data-group-id (its own id) alongside
// data-parent (its parent's id) for the recursion below to find it.
window.collapseOrderBookGroup = function(groupId) {
  const icon = document.getElementById(`icon-${groupId}`);
  if (icon) icon.textContent = '▶';

  document.querySelectorAll(`[data-parent="${groupId}"]`).forEach(row => {
    row.classList.add('ob-hidden');
    if (row.dataset.groupId) {
      window.collapseOrderBookGroup(row.dataset.groupId);
    }
  });
};

window.expandOrderBookGroup = function(groupId) {
  const icon = document.getElementById(`icon-${groupId}`);
  if (icon) icon.textContent = '▼';

  document.querySelectorAll(`[data-parent="${groupId}"]`).forEach(row => {
    row.classList.remove('ob-hidden');
  });
};

window.toggleOrderBookGroup = function(groupId) {
  const icon = document.getElementById(`icon-${groupId}`);
  const isCollapsed = !icon || icon.textContent.trim() === '▶';

  if (isCollapsed) {
    window.expandOrderBookGroup(groupId);
  } else {
    window.collapseOrderBookGroup(groupId);
  }
};



async function refreshData() {
  const status = document.getElementById('refreshStatus');
  const btn = document.getElementById('refreshBtn');

  try {
    // ✅ UI: loading state
    btn.disabled = true;
    btn.innerText = 'Refreshing...';
    status.innerText = 'Updating data...';

    const res = await fetch(BASE + '/refresh', {
      method: 'POST'
    });

    const json = await res.json();

    if (!json.success) {
      throw new Error(json.error?.message || 'Refresh failed');
    }

    // ✅ UI: success
    status.innerText = '✅ Data updated successfully';

    // ✅ reload dashboard data
    await loadData();

    setTimeout(() => {
      status.innerText = '';
    }, 3000);

  } catch (err) {
    console.error(err);
    status.innerText = '❌ Refresh failed';
  } finally {
    btn.disabled = false;
    btn.innerText = 'Refresh Data';
  }
}


function formatRefreshAge(value) {
  if (!value) return 'Refresh status unavailable';

  const refreshedAt = new Date(value);
  if (Number.isNaN(refreshedAt.getTime())) return 'Refresh status unavailable';

  const diffMinutes = Math.max(0, Math.floor((Date.now() - refreshedAt.getTime()) / 60000));

  if (diffMinutes < 1) return 'Last refresh just now';
  if (diffMinutes === 1) return 'Last refresh 1 minute ago';
  if (diffMinutes < 60) return `Last refresh ${diffMinutes} minutes ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours === 1) return 'Last refresh 1 hour ago';
  if (diffHours < 24) return `Last refresh ${diffHours} hours ago`;

  const diffDays = Math.floor(diffHours / 24);
  return diffDays === 1 ? 'Last refresh 1 day ago' : `Last refresh ${diffDays} days ago`;
}

function renderRefreshSummary(summary) {
  const el = document.getElementById('refreshSummary');
  if (!el) return;

  const failures = summary?.failures || [];

  el.classList.toggle('has-failure', failures.length > 0);

  if (failures.length) {
    const names = failures.map(row => row.name).join(', ');
    el.innerText = `Refresh failed: ${names}`;
    el.title = failures
      .map(row => `${row.name}: ${row.status}${row.errorMessage ? ' - ' + row.errorMessage : ''}`)
      .join('\n');
    return;
  }

  el.innerText = formatRefreshAge(summary?.lastRefreshUtc);
  el.title = summary?.datasets
    ? summary.datasets.map(row => `${row.name}: ${row.status}`).join('\n')
    : '';
}

async function loadRefreshStatus() {
  try {
    const res = await fetch(BASE + '/refresh-status');
    const json = await res.json();

    if (!json.success) throw new Error(json.error?.message || 'Refresh status failed');

    renderRefreshSummary(json.data);
  } catch (err) {
    console.error(err);
    renderRefreshSummary(null);
  }
}

async function loadData() {
  const [valueRes, otifRes, orderBookRes] = await Promise.all([
    fetch(BASE + '/value-metrics'),
    fetch(BASE + '/otif-metrics'),
    fetch(BASE + '/orderbook-summary')
  ]);

  rawValueData = (await valueRes.json()).data;
  rawOtifData = (await otifRes.json()).data;
  rawOrderBookData = (await orderBookRes.json()).data;

  renderDashboard();
  await loadRefreshStatus();
}

function getFilters() {
  const from = document.getElementById('dateFrom').value;
  const to = document.getElementById('dateTo').value;

  return { from, to };
}

function filterData(data) {
  const from = document.getElementById('dateFrom').value;
  const to = document.getElementById('dateTo').value;

  return data.filter(r =>
    (!from || r.date >= from) &&
    (!to || r.date <= to)
  );
}


// ✅ build cumulative
function buildCumulativeValueData(data) {
  const result = [];
  let running = 0;

  for (const row of data) {
    const vs = Object.keys(row).find(k => k !== 'date');
    const current = row[vs] || {};

    running += current.invoiced || 0;

    result.push({
      date: row.date,
      value: running
    });
  }

  return result;
}

// ✅ extended logic
function buildExtendedValueData(data) {
  const result = [];
  let running = 0;

  for (const row of data) {
    const vs = Object.keys(row).find(k => k !== 'date');
    const current = row[vs] || {};

    running += current.invoiced || 0;

    result.push({
      date: row.date,
      invoiced: running,
      plusPicked: running + (current.picked || 0),
      plusStock: running + (current.stock || 0)
    });
  }

  return result;
}

// ✅ ECharts renderer base
function renderChart(id, option) {
  if (charts[id]) {
    charts[id].dispose();
  }

  const el = document.getElementById(id);
  if (!el) return;

  const chart = echarts.init(el);
  chart.setOption(option);

  charts[id] = chart;
}

// ✅ VALUE DAILY
function renderValueChart(id, data, colour) {
  renderChart(id, {
    tooltip: {
      trigger: 'axis',
      valueFormatter: value =>
        '£' + Number(value || 0).toLocaleString('en-GB', {
          maximumFractionDigits: 0
        })
    },

    grid: { left: 60, right: 20, top: 30, bottom: 40 },

    xAxis: {
      type: 'category',
      data: data.map(d => d.date)
    },


    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: {
        formatter: value =>
          '£' + value.toLocaleString('en-GB', {
            maximumFractionDigits: 0
          })
      }
    },


    series: [
      {
        name: 'Invoiced',
        type: 'line',
        areaStyle: { opacity: 0.25 },
        data: data.map(d => {
          const vs = Object.keys(d).find(k => k !== 'date');
          return d[vs]?.invoiced || 0;
        }),
        lineStyle: { width: 3, color: colour }
      }
    ]
  });
}


// ✅ VALUE CUMULATIVE
function renderValueCumulativeChart(id, data, colour) {
  renderChart(id, {
    tooltip: {
      trigger: 'axis',
      valueFormatter: value =>
        '£' + Number(value || 0).toLocaleString('en-GB', {
          maximumFractionDigits: 0
        })
    },

    grid: { left: 60, right: 20, top: 30, bottom: 40 },

    xAxis: {
      type: 'category',
      data: data.map(d => d.date)
    },

    yAxis: {
      type: 'value',
      scale: true, // ✅ critical
      min: 'dataMin',
      splitNumber: 5,
      axisLabel: {
        formatter: value =>
          '£' + value.toLocaleString('en-GB', {
            maximumFractionDigits: 0
          })}
    },

    series: [
      {
        type: 'line',
        areaStyle: { opacity: 0.3 },
        data: data.map(d => d.value),
        lineStyle: { width: 3, color: colour }
      }
    ]
  });
}

// ✅ EXTENDED VALUE
function renderExtendedChart(id, data, colour) {
  renderChart(id, {
    tooltip: {
      trigger: 'axis',
      valueFormatter: value =>
        '£' + Number(value || 0).toLocaleString('en-GB', {
          maximumFractionDigits: 0
        })
    },

    legend: { top: 5 },

    xAxis: {
      type: 'category',
      data: data.map(d => d.date)
    },

    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: {
        formatter: value =>
          '£' + value.toLocaleString('en-GB', {
            maximumFractionDigits: 0
          })
      }
    },

    series: [
      {
        name: 'Invoiced',
        type: 'line',
        areaStyle: {},
        data: data.map(d => d.invoiced),
        lineStyle: { width: 3, color: colour }
      },
      {
        name: '+ Picked',
        type: 'line',
        data: data.map(d => d.plusPicked),
        lineStyle: { width: 2, type: 'dashed', color: '#84cc16' }
      },
      {
        name: '+ Stock',
        type: 'line',
        data: data.map(d => d.plusStock),
        lineStyle: { width: 2, type: 'dotted', color: '#64748B' }
      }
    ]
  });
}

// ✅ OTIF
function renderOtifChart(id, data, colour) {
  renderChart(id, {
    tooltip: { trigger: 'axis' },

    grid: { left: 60, right: 20, top: 30, bottom: 40 },

    xAxis: {
      type: 'category',
      data: data.map(d => d.date)
    },

    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      splitNumber: 5,
      axisLabel: { formatter: '{value}%' }
    },

    series: [{
      type: 'line',
      areaStyle: { opacity: 0.2 },
      data: data.map(d => {
        const vs = Object.keys(d).find(k => k !== 'date');
        return (d[vs]?.otif || 0) * 100;
      }),
      lineStyle: { width: 3, color: colour }
    }]
  });
}

// ✅ CUMULATIVE OTIF
function buildCumulativeOtifData(data) {
  const result = [];

  let runningOnTime = 0;
  let runningTotal = 0;

  for (const row of data) {
    const vs = Object.keys(row).find(k => k !== 'date');
    const current = row[vs] || {};

    runningOnTime += current.onTime || 0;
    runningTotal  += current.total || 0;

    const otif =
      runningTotal > 0
        ? (runningOnTime / runningTotal) * 100
        : 0;

    result.push({
      date: row.date,
      value: otif
    });
  }

  return result;
}

// ✅ CUMULATIVE OTIF CHART RENDERER
function renderOtifCumulativeChart(id, data, colour) {
  renderChart(id, {
    tooltip: {
      trigger: 'axis',
      valueFormatter: v => v.toFixed(1) + '%'
    },

    grid: { left: 60, right: 20, top: 30, bottom: 40 },

    xAxis: {
      type: 'category',
      data: data.map(d => d.date)
    },

    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      splitNumber: 5,
      axisLabel: {
        formatter: '{value}%'
      }
    },

    series: [
      {
        name: 'Cumulative OTIF',
        type: 'line',
        smooth: true,
        areaStyle: { opacity: 0.2 },

        data: data.map(d => d.value),

        lineStyle: {
          width: 3,
          color: colour
        }
      },
      {
        name: 'Target (95%)',
        type: 'line',
        data: data.map(() => 95),

        lineStyle: {
          width: 2,
          type: 'dashed',
          color: '#DC2626'
        },

        symbol: 'none'
      }
    ]
  });
}


// ✅ FILTER BY AREA
function filterByArea(data, area) {
  return data.map(row => {
    const newRow = { date: row.date };
    if (row[area]) newRow[area] = row[area];
    return newRow;
  });
}

// ✅ TABLE RENDER
function renderTable(data) {
  const table = document.getElementById('dataTable');
  if (!table) return;

  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');

  let ptfeRunning = 0;
  let pvRunning = 0;

  thead.innerHTML = `
    <tr>
      <th>Date</th>
      <th>PTFE Daily</th>
      <th>PTFE Cum</th>
      <th>PV Daily</th>
      <th>PV Cum</th>
      <th>Total Cum</th>
    </tr>
  `;

  tbody.innerHTML = data.map(row => {
    const ptfe = row.PTFE?.invoiced || 0;
    const pv   = row.PV?.invoiced || 0;

    ptfeRunning += ptfe;
    pvRunning   += pv;

    return `
      <tr>
        <td>${row.date}</td>
        <td>${formatNumber(ptfe)}</td>
        <td>${formatNumber(ptfeRunning)}</td>
        <td>${formatNumber(pv)}</td>
        <td>${formatNumber(pvRunning)}</td>
        <td><strong>${formatNumber(ptfeRunning + pvRunning)}</strong></td>
      </tr>
    `;
  }).join('');
}


function formatNumber(n) {
  return n.toLocaleString('en-GB', {
    maximumFractionDigits: 0
  });
}



function formatCurrency(n) {
  if ( n < 1000 ) {
    return '£' + (Math.round(n, 0) || 0).toLocaleString('en-GB');
  }

  if ( n < 1000000 ) {
    return '£' + (Math.round(n / 1000, 0) || 0) + ' K'.toLocaleString('en-GB');
  }

  return '£' + (Math.round(n / 10000) / 100 || 0) + ' M'.toLocaleString('en-GB');
}

function formatPercent(n) {
  return (n || 0).toLocaleString('en-GB', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }) + '%';
}


function renderKpis(valueData, otifData) {
  let ptfe = 0;
  let pv = 0;
  let ptfeOnTime = 0;
  let ptfeTotal = 0;
  let pvOnTime = 0;
  let pvTotal = 0;

  for (const row of valueData) {
    ptfe += row.PTFE?.invoiced || 0;
    pv   += row.PV?.invoiced || 0;
  }

  for (const row of otifData) {
    ptfeOnTime += row.PTFE?.onTime || 0;
    ptfeTotal  += row.PTFE?.total || 0;
    pvOnTime   += row.PV?.onTime || 0;
    pvTotal    += row.PV?.total || 0;
  }

  const ptfeOtif = ptfeTotal ? (ptfeOnTime / ptfeTotal) * 100 : 0;
  const pvOtif = pvTotal ? (pvOnTime / pvTotal) * 100 : 0;
  const totalOtifTotal = ptfeTotal + pvTotal;
  const totalOtif = totalOtifTotal ? ((ptfeOnTime + pvOnTime) / totalOtifTotal) * 100 : 0;

  document.getElementById('kpi-ptfe').innerText = formatCurrency(ptfe);
  document.getElementById('kpi-pv').innerText   = formatCurrency(pv);
  document.getElementById('kpi-ptfe-otif').innerText = formatPercent(ptfeOtif);
  document.getElementById('kpi-pv-otif').innerText = formatPercent(pvOtif);

  return { ptfe, pv };
}


// ORDERBOOK
let rawOrderBookData = [];

function renderOrderBookTable(rows, ptfeInvoiced = 0) {

  const container = document.getElementById('orderBookTable');

  if (!container) return;

  const grouped = {};

  for (const row of rows) {

    const year = Number(row.year);
    const month = Number(row.month);
    const vs = row.valueStream;

    grouped[year] ??= {};

    grouped[year][month] ??= {
      PTFE: {
        orders: 0,
        stock: 0,
        picked: 0
      },
      PV: {
        orders: 0,
        stock: 0,
        picked: 0
      }
    };

    if (!grouped[year][month][vs]) continue;

    grouped[year][month][vs].orders += row.orders || 0;
    grouped[year][month][vs].stock += row.stock || 0;
    grouped[year][month][vs].picked += row.picked || 0;
  }

  // Tally PTFE picked/stock across every period on or before the current
  // real-world month. Done once, after grouping is complete — not per row —
  // and compared against today's actual date, not each row's own month.
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;

  let pickedToDate = 0;
  let stockToDate = 0;

  for (const y of Object.keys(grouped)) {
    if (Number(y) > currentYear) continue;

    for (const m of Object.keys(grouped[y])) {
      if (Number(y) === currentYear && Number(m) > currentMonth) continue;

      pickedToDate += grouped[y][m].PTFE.picked || 0;
      stockToDate += grouped[y][m].PTFE.stock || 0;
    }
  }

  const remainingStock = stockToDate - pickedToDate;
  const potential = ptfeInvoiced + stockToDate;

  document.getElementById('kpi-ptfe-picked-only').innerText = formatCurrency(pickedToDate);
  document.getElementById('kpi-ptfe-picked').innerText = formatCurrency(pickedToDate + ptfeInvoiced);
  document.getElementById('kpi-ptfe-stock').innerText = formatCurrency(remainingStock);
  document.getElementById('kpi-ptfe-potential').innerText = formatCurrency(potential);

  const grand = {
    PTFE: {
      orders: 0,
      stock: 0,
      picked: 0
    },
    PV: {
      orders: 0,
      stock: 0,
      picked: 0
    }
  };

  let html = `
    <table class="orderbook-table">

      <thead>

        <tr>
          <th rowspan="2">Year / Month</th>

          <th colspan="3">PTFE</th>
          <th colspan="3">PV</th>
        </tr>

        <tr>
          <th>Orders</th>
          <th>Stock</th>
          <th>Picked</th>

          <th>Orders</th>
          <th>Stock</th>
          <th>Picked</th>
        </tr>

      </thead>

      <tbody>
  `;

  const years = Object.keys(grouped)
    .map(Number)
    .sort((a, b) => a - b);

  for (const year of years) {

    const months = Object.keys(grouped[year])
      .map(Number)
      .sort((a, b) => a - b);

    const yearKey = `year-${year}`;

    const yearTotal = {
      PTFE: {
        orders: 0,
        stock: 0,
        picked: 0
      },
      PV: {
        orders: 0,
        stock: 0,
        picked: 0
      }
    };

    for (const month of months) {

      const ptfe = grouped[year][month].PTFE;
      const pv = grouped[year][month].PV;

      yearTotal.PTFE.orders += ptfe.orders;
      yearTotal.PTFE.stock += ptfe.stock;
      yearTotal.PTFE.picked += ptfe.picked;

      yearTotal.PV.orders += pv.orders;
      yearTotal.PV.stock += pv.stock;
      yearTotal.PV.picked += pv.picked;
    }

    grand.PTFE.orders += yearTotal.PTFE.orders;
    grand.PTFE.stock += yearTotal.PTFE.stock;
    grand.PTFE.picked += yearTotal.PTFE.picked;

    grand.PV.orders += yearTotal.PV.orders;
    grand.PV.stock += yearTotal.PV.stock;
    grand.PV.picked += yearTotal.PV.picked;

    html += `
      <tr
        class="orderbook-year-row"
        data-group-id="${yearKey}"
        onclick="toggleOrderBookGroup('${yearKey}')">

        <td>

          <span id="icon-${yearKey}">▶</span>
          <strong>${year}</strong>

        </td>

        <td>${currencyCell(yearTotal.PTFE.orders)}</td>
        <td>${currencyCell(yearTotal.PTFE.stock)}</td>
        <td>${currencyCell(yearTotal.PTFE.picked)}</td>

        <td>${currencyCell(yearTotal.PV.orders)}</td>
        <td>${currencyCell(yearTotal.PV.stock)}</td>
        <td>${currencyCell(yearTotal.PV.picked)}</td>

      </tr>
    `;

    for (const month of months) {

      const ptfe = grouped[year][month].PTFE;
      const pv = grouped[year][month].PV;

      html += `
        <tr
          data-parent="${yearKey}"
          class="ob-hidden">

          <td class="orderbook-month">
            ${monthName(month)}
          </td>

          <td>${currencyCell(ptfe.orders)}</td>
          <td>${currencyCell(ptfe.stock)}</td>
          <td>${currencyCell(ptfe.picked)}</td>

          <td>${currencyCell(pv.orders)}</td>
          <td>${currencyCell(pv.stock)}</td>
          <td>${currencyCell(pv.picked)}</td>

        </tr>
      `;
    }
  }

  html += `
      <tr class="orderbook-grand-total">

        <td>
          <strong>Grand Total</strong>
        </td>

        <td>${currencyCell(grand.PTFE.orders)}</td>
        <td>${currencyCell(grand.PTFE.stock)}</td>
        <td>${currencyCell(grand.PTFE.picked)}</td>

        <td>${currencyCell(grand.PV.orders)}</td>
        <td>${currencyCell(grand.PV.stock)}</td>
        <td>${currencyCell(grand.PV.picked)}</td>

      </tr>

      </tbody>

    </table>
  `;

  container.innerHTML = html;
}


// ── ORDER BOOK: BREAKDOWN MODALS ────────────────────────────────────────────
// Two views share one generic tree-builder/renderer:
//   "Full Breakdown"          — Year > Month > Customer > Order > Material,
//                                 with each material line tagged with its date
//   "Breakdown for Month End" — Customer > Order (date shown inline) > Material,
//                                 pre-filtered to rows on or before the current month.
// Both reuse toggleOrderBookGroup/.ob-hidden/data-parent (now recursive — see
// above), and support click-to-sort on any column via data-level indentation
// for the pivot-style layout.

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function numberCell(value) {
  return value
    ? Math.round(value).toLocaleString('en-GB')
    : '-';
}

function zeroBreakdownTotals() {
  return {
    orderQty: 0, orderValue: 0,
    stockQty: 0, stockValue: 0,
    pickedQty: 0, pickedValue: 0
  };
}

function addBreakdownTotals(target, row) {
  target.orderQty    += row.orderQty    || 0;
  target.orderValue  += row.orderValue  || 0;
  target.stockQty    += row.stockQty    || 0;
  target.stockValue  += row.stockValue  || 0;
  target.pickedQty   += row.pickedQty   || 0;
  target.pickedValue += row.pickedValue || 0;
}

// Value-only — quantities are tracked in the totals (zeroBreakdownTotals/
// addBreakdownTotals) for the Excel export, but the modal itself only shows
// value columns: quantities aren't useful for "what-if" analysis in the UI
// and just add clutter, per feedback.
function breakdownValueCells(totals) {
  return `
    <td>${currencyCell(totals.orderValue)}</td>
    <td>${currencyCell(totals.stockValue)}</td>
    <td>${currencyCell(totals.pickedValue)}</td>
  `;
}

// "On or before the current month" — same year/month comparison pattern
// already used for the PTFE KPI tally in renderOrderBookTable() above.
function isOnOrBeforeCurrentMonth(dateStr) {
  if (!dateStr) return false;

  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return false;

  const today = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const cy = today.getFullYear();
  const cm = today.getMonth() + 1;

  return y < cy || (y === cy && m <= cm);
}

// Level definitions — each function pulls the {key, label} for one grouping
// level out of a breakdown row. buildBreakdownTree() walks these in order,
// creating/reusing one group node per level, then attaches the row itself
// as a leaf under the deepest level.
const fullBreakdownLevels = [
  row => {
    const y = row.requestDate ? row.requestDate.slice(0, 4) : 'Unknown';
    return { key: `y-${y}`, label: y };
  },
  row => {
    const y = row.requestDate ? row.requestDate.slice(0, 4) : 'x';
    const m = row.requestDate ? Number(row.requestDate.slice(5, 7)) : 0;
    return { key: `m-${y}-${m}`, label: m ? monthName(m) : 'Unknown' };
  },
  row => {
    const c = row.customer || 'UNKNOWN';
    return { key: `c-${c}`, label: row.customerName || c };
  },
  row => {
    const o = row.referenceDocument || 'UNKNOWN';
    return { key: `o-${o}`, label: `Order ${o}` };
  }
];

const monthEndLevels = [
  row => {
    const c = row.customer || 'UNKNOWN';
    return { key: `c-${c}`, label: row.customerName || c };
  },
  row => {
    const o = row.referenceDocument || 'UNKNOWN';
    return { key: `o-${o}`, label: `Order ${o}`, extraLabel: row.requestDate || '' };
  }
];

function buildBreakdownTree(rows, levelDefs, leafExtraFn) {
  const root = { children: new Map() };

  rows.forEach((row, rowIdx) => {
    let node = root;

    levelDefs.forEach((levelDef, i) => {
      const { key, label, extraLabel } = levelDef(row);

      if (!node.children.has(key)) {
        node.children.set(key, {
          key,
          label,
          extraLabel: extraLabel || null,
          level: i,
          isLeaf: false,
          totals: zeroBreakdownTotals(),
          children: new Map()
        });
      }

      const child = node.children.get(key);
      addBreakdownTotals(child.totals, row);
      node = child;
    });

    // node is now the deepest group node (e.g. the order) — attach this
    // row as a leaf material line underneath it. leafExtraFn optionally
    // supplies a tag shown before the material label (Full Breakdown uses
    // this to show the row's date, since it no longer has its own grouping
    // level — see fullBreakdownLevels above).
    node.children.set(`leaf-${rowIdx}`, {
      label: `${row.material} - ${row.materialText}`,
      extraLabel: leafExtraFn ? leafExtraFn(row) : null,
      level: levelDefs.length,
      isLeaf: true,
      row
    });
  });

  return root.children;
}

function sortBreakdownChildren(childrenMap, sortKey, dir) {
  const arr = Array.from(childrenMap.values());

  arr.sort((a, b) => {
    if (sortKey === 'label') {
      return dir * String(a.label).localeCompare(String(b.label), undefined, { numeric: true });
    }

    const av = a.isLeaf ? (a.row[sortKey] || 0) : (a.totals[sortKey] || 0);
    const bv = b.isLeaf ? (b.row[sortKey] || 0) : (b.totals[sortKey] || 0);

    return dir * (av - bv);
  });

  return arr;
}

function renderBreakdownRows(childrenMap, parentGroupId, sortKey, dir) {
  const arr = sortBreakdownChildren(childrenMap, sortKey, dir);
  let html = '';

  arr.forEach(node => {
    if (node.isLeaf) {
      const leafLabelHtml = node.extraLabel
        ? `<span class="breakdown-date-tag">${escapeHtml(node.extraLabel)}</span> ${escapeHtml(node.label)}`
        : escapeHtml(node.label);

      html += `
        <tr class="breakdown-leaf-row ob-hidden" data-level="${node.level}" data-parent="${parentGroupId}">
          <td>${leafLabelHtml}</td>
          <td>${currencyCell(node.row.orderValue)}</td>
          <td>${currencyCell(node.row.stockValue)}</td>
          <td>${currencyCell(node.row.pickedValue)}</td>
        </tr>
      `;
      return;
    }

    const groupId = `${parentGroupId || 'root'}-${node.key}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const isRoot = node.level === 0;
    const parentAttr = parentGroupId ? ` data-parent="${parentGroupId}"` : '';
    const labelHtml = node.extraLabel
      ? `${escapeHtml(node.label)} <span class="breakdown-date-tag">${escapeHtml(node.extraLabel)}</span>`
      : escapeHtml(node.label);

    html += `
      <tr class="breakdown-group-row${isRoot ? '' : ' ob-hidden'}" data-level="${node.level}" data-group-id="${groupId}"${parentAttr} onclick="toggleOrderBookGroup('${groupId}')">
        <td><span id="icon-${groupId}">▶</span> ${labelHtml}</td>
        ${breakdownValueCells(node.totals)}
      </tr>
    `;

    html += renderBreakdownRows(node.children, groupId, sortKey, dir);
  });

  return html;
}

let breakdownSortKey = 'label';
let breakdownSortDir = 1;
let currentBreakdownRows = [];
let currentBreakdownMode = 'full';

window.sortBreakdownTable = function(key) {
  if (breakdownSortKey === key) {
    breakdownSortDir *= -1;
  } else {
    breakdownSortKey = key;
    breakdownSortDir = 1;
  }

  renderBreakdownTable(currentBreakdownRows, currentBreakdownMode);
};

function renderBreakdownTable(rows, mode = currentBreakdownMode) {
  currentBreakdownMode = mode;
  currentBreakdownRows = rows;

  const container = document.getElementById('breakdownTableContainer');

  if (!rows.length) {
    container.innerHTML = '<p>No order book data available.</p>';
    return;
  }

  const levelDefs = mode === 'monthEnd' ? monthEndLevels : fullBreakdownLevels;
  const firstColLabel = mode === 'monthEnd'
    ? 'Customer / Order / Material'
    : 'Year / Month / Customer / Order / Material';

  // Full Breakdown no longer has its own Date grouping level — the date is
  // shown as a tag before each material line instead (see buildBreakdownTree).
  const leafExtraFn = mode === 'monthEnd' ? null : (row => row.requestDate || 'Unknown');
  const tree = buildBreakdownTree(rows, levelDefs, leafExtraFn);

  // Value-only in the UI — quantities add clutter for on-screen "what-if"
  // analysis and aren't shown here, but they're still exported to Excel
  // (see the /orderbook-breakdown/export route, unaffected by this).
  const columns = [
    { key: 'label', label: firstColLabel },
    { key: 'orderValue', label: 'Order Value' },
    { key: 'stockValue', label: 'Stock Value' },
    { key: 'pickedValue', label: 'Picked Value' }
  ];

  const theadCells = columns.map(col => {
    const active = breakdownSortKey === col.key;
    const arrow = active ? (breakdownSortDir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="breakdown-sortable${active ? ' breakdown-sort-active' : ''}" onclick="sortBreakdownTable('${col.key}')">${col.label}${arrow}</th>`;
  }).join('');

  const html = `
    <table class="breakdown-table" data-no-paginate>
      <thead>
        <tr>${theadCells}</tr>
      </thead>
      <tbody>
        ${renderBreakdownRows(tree, null, breakdownSortKey, breakdownSortDir)}
      </tbody>
    </table>
  `;

  container.innerHTML = html;
}

async function openBreakdownModal(mode) {
  const overlay = document.getElementById('breakdownOverlay');
  const container = document.getElementById('breakdownTableContainer');
  const title = document.getElementById('breakdownModalTitle');

  breakdownSortKey = 'label';
  breakdownSortDir = 1;

  if (title) {
    title.textContent = mode === 'monthEnd'
      ? 'Order Book — Breakdown for Month End'
      : 'Order Book — Full Breakdown';
  }

  overlay.style.display = 'flex';
  container.innerHTML = 'Loading…';

  try {
    const res = await fetch(BASE + '/orderbook-breakdown');
    const json = await res.json();

    if (!json.success) throw new Error(json.error?.message || 'Failed to load breakdown');

    let rows = json.data;

    if (mode === 'monthEnd') {
      rows = rows.filter(r => isOnOrBeforeCurrentMonth(r.requestDate));
    }

    renderBreakdownTable(rows, mode);
  } catch (err) {
    console.error(err);
    container.innerHTML = '<p>Failed to load breakdown.</p>';
  }
}

function closeBreakdownModal() {
  document.getElementById('breakdownOverlay').style.display = 'none';
}

function exportBreakdown() {
  // Plain navigation, not fetch+blob — the response is a Content-Disposition:
  // attachment, so the browser handles the download without leaving the page,
  // and it rides on the same session cookie as every other request here.
  // Mode-aware: when the Month End modal is open, ?mode=monthEnd tells the
  // server to apply the same on-or-before-current-month filter the modal
  // itself uses, so the export matches what's on screen.
  const params = currentBreakdownMode === 'monthEnd' ? '?mode=monthEnd' : '';
  window.location.href = BASE + '/orderbook-breakdown/export' + params;
}

// Sends the raw edited .xlsx straight through as the request body (same
// "plain fetch with the file as body" pattern used for supplier invoice
// uploads elsewhere in this app) — rides on the normal portal session
// cookie, same as every other request here, so this satisfies "upload
// using your login credentials" without any separate sign-in step. The
// server reads whatever's in the Data/Next Month tabs' Risk, Won't Get,
// Reason, Last Day, Last Day Time and Bring Forward columns and saves it,
// so the next person to hit Export sees it prefilled.
function showUploadStatus(message, isError) {
  const el = document.getElementById('uploadNotesStatus');
  el.textContent = message;
  el.style.color = isError ? '#b91c1c' : '#166534';
  clearTimeout(showUploadStatus._t);
  showUploadStatus._t = setTimeout(() => { el.textContent = ''; }, 6000);
}

async function uploadBreakdownNotes(e) {
  const file = e.target.files[0];
  e.target.value = ''; // allow re-selecting the same file next time
  if (!file) return;

  const btn = document.getElementById('uploadNotesBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Uploading…';

  try {
    const buf = await file.arrayBuffer();
    const res = await fetch(BASE + '/orderbook-breakdown/upload-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      body: buf,
    });
    const json = await res.json().catch(() => ({}));

    if (!res.ok || !json.success) {
      throw new Error(json.error?.message || json.error || `Upload failed (${res.status}).`);
    }

    showUploadStatus(`Saved — ${json.data.rowsUpdated} line(s) updated.`, false);
  } catch (err) {
    showUploadStatus(`Upload failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}


// ✅ MAIN RENDER
function renderDashboard() {
  const valueData = filterData(rawValueData);
  const otifData = filterData(rawOtifData);

  const ptfe = filterByArea(valueData, 'PTFE');
  const pv = filterByArea(valueData, 'PV');

  const ptfeOtif = filterByArea(otifData, 'PTFE');
  const pvOtif = filterByArea(otifData, 'PV');

  const ptfeOtifCum = buildCumulativeOtifData(ptfeOtif);
  const pvOtifCum   = buildCumulativeOtifData(pvOtif);

  renderTable(valueData);
  const kpis = renderKpis(valueData, otifData);
  renderOrderBookTable(rawOrderBookData, kpis.ptfe);

  renderValueChart('ptfeValueChart', ptfe, '#2563EB');
  //renderValueCumulativeChart('ptfeValueCumulativeChart', buildCumulativeValueData(ptfe), '#2563EB');
  renderExtendedChart('ptfeValueExtendedChart', buildExtendedValueData(ptfe), '#2563EB');
  renderOtifChart('ptfeOtifChart', ptfeOtif, '#2563EB');
  renderOtifCumulativeChart('ptfeOtifCumulativeChart', ptfeOtifCum, '#2563EB');

  renderValueChart('pvValueChart', pv, '#16A34A');
  //renderValueCumulativeChart('pvValueCumulativeChart', buildCumulativeValueData(pv), '#16A34A');
  renderExtendedChart('pvValueExtendedChart', buildExtendedValueData(pv), '#16A34A');
  renderOtifChart('pvOtifChart', pvOtif, '#16A34A');
  renderOtifCumulativeChart('pvOtifCumulativeChart', pvOtifCum, '#16A34A');
}

// ✅ INIT
document.addEventListener('DOMContentLoaded', async () => {
  setDefaultDates();
  await loadData();
});

document.getElementById('refreshBtn').onclick = refreshData;
document.getElementById('dateFrom').onchange = renderDashboard;
document.getElementById('dateTo').onchange = renderDashboard;

document.getElementById('fullBreakdownBtn').onclick = () => openBreakdownModal('full');
document.getElementById('monthEndBreakdownBtn').onclick = () => openBreakdownModal('monthEnd');
// Server-rendered, standalone printable page (no fetch/blob needed) — opens
// in a new tab and auto-triggers the browser's print dialog, same pattern
// as the batch label preview elsewhere in this app.
document.getElementById('productionPlanBtn').onclick = () => {
  window.open(BASE + '/orderbook-breakdown/production-plan/print', '_blank');
};
document.getElementById('closeBreakdownBtn').onclick = closeBreakdownModal;
document.getElementById('exportBreakdownBtn').onclick = exportBreakdown;
document.getElementById('uploadNotesBtn').onclick = () => document.getElementById('uploadNotesInput').click();
document.getElementById('uploadNotesInput').onchange = uploadBreakdownNotes;

document.getElementById('breakdownOverlay').addEventListener('click', e => {
  if (e.target.id === 'breakdownOverlay') closeBreakdownModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeBreakdownModal();
});
