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

      const top15 = data.filter((r) => r.uom === "M").slice(0, 15);
      const uniqueMaterials = new Set(data.map((r) => r.material)).size;

      outputEl.appendChild(
        R.kpiRow([
          { label: "Unique Materials", value: uniqueMaterials },
          { label: "Top Material", value: top15[0]?.material || "—", sub: top15[0] ? `${R.fmtNum(top15[0].totalOutput)} M` : "" },
          { label: "Total Batches", value: data.reduce((s, r) => s + r.batchCount, 0) },
        ])
      );

      outputEl.appendChild(R.chartsGrid([{ title: "Top 15 Materials by Output (Metres)", canvasId: "ch-mat-rank", wide: true, tall: true }]));
      R.mkChart("ch-mat-rank", {
        type: "bar",
        data: {
          labels: top15.map((r) => r.material),
          datasets: [{ label: "Metres", data: top15.map((r) => Number(r.totalOutput)), backgroundColor: R.RPT_PALETTE.map((c) => c + "cc").slice(0, top15.length), borderRadius: 4 }],
        },
        options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });

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
