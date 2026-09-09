// SAP Performance report — port of runReportSapPerf in production-nexus.js.
(function () {
  const R = window.ProductionReports;
  const filtersEl = document.getElementById("rpt-filters");
  const msgEl = document.getElementById("rpt-msg");
  const outputEl = document.getElementById("rpt-output");

  async function run(filters) {
    msgEl.textContent = "";
    outputEl.textContent = "Loading…";
    try {
      const { data } = await R.api(`/reports/sap-performance?${R.buildQuery(filters)}`);

      outputEl.innerHTML = "";
      outputEl.appendChild(R.exportButton(() => data.byProcess, `sap-performance-${new Date().toISOString().slice(0, 10)}.csv`));

      const byProcessHeading = document.createElement("h3");
      byProcessHeading.textContent = "By Process";
      outputEl.appendChild(byProcessHeading);
      outputEl.appendChild(
        R.buildTable(["Process", "Total", "Success", "Failed", "Reversed"], data.byProcess, (row) => {
          const tr = document.createElement("tr");
          for (const val of [R.PROCESS_LABELS[row.processCode] || row.processCode, row.total, row.success, row.failed, row.reversed]) {
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
        R.buildTable(["Period", "Success", "Failed"], data.timeSeries, (row) => {
          const tr = document.createElement("tr");
          for (const val of [row.period, row.success, row.failed]) {
            const td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
          }
          return tr;
        })
      );

      const alertsHeading = document.createElement("h3");
      alertsHeading.textContent = "Backflush Alerts";
      outputEl.appendChild(alertsHeading);
      outputEl.appendChild(
        R.buildTable(["Process", "Alerts"], data.alerts, (row) => {
          const tr = document.createElement("tr");
          for (const val of [R.PROCESS_LABELS[row.processCode] || row.processCode, row.alertCount]) {
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
