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

      const total = data.byProcess.reduce((s, r) => s + r.total, 0);
      const success = data.byProcess.reduce((s, r) => s + r.success, 0);
      const failed = data.byProcess.reduce((s, r) => s + r.failed, 0);
      const reversed = data.byProcess.reduce((s, r) => s + r.reversed, 0);
      const alertCount = data.alerts.reduce((s, r) => s + r.alertCount, 0);
      const rate = total > 0 ? ((success / total) * 100).toFixed(1) : "—";

      outputEl.appendChild(
        R.kpiRow([
          { label: "Total Backflushes", value: total },
          { label: "Success Rate", value: `${rate}%`, sub: `${success} posted` },
          { label: "Failed", value: failed, sub: "Status 6 records" },
          { label: "Reversed", value: reversed },
          { label: "190 Alerts", value: alertCount, sub: "No component consumption" },
        ])
      );

      outputEl.appendChild(
        R.chartsGrid([
          { title: "Overall Status Split", canvasId: "ch-sap-donut" },
          { title: "Success vs Failed by Process", canvasId: "ch-sap-proc" },
          { title: "Success vs Failed over Time", canvasId: "ch-sap-ts", wide: true },
        ])
      );

      R.mkChart("ch-sap-donut", {
        type: "doughnut",
        data: { labels: ["Success", "Failed", "Reversed"], datasets: [{ data: [success, failed, reversed], backgroundColor: [R.RPT_SUCCESS, R.RPT_ERR, R.RPT_MUT] }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right" } } },
      });

      R.mkChart("ch-sap-proc", {
        type: "bar",
        data: {
          labels: data.byProcess.map((r) => R.PROCESS_LABELS[r.processCode] || r.processCode),
          datasets: [
            { label: "Success", data: data.byProcess.map((r) => r.success), backgroundColor: R.RPT_SUCCESS + "cc", borderRadius: 3 },
            { label: "Failed", data: data.byProcess.map((r) => r.failed), backgroundColor: R.RPT_ERR + "cc", borderRadius: 3 },
          ],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
      });

      R.mkChart("ch-sap-ts", {
        type: "line",
        data: {
          labels: data.timeSeries.map((r) => r.period),
          datasets: [
            { label: "Success", data: data.timeSeries.map((r) => r.success), borderColor: R.RPT_SUCCESS, backgroundColor: "transparent", tension: 0.3 },
            { label: "Failed", data: data.timeSeries.map((r) => r.failed), borderColor: R.RPT_ERR, backgroundColor: "transparent", tension: 0.3 },
          ],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
      });

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
