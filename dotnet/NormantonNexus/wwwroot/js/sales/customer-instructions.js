// Customer Standard Instructions tile — ported from private/js/sales.js's
// renderCustomerInstructions()/openModal()/openBulkImportModal() (lines
// 125-357 in the Node original), now its own page instead of an
// innerHTML-injected section. Behavior unchanged: paste-import supports a
// tab-delimited (Excel-paste) three-column format with an auto-detected
// header row, preview-before-import, and per-row continue-on-error results.
// Unlike the Node original, every dynamic value here is built via
// textContent/DOM APIs rather than innerHTML template strings, matching
// this app's established XSS-safe convention (see mass-update.js).
(function () {
  const tableEl = document.getElementById("ci-table");
  const msgEl = document.getElementById("ci-msg");

  const formEl = document.getElementById("ci-form");
  const formTitleEl = document.getElementById("ci-form-title");
  const custInput = document.getElementById("ci-cust");
  const nameInput = document.getElementById("ci-name");
  const instrInput = document.getElementById("ci-instr");
  const formMsgEl = document.getElementById("ci-form-msg");

  const importPanelEl = document.getElementById("ci-import-panel");
  const importPasteEl = document.getElementById("ci-import-paste");
  const importPreviewEl = document.getElementById("ci-import-preview");
  const importMsgEl = document.getElementById("ci-import-msg");
  const importGoBtn = document.getElementById("ci-import-go-btn");

  let rows = [];
  let editingCustomer = null; // null = adding, otherwise editing this customer
  let parsedImportRows = [];

  async function api(path, opts) {
    const r = await fetch("/api/sales" + path, opts);
    let json = null;
    try {
      json = await r.json();
    } catch {
      /* non-JSON body */
    }
    if (json?.success === false || !r.ok) {
      throw new Error(json?.error?.message || `Request failed (HTTP ${r.status})`);
    }
    return json;
  }

  // ── List ──────────────────────────────────────────────────────────────
  async function load() {
    msgEl.textContent = "";
    tableEl.textContent = "Loading…";
    try {
      const { data } = await api("/customer-instructions");
      rows = data;
      renderTable();
    } catch (err) {
      tableEl.textContent = "";
      msgEl.textContent = err.message;
    }
  }

  function renderTable() {
    tableEl.innerHTML = "";
    if (rows.length === 0) {
      tableEl.textContent = "No customer standard instructions saved yet.";
      return;
    }

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Customer", "Instructions", "Last Updated", "Actions"]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");

      const custTd = document.createElement("td");
      custTd.textContent = row.customerName ? `${row.customer} — ${row.customerName}` : row.customer;

      const instrTd = document.createElement("td");
      instrTd.style.whiteSpace = "pre-wrap";
      instrTd.textContent = row.instructions;

      const updatedTd = document.createElement("td");
      updatedTd.style.fontSize = "0.8rem";
      updatedTd.style.color = "#6b7280";
      const when = row.lastUpdatedUtc ? new Date(row.lastUpdatedUtc).toLocaleString("en-GB") : "—";
      updatedTd.textContent = row.updatedByUsername ? `${when} · ${row.updatedByUsername}` : when;

      const actionsTd = document.createElement("td");
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "secondary";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => openForm(row));
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "secondary";
      delBtn.style.marginLeft = "0.4rem";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteRow(row.customer));
      actionsTd.append(editBtn, delBtn);

      tr.append(custTd, instrTd, updatedTd, actionsTd);
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    tableEl.appendChild(table);
  }

  async function deleteRow(customer) {
    if (!confirm(`Delete standard instructions for customer ${customer}?`)) return;
    try {
      await api(`/customer-instructions/${encodeURIComponent(customer)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      msgEl.textContent = err.message;
    }
  }

  // ── Add / Edit form ──────────────────────────────────────────────────
  function openForm(existing) {
    editingCustomer = existing ? existing.customer : null;
    formTitleEl.textContent = existing ? "Edit Customer" : "Add Customer";
    custInput.value = existing ? existing.customer : "";
    custInput.disabled = !!existing;
    nameInput.value = existing ? existing.customerName ?? "" : "";
    instrInput.value = existing ? existing.instructions : "";
    formMsgEl.textContent = "";
    formEl.style.display = "";
    importPanelEl.style.display = "none";
  }

  document.getElementById("ci-add-btn").addEventListener("click", () => openForm(null));
  document.getElementById("ci-cancel-btn").addEventListener("click", () => {
    formEl.style.display = "none";
  });

  document.getElementById("ci-save-btn").addEventListener("click", async () => {
    const customer = editingCustomer ?? custInput.value.trim();
    const customerName = nameInput.value.trim();
    const instructions = instrInput.value.trim();
    if (!customer) {
      formMsgEl.textContent = "Customer number is required.";
      return;
    }
    if (!instructions) {
      formMsgEl.textContent = "Instructions text is required.";
      return;
    }
    try {
      await api(`/customer-instructions/${encodeURIComponent(customer)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerName, instructions }),
      });
      formEl.style.display = "none";
      await load();
    } catch (err) {
      formMsgEl.textContent = err.message;
    }
  });

  // ── Bulk import ──────────────────────────────────────────────────────
  // Minimal RFC4180-style parser, tab-delimited (pasting from Excel produces
  // TSV on the clipboard) — port of parseTsvText in the Node original.
  function parseTsvText(text) {
    const parsedRows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const pushField = () => {
      row.push(field);
      field = "";
    };
    const pushRow = () => {
      pushField();
      parsedRows.push(row);
      row = [];
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === "\t") {
        pushField();
      } else if (c === "\n") {
        pushRow();
      } else if (c === "\r") {
        // skip — the following \n (or EOF) ends the row
      } else {
        field += c;
      }
    }
    if (field !== "" || row.length) pushRow();
    return parsedRows.filter((r) => r.some((v) => String(v).trim() !== ""));
  }

  // Header row is auto-detected: SAP customer numbers are always numeric, so
  // a non-numeric first cell means the first row is a header, not data.
  function parseCustomerInstructionsImport(text) {
    const rawRows = parseTsvText(text);
    if (rawRows.length === 0) return { rows: [], duplicates: [] };

    const first = (rawRows[0][0] || "").trim();
    const dataRows = /^\d+$/.test(first) ? rawRows : rawRows.slice(1);

    const seen = new Map();
    const parsedRows = dataRows
      .map((cols) => {
        const customer = (cols[0] || "").trim();
        const customerName = (cols[1] || "").trim();
        const instructions = (cols[2] || "").trim();
        if (customer) seen.set(customer, (seen.get(customer) || 0) + 1);
        return { customer, customerName, instructions };
      })
      .filter((r) => r.customer || r.instructions);

    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
    return { rows: parsedRows, duplicates };
  }

  document.getElementById("ci-import-btn").addEventListener("click", () => {
    importPasteEl.value = "";
    importPreviewEl.textContent = "";
    importMsgEl.textContent = "";
    importGoBtn.disabled = true;
    parsedImportRows = [];
    importPanelEl.style.display = "";
    formEl.style.display = "none";
  });
  document.getElementById("ci-import-cancel-btn").addEventListener("click", () => {
    importPanelEl.style.display = "none";
  });

  document.getElementById("ci-import-preview-btn").addEventListener("click", () => {
    importMsgEl.textContent = "";
    importPreviewEl.innerHTML = "";

    const { rows: parsed, duplicates } = parseCustomerInstructionsImport(importPasteEl.value);
    if (parsed.length === 0) {
      importGoBtn.disabled = true;
      importMsgEl.textContent = "No rows found — paste Account Code / Company Name / Special Instructions, one row per line.";
      return;
    }

    const valid = parsed.filter((r) => r.customer && r.instructions);
    const invalid = parsed.filter((r) => !r.customer || !r.instructions);
    parsedImportRows = valid;

    const summary = document.createElement("p");
    let summaryText = `${valid.length} row${valid.length === 1 ? "" : "s"} ready to import`;
    if (invalid.length) summaryText += `, ${invalid.length} skipped (missing account code or instructions)`;
    if (duplicates.length) summaryText += `, ${duplicates.length} account code(s) appear more than once — last occurrence wins`;
    summary.textContent = summaryText;
    importPreviewEl.appendChild(summary);

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Account Code", "Company", "Instructions"]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    for (const r of valid.slice(0, 200)) {
      const tr = document.createElement("tr");
      const custTd = document.createElement("td");
      custTd.textContent = r.customer;
      const nameTd = document.createElement("td");
      nameTd.textContent = r.customerName;
      const instrTd = document.createElement("td");
      instrTd.textContent = r.instructions;
      tr.append(custTd, nameTd, instrTd);
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    importPreviewEl.appendChild(table);
    if (valid.length > 200) {
      const more = document.createElement("p");
      more.style.fontSize = "0.8rem";
      more.style.color = "#6b7280";
      more.textContent = `…and ${valid.length - 200} more`;
      importPreviewEl.appendChild(more);
    }

    importGoBtn.disabled = valid.length === 0;
  });

  importGoBtn.addEventListener("click", async () => {
    if (parsedImportRows.length === 0) return;
    importGoBtn.disabled = true;
    importGoBtn.textContent = "Importing…";
    importMsgEl.style.color = "#6b7280";
    importMsgEl.textContent = `Importing ${parsedImportRows.length} rows…`;
    try {
      const { data } = await api("/customer-instructions/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: parsedImportRows }),
      });
      const { created, updated, failed } = data;
      if (failed && failed.length) {
        importMsgEl.style.color = "#b91c1c";
        importMsgEl.textContent = "";
        const summary = document.createElement("div");
        summary.textContent = `Imported ${created} new, updated ${updated}. ${failed.length} row(s) failed:`;
        importMsgEl.appendChild(summary);
        for (const f of failed.slice(0, 15)) {
          const line = document.createElement("div");
          line.textContent = `${f.customer}: ${f.error}`;
          importMsgEl.appendChild(line);
        }
        if (failed.length > 15) {
          const more = document.createElement("div");
          more.textContent = `…and ${failed.length - 15} more`;
          importMsgEl.appendChild(more);
        }
        importGoBtn.textContent = "Import";
        importGoBtn.disabled = false;
      } else {
        importPanelEl.style.display = "none";
        importGoBtn.textContent = "Import";
        await load();
      }
    } catch (err) {
      importMsgEl.style.color = "#b91c1c";
      importMsgEl.textContent = err.message;
      importGoBtn.textContent = "Import";
      importGoBtn.disabled = false;
    }
  });

  load();
})();
