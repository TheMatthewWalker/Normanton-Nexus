// Production Output report — port of runReportOutput/renderReportOutput in
// private/js/production-nexus.js.
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
      const { data } = await R.api(`/reports/output?${R.buildQuery(filters)}`);

      outputEl.innerHTML = "";
      outputEl.appendChild(R.exportButton(() => data.timeSeries, `production-output-${new Date().toISOString().slice(0, 10)}.csv`));

      const totalM = data.summary.filter((r) => r.uom === "M").reduce((s, r) => s + Number(r.totalOutput), 0);
      const totalKg = data.summary.filter((r) => r.uom === "KG").reduce((s, r) => s + Number(r.totalOutput), 0);
      const totalBatches = data.summary.reduce((s, r) => s + r.batchCount, 0);
      outputEl.appendChild(
        R.kpiRow([
          { label: "Total Metres Produced", value: `${R.fmtNum(totalM)} M`, sub: `${data.summary.filter((r) => r.uom === "M").length} processes` },
          { label: "Total KG Mixed", value: `${R.fmtNum(totalKg)} KG`, sub: "Mixing only" },
          { label: "Completed Batches", value: totalBatches, sub: "All processes" },
        ])
      );

      outputEl.appendChild(
        R.chartsGrid([
          { title: "Output by Process", canvasId: "ch-out-proc" },
          { title: "Output over Time (Metres)", canvasId: "ch-out-ts", wide: true, tall: true },
        ])
      );

      R.mkChart("ch-out-proc", {
        type: "bar",
        data: {
          labels: data.summary.map((r) => `${R.PROCESS_LABELS[r.processCode] || r.processCode} (${r.uom})`),
          datasets: [{ label: "Total Output", data: data.summary.map((r) => Number(r.totalOutput)), backgroundColor: R.RPT_PALETTE.slice(0, data.summary.length), borderRadius: 4 }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });

      const periods = [...new Set(data.timeSeries.map((r) => r.period))].sort();
      const mProcs = [...new Set(data.timeSeries.map((r) => r.processCode))].filter((p) => data.timeSeries.find((r) => r.processCode === p && r.uom === "M"));
      R.mkChart("ch-out-ts", {
        type: "line",
        data: {
          labels: periods,
          datasets: mProcs.map((p, i) => ({
            label: R.PROCESS_LABELS[p] || p,
            data: periods.map((per) => {
              const r = data.timeSeries.find((x) => x.processCode === p && x.period === per);
              return r ? Number(r.totalOutput) : null;
            }),
            borderColor: R.RPT_PALETTE[i % R.RPT_PALETTE.length],
            backgroundColor: "transparent",
            tension: 0.3,
            spanGaps: true,
          })),
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
      });

      const summaryHeading = document.createElement("h3");
      summaryHeading.textContent = "Summary";
      outputEl.appendChild(summaryHeading);
      outputEl.appendChild(
        R.buildTable(["Process", "UoM", "Batches", "Total Output", "Avg / Batch"], data.summary, (row) => {
          const tr = document.createElement("tr");
          for (const val of [R.PROCESS_LABELS[row.processCode] || row.processCode, row.uom, row.batchCount, R.fmtNum(row.totalOutput), R.fmtNum(row.avgPerBatch)]) {
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
        R.buildTable(["Period", "Process", "UoM", "Batches", "Total Output"], data.timeSeries, (row) => {
          const tr = document.createElement("tr");
          for (const val of [row.period, R.PROCESS_LABELS[row.processCode] || row.processCode, row.uom, row.batchCount, R.fmtNum(row.totalOutput)]) {
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
