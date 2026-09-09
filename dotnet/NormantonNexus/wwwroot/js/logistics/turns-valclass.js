// Stock Turns & Valuation tile — the real, full filterable per-material
// list (GET /turns-valclass), matching Node's own tile description exactly.
// Aggregates/value-by-price moved to their own tiles (Stock Value Overview /
// Stock Value by Price), matching Node's own separate-tile grouping.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance");

  const ROW_CAP = 500;

  function fmtNum(n, dp) {
    if (n === null || n === undefined || n === "") return "—";
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp ?? 2, minimumFractionDigits: 0 });
  }
  function fmtDate(d) {
    return d ? new Date(d).toLocaleDateString("en-GB") : "—";
  }

  async function loadMrpControllers() {
    const sel = document.getElementById("tv-mrp-controller");
    try {
      const { data } = await api("/turns-valclass/mrp-controllers");
      sel.innerHTML = '<option value="">All</option>' + (data || []).map((c) =>
        `<option value="${esc(c.controller)}">${esc(c.controller)} (${c.materialCount})</option>`).join("");
    } catch { /* best-effort */ }
  }

  async function loadRefreshStatus() {
    const el = document.getElementById("tv-refresh-status");
    try {
      const { data } = await api("/turns-valclass/refresh-status");
      if (data.failures && data.failures.length) {
        el.innerHTML = `<span class="tf-inline-error">Refresh failed: ${data.failures.map((f) => esc(f.name)).join(", ")}</span>`;
      } else if (data.lastRefreshUtc) {
        el.textContent = `Last refresh: ${new Date(data.lastRefreshUtc).toLocaleString("en-GB")}`;
      } else {
        el.textContent = "No refresh has completed yet.";
      }
    } catch (err) {
      el.textContent = "Could not load refresh status: " + err.message;
    }
  }

  async function runRefresh() {
    const btn = document.getElementById("tv-refresh-btn");
    btn.disabled = true; btn.textContent = "Refreshing…";
    try {
      await api("/turns-valclass/refresh", { method: "POST" });
      await loadRefreshStatus();
    } catch (err) {
      document.getElementById("tv-refresh-status").innerHTML = `<span class="tf-inline-error">${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false; btn.textContent = "Refresh Now";
    }
  }

  function buildQuery() {
    const params = new URLSearchParams();
    const add = (key, id) => { const v = document.getElementById(id).value.trim(); if (v) params.set(key, v); };
    add("search", "tv-search");
    add("material", "tv-material");
    add("plant", "tv-plant");
    add("mrpController", "tv-mrp-controller");
    add("materialType", "tv-material-type");
    add("valuationClass", "tv-valuation-class");
    add("profitCentre", "tv-profit-centre");
    return params.toString();
  }

  async function load() {
    const bodyEl = document.getElementById("tv-body");
    bodyEl.innerHTML = '<div class="nx-toolbar-hint">Loading…</div>';
    try {
      const qs = buildQuery();
      const { data } = await api(`/turns-valclass${qs ? "?" + qs : ""}`);
      render(data || []);
    } catch (err) {
      bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function render(rows) {
    const bodyEl = document.getElementById("tv-body");
    if (rows.length === 0) {
      bodyEl.innerHTML = '<div class="nx-empty">No materials match these filters.</div>';
      return;
    }
    const shown = rows.slice(0, ROW_CAP);
    const cap = rows.length > ROW_CAP
      ? `<p style="font-size:12px;color:var(--text-muted)">Showing first ${ROW_CAP.toLocaleString()} of ${rows.length.toLocaleString()} — narrow your filters to see more specific results.</p>`
      : `<p style="font-size:12px;color:var(--text-muted)">${rows.length.toLocaleString()} material(s)</p>`;

    bodyEl.innerHTML = `
      ${cap}
      <div style="overflow-x:auto">
        <table class="table--compact">
          <thead><tr>
            <th>Material</th><th>Plant</th><th>Type</th><th>MRP Ctrl</th><th>Val. Class</th><th>Profit Ctr</th>
            <th>Stock Qty</th><th>Stock Value</th><th>Unit Price</th><th>Book Value</th>
            <th>Turns</th><th>Days in Stock</th><th>Turnover Cat.</th><th>Last Receipt</th><th>Last Consumption</th><th>Warning</th>
          </tr></thead>
          <tbody>${shown.map(renderRow).join("")}</tbody>
        </table>
      </div>`;
  }

  function renderRow(r) {
    return `<tr>
      <td><strong>${esc(r.material)}</strong><div style="font-size:10.5px;color:var(--text-muted)">${esc(r.materialText || "")}</div></td>
      <td>${esc(r.plant)}</td>
      <td>${esc(r.materialType || "—")}</td>
      <td>${esc(r.mrpController || "—")}</td>
      <td>${esc(r.valuationClass || "—")}</td>
      <td>${esc(r.profitCentre || "—")}</td>
      <td>${fmtNum(r.stockQty, 3)}</td>
      <td>£${fmtNum(r.stockValue, 0)}</td>
      <td>£${fmtNum(r.unitPrice, 4)}</td>
      <td>£${fmtNum(r.bookValue, 0)}</td>
      <td>${fmtNum(r.stockTurns, 2)}</td>
      <td>${fmtNum(r.daysInStock, 0)}</td>
      <td>${esc(r.turnoverCategory || "—")}</td>
      <td>${fmtDate(r.lastReceiptDate)}</td>
      <td>${fmtDate(r.lastConsumptionDate)}</td>
      <td>${r.warning ? `<span class="badge badge--error">${esc(r.warning)}</span>` : "—"}</td>
    </tr>`;
  }

  document.getElementById("tv-apply-btn").addEventListener("click", load);
  document.getElementById("tv-refresh-btn").addEventListener("click", runRefresh);
  [
    "tv-search", "tv-material", "tv-plant", "tv-material-type", "tv-valuation-class", "tv-profit-centre",
  ].forEach((id) => document.getElementById(id).addEventListener("keydown", (e) => { if (e.key === "Enter") load(); }));
  document.getElementById("tv-mrp-controller").addEventListener("change", load);

  loadMrpControllers();
  loadRefreshStatus();
  load();
})();
