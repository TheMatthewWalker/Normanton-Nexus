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

      const byOp = {};
      for (const r of data) {
        if (!byOp[r.username]) byOp[r.username] = { totalM: 0, totalKg: 0, batches: 0 };
        if (r.uom === "M") byOp[r.username].totalM += Number(r.totalOutput);
        if (r.uom === "KG") byOp[r.username].totalKg += Number(r.totalOutput);
        byOp[r.username].batches += r.batchCount;
      }
      const ranked = Object.entries(byOp)
        .sort((a, b) => b[1].totalM + b[1].totalKg - (a[1].totalM + a[1].totalKg))
        .slice(0, 15);

      outputEl.appendChild(
        R.kpiRow([
          { label: "Operators Active", value: Object.keys(byOp).length },
          { label: "Top Operator", value: ranked[0]?.[0] || "—", sub: ranked[0] ? `${R.fmtNum(ranked[0][1].totalM)} M` : "" },
        ])
      );

      outputEl.appendChild(R.chartsGrid([{ title: "Top Operators by Output (Metres)", canvasId: "ch-op-rank", wide: true, tall: true }]));
      R.mkChart("ch-op-rank", {
        type: "bar",
        data: {
          labels: ranked.map(([n]) => n),
          datasets: [{ label: "Metres", data: ranked.map(([, v]) => v.totalM), backgroundColor: R.RPT_PALETTE[0] + "cc", borderRadius: 4 }],
        },
        options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });

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
