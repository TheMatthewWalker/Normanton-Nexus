// SAP Reversals — search SAP postings (by material document / batch
// reference / material / date range / operator) then bulk-reverse the
// selected backflush documents. Port of the reversal search UI in
// production-nexus.js. Every dynamic value is built via textContent/DOM
// APIs, never innerHTML. Node's SSE progress streaming for the bulk
// reversal is not reproduced (see ReversalHelper.cs's doc comment) — the
// bulk call here is a single request/response, so the UI just shows a
// "Reversing…" state until it completes.
(function () {
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

    const modeRow = document.createElement("div");
    modeRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px";
    for (const [m, label] of MODES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = m === mode ? "" : "secondary";
      btn.textContent = label;
      btn.addEventListener("click", () => { mode = m; renderSearchBar(); });
      modeRow.appendChild(btn);
    }
    inputsEl.appendChild(modeRow);

    const fieldRow = document.createElement("div");
    fieldRow.style.cssText = "display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap";

    if (mode === "matdoc") {
      fieldRow.appendChild(makeTextInput("rev-matdoc", "Material document"));
    } else if (mode === "batch") {
      const select = document.createElement("select");
      select.id = "rev-pc";
      for (const pc of PROCESS_CODES) {
        const opt = document.createElement("option");
        opt.value = pc;
        opt.textContent = pc;
        select.appendChild(opt);
      }
      fieldRow.append(select, makeTextInput("rev-rid", "Record ID"));
    } else if (mode === "material") {
      fieldRow.appendChild(makeTextInput("rev-material", "Material number"));
    } else if (mode === "daterange") {
      const fromInput = document.createElement("input");
      fromInput.type = "date";
      fromInput.id = "rev-date-from";
      const toInput = document.createElement("input");
      toInput.type = "date";
      toInput.id = "rev-date-to";
      fieldRow.append(fromInput, toInput);
    } else if (mode === "operator") {
      fieldRow.appendChild(makeTextInput("rev-operator", "Operator name"));
    }

    const searchBtn = document.createElement("button");
    searchBtn.type = "button";
    searchBtn.textContent = "Search";
    searchBtn.addEventListener("click", doSearch);
    fieldRow.appendChild(searchBtn);

    inputsEl.appendChild(fieldRow);
  }

  function makeTextInput(id, placeholder) {
    const input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.placeholder = placeholder;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
    return input;
  }

  async function doSearch() {
    msgEl.textContent = "";
    resultsEl.textContent = "Searching…";

    try {
      let json;
      if (mode === "matdoc") {
        const doc = document.getElementById("rev-matdoc")?.value.trim();
        if (!doc) { resultsEl.textContent = "Enter a material document number."; return; }
        json = await api(`/reversal/search?materialDocument=${encodeURIComponent(doc)}`);
      } else if (mode === "batch") {
        const pc = document.getElementById("rev-pc")?.value;
        const rid = document.getElementById("rev-rid")?.value.trim();
        if (!pc || !rid) { resultsEl.textContent = "Select a process and enter the record ID."; return; }
        json = await api(`/reversal/by-batch/${encodeURIComponent(pc)}/${encodeURIComponent(rid)}`);
      } else if (mode === "material") {
        const mat = document.getElementById("rev-material")?.value.trim();
        if (!mat) { resultsEl.textContent = "Enter a material number."; return; }
        json = await api(`/reversal/find?material=${encodeURIComponent(mat)}`);
      } else if (mode === "daterange") {
        const from = document.getElementById("rev-date-from")?.value;
        const to = document.getElementById("rev-date-to")?.value;
        if (!from && !to) { resultsEl.textContent = "Enter at least one date."; return; }
        const p = new URLSearchParams();
        if (from) p.set("dateFrom", from);
        if (to) p.set("dateTo", to);
        json = await api(`/reversal/find?${p}`);
      } else if (mode === "operator") {
        const op = document.getElementById("rev-operator")?.value.trim();
        if (!op) { resultsEl.textContent = "Enter an operator name."; return; }
        json = await api(`/reversal/find?operator=${encodeURIComponent(op)}`);
      }

      resultRows = json.data || [];
      if (!resultRows.length) { resultsEl.textContent = "No SAP postings found."; return; }
      renderResults();
    } catch (err) {
      resultsEl.textContent = err.message;
    }
  }

  function renderResults() {
    const reversible = resultRows.filter((r) => !r.isReversed && r.materialDocumentSap);
    const showMaterial = resultRows.some((r) => r.material);

    resultsEl.innerHTML = "";

    const toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:10px";

    const selectAllLabel = document.createElement("label");
    const selectAll = document.createElement("input");
    selectAll.type = "checkbox";
    selectAll.checked = true;
    selectAllLabel.append(selectAll, document.createTextNode(" Select All"));

    const spacer = document.createElement("span");
    spacer.style.flex = "1";

    const bulkBtn = document.createElement("button");
    bulkBtn.type = "button";
    bulkBtn.textContent = "Reverse Selected";
    bulkBtn.disabled = !reversible.length;

    toolbar.append(selectAllLabel, spacer, bulkBtn);
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
      if (!docs.length) { bulkMsg.style.color = "#b91c1c"; bulkMsg.textContent = "No entries selected."; return; }

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
            if (cell) { cell.style.color = "#059669"; cell.textContent = `✓ ${r.reversalDocument || ""}`; }
          } else {
            fail++;
            if (cell) { cell.style.color = r.synced ? "#d97706" : "#b91c1c"; cell.title = r.error || ""; cell.textContent = r.synced ? "Synced" : "✗ Failed"; }
          }
        }

        bulkMsg.style.color = fail ? "#d97706" : "#059669";
        bulkMsg.textContent = fail ? `${ok} reversed, ${fail} failed — see inline results.` : `All ${ok} document${ok === 1 ? "" : "s"} reversed successfully.`;
      } catch (err) {
        bulkMsg.style.color = "#b91c1c";
        bulkMsg.textContent = err.message;
      } finally {
        bulkBtn.disabled = false;
        bulkBtn.textContent = "Reverse Selected";
      }
    });
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
      statusTd.textContent = `Reversed ${row.reversalDocumentSap || ""}`;
      statusTd.style.color = "#6b7280";
    } else {
      statusTd.textContent = "Not Reversed";
    }
    const resultTd = document.createElement("td");
    resultTd.id = `rev-result-${row.materialDocumentSap || row.sapPostingId}`;

    cells.push(typeTd, qtyTd, postedTd, byTd, statusTd, resultTd);
    tr.append(...cells);
    return tr;
  }

  renderSearchBar();
  resultsEl.textContent = "Search for SAP postings to reverse.";
})();
