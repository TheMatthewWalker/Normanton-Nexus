// Admin > DB Explorer — superadmin-only SSMS-lite schema browser.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/admin/dbexplorer");

  let tables = [];
  let currentDatabase = "";

  async function loadDatabases() {
    const sel = document.getElementById("dbx-database");
    try {
      const { data } = await api("/databases");
      sel.innerHTML = (data || []).map((d) => `<option value="${esc(d.name)}">${esc(d.name)}</option>`).join("");
      if (data && data.length > 0) {
        currentDatabase = data[0].name;
        await loadTables();
      }
    } catch (err) {
      sel.innerHTML = `<option>Error: ${esc(err.message)}</option>`;
    }
  }

  document.getElementById("dbx-database").addEventListener("change", async (e) => {
    currentDatabase = e.target.value;
    await loadTables();
  });

  async function loadTables() {
    const el = document.getElementById("dbx-tables");
    el.textContent = "Loading…";
    try {
      const { data } = await api(`/${encodeURIComponent(currentDatabase)}/tables`);
      tables = data || [];
      renderTables();
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function renderTables() {
    const q = document.getElementById("dbx-table-search").value.trim().toLowerCase();
    const rows = q ? tables.filter((t) => t.tableName.toLowerCase().includes(q) || t.schemaName.toLowerCase().includes(q)) : tables;
    const el = document.getElementById("dbx-tables");
    el.innerHTML = rows.length === 0 ? "<p>No tables.</p>" : `
      <ul style="list-style:none; padding:0; margin:0;">
        ${rows.map((t) => `<li><button type="button" class="btn secondary" data-table="${esc(t.schemaName)}.${esc(t.tableName)}" style="width:100%; text-align:left;">${esc(t.schemaName)}.${esc(t.tableName)} <span style="color:#888;">(${t.approxRowCount ?? "?"})</span></button></li>`).join("")}
      </ul>`;
    el.querySelectorAll("button[data-table]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const [schema, table] = btn.dataset.table.split(".");
        openTable(schema, table);
      });
    });
  }

  document.getElementById("dbx-table-search").addEventListener("input", renderTables);

  async function openTable(schema, table) {
    const el = document.getElementById("dbx-table-detail");
    el.innerHTML = "Loading…";
    try {
      const [cols, constraints] = await Promise.all([
        api(`/${encodeURIComponent(currentDatabase)}/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/columns`),
        api(`/${encodeURIComponent(currentDatabase)}/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/constraints`),
      ]);
      const colRows = cols.data || [];
      const c = constraints.data;
      el.innerHTML = `
        <h4>${esc(schema)}.${esc(table)}</h4>
        <button type="button" class="btn secondary" id="dbx-preview-btn">Preview 50 rows</button>
        <h5>Columns</h5>
        <table>
          <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Len</th><th>Precision</th><th>Scale</th><th>Nullable</th><th>Identity</th><th>Default</th><th>PK</th></tr></thead>
          <tbody>${colRows.map((cl) => `<tr><td>${cl.columnId}</td><td>${esc(cl.columnName)}</td><td>${esc(cl.dataType)}</td><td>${cl.maxLength}</td><td>${cl.precision}</td><td>${cl.scale}</td><td>${cl.isNullable ? "Yes" : "No"}</td><td>${cl.isIdentity ? "Yes" : "No"}</td><td>${esc(cl.defaultValue)}</td><td>${cl.isPrimaryKey ? "Yes" : ""}</td></tr>`).join("")}</tbody>
        </table>
        <h5>Keys</h5>
        <table><thead><tr><th>Name</th><th>Type</th><th>Columns</th></tr></thead><tbody>${(c.keys || []).map((k) => `<tr><td>${esc(k.constraintName)}</td><td>${esc(k.constraintType)}</td><td>${esc(k.columns)}</td></tr>`).join("")}</tbody></table>
        <h5>Foreign Keys (outgoing)</h5>
        <table><thead><tr><th>Name</th><th>Column</th><th>References</th></tr></thead><tbody>${(c.foreignKeysOut || []).map((f) => `<tr><td>${esc(f.constraintName)}</td><td>${esc(f.columnName)}</td><td>${esc(f.referencedSchema)}.${esc(f.referencedTable)}.${esc(f.referencedColumn)}</td></tr>`).join("")}</tbody></table>
        <h5>Foreign Keys (incoming)</h5>
        <table><thead><tr><th>Name</th><th>From</th><th>Column</th></tr></thead><tbody>${(c.foreignKeysIn || []).map((f) => `<tr><td>${esc(f.constraintName)}</td><td>${esc(f.sourceSchema)}.${esc(f.sourceTable)}</td><td>${esc(f.sourceColumn)} &rarr; ${esc(f.columnName)}</td></tr>`).join("")}</tbody></table>
        <h5>Check Constraints</h5>
        <table><thead><tr><th>Name</th><th>Definition</th><th>Disabled</th></tr></thead><tbody>${(c.checkConstraints || []).map((k) => `<tr><td>${esc(k.constraintName)}</td><td>${esc(k.definition)}</td><td>${k.isDisabled ? "Yes" : "No"}</td></tr>`).join("")}</tbody></table>
        <h5>Indexes</h5>
        <table><thead><tr><th>Name</th><th>Type</th><th>Unique</th><th>PK</th><th>Columns</th></tr></thead><tbody>${(c.indexes || []).map((k) => `<tr><td>${esc(k.indexName)}</td><td>${esc(k.indexType)}</td><td>${k.isUnique ? "Yes" : "No"}</td><td>${k.isPrimaryKey ? "Yes" : "No"}</td><td>${esc(k.columns)}</td></tr>`).join("")}</tbody></table>
        <h5>Preview</h5>
        <div id="dbx-preview"></div>`;

      document.getElementById("dbx-preview-btn").addEventListener("click", async () => {
        const previewEl = document.getElementById("dbx-preview");
        previewEl.textContent = "Loading…";
        try {
          const { data: rows } = await api(`/${encodeURIComponent(currentDatabase)}/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/preview?top=50`);
          if (!rows || rows.length === 0) { previewEl.innerHTML = "<p>No rows.</p>"; return; }
          const keys = Object.keys(rows[0]);
          previewEl.innerHTML = `
            <div style="overflow-x:auto;">
              <table>
                <thead><tr>${keys.map((k) => `<th>${esc(k)}</th>`).join("")}</tr></thead>
                <tbody>${rows.map((r) => `<tr>${keys.map((k) => `<td>${esc(r[k])}</td>`).join("")}</tr>`).join("")}</tbody>
              </table>
            </div>`;
        } catch (err) {
          previewEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
        }
      });
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  loadDatabases();
})();
