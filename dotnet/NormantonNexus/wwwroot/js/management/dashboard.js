// Management dashboard — port of private/js/management.js. Charts use
// Chart.js (already the established CDN choice elsewhere in this app —
// see Finance/ActualCosts.cshtml) rather than Node's echarts, and the
// Full/Month End Breakdown views are a flat sortable table here rather
// than Node's collapsible Year>Month>Customer>Order>Material tree — a
// deliberate simplification for this secondary "what-if" detail view,
// not a missing feature; every figure it shows is the same real data.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance");

  let rawValueData = [];
  let rawOtifData = [];
  let rawOrderBookData = [];
  const charts = {};

  function fmtDate(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function formatCurrency(v) { return "£" + Math.round(v || 0).toLocaleString("en-GB"); }
  function formatPercent(v) { return (v || 0).toFixed(1) + "%"; }
  function currencyCell(v) { return v ? "£" + Math.round(v).toLocaleString("en-GB") : "£-"; }
  function numberCell(v) { return v ? Math.round(v).toLocaleString("en-GB") : "-"; }
  const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function setDefaultDates() {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    document.getElementById("dateFrom").value = fmtDate(start);
    document.getElementById("dateTo").value = fmtDate(today);
  }

  function filterData(data) {
    const from = document.getElementById("dateFrom").value;
    const to = document.getElementById("dateTo").value;
    return data.filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
  }

  function filterByArea(data, area) {
    return data.map((row) => {
      const streams = row.streams || {};
      return { date: row.date, area: streams[area] || null };
    });
  }

  // ── Refresh ──────────────────────────────────────────────────────
  document.getElementById("refreshBtn").addEventListener("click", async () => {
    const status = document.getElementById("refreshStatus");
    const btn = document.getElementById("refreshBtn");
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    status.textContent = "Updating data…";
    try {
      await api("/refresh", { method: "POST" });
      status.textContent = "Data updated successfully";
      await loadData();
      setTimeout(() => { status.textContent = ""; }, 3000);
    } catch (err) {
      status.textContent = "Refresh failed: " + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Refresh Data";
    }
  });

  function formatRefreshAge(value) {
    if (!value) return "Refresh status unavailable";
    const t = new Date(value);
    if (Number.isNaN(t.getTime())) return "Refresh status unavailable";
    const diffMin = Math.max(0, Math.floor((Date.now() - t.getTime()) / 60000));
    if (diffMin < 1) return "Last refresh just now";
    if (diffMin === 1) return "Last refresh 1 minute ago";
    if (diffMin < 60) return `Last refresh ${diffMin} minutes ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr === 1) return "Last refresh 1 hour ago";
    if (diffHr < 24) return `Last refresh ${diffHr} hours ago`;
    const diffDay = Math.floor(diffHr / 24);
    return diffDay === 1 ? "Last refresh 1 day ago" : `Last refresh ${diffDay} days ago`;
  }

  async function loadRefreshStatus() {
    const el = document.getElementById("refreshSummary");
    try {
      const { data } = await api("/refresh-status");
      const failures = data?.failures || [];
      if (failures.length) {
        el.textContent = "Refresh failed: " + failures.map((f) => f.name).join(", ");
        el.title = failures.map((f) => `${f.name}: ${f.status}${f.errorMessage ? " - " + f.errorMessage : ""}`).join("\n");
        return;
      }
      el.textContent = formatRefreshAge(data?.lastRefreshUtc);
      el.title = (data?.datasets || []).map((d) => `${d.name}: ${d.status}`).join("\n");
    } catch {
      el.textContent = "Refresh status unavailable";
    }
  }

  // ── Load + render ────────────────────────────────────────────────
  async function loadData() {
    const [valueRes, otifRes, orderBookRes] = await Promise.all([
      api("/value-metrics"), api("/otif-metrics"), api("/orderbook-summary"),
    ]);
    rawValueData = valueRes.data || [];
    rawOtifData = otifRes.data || [];
    rawOrderBookData = orderBookRes.data || [];
    renderDashboard();
    await loadRefreshStatus();
  }

  function renderDashboard() {
    const valueData = filterData(rawValueData);
    const otifData = filterData(rawOtifData);

    const ptfe = filterByArea(valueData, "PTFE");
    const pv = filterByArea(valueData, "PV");
    const ptfeOtif = filterByArea(otifData, "PTFE");
    const pvOtif = filterByArea(otifData, "PV");

    renderTable(valueData);
    const kpis = renderKpis(valueData, otifData);
    renderOrderBookTable(rawOrderBookData, kpis.ptfe);

    renderLineChart("ptfeValueChart", ptfe.map((d) => d.date), ptfe.map((d) => d.area?.invoiced || 0), "PTFE Invoiced", "#2563eb");
    renderLineChart("pvValueChart", pv.map((d) => d.date), pv.map((d) => d.area?.invoiced || 0), "PV Invoiced", "#16a34a");
    renderLineChart("ptfeOtifChart", ptfeOtif.map((d) => d.date), ptfeOtif.map((d) => (d.area && d.area.total ? (d.area.onTime / d.area.total) * 100 : 0)), "PTFE OTIF %", "#2563eb");
    renderLineChart("pvOtifChart", pvOtif.map((d) => d.date), pvOtif.map((d) => (d.area && d.area.total ? (d.area.onTime / d.area.total) * 100 : 0)), "PV OTIF %", "#16a34a");

    renderLineChart("ptfeValueExtendedChart", ptfe.map((d) => d.date), cumulative(ptfe.map((d) => d.area?.invoiced || 0)), "PTFE Cumulative Invoiced", "#2563eb");
    renderLineChart("pvValueExtendedChart", pv.map((d) => d.date), cumulative(pv.map((d) => d.area?.invoiced || 0)), "PV Cumulative Invoiced", "#16a34a");
    renderLineChart("ptfeOtifCumulativeChart", ptfeOtif.map((d) => d.date), cumulativeOtif(ptfeOtif), "PTFE Cumulative OTIF %", "#2563eb");
    renderLineChart("pvOtifCumulativeChart", pvOtif.map((d) => d.date), cumulativeOtif(pvOtif), "PV Cumulative OTIF %", "#16a34a");
  }

  function cumulative(values) {
    let running = 0;
    return values.map((v) => (running += v));
  }
  function cumulativeOtif(rows) {
    let onTime = 0, total = 0;
    return rows.map((d) => {
      onTime += d.area?.onTime || 0;
      total += d.area?.total || 0;
      return total > 0 ? (onTime / total) * 100 : 0;
    });
  }

  function renderLineChart(canvasId, labels, values, label, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (charts[canvasId]) charts[canvasId].destroy();
    charts[canvasId] = new Chart(canvas, {
      type: "line",
      data: { labels, datasets: [{ label, data: values, borderColor: color, backgroundColor: color + "33", tension: 0.2, pointRadius: 0 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 6 } } } },
    });
  }

  function renderTable(data) {
    const table = document.getElementById("dataTable");
    const thead = table.querySelector("thead");
    const tbody = table.querySelector("tbody");
    thead.innerHTML = "<tr><th>Date</th><th>PTFE Daily</th><th>PTFE Cum</th><th>PV Daily</th><th>PV Cum</th><th>Total Cum</th></tr>";
    let ptfeRunning = 0, pvRunning = 0;
    tbody.innerHTML = data.map((row) => {
      const ptfe = row.streams?.PTFE?.invoiced || 0;
      const pv = row.streams?.PV?.invoiced || 0;
      ptfeRunning += ptfe; pvRunning += pv;
      return `<tr><td>${esc(row.date)}</td><td>${formatCurrency(ptfe)}</td><td>${formatCurrency(ptfeRunning)}</td><td>${formatCurrency(pv)}</td><td>${formatCurrency(pvRunning)}</td><td>${formatCurrency(ptfeRunning + pvRunning)}</td></tr>`;
    }).join("");
  }

  function renderKpis(valueData, otifData) {
    let ptfe = 0, pv = 0, ptfeOnTime = 0, ptfeTotal = 0, pvOnTime = 0, pvTotal = 0;
    for (const row of valueData) {
      ptfe += row.streams?.PTFE?.invoiced || 0;
      pv += row.streams?.PV?.invoiced || 0;
    }
    for (const row of otifData) {
      ptfeOnTime += row.streams?.PTFE?.onTime || 0;
      ptfeTotal += row.streams?.PTFE?.total || 0;
      pvOnTime += row.streams?.PV?.onTime || 0;
      pvTotal += row.streams?.PV?.total || 0;
    }
    const ptfeOtif = ptfeTotal ? (ptfeOnTime / ptfeTotal) * 100 : 0;
    const pvOtif = pvTotal ? (pvOnTime / pvTotal) * 100 : 0;
    document.getElementById("kpi-ptfe").textContent = formatCurrency(ptfe);
    document.getElementById("kpi-pv").textContent = formatCurrency(pv);
    document.getElementById("kpi-ptfe-otif").textContent = formatPercent(ptfeOtif);
    document.getElementById("kpi-pv-otif").textContent = formatPercent(pvOtif);
    return { ptfe, pv };
  }

  // ── Order Book summary table ─────────────────────────────────────
  function renderOrderBookTable(rows, ptfeInvoiced) {
    const container = document.getElementById("orderBookTable");
    const grouped = {};
    for (const row of rows) {
      const year = Number(row.year), month = Number(row.month), vs = row.valueStream;
      grouped[year] ??= {};
      grouped[year][month] ??= { PTFE: { orders: 0, stock: 0, picked: 0 }, PV: { orders: 0, stock: 0, picked: 0 } };
      if (!grouped[year][month][vs]) continue;
      grouped[year][month][vs].orders += row.orders || 0;
      grouped[year][month][vs].stock += row.stock || 0;
      grouped[year][month][vs].picked += row.picked || 0;
    }

    const today = new Date();
    const currentYear = today.getFullYear(), currentMonth = today.getMonth() + 1;
    let pickedToDate = 0, stockToDate = 0;
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
    document.getElementById("kpi-ptfe-picked-only").textContent = formatCurrency(pickedToDate);
    document.getElementById("kpi-ptfe-picked").textContent = formatCurrency(pickedToDate + ptfeInvoiced);
    document.getElementById("kpi-ptfe-stock").textContent = formatCurrency(remainingStock);
    document.getElementById("kpi-ptfe-potential").textContent = formatCurrency(potential);

    const grand = { PTFE: { orders: 0, stock: 0, picked: 0 }, PV: { orders: 0, stock: 0, picked: 0 } };
    const years = Object.keys(grouped).map(Number).sort((a, b) => a - b);
    let html = `<table><thead><tr><th rowspan="2">Year / Month</th><th colspan="3">PTFE</th><th colspan="3">PV</th></tr><tr><th>Orders</th><th>Stock</th><th>Picked</th><th>Orders</th><th>Stock</th><th>Picked</th></tr></thead><tbody>`;

    for (const year of years) {
      const months = Object.keys(grouped[year]).map(Number).sort((a, b) => a - b);
      const yearKey = `ob-year-${year}`;
      const yearTotal = { PTFE: { orders: 0, stock: 0, picked: 0 }, PV: { orders: 0, stock: 0, picked: 0 } };
      for (const month of months) {
        const p = grouped[year][month].PTFE, v = grouped[year][month].PV;
        yearTotal.PTFE.orders += p.orders; yearTotal.PTFE.stock += p.stock; yearTotal.PTFE.picked += p.picked;
        yearTotal.PV.orders += v.orders; yearTotal.PV.stock += v.stock; yearTotal.PV.picked += v.picked;
      }
      grand.PTFE.orders += yearTotal.PTFE.orders; grand.PTFE.stock += yearTotal.PTFE.stock; grand.PTFE.picked += yearTotal.PTFE.picked;
      grand.PV.orders += yearTotal.PV.orders; grand.PV.stock += yearTotal.PV.stock; grand.PV.picked += yearTotal.PV.picked;

      html += `<tr style="cursor:pointer; font-weight:600;" data-toggle="${yearKey}"><td><span id="icon-${yearKey}">&#9654;</span> ${year}</td>
        <td>${currencyCell(yearTotal.PTFE.orders)}</td><td>${currencyCell(yearTotal.PTFE.stock)}</td><td>${currencyCell(yearTotal.PTFE.picked)}</td>
        <td>${currencyCell(yearTotal.PV.orders)}</td><td>${currencyCell(yearTotal.PV.stock)}</td><td>${currencyCell(yearTotal.PV.picked)}</td></tr>`;

      for (const month of months) {
        const p = grouped[year][month].PTFE, v = grouped[year][month].PV;
        html += `<tr data-parent="${yearKey}" hidden><td style="padding-left:1.5rem;">${MONTH_NAMES[month]}</td>
          <td>${currencyCell(p.orders)}</td><td>${currencyCell(p.stock)}</td><td>${currencyCell(p.picked)}</td>
          <td>${currencyCell(v.orders)}</td><td>${currencyCell(v.stock)}</td><td>${currencyCell(v.picked)}</td></tr>`;
      }
    }

    html += `<tr style="font-weight:700;"><td>Grand Total</td>
      <td>${currencyCell(grand.PTFE.orders)}</td><td>${currencyCell(grand.PTFE.stock)}</td><td>${currencyCell(grand.PTFE.picked)}</td>
      <td>${currencyCell(grand.PV.orders)}</td><td>${currencyCell(grand.PV.stock)}</td><td>${currencyCell(grand.PV.picked)}</td></tr></tbody></table>`;

    container.innerHTML = html;
    container.querySelectorAll("tr[data-toggle]").forEach((tr) => {
      tr.addEventListener("click", () => {
        const key = tr.dataset.toggle;
        const icon = document.getElementById(`icon-${key}`);
        const rows2 = container.querySelectorAll(`tr[data-parent="${key}"]`);
        const collapsed = rows2[0]?.hidden;
        rows2.forEach((r) => { r.hidden = !collapsed; });
        if (icon) icon.innerHTML = collapsed ? "&#9660;" : "&#9654;";
      });
    });
  }

  // ── Full/Month End Breakdown (flat, sortable) ────────────────────
  let breakdownRows = [];
  let breakdownSortKey = "customer";
  let breakdownSortDir = 1;

  function isOnOrBeforeCurrentMonth(dateStr) {
    if (!dateStr) return true;
    const d = new Date(dateStr);
    const today = new Date();
    return d.getFullYear() < today.getFullYear() || (d.getFullYear() === today.getFullYear() && d.getMonth() <= today.getMonth());
  }

  async function openBreakdown(mode) {
    document.getElementById("breakdownSection").style.display = "";
    document.getElementById("breakdownTitle").textContent = mode === "monthEnd" ? "Order Book — Breakdown for Month End" : "Order Book — Full Breakdown";
    const container = document.getElementById("breakdownTableContainer");
    container.innerHTML = "Loading…";
    try {
      const { data } = await api("/orderbook-breakdown");
      let rows = data || [];
      if (mode === "monthEnd") rows = rows.filter((r) => isOnOrBeforeCurrentMonth(r.requestDate));
      breakdownRows = rows;
      renderBreakdownTable();
    } catch (err) {
      container.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function renderBreakdownTable() {
    const container = document.getElementById("breakdownTableContainer");
    if (breakdownRows.length === 0) { container.innerHTML = "<p>No order book data available.</p>"; return; }
    const cols = [
      { key: "customer", label: "Customer" }, { key: "customerName", label: "Customer Name" },
      { key: "referenceDocument", label: "Order" }, { key: "material", label: "Material" }, { key: "materialText", label: "Description" },
      { key: "requestDate", label: "Date" }, { key: "valueStream", label: "Stream" },
      { key: "orderValue", label: "Order Value" }, { key: "stockValue", label: "Stock Value" }, { key: "pickedValue", label: "Picked Value" },
    ];
    const sorted = [...breakdownRows].sort((a, b) => {
      const av = a[breakdownSortKey], bv = b[breakdownSortKey];
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av > bv ? 1 : av < bv ? -1 : 0) * breakdownSortDir;
    });
    container.innerHTML = `
      <table>
        <thead><tr>${cols.map((c) => `<th style="cursor:pointer;" data-sort="${c.key}">${c.label}${breakdownSortKey === c.key ? (breakdownSortDir === 1 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>
        <tbody>
          ${sorted.map((r) => `<tr>
            <td>${esc(r.customer)}</td><td>${esc(r.customerName)}</td><td>${esc(r.referenceDocument)}</td>
            <td>${esc(r.material)}</td><td>${esc(r.materialText)}</td><td>${esc(r.requestDate)}</td><td>${esc(r.valueStream)}</td>
            <td>${currencyCell(r.orderValue)}</td><td>${currencyCell(r.stockValue)}</td><td>${currencyCell(r.pickedValue)}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
    container.querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (breakdownSortKey === key) breakdownSortDir *= -1;
        else { breakdownSortKey = key; breakdownSortDir = 1; }
        renderBreakdownTable();
      });
    });
  }

  document.getElementById("fullBreakdownBtn").addEventListener("click", () => openBreakdown("full"));
  document.getElementById("monthEndBreakdownBtn").addEventListener("click", () => openBreakdown("monthEnd"));
  document.getElementById("closeBreakdownBtn").addEventListener("click", () => { document.getElementById("breakdownSection").style.display = "none"; });
  document.getElementById("productionPlanBtn").addEventListener("click", () => { window.open("/api/performance/orderbook-breakdown/production-plan/print", "_blank"); });

  document.getElementById("uploadNotesBtn").addEventListener("click", () => document.getElementById("uploadNotesInput").click());
  document.getElementById("uploadNotesInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const statusEl = document.getElementById("uploadNotesStatus");
    statusEl.textContent = "Uploading…";
    try {
      const buf = await file.arrayBuffer();
      const { data } = await api("/orderbook-breakdown/upload-notes", {
        method: "POST", headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, body: buf,
      });
      statusEl.textContent = `Saved — ${data.rowsUpdated} line(s) updated.`;
    } catch (err) {
      statusEl.textContent = "Upload failed: " + err.message;
    }
    setTimeout(() => { statusEl.textContent = ""; }, 6000);
  });

  // ── Consignment Customers ────────────────────────────────────────
  async function loadConsignmentCustomers() {
    const body = document.getElementById("consignmentCustomersBody");
    try {
      const { data } = await api("/consignment-customers");
      const rows = data || [];
      body.innerHTML = rows.length ? rows.map((r) => `
        <tr><td>${esc(r.customer)}</td><td>${esc(r.customerName)}</td><td><button type="button" class="btn secondary" data-remove="${esc(r.customer)}">Remove</button></td></tr>`).join("")
        : '<tr><td colspan="3">No consignment customers flagged.</td></tr>';
      body.querySelectorAll("button[data-remove]").forEach((btn) => {
        btn.addEventListener("click", () => removeConsignmentCustomer(btn.dataset.remove));
      });
    } catch (err) {
      body.innerHTML = `<tr><td colspan="3">Failed to load: ${esc(err.message)}</td></tr>`;
    }
  }

  document.getElementById("ccAddBtn").addEventListener("click", async () => {
    const customerInput = document.getElementById("ccAddCustomer");
    const nameInput = document.getElementById("ccAddCustomerName");
    const status = document.getElementById("ccStatus");
    const customer = customerInput.value.trim();
    if (!customer) { status.textContent = "Enter a customer number first."; return; }
    status.textContent = "Saving…";
    try {
      await api(`/consignment-customers/${encodeURIComponent(customer)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customerName: nameInput.value.trim() || null }),
      });
      customerInput.value = ""; nameInput.value = ""; status.textContent = "";
      await loadConsignmentCustomers();
    } catch (err) {
      status.textContent = "Failed to save: " + err.message;
    }
  });

  async function removeConsignmentCustomer(customer) {
    const status = document.getElementById("ccStatus");
    status.textContent = "Removing…";
    try {
      await api(`/consignment-customers/${encodeURIComponent(customer)}`, { method: "DELETE" });
      status.textContent = "";
      await loadConsignmentCustomers();
    } catch (err) {
      status.textContent = "Failed to remove: " + err.message;
    }
  }

  document.getElementById("dateFrom").addEventListener("change", renderDashboard);
  document.getElementById("dateTo").addEventListener("change", renderDashboard);

  setDefaultDates();
  loadData();
  loadConsignmentCustomers();
})();
