// Haulier On-Time Performance tile — GET /api/shipmentmain/otif-report.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentmain");
  const bodyEl = document.getElementById("or-body");
  const pct = (r) => (r.total ? Math.round((r.onTime / r.total) * 1000) / 10 : 0);

  function pctBadge(p) {
    const cls = p >= 95 ? "badge--success" : p >= 85 ? "badge--warn" : "badge--error";
    return `<span class="badge ${cls}">${p}%</span>`;
  }

  async function load() {
    const months = document.getElementById("or-months").value || 12;
    bodyEl.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await api(`/otif-report?months=${months}`);
      render(data);
    } catch (err) {
      bodyEl.innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
    }
  }

  function table(title, rows, keyLabel, keyField) {
    if (rows.length === 0) return `<h3>${title}</h3><div class="nx-empty">No data.</div>`;
    return `
      <h3>${title}</h3>
      <table>
        <thead><tr><th>${keyLabel}</th><th>On Time</th><th>Total</th><th>OTIF %</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr><td>${esc(r[keyField])}</td><td>${esc(r.onTime)}</td><td>${esc(r.total)}</td><td>${pctBadge(pct(r))}</td></tr>`).join("")}
        </tbody>
      </table>`;
  }

  function render(data) {
    bodyEl.innerHTML = `
      <div class="nx-toolbar" style="margin-bottom:14px">
        <span class="nx-toolbar-title">Overall ${pctBadge(pct(data.totals))}</span>
        <span class="nx-toolbar-spacer"></span>
        <span class="nx-toolbar-hint">${data.totals.onTime} / ${data.totals.total} on time over ${data.months} months</span>
      </div>
      ${table("By Haulier", data.byHaulier, "Haulier", "haulier")}
      ${table("By Country", data.byCountry, "Country", "country")}
      ${table("By Destination", data.byDestination, "Destination", "destination")}
      ${table("By Month", data.byMonth.map((m) => ({ ...m, month: `${m.yr}-${String(m.mo).padStart(2, "0")}` })), "Month", "month")}`;
  }

  document.getElementById("or-refresh").addEventListener("click", load);
  load();
})();
