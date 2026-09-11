// Shift Performance report — port of runReportShift in production-nexus.js.
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
      const { data } = await R.api(`/reports/shift-comparison?${R.buildQuery(filters)}`);

      outputEl.innerHTML = "";
      outputEl.appendChild(R.exportButton(() => data.output, `shift-performance-${new Date().toISOString().slice(0, 10)}.csv`));

      const outputHeading = document.createElement("h3");
      outputHeading.textContent = "Output by Shift";
      outputEl.appendChild(outputHeading);
      outputEl.appendChild(
        R.buildTable(["Shift", "Process", "UoM", "Batches", "Total Output"], data.output, (row) => {
          const tr = document.createElement("tr");
          const tdShift = document.createElement("td");
          tdShift.appendChild(R.badgeEl(row.shiftName, "accent"));
          const tdProcess = document.createElement("td");
          tdProcess.textContent = R.PROCESS_LABELS[row.processCode] || row.processCode;
          const tdUom = document.createElement("td");
          tdUom.textContent = row.uom;
          const tdBatches = document.createElement("td");
          tdBatches.textContent = row.batchCount;
          const tdTotal = document.createElement("td");
          tdTotal.textContent = R.fmtNum(row.totalOutput);
          tr.append(tdShift, tdProcess, tdUom, tdBatches, tdTotal);
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
      outputEl.innerHTML = "";
      msgEl.textContent = err.message;
      msgEl.classList.remove("hidden");
    }
  }

  outputEl.innerHTML = `<div class="nx-empty">Choose filters and click Run Report to see results.</div>`;
  R.mountFilterBar(filtersEl, run);
})();
