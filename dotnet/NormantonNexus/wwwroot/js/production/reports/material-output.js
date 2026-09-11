// Material Throughput report — port of runReportMaterial in production-nexus.js.
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
      const { data } = await R.api(`/reports/material-output?${R.buildQuery(filters)}`);

      outputEl.innerHTML = "";
      outputEl.appendChild(R.exportButton(() => data, `material-throughput-${new Date().toISOString().slice(0, 10)}.csv`));
      outputEl.appendChild(
        R.buildTable(["Material", "Process", "UoM", "Batches", "Total Output", "Avg / Batch"], data, (row) => {
          const tr = document.createElement("tr");
          for (const val of [row.material, R.PROCESS_LABELS[row.processCode] || row.processCode, row.uom, row.batchCount, R.fmtNum(row.totalOutput), R.fmtNum(row.avgPerBatch)]) {
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
