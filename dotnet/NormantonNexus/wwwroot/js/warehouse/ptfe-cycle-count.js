// Weekly PTFE Cycle Count tile — read-only view, port of the display half
// of runPtfeCycleCount() in private/js/warehouse.js. GET /counts/current-ptfe
// lazily creates this week's count if the Monday cron hasn't fired yet.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/stockcount");
  const bodyEl = document.getElementById("pc-body");

  (async () => {
    try {
      const { data } = await api("/counts/current-ptfe");
      const doc = data.document;
      const lines = data.lines || [];
      bodyEl.innerHTML = `
        <p><strong>Count #${doc.countId}</strong> — Status: ${esc(doc.status)} — Week of ${doc.weekStartDate ? new Date(doc.weekStartDate).toLocaleDateString("en-GB") : ""}</p>
        ${lines.length === 0 ? "<p>No lines entered yet.</p>" : `
          <table>
            <thead><tr><th>Material</th><th>Counted Qty</th><th>SAP Qty</th><th>Variance</th><th>Bin</th></tr></thead>
            <tbody>
              ${lines.map((l) => `<tr><td>${esc(l.material)} ${esc(l.materialText)}</td><td>${esc(l.countedQty)}</td><td>${esc(l.sapQty)}</td><td>${esc(l.varianceQty)}</td><td>${esc(l.storageType)}/${esc(l.bin)}</td></tr>`).join("")}
            </tbody>
          </table>`}`;
    } catch (err) {
      bodyEl.innerHTML = `<p>Error: ${esc(err.message)}</p>`;
    }
  })();
})();
