// Haulier On-Time Performance tile — GET /api/shipmentmain/otif-report.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentmain");
  const bodyEl = document.getElementById("or-body");
  const pct = (r) => (r.total ? Math.round((r.onTime / r.total) * 1000) / 10 : 0);

  async function load() {
    const months = document.getElementById("or-months").value || 12;
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api(`/otif-report?months=${months}`);
      render(data);
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function table(title, rows, keyLabel, keyField) {
    return `
      <h3>${title}</h3>
      <table>
        <thead><tr><th>${keyLabel}</th><th>On Time</th><th>Total</th><th>OTIF %</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr><td>${esc(r[keyField])}</td><td>${esc(r.onTime)}</td><td>${esc(r.total)}</td><td>${pct(r)}%</td></tr>`).join("")}
        </tbody>
      </table>`;
  }

  function render(data) {
    bodyEl.innerHTML = `
      <p><strong>Overall: ${pct(data.totals)}%</strong> (${data.totals.onTime} / ${data.totals.total}) over ${data.months} months</p>
      ${table("By Haulier", data.byHaulier, "Haulier", "haulier")}
      ${table("By Country", data.byCountry, "Country", "country")}
      ${table("By Destination", data.byDestination, "Destination", "destination")}
      ${table("By Month", data.byMonth.map((m) => ({ ...m, month: `${m.yr}-${String(m.mo).padStart(2, "0")}` })), "Month", "month")}`;
  }

  document.getElementById("or-refresh").addEventListener("click", load);
  load();
})();
