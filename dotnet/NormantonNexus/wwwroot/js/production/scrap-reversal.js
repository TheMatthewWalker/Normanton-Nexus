// Scrap Reversal — missed-reversal alerts (scrap posted against a job
// whose backflush was later reversed) plus a flexible search/bulk-reverse
// action. Port of runScrapReversal in production-nexus.js. Node's search
// UI switches between 5 single-field "modes"; this port shows all filter
// fields at once instead, since the backend combines every provided field
// with AND regardless (a real simplification of the UI, not the
// functionality — every filter Node supports is still here). Node's SSE
// progress streaming for bulk reversal is not reproduced (see
// ScrapReversalHelper.cs's doc comment) — the bulk call here is a single
// request/response.
(function () {
  const missedEl = document.getElementById("sr-missed");
  const resultsEl = document.getElementById("sr-results");

  const PROCESS_LABELS = { MX: "Mixing", EX: "Extrusion", CO: "Convoluting", BR: "Braiding", CL: "Coverline", TW: "Tape Wrap", DR: "Drumming", EW: "Ewald", HA: "Hose Assembly" };

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

  function batchRefOf(row) {
    return row.batchRef || `${row.processCode}${String(row.processRecordId).padStart(8, "0")}`;
  }

  async function loadMissed() {
    missedEl.textContent = "Loading…";
    try {
      const { data } = await api("/scrap-reversal/missed");
      if (!data.length) {
        missedEl.textContent = "No missed reversals — every reversed backflush's scrap has been cleaned up.";
        return;
      }
      missedEl.innerHTML = "";
      missedEl.appendChild(buildTable(data, true));
    } catch (err) {
      missedEl.textContent = err.message;
    }
  }

  document.getElementById("sr-search-btn").addEventListener("click", async () => {
    const params = new URLSearchParams();
    const matdoc = document.getElementById("sr-matdoc").value.trim();
    const batchRef = document.getElementById("sr-batchref").value.trim();
    const material = document.getElementById("sr-material").value.trim();
    const pc = document.getElementById("sr-pc").value;
    const from = document.getElementById("sr-from").value;
    const to = document.getElementById("sr-to").value;
    const operator = document.getElementById("sr-operator").value.trim();

    if (matdoc) params.set("materialDocument", matdoc);
    if (batchRef) params.set("batchRef", batchRef);
    if (material) params.set("material", material);
    if (pc) params.set("processCode", pc);
    if (from) params.set("dateFrom", from);
    if (to) params.set("dateTo", to);
    if (operator) params.set("operator", operator);

    if (![...params.keys()].length) {
      resultsEl.textContent = "Enter at least one search parameter.";
      return;
    }

    resultsEl.textContent = "Searching…";
    try {
      const { data } = await api(`/scrap-reversal/search?${params}`);
      if (!data.length) { resultsEl.textContent = "No scrap documents found."; return; }
      resultsEl.innerHTML = "";
      resultsEl.appendChild(buildTable(data, false));
    } catch (err) {
      resultsEl.textContent = err.message;
    }
  });

  function buildTable(rows, missedOnly) {
    const wrap = document.createElement("div");

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
    toolbar.append(selectAllLabel, spacer, bulkBtn);
    wrap.appendChild(toolbar);

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["", "Material Doc", "Batch", "Process", "Material", "Reason", "Quantity", "Posted", "Posted By", "Backflush", ""]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    for (const row of rows) tbody.appendChild(buildRow(row));
    table.append(thead, tbody);
    wrap.appendChild(table);

    const msgEl = document.createElement("p");
    wrap.appendChild(msgEl);

    selectAll.addEventListener("change", () => {
      tbody.querySelectorAll(".sr-chk").forEach((c) => { c.checked = selectAll.checked; });
    });

    bulkBtn.addEventListener("click", async () => {
      const items = [...tbody.querySelectorAll(".sr-chk:checked")].map((c) => ({
        scrapDocumentId: Number(c.dataset.scrapdocid),
        materialDocument: c.dataset.matdoc,
      }));
      if (!items.length) { msgEl.style.color = "#b91c1c"; msgEl.textContent = "No entries selected."; return; }

      bulkBtn.disabled = true;
      bulkBtn.textContent = `Reversing ${items.length} document${items.length === 1 ? "" : "s"}…`;
      msgEl.textContent = "";

      try {
        const res = await api("/scrap-reversal/reverse/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items }),
        });

        let ok = 0, fail = 0;
        for (const r of res.data || []) {
          const cell = document.getElementById(`sr-result-${r.scrapDocumentId}`);
          if (r.success) {
            ok++;
            if (cell) { cell.style.color = "#059669"; cell.textContent = r.synced ? "Synced" : `✓ ${r.reversalDocument || ""}`; }
          } else {
            fail++;
            if (cell) { cell.style.color = "#b91c1c"; cell.title = r.error || ""; cell.textContent = "✗ Failed"; }
          }
        }

        msgEl.style.color = fail ? "#d97706" : "#059669";
        msgEl.textContent = fail ? `${ok} reversed, ${fail} failed — see inline results.` : `All ${ok} document${ok === 1 ? "" : "s"} reversed successfully.`;
      } catch (err) {
        msgEl.style.color = "#b91c1c";
        msgEl.textContent = err.message;
      } finally {
        bulkBtn.disabled = false;
        bulkBtn.textContent = "Reverse Selected";
      }
    });

    return wrap;
  }

  function buildRow(row) {
    const tr = document.createElement("tr");

    const chkTd = document.createElement("td");
    if (!row.isReversed) {
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "sr-chk";
      chk.dataset.scrapdocid = row.scrapDocumentId;
      chk.dataset.matdoc = row.materialDocument;
      chk.checked = true;
      chkTd.appendChild(chk);
    }

    const docTd = document.createElement("td");
    docTd.textContent = row.materialDocument;
    const refTd = document.createElement("td");
    refTd.textContent = batchRefOf(row);
    const pcTd = document.createElement("td");
    pcTd.textContent = PROCESS_LABELS[row.processCode] || row.processCode;
    const matTd = document.createElement("td");
    matTd.textContent = row.material || "—";
    const reasonTd = document.createElement("td");
    reasonTd.textContent = row.reasonDescription || row.reasonCode || "—";
    const qtyTd = document.createElement("td");
    qtyTd.style.textAlign = "right";
    qtyTd.textContent = `${Number(row.quantity).toFixed(3)} ${row.unitOfMeasure}`;
    const postedTd = document.createElement("td");
    postedTd.textContent = fmtDate(row.postedAt);
    const byTd = document.createElement("td");
    byTd.textContent = row.postedBy || "—";
    const backflushTd = document.createElement("td");
    backflushTd.textContent = row.backflushReversed ? "Reversed" : "—";
    if (row.backflushReversed && !row.isReversed) backflushTd.style.color = "#d97706";
    const resultTd = document.createElement("td");
    resultTd.id = `sr-result-${row.scrapDocumentId}`;
    if (row.isReversed) { resultTd.textContent = `Reversed ${row.reversalDocument || ""}`; resultTd.style.color = "#6b7280"; }

    tr.append(chkTd, docTd, refTd, pcTd, matTd, reasonTd, qtyTd, postedTd, byTd, backflushTd, resultTd);
    return tr;
  }

  loadMissed();
})();
