// Scrap Analysis report — port of runReportScrap in production-nexus.js.
// Note: unlike most other reports, Node's own Scrap queries never apply
// the process filter to any of the three result sets — ported faithfully,
// not "fixed" (see ProductionReportsHelper.GetScrapAsync's comment).
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
      const { data } = await R.api(`/reports/scrap?${R.buildQuery(filters)}`);

      outputEl.innerHTML = "";
      outputEl.appendChild(R.exportButton(() => data.byReason, `scrap-analysis-${new Date().toISOString().slice(0, 10)}.csv`));

      outputEl.appendChild(
        R.kpiRow([
          { label: "Total Scrap (KG)", value: `${R.fmtNum(data.totals.totalKg)} KG` },
          { label: "Scrap Entries", value: data.totals.entryCount },
          { label: "Top Reason", value: data.totals.topReason || "—" },
        ])
      );

      outputEl.appendChild(
        R.chartsGrid([
          { title: "Scrap by Reason (KG)", canvasId: "ch-scr-reason" },
          { title: "Scrap by Process (KG)", canvasId: "ch-scr-proc" },
          { title: "Scrap Trend (KG)", canvasId: "ch-scr-ts", wide: true },
        ])
      );

      R.mkChart("ch-scr-reason", {
        type: "doughnut",
        data: {
          labels: data.byReason.map((r) => r.reasonDescription),
          datasets: [{ data: data.byReason.map((r) => Number(r.totalKg)), backgroundColor: R.RPT_PALETTE.slice(0, data.byReason.length) }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right" } } },
      });

      R.mkChart("ch-scr-proc", {
        type: "bar",
        data: {
          labels: data.byProcess.map((r) => R.PROCESS_LABELS[r.processCode] || r.processCode),
          datasets: [{ label: "Scrap (KG)", data: data.byProcess.map((r) => Number(r.totalKg)), backgroundColor: R.RPT_ERR + "cc", borderRadius: 4 }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });

      R.mkChart("ch-scr-ts", {
        type: "bar",
        data: {
          labels: data.timeSeries.map((r) => r.period),
          datasets: [{ label: "Scrap (KG)", data: data.timeSeries.map((r) => Number(r.totalKg)), backgroundColor: R.RPT_WARN + "99", borderRadius: 3 }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });

      const summary = document.createElement("p");
      summary.textContent = `Total: ${R.fmtNum(data.totals.totalKg)} KG across ${data.totals.entryCount} entries — top reason: ${data.totals.topReason}`;
      outputEl.appendChild(summary);

      const reasonHeading = document.createElement("h3");
      reasonHeading.textContent = "By Reason";
      outputEl.appendChild(reasonHeading);
      outputEl.appendChild(
        R.buildTable(["Reason", "Total KG", "Entries"], data.byReason, (row) => {
          const tr = document.createElement("tr");
          for (const val of [row.reasonDescription, R.fmtNum(row.totalKg), row.entryCount]) {
            const td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
          }
          return tr;
        })
      );

      const processHeading = document.createElement("h3");
      processHeading.textContent = "By Process";
      outputEl.appendChild(processHeading);
      outputEl.appendChild(
        R.buildTable(["Process", "Total KG", "Entries"], data.byProcess, (row) => {
          const tr = document.createElement("tr");
          for (const val of [R.PROCESS_LABELS[row.processCode] || row.processCode, R.fmtNum(row.totalKg), row.entryCount]) {
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
        R.buildTable(["Period", "Total KG", "Entries"], data.timeSeries, (row) => {
          const tr = document.createElement("tr");
          for (const val of [row.period, R.fmtNum(row.totalKg), row.entryCount]) {
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
