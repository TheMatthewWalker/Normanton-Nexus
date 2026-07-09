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

// TOGGLE FOR ORDERBOOK GROUPS
window.toggleOrderBookGroup = function(groupId) {

  const rows = document.querySelectorAll(
    `[data-parent="${groupId}"]`
  );

  rows.forEach(row => {
    row.classList.toggle('ob-hidden');
  });

  const icon = document.getElementById(`icon-${groupId}`);

  if (icon) {
    icon.textContent =
      icon.textContent === '▶'
        ? '▼'
        : '▶';
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
``


function formatNumber(n) {
  return n.toLocaleString('en-GB', {
    maximumFractionDigits: 0
  });
}



function formatCurrency(n) {
  return '£' + (n || 0).toLocaleString('en-GB', {
    maximumFractionDigits: 0
  });
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
  document.getElementById('kpi-total').innerText = formatCurrency(ptfe + pv);
  document.getElementById('kpi-ptfe-otif').innerText = formatPercent(ptfeOtif);
  document.getElementById('kpi-pv-otif').innerText = formatPercent(pvOtif);
  document.getElementById('kpi-total-otif').innerText = formatPercent(totalOtif);
}


// ORDERBOOK
let rawOrderBookData = [];

function renderOrderBookTable(rows) {

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
  renderKpis(valueData, otifData);
  renderOrderBookTable(rawOrderBookData);

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

