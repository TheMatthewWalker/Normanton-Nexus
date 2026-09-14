// SQL Console — a genuinely missing Admin tile found by a later gap audit
// against the Node tile inventory (private/js/admin.js's runSql()/
// buildSqlResultsHTML()/exportSqlCsv(), backing admin.html's SQL Console
// section), not a deliberate deferral. Port of routes/sqlqueries.js's POST
// /sql/query only — see SqlConsoleQueryRequest's own header comment
// (SqlConsoleModels.cs) for why /sql/query-csv isn't ported.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/admin/sql");

  // One entry per SELECT in the last-run batch — exportSqlCsv(index) reads
  // whichever one the user clicked "Export" next to. Matches Node's own
  // sqlLastRecordsets module-level variable exactly.
  let lastRecordsets = [];

  function buildTable(rows) {
    const cols = Object.keys(rows[0]);
    let h = '<div style="overflow-x:auto"><table class="table--compact"><thead><tr>';
    cols.forEach((c) => { h += `<th>${esc(c)}</th>`; });
    h += "</tr></thead><tbody>";
    rows.forEach((row) => {
      h += "<tr>";
      cols.forEach((c) => { h += `<td>${esc(String(row[c] ?? ""))}</td>`; });
      h += "</tr>";
    });
    h += "</tbody></table></div>";
    return h;
  }

  // Renders every non-empty recordset from a (possibly multi-statement)
  // batch as its own labelled section — a query with several SELECTs
  // separated by semicolons comes back as one entry per SELECT, in order.
  function buildResultsHtml(recordsets) {
    const nonEmpty = recordsets.map((rows, i) => ({ rows, i })).filter((r) => r.rows && r.rows.length > 0);
    if (!nonEmpty.length) return "";

    const multi = nonEmpty.length > 1;
    let h = "";
    nonEmpty.forEach(({ rows, i }) => {
      h += '<div style="margin-bottom:16px">';
      if (multi) {
        h += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">`
          + `<span>Result ${i + 1} — ${rows.length} row(s)</span>`
          + `<button type="button" class="secondary" data-export-index="${i}">Export CSV</button>`
          + `</div>`;
      }
      h += buildTable(rows);
      h += "</div>";
    });
    return h;
  }

  function exportCsv(index) {
    const rows = index == null ? lastRecordsets.find((r) => r && r.length) : lastRecordsets[index];
    if (!rows || !rows.length) return;
    const cols = Object.keys(rows[0]);
    const lines = [
      cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","),
      ...rows.map((row) => cols.map((c) => `"${String(row[c] ?? "").replace(/"/g, '""')}"`).join(",")),
    ];
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const suffix = lastRecordsets.filter((r) => r && r.length).length > 1 && index != null ? `-result${index + 1}` : "";
    a.download = `sql${suffix}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function runSql() {
    const inputEl = document.getElementById("sql-input");
    const resultEl = document.getElementById("sql-result");
    const countEl = document.getElementById("sql-row-count");
    const exportBtn = document.getElementById("sql-export");

    const query = inputEl.value.trim();
    if (!query) return;

    lastRecordsets = [];
    countEl.style.display = "none";
    exportBtn.style.display = "none";
    resultEl.innerHTML = '<div class="nx-toolbar-hint">Running…</div>';

    try {
      const { data } = await api("/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      const recordsets = Array.isArray(data.recordsets) ? data.recordsets : [];
      lastRecordsets = recordsets;
      const nonEmptyCount = recordsets.filter((r) => r && r.length > 0).length;

      if (nonEmptyCount > 0) {
        resultEl.innerHTML = buildResultsHtml(recordsets);
        const totalRows = recordsets.reduce((sum, r) => sum + (r ? r.length : 0), 0);
        if (nonEmptyCount === 1) {
          countEl.textContent = `${totalRows} row(s)`;
          countEl.style.display = "";
          exportBtn.style.display = "";
          exportBtn.onclick = () => exportCsv(recordsets.findIndex((r) => r && r.length));
        } else {
          countEl.textContent = `${nonEmptyCount} result sets, ${totalRows} row(s) total`;
          countEl.style.display = "";
          exportBtn.style.display = "none";
        }
      } else {
        resultEl.innerHTML = `<div class="nx-empty">Query OK — ${data.rowsAffected || 0} row(s) affected.</div>`;
      }
    } catch (err) {
      resultEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  document.getElementById("sql-run").addEventListener("click", runSql);
  document.getElementById("sql-clear").addEventListener("click", () => {
    document.getElementById("sql-input").value = "";
    document.getElementById("sql-result").innerHTML = "";
    document.getElementById("sql-row-count").style.display = "none";
    document.getElementById("sql-export").style.display = "none";
    lastRecordsets = [];
  });
  document.getElementById("sql-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSql(); }
  });
  document.getElementById("sql-result").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-export-index]");
    if (btn) exportCsv(Number(btn.dataset.exportIndex));
  });
})();
