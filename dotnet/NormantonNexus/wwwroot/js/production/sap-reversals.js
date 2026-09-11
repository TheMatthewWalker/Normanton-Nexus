// SAP Reversals — search SAP postings (by material document / batch
// reference / material / date range / operator) then bulk-reverse the
// selected backflush documents. Port of the reversal search UI in
// production-nexus.js. Dynamic values are built via textContent/DOM APIs;
// badge pills use innerHTML with values run through NexusApi.esc() first.
// Node's SSE progress streaming for the bulk reversal is not reproduced
// (see ReversalHelper.cs's doc comment) — the bulk call here is a single
// request/response, so the UI just shows a "Reversing…" state until it
// completes.
(function () {
  const esc = NexusApi.esc;
  const inputsEl = document.getElementById("rev-search-inputs");
  const msgEl = document.getElementById("rev-msg");
  const resultsEl = document.getElementById("rev-results");

  const MODES = [
    ["matdoc", "By Material Document"],
    ["batch", "By Batch Reference"],
    ["material", "By Material"],
    ["daterange", "By Date Range"],
    ["operator", "By Operator"],
  ];
  const PROCESS_CODES = ["MX", "EX", "CO", "BR", "CL", "TW", "DR", "EW", "HA"];

  let mode = "matdoc";
  let resultRows = [];

  async function api(path, opts) {
    const r = await fetch("/api/productionnexus" + path, opts);
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

  function fmtDate(dt) {
    return dt ? new Date(dt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  }

  function renderSearchBar() {
    inputsEl.innerHTML = "";

    const toolbar = document.createElement("div");
    toolbar.className = "nx-toolbar";
    toolbar.style.cssText = "flex-direction:column;align-items:stretch;gap:10px";

    const modeRow = document.createElement("div");
    modeRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
    for (const [m, label] of MODES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = m === mode ? "btn" : "secondary";
      btn.textContent = label;
      btn.addEventListener("click", () => { mode = m; renderSearchBar(); });
      modeRow.appendChild(btn);
    }
    toolbar.appendChild(modeRow);

    const fieldRow = document.createElement("div");
    fieldRow.className = "tf-row";
    fieldRow.style.marginBottom = "0";

    if (mode === "matdoc") {
      fieldRow.appendChild(makeTextField("rev-matdoc", "Material Document", "Material document"));
    } else if (mode === "batch") {
      const pcField = document.createElement("div");
      pcField.className = "tf-field";
      const pcLabel = document.createElement("label");
      pcLabel.className = "tf-label";
      pcLabel.htmlFor = "rev-pc";
      pcLabel.textContent = "Process";
      const select = document.createElement("select");
      select.id = "rev-pc";
      select.className = "tf-input";
      for (const pc of PROCESS_CODES) {
        const opt = document.createElement("option");
        opt.value = pc;
        opt.textContent = pc;
        select.appendChild(opt);
      }
      pcField.append(pcLabel, select);
      fieldRow.append(pcField, makeTextField("rev-rid", "Record ID", "Record ID"));
    } else if (mode === "material") {
      fieldRow.appendChild(makeTextField("rev-material", "Material", "Material number"));
    } else if (mode === "daterange") {
      const fromField = document.createElement("div");
      fromField.className = "tf-field";
      const fromLabel = document.createElement("label");
      fromLabel.className = "tf-label";
      fromLabel.htmlFor = "rev-date-from";
      fromLabel.textContent = "From";
      const fromInput = document.createElement("input");
      fromInput.type = "date";
      fromInput.id = "rev-date-from";
      fromInput.className = "tf-input";
      fromField.append(fromLabel, fromInput);

      const toField = document.createElement("div");
      toField.className = "tf-field";
      const toLabel = document.createElement("label");
      toLabel.className = "tf-label";
      toLabel.htmlFor = "rev-date-to";
      toLabel.textContent = "To";
      const toInput = document.createElement("input");
      toInput.type = "date";
      toInput.id = "rev-date-to";
      toInput.className = "tf-input";
      toField.append(toLabel, toInput);

      fieldRow.append(fromField, toField);
    } else if (mode === "operator") {
      fieldRow.appendChild(makeTextField("rev-operator", "Operator", "Operator name"));
    }

    const searchField = document.createElement("div");
    searchField.className = "tf-field";
    searchField.style.cssText = "justify-content:flex-end;flex-direction:row;gap:8px;flex:0 0 auto";
    const searchBtn = document.createElement("button");
    searchBtn.type = "button";
    searchBtn.className = "btn";
    searchBtn.textContent = "Search";
    searchBtn.addEventListener("click", doSearch);
    searchField.appendChild(searchBtn);
    fieldRow.appendChild(searchField);

    toolbar.appendChild(fieldRow);
    inputsEl.appendChild(toolbar);
  }

  function makeTextField(id, label, placeholder) {
    const field = document.createElement("div");
    field.className = "tf-field";
    const labelEl = document.createElement("label");
    labelEl.className = "tf-label";
    labelEl.htmlFor = id;
    labelEl.textContent = label;
    const input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.className = "tf-input";
    input.placeholder = placeholder;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
    field.append(labelEl, input);
    return field;
  }

  function showEmpty(text) {
    resultsEl.innerHTML = "";
    const box = document.createElement("div");
    box.className = "nx-empty";
    box.textContent = text;
    resultsEl.appendChild(box);
  }

  async function doSearch() {
    msgEl.textContent = "";
    showEmpty("Searching…");

    try {
      let json;
      if (mode === "matdoc") {
        const doc = document.getElementById("rev-matdoc")?.value.trim();
        if (!doc) { showEmpty("Enter a material document number."); return; }
        json = await api(`/reversal/search?materialDocument=${encodeURIComponent(doc)}`);
      } else if (mode === "batch") {
        const pc = document.getElementById("rev-pc")?.value;
        const rid = document.getElementById("rev-rid")?.value.trim();
        if (!pc || !rid) { showEmpty("Select a process and enter the record ID."); return; }
        json = await api(`/reversal/by-batch/${encodeURIComponent(pc)}/${encodeURIComponent(rid)}`);
      } else if (mode === "material") {
        const mat = document.getElementById("rev-material")?.value.trim();
        if (!mat) { showEmpty("Enter a material number."); return; }
        json = await api(`/reversal/find?material=${encodeURIComponent(mat)}`);
      } else if (mode === "daterange") {
        const from = document.getElementById("rev-date-from")?.value;
        const to = document.getElementById("rev-date-to")?.value;
        if (!from && !to) { showEmpty("Enter at least one date."); return; }
        const p = new URLSearchParams();
        if (from) p.set("dateFrom", from);
        if (to) p.set("dateTo", to);
        json = await api(`/reversal/find?${p}`);
      } else if (mode === "operator") {
        const op = document.getElementById("rev-operator")?.value.trim();
        if (!op) { showEmpty("Enter an operator name."); return; }
        json = await api(`/reversal/find?operator=${encodeURIComponent(op)}`);
      }

      resultRows = json.data || [];
      if (!resultRows.length) { showEmpty("No SAP postings found."); return; }
      renderResults();
    } catch (err) {
      showEmpty(err.message);
    }
  }

  function renderResults() {
    const reversible = resultRows.filter((r) => !r.isReversed && r.materialDocumentSap);
    const showMaterial = resultRows.some((r) => r.material);

    resultsEl.innerHTML = "";

    const toolbar = document.createElement("div");
    toolbar.className = "nx-toolbar";

    const toolbarTitle = document.createElement("span");
    toolbarTitle.className = "nx-toolbar-title";
    toolbarTitle.textContent = `${resultRows.length} posting${resultRows.length === 1 ? "" : "s"} found`;

    const selectAllLabel = document.createElement("label");
    selectAllLabel.className = "nx-toolbar-hint";
    const selectAll = document.createElement("input");
    selectAll.type = "checkbox";
    selectAll.checked = true;
    selectAllLabel.append(selectAll, document.createTextNode(" Select All"));

    const spacer = document.createElement("span");
    spacer.className = "nx-toolbar-spacer";

    const bulkBtn = document.createElement("button");
    bulkBtn.type = "button";
    bulkBtn.className = "btn";
    bulkBtn.textContent = "Reverse Selected";
    bulkBtn.disabled = !reversible.length;

    toolbar.append(toolbarTitle, selectAllLabel, spacer, bulkBtn);
    resultsEl.appendChild(toolbar);

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const headers = ["", "Material Doc"];
    if (showMaterial) headers.push("Material");
    headers.push("Type", "Quantity", "Posted", "Posted By", "Status", "");
    for (const label of headers) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    for (const row of resultRows) tbody.appendChild(buildRow(row, showMaterial));
    table.append(thead, tbody);
    resultsEl.appendChild(table);

    const bulkMsg = document.createElement("p");
    bulkMsg.id = "rev-bulk-msg";
    resultsEl.appendChild(bulkMsg);

    selectAll.addEventListener("change", () => {
      tbody.querySelectorAll(".rev-chk").forEach((c) => { c.checked = selectAll.checked; });
    });

    bulkBtn.addEventListener("click", async () => {
      const docs = [...tbody.querySelectorAll(".rev-chk:checked")].map((c) => c.dataset.matdoc);
      if (!docs.length) { setBulkMsg(bulkMsg, "No entries selected.", "error"); return; }

      bulkBtn.disabled = true;
      bulkBtn.textContent = `Reversing ${docs.length} document${docs.length === 1 ? "" : "s"}…`;
      bulkMsg.textContent = "";

      try {
        const res = await api("/reversal/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ materialDocuments: docs }),
        });

        let ok = 0, fail = 0;
        for (const r of res.data || []) {
          const cell = document.getElementById(`rev-result-${r.materialDocument}`);
          if (r.success) {
            ok++;
            if (cell) cell.innerHTML = `<span class="badge badge--success">✓ ${esc(r.reversalDocument || "")}</span>`;
          } else {
            fail++;
            if (cell) {
              cell.title = r.error || "";
              cell.innerHTML = r.synced ? '<span class="badge badge--warn">Synced</span>' : '<span class="badge badge--error">✗ Failed</span>';
            }
          }
        }

        setBulkMsg(bulkMsg, fail ? `${ok} reversed, ${fail} failed — see inline results.` : `All ${ok} document${ok === 1 ? "" : "s"} reversed successfully.`, fail ? "warn" : "success");
      } catch (err) {
        setBulkMsg(bulkMsg, err.message, "error");
      } finally {
        bulkBtn.disabled = false;
        bulkBtn.textContent = "Reverse Selected";
      }
    });
  }

  function setBulkMsg(el, text, kind) {
    el.className = kind === "error" ? "tf-inline-error" : "";
    el.style.color = kind === "warn" ? "var(--warn)" : kind === "success" ? "var(--success)" : "";
    el.textContent = text;
  }

  function buildRow(row, showMaterial) {
    const tr = document.createElement("tr");

    const chkTd = document.createElement("td");
    if (!row.isReversed && row.materialDocumentSap) {
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "rev-chk";
      chk.dataset.matdoc = row.materialDocumentSap;
      chk.checked = true;
      chkTd.appendChild(chk);
    }

    const docTd = document.createElement("td");
    docTd.style.fontWeight = "700";
    docTd.textContent = row.materialDocumentSap || "—";

    const cells = [chkTd, docTd];
    if (showMaterial) {
      const matTd = document.createElement("td");
      matTd.textContent = row.material || "—";
      cells.push(matTd);
    }

    const typeTd = document.createElement("td");
    typeTd.textContent = row.postingType;
    const qtyTd = document.createElement("td");
    qtyTd.style.textAlign = "right";
    qtyTd.textContent = `${Number(row.quantity || 0).toFixed(3)} ${row.unitOfMeasure || ""}`;
    const postedTd = document.createElement("td");
    postedTd.textContent = fmtDate(row.postedAt);
    const byTd = document.createElement("td");
    byTd.textContent = row.postedBy || "—";
    const statusTd = document.createElement("td");
    if (row.isReversed) {
      statusTd.innerHTML = `<span class="badge badge--success">Reversed ${esc(row.reversalDocumentSap || "")}</span>`;
    } else {
      statusTd.innerHTML = '<span class="badge">Not Reversed</span>';
    }
    const resultTd = document.createElement("td");
    resultTd.id = `rev-result-${row.materialDocumentSap || row.sapPostingId}`;

    cells.push(typeTd, qtyTd, postedTd, byTd, statusTd, resultTd);
    tr.append(...cells);
    return tr;
  }

  renderSearchBar();
  showEmpty("Search for SAP postings to reverse.");
})();
