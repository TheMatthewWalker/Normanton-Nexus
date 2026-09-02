// Scrap Analysis report — port of runReportScrap in production-nexus.js.
// Note: unlike most other reports, Node's own Scrap queries never apply
// the process filter to any of the three result sets — ported faithfully,
// not "fixed" (see ProductionReportsHelper.GetScrapAsync's comment).
(function () {
  const R = window.ProductionReports;
  const filtersEl = document.getElementById("rpt-filters");
  const msgEl = document.getElementById("rpt-msg");
  const outputEl = document.getElementById("rpt-output");

  async function run(filters) {
    msgEl.textContent = "";
    outputEl.textContent = "Loading…";
    try {
      const { data } = await R.api(`/reports/scrap?${R.buildQuery(filters)}`);

      outputEl.innerHTML = "";
      outputEl.appendChild(R.exportButton(() => data.byReason, `scrap-analysis-${new Date().toISOString().slice(0, 10)}.csv`));

      const summary = document.createElement("p");
      summary.textContent = `Total: ${R.fmtNum(data.totals.totalKg)} KG across ${data.totals.entryCount} entries — top reason: ${data.totals.topReason}`;
      outputEl.appendChild(summary);

      const reasonHeading = document.createElement("h3");
      reasonHeading.textContent = "By Reason";
      outputEl.appendChild(reasonHeading);
      outputEl.appendChild(
        R.buildTable(["Reason", "Total KG", "Entries"], data.byReason, (row) => {
          const tr = document.createElement("tr");
          for (const val of [row.reasonDescription, R.fmtNum(row.totalKg), row.entryCount]) {
            const td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
          }
          return tr;
        })
      );

      const processHeading = document.createElement("h3");
      processHeading.textContent = "By Process";
      outputEl.appendChild(processHeading);
      outputEl.appendChild(
        R.buildTable(["Process", "Total KG", "Entries"], data.byProcess, (row) => {
          const tr = document.createElement("tr");
          for (const val of [R.PROCESS_LABELS[row.processCode] || row.processCode, R.fmtNum(row.totalKg), row.entryCount]) {
            const td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
          }
          return tr;
        })
      );

      const seriesHeading = document.createElement("h3");
      seriesHeading.textContent = "By Period";
      outputEl.appendChild(seriesHeading);
      outputEl.appendChild(
        R.buildTable(["Period", "Total KG", "Entries"], data.timeSeries, (row) => {
          const tr = document.createElement("tr");
          for (const val of [row.period, R.fmtNum(row.totalKg), row.entryCount]) {
            const td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
          }
          return tr;
        })
      );
    } catch (err) {
      outputEl.textContent = "";
      msgEl.textContent = err.message;
    }
  }

  R.mountFilterBar(filtersEl, run);
})();
