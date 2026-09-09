// Shift Performance report — port of runReportShift in production-nexus.js.
(function () {
  const R = window.ProductionReports;
  const filtersEl = document.getElementById("rpt-filters");
  const msgEl = document.getElementById("rpt-msg");
  const outputEl = document.getElementById("rpt-output");

  async function run(filters) {
    msgEl.textContent = "";
    outputEl.textContent = "Loading…";
    try {
      const { data } = await R.api(`/reports/shift-comparison?${R.buildQuery(filters)}`);

      outputEl.innerHTML = "";
      outputEl.appendChild(R.exportButton(() => data.output, `shift-performance-${new Date().toISOString().slice(0, 10)}.csv`));

      const outputHeading = document.createElement("h3");
      outputHeading.textContent = "Output by Shift";
      outputEl.appendChild(outputHeading);
      outputEl.appendChild(
        R.buildTable(["Shift", "Process", "UoM", "Batches", "Total Output"], data.output, (row) => {
          const tr = document.createElement("tr");
          for (const val of [row.shiftName, R.PROCESS_LABELS[row.processCode] || row.processCode, row.uom, row.batchCount, R.fmtNum(row.totalOutput)]) {
            const td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
          }
          return tr;
        })
      );

      const scrapHeading = document.createElement("h3");
      scrapHeading.textContent = "Scrap by Process";
      outputEl.appendChild(scrapHeading);
      outputEl.appendChild(
        R.buildTable(["Process", "Scrap KG", "Entries"], data.scrapByProcess, (row) => {
          const tr = document.createElement("tr");
          for (const val of [R.PROCESS_LABELS[row.processCode] || row.processCode, R.fmtNum(row.scrapKg), row.entryCount]) {
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
