// Operator Output report — port of runReportOperator in production-nexus.js.
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
      const { data } = await R.api(`/reports/operator-output?${R.buildQuery(filters)}`);

      outputEl.innerHTML = "";
      outputEl.appendChild(R.exportButton(() => data, `operator-output-${new Date().toISOString().slice(0, 10)}.csv`));
      outputEl.appendChild(
        R.buildTable(["Operator", "Process", "UoM", "Batches", "Total Output"], data, (row) => {
          const tr = document.createElement("tr");
          for (const val of [row.username, R.PROCESS_LABELS[row.processCode] || row.processCode, row.uom, row.batchCount, R.fmtNum(row.totalOutput)]) {
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
