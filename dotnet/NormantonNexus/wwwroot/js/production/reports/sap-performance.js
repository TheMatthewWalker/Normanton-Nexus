// SAP Performance report — port of runReportSapPerf in production-nexus.js.
(function () {
  const R = window.ProductionReports;
  const filtersEl = document.getElementById("rpt-filters");
  const msgEl = document.getElementById("rpt-msg");
  const outputEl = document.getElementById("rpt-output");

  async function run(filters) {
    msgEl.classList.add("hidden");
    msgEl.textContent = "";
    outputEl.innerHTML = `<div class="nx-empty">Loading…</div>`;
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
          const tdProcess = document.createElement("td");
          tdProcess.textContent = R.PROCESS_LABELS[row.processCode] || row.processCode;
          const tdTotal = document.createElement("td");
          tdTotal.textContent = row.total;
          const tdSuccess = document.createElement("td");
          tdSuccess.appendChild(R.badgeEl(row.success, row.success > 0 ? "success" : undefined));
          const tdFailed = document.createElement("td");
          tdFailed.appendChild(R.badgeEl(row.failed, row.failed > 0 ? "error" : undefined));
          const tdReversed = document.createElement("td");
          tdReversed.appendChild(R.badgeEl(row.reversed, row.reversed > 0 ? "warn" : undefined));
          tr.append(tdProcess, tdTotal, tdSuccess, tdFailed, tdReversed);
          return tr;
        })
      );

      const seriesHeading = document.createElement("h3");
      seriesHeading.textContent = "By Period";
      outputEl.appendChild(seriesHeading);
      outputEl.appendChild(
        R.buildTable(["Period", "Success", "Failed"], data.timeSeries, (row) => {
          const tr = document.createElement("tr");
          const tdPeriod = document.createElement("td");
          tdPeriod.textContent = row.period;
          const tdSuccess = document.createElement("td");
          tdSuccess.appendChild(R.badgeEl(row.success, row.success > 0 ? "success" : undefined));
          const tdFailed = document.createElement("td");
          tdFailed.appendChild(R.badgeEl(row.failed, row.failed > 0 ? "error" : undefined));
          tr.append(tdPeriod, tdSuccess, tdFailed);
          return tr;
        })
      );

      const alertsHeading = document.createElement("h3");
      alertsHeading.textContent = "Backflush Alerts";
      outputEl.appendChild(alertsHeading);
      outputEl.appendChild(
        R.buildTable(["Process", "Alerts"], data.alerts, (row) => {
          const tr = document.createElement("tr");
          const tdProcess = document.createElement("td");
          tdProcess.textContent = R.PROCESS_LABELS[row.processCode] || row.processCode;
          const tdAlerts = document.createElement("td");
          tdAlerts.appendChild(R.badgeEl(row.alertCount, row.alertCount > 0 ? "warn" : undefined));
          tr.append(tdProcess, tdAlerts);
          return tr;
        })
      );
    } catch (err) {
      outputEl.innerHTML = "";
      msgEl.textContent = err.message;
      msgEl.classList.remove("hidden");
    }
  }

  outputEl.innerHTML = `<div class="nx-empty">Choose filters and click Run Report to see results.</div>`;
  R.mountFilterBar(filtersEl, run);
})();
