// Approve Scrap — supervisor queue reviewing/posting operator scrap
// entries to SAP. Port of runApproveScrap in production-nexus.js. Every
// dynamic value is built via textContent/DOM APIs, never innerHTML.
(function () {
  const bodyEl = document.getElementById("as-body");

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

  async function load() {
    bodyEl.textContent = "Loading pending scrap…";
    try {
      const { data } = await api("/scrap/pending");

      if (data.length === 0) {
        bodyEl.textContent = "No scrap entries pending approval.";
        return;
      }

      bodyEl.innerHTML = "";

      const toolbar = document.createElement("div");
      toolbar.style.cssText = "display:flex;align-items:center;gap:12px;margin-bottom:10px";

      const selectAllLabel = document.createElement("label");
      const selectAll = document.createElement("input");
      selectAll.type = "checkbox";
      selectAll.checked = true;
      selectAllLabel.append(selectAll, document.createTextNode(" Select All"));

      const spacer = document.createElement("span");
      spacer.style.flex = "1";

      const rejectBtn = document.createElement("button");
      rejectBtn.type = "button";
      rejectBtn.className = "secondary";
      rejectBtn.textContent = "Reject Selected";

      const approveBtn = document.createElement("button");
      approveBtn.type = "button";
      approveBtn.textContent = "Approve && Post Selected to SAP";

      toolbar.append(selectAllLabel, spacer, rejectBtn, approveBtn);
      bodyEl.appendChild(toolbar);

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of ["", "Batch", "Process", "Material", "Reason", "Quantity", "Entered By", "Entered At", ""]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = document.createElement("tbody");
      for (const row of data) tbody.appendChild(buildRow(row));
      table.append(thead, tbody);
      bodyEl.appendChild(table);

      const msgEl = document.createElement("p");
      msgEl.id = "as-msg";
      bodyEl.appendChild(msgEl);

      selectAll.addEventListener("change", () => {
        tbody.querySelectorAll(".as-chk").forEach((c) => { c.checked = selectAll.checked; });
      });

      approveBtn.addEventListener("click", async () => {
        const checked = [...tbody.querySelectorAll(".as-chk:checked")].map((c) => Number(c.dataset.scrapid));
        if (!checked.length) { msgEl.style.color = "#b91c1c"; msgEl.textContent = "No entries selected."; return; }

        approveBtn.disabled = true;
        approveBtn.textContent = `Posting ${checked.length} entr${checked.length === 1 ? "y" : "ies"} to SAP…`;
        msgEl.textContent = "";

        try {
          const res = await api("/scrap/approve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scrapIds: checked }),
          });

          let ok = 0, fail = 0;
          for (const r of res.data || []) {
            const cell = document.getElementById(`as-result-${r.scrapId}`);
            if (r.success) {
              ok++;
              if (cell) { cell.style.color = "#059669"; cell.textContent = `✓ ${(r.materialDocuments || []).join(", ")}`; }
            } else {
              fail++;
              if (cell) { cell.style.color = "#b91c1c"; cell.title = r.error || ""; cell.textContent = "✗ Failed"; }
            }
          }

          msgEl.style.color = fail ? "#d97706" : "#059669";
          msgEl.textContent = fail ? `${ok} posted successfully, ${fail} failed — see inline results.` : `All ${ok} entries posted to SAP successfully.`;
        } catch (err) {
          msgEl.style.color = "#b91c1c";
          msgEl.textContent = err.message;
        } finally {
          approveBtn.disabled = false;
          approveBtn.textContent = "Approve && Post Selected to SAP";
        }
      });

      let rejectArmed = false;
      rejectBtn.addEventListener("click", async () => {
        const checked = [...tbody.querySelectorAll(".as-chk:checked")].map((c) => Number(c.dataset.scrapid));
        if (!checked.length) { msgEl.style.color = "#b91c1c"; msgEl.textContent = "No entries selected."; return; }

        if (!rejectArmed) {
          rejectArmed = true;
          rejectBtn.textContent = `Click again to reject ${checked.length} entr${checked.length === 1 ? "y" : "ies"}`;
          msgEl.style.color = "#b91c1c";
          msgEl.textContent = "Rejected entries are removed permanently and can never be posted to SAP.";
          setTimeout(() => { rejectArmed = false; rejectBtn.textContent = "Reject Selected"; }, 5000);
          return;
        }
        rejectArmed = false;

        rejectBtn.disabled = true;
        rejectBtn.textContent = "Rejecting…";
        msgEl.textContent = "";

        try {
          const res = await api("/scrap/reject", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scrapIds: checked }),
          });

          let ok = 0, fail = 0;
          for (const r of res.data || []) {
            if (r.success) {
              ok++;
              tbody.querySelector(`tr[data-scrapid="${r.scrapId}"]`)?.remove();
            } else {
              fail++;
              const cell = document.getElementById(`as-result-${r.scrapId}`);
              if (cell) { cell.style.color = "#b91c1c"; cell.textContent = `✗ ${r.error || ""}`; }
            }
          }

          msgEl.style.color = fail ? "#d97706" : "#059669";
          msgEl.textContent = fail ? `${ok} rejected, ${fail} failed — see inline results.` : `${ok} entr${ok === 1 ? "y" : "ies"} rejected.`;
          if (!tbody.querySelectorAll("tr").length) bodyEl.textContent = "No scrap entries pending approval.";
        } catch (err) {
          msgEl.style.color = "#b91c1c";
          msgEl.textContent = err.message;
        } finally {
          rejectBtn.disabled = false;
          rejectBtn.textContent = "Reject Selected";
        }
      });
    } catch (err) {
      bodyEl.textContent = err.message;
    }
  }

  function buildRow(row) {
    const tr = document.createElement("tr");
    tr.dataset.scrapid = row.scrapId;

    const chkTd = document.createElement("td");
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.className = "as-chk";
    chk.dataset.scrapid = row.scrapId;
    chk.checked = true;
    chkTd.appendChild(chk);

    const refTd = document.createElement("td");
    refTd.textContent = batchRefOf(row);
    const pcTd = document.createElement("td");
    pcTd.textContent = PROCESS_LABELS[row.processCode] || row.processCode;
    const matTd = document.createElement("td");
    matTd.textContent = row.material || "—";
    const reasonTd = document.createElement("td");
    reasonTd.textContent = row.reasonDescription || row.reasonCode;
    const qtyTd = document.createElement("td");
    qtyTd.style.textAlign = "right";
    qtyTd.textContent = `${Number(row.quantity).toFixed(3)} ${row.unitOfMeasure}`;
    const byTd = document.createElement("td");
    byTd.textContent = row.enteredBy || "—";
    const atTd = document.createElement("td");
    atTd.textContent = fmtDate(row.enteredAt);
    const resultTd = document.createElement("td");
    resultTd.id = `as-result-${row.scrapId}`;

    tr.append(chkTd, refTd, pcTd, matTd, reasonTd, qtyTd, byTd, atTd, resultTd);
    return tr;
  }

  load();
})();
