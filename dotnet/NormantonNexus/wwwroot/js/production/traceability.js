// Traceability tile — port of runTraceability in private/js/production-nexus.js.
// Resolves a batch ref via /history (same as Node), then walks the
// recursive ancestor chain from /trace/:pc/:id, building an ordered,
// deduplicated list of nodes (searched batch first, then ancestors in
// depth order) exactly as the Node original does.
(function () {
  const R = window.ProductionReports;
  const refInput = document.getElementById("trace-ref");
  const pcSelect = document.getElementById("trace-pc");
  const resultsEl = document.getElementById("trace-results");

  for (const [code, label] of Object.entries(R.PROCESS_LABELS)) pcSelect.add(new Option(label, code));

  function fmtDate(dt) {
    return dt ? new Date(dt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  }
  function fmtQty(qty, uom) {
    return qty != null ? `${Number(qty).toFixed(3)} ${uom || ""}` : "—";
  }

  document.getElementById("trace-btn").addEventListener("click", async () => {
    const ref = refInput.value.trim();
    const pc = pcSelect.value;
    if (!ref && !pc) return;

    resultsEl.textContent = "Tracing…";
    try {
      const params = new URLSearchParams({ ref });
      if (pc) params.set("processCode", pc);
      const hist = await R.api(`/history?${params}`);
      const batch = (hist.data || [])[0];
      if (!batch) {
        resultsEl.textContent = "Batch not found.";
        return;
      }

      const traceJson = await R.api(`/trace/${batch.processCode}/${batch.recordId}`);
      const chain = traceJson.data?.chain || [];
      const details = traceJson.data?.details || {};

      const seen = new Set();
      const nodes = [];
      function push(code2, rid, depth) {
        const key = `${code2}-${rid}`;
        if (seen.has(key)) return;
        seen.add(key);
        nodes.push({ pc: code2, rid, depth, key });
      }
      push(batch.processCode, batch.recordId, 0);
      for (const t of chain) {
        push(t.childProcessCode, t.childRecordId, t.depth);
        push(t.parentProcessCode, t.parentRecordId, t.depth + 1);
      }

      resultsEl.innerHTML = "";
      resultsEl.appendChild(
        R.buildTable(["Level", "Process", "Batch Ref", "Material", "Quantity", "Created", "Operator"], nodes, (n, i) => {
          const d = details[n.key] || {};
          const tr = document.createElement("tr");
          if (n === nodes[0]) tr.style.background = "rgba(37,99,235,0.06)";

          const levelTd = document.createElement("td");
          levelTd.textContent = n === nodes[0] ? `${n.depth} (searched)` : n === nodes[nodes.length - 1] && nodes.length > 1 ? `${n.depth} (root)` : String(n.depth);
          const pcTd = document.createElement("td");
          pcTd.textContent = R.PROCESS_LABELS[n.pc] || n.pc;
          const refTd = document.createElement("td");
          refTd.textContent = d.batchRef || `${n.pc}${String(n.rid).padStart(8, "0")}`;
          const matTd = document.createElement("td");
          matTd.textContent = d.material || "—";
          const qtyTd = document.createElement("td");
          qtyTd.textContent = fmtQty(d.quantity, d.uom);
          const createdTd = document.createElement("td");
          createdTd.textContent = fmtDate(d.createdAt);
          const opTd = document.createElement("td");
          opTd.textContent = d.operator || "—";
          tr.append(levelTd, pcTd, refTd, matTd, qtyTd, createdTd, opTd);
          return tr;
        })
      );

      if (chain.length === 0) {
        const note = document.createElement("p");
        note.style.color = "#6b7280";
        note.style.fontSize = "0.8rem";
        note.textContent = "No trace links recorded — showing batch details only.";
        resultsEl.appendChild(note);
      }
    } catch (err) {
      resultsEl.textContent = err.message;
    }
  });
})();
