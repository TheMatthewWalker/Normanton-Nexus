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


async function loadData() {
  const valueRes = await fetch(BASE + '/value-metrics');
  const otifRes = await fetch(BASE + '/otif-metrics');

  rawValueData = (await valueRes.json()).data;
  rawOtifData = (await otifRes.json()).data;

  renderDashboard();
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
    tooltip: { trigger: 'axis' },

    grid: { left: 60, right: 20, top: 30, bottom: 40 },

    xAxis: {
      type: 'category',
      data: data.map(d => d.date)
    },

    yAxis: {
      type: 'value',
      scale: true,
      splitLine: { lineStyle: { color: '#E5EAF2' } }
    },

    series: [
      {
        name: 'Invoiced',
        type: 'line',
        stack: 'total',
        areaStyle: { opacity: 0.25 },
        data: data.map(d => {
          const vs = Object.keys(d).find(k => k !== 'date');
          return d[vs]?.invoiced || 0;
        }),
        lineStyle: { width: 3, color: colour }
      },
      {
        name: 'Picked',
        type: 'line',
        stack: 'total',
        areaStyle: { opacity: 0.2 },
        data: data.map(d => {
          const vs = Object.keys(d).find(k => k !== 'date');
          return d[vs]?.picked || 0;
        }),
        lineStyle: { width: 2, color: '#84cc16' }
      },
      {
        name: 'Stock',
        type: 'line',
        stack: 'total',
        areaStyle: { opacity: 0.15 },
        data: data.map(d => {
          const vs = Object.keys(d).find(k => k !== 'date');
          return d[vs]?.stock || 0;
        }),
        lineStyle: { width: 2, color: '#64748B' }
      }
    ]
  });
}


// ✅ VALUE CUMULATIVE
function renderValueCumulativeChart(id, data, colour) {
  renderChart(id, {
    tooltip: { trigger: 'axis' },

    grid: { left: 60, right: 20, top: 30, bottom: 40 },

    xAxis: {
      type: 'category',
      data: data.map(d => d.date)
    },

    yAxis: {
      type: 'value',
      scale: true, // ✅ critical
      min: 'dataMin',
      splitNumber: 5
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
``

// ✅ EXTENDED VALUE
function renderExtendedChart(id, data, colour) {
  renderChart(id, {
    tooltip: { trigger: 'axis' },
    legend: { top: 5 },

    xAxis: {
      type: 'category',
      data: data.map(d => d.date)
    },

    yAxis: {
      type: 'value',
      scale: true
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


function renderKpis(data) {
  let ptfe = 0;
  let pv = 0;

  for (const row of data) {
    ptfe += row.PTFE?.invoiced || 0;
    pv   += row.PV?.invoiced || 0;
  }

  document.getElementById('kpi-ptfe').innerText = formatCurrency(ptfe);
  document.getElementById('kpi-pv').innerText   = formatCurrency(pv);
  document.getElementById('kpi-total').innerText = formatCurrency(ptfe + pv);
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
  renderKpis(valueData);

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

