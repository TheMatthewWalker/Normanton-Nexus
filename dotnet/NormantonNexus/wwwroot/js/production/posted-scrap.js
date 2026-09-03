// Posted Scrap — approved/SAP-posted scrap summary by work centre and
// reason, plus a failed-postings retry queue. Port of runPostedScrap in
// production-nexus.js. The drill-down modal in Node's original is
// simplified here to an inline expand under the clicked reason row (no
// shared modal component exists yet in this port — visual-polish
// simplification, same precedent as reports-common.js skipping charts).
(function () {
  const bodyEl = document.getElementById("ps-body");

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
    bodyEl.textContent = "Loading scrap data…";
    try {
      const [summaryRes, failedRes] = await Promise.all([api("/scrap/summary"), api("/scrap/failed")]);
      const summary = summaryRes.data || [];
      const failed = failedRes.data || [];

      bodyEl.innerHTML = "";

      if (failed.length) {
        const reasons = (await api("/scrap-reasons")).data || [];
        bodyEl.appendChild(buildFailedSection(failed, reasons));
      }

      const postedHeader = document.createElement("h3");
      postedHeader.textContent = "Posted Scrap (SAP confirmed)";
      bodyEl.appendChild(postedHeader);

      if (!summary.length) {
        const empty = document.createElement("p");
        empty.textContent = "No SAP-posted scrap recorded yet.";
        bodyEl.appendChild(empty);
        return;
      }

      const byProcess = new Map();
      for (const r of summary) {
        if (!byProcess.has(r.processCode)) byProcess.set(r.processCode, []);
        byProcess.get(r.processCode).push(r);
      }

      for (const [pc, rows] of byProcess) {
        bodyEl.appendChild(buildProcessSummary(pc, rows));
      }
    } catch (err) {
      bodyEl.textContent = err.message;
    }
  }

  function buildProcessSummary(processCode, rows) {
    const total = rows.reduce((s, r) => s + Number(r.totalScrap || 0), 0);
    const uom = rows[0].unitOfMeasure;

    const section = document.createElement("div");
    section.style.cssText = "border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;margin-bottom:10px";

    const header = document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px";
    const title = document.createElement("strong");
    title.textContent = PROCESS_LABELS[processCode] || processCode;
    const totalEl = document.createElement("span");
    totalEl.style.color = "#b91c1c";
    totalEl.textContent = `${total.toFixed(3)} ${uom} total`;
    header.append(title, totalEl);
    section.appendChild(header);

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Reason", "Entries", "Total Scrap", "UOM", ""]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");

    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.style.cursor = "pointer";
      const reasonTd = document.createElement("td");
      reasonTd.textContent = r.reasonDescription || r.reasonCode || "—";
      const countTd = document.createElement("td");
      countTd.style.textAlign = "right";
      countTd.textContent = r.entryCount;
      const totalTd = document.createElement("td");
      totalTd.style.textAlign = "right";
      totalTd.style.color = "#b91c1c";
      totalTd.textContent = Number(r.totalScrap).toFixed(3);
      const uomTd = document.createElement("td");
      uomTd.textContent = r.unitOfMeasure;
      const drillTd = document.createElement("td");
      drillTd.style.color = "#6b7280";
      drillTd.style.fontSize = "0.8rem";
      drillTd.textContent = "↗ drill down";

      const drillRow = document.createElement("tr");
      const drillCell = document.createElement("td");
      drillCell.colSpan = 5;
      drillCell.hidden = true;
      drillRow.appendChild(drillCell);

      tr.addEventListener("click", async () => {
        drillCell.hidden = !drillCell.hidden;
        if (!drillCell.hidden && !drillCell.dataset.loaded) {
          drillCell.dataset.loaded = "1";
          drillCell.textContent = "Loading…";
          await loadDrilldown(drillCell, processCode, r.reasonCode);
        }
      });

      tr.append(reasonTd, countTd, totalTd, uomTd, drillTd);
      tbody.append(tr, drillRow);
    }

    table.append(thead, tbody);
    section.appendChild(table);
    return section;
  }

  async function loadDrilldown(container, processCode, reasonCode) {
    try {
      const { data } = await api(`/scrap/entries?processCode=${encodeURIComponent(processCode)}&reasonCode=${encodeURIComponent(reasonCode)}`);
      container.textContent = "";
      if (!data.length) {
        container.textContent = "No entries found.";
        return;
      }

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of ["Batch", "Material", "Qty", "SAP Material Documents", "Entered"]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = document.createElement("tbody");
      for (const e of data) {
        const tr = document.createElement("tr");
        const refTd = document.createElement("td");
        refTd.textContent = batchRefOf(e);
        const matTd = document.createElement("td");
        matTd.textContent = e.material || "—";
        const qtyTd = document.createElement("td");
        qtyTd.style.textAlign = "right";
        qtyTd.textContent = Number(e.quantity).toFixed(3);
        const docsTd = document.createElement("td");
        docsTd.textContent = (e.materialDocuments || []).map((d) => d.materialDocument).filter(Boolean).join(", ") || e.sapMaterialDocument || "—";
        const atTd = document.createElement("td");
        atTd.textContent = fmtDate(e.enteredAt);
        tr.append(refTd, matTd, qtyTd, docsTd, atTd);
        tbody.appendChild(tr);
      }
      table.append(thead, tbody);
      container.appendChild(table);
    } catch (err) {
      container.textContent = err.message;
    }
  }

  function buildFailedSection(failed, reasons) {
    const section = document.createElement("div");
    section.style.marginBottom = "24px";

    const header = document.createElement("h3");
    header.style.color = "#b91c1c";
    header.textContent = `Failed SAP Postings (${failed.length} entr${failed.length !== 1 ? "ies" : "y"} approved but not posted)`;
    section.appendChild(header);

    for (const f of failed) {
      section.appendChild(buildFailedCard(f, reasons));
    }
    return section;
  }

  function buildFailedCard(f, reasons) {
    const card = document.createElement("div");
    card.id = `ps-failed-${f.scrapId}`;
    card.style.cssText = "border:1px solid #fca5a5;border-radius:8px;padding:12px 14px;margin-bottom:10px";

    const titleRow = document.createElement("div");
    titleRow.style.cssText = "display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px";
    const titleEl = document.createElement("div");
    const titleStrong = document.createElement("strong");
    titleStrong.textContent = `${batchRefOf(f)} · ${PROCESS_LABELS[f.processCode] || f.processCode}`;
    const subEl = document.createElement("div");
    subEl.style.cssText = "font-size:0.8rem;color:#6b7280;margin-top:2px";
    subEl.textContent = `${f.material || "—"} · ${f.reasonDescription || f.reasonCode} · ${Number(f.quantity).toFixed(3)} ${f.unitOfMeasure}`;
    titleEl.append(titleStrong, subEl);
    const badge = document.createElement("span");
    badge.style.cssText = "color:#b91c1c;font-size:0.75rem;font-weight:600";
    badge.textContent = "SAP Failed";
    titleRow.append(titleEl, badge);

    const errorBox = document.createElement("div");
    errorBox.style.cssText = "background:#fef2f2;border-radius:6px;padding:6px 8px;font-size:0.8rem;margin-bottom:10px";
    errorBox.textContent = f.sapErrorMessage || "No error message recorded";

    const form = document.createElement("div");
    form.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end";

    const qtyField = document.createElement("div");
    const qtyLabel = document.createElement("label");
    qtyLabel.textContent = "Quantity ";
    const qtyInput = document.createElement("input");
    qtyInput.type = "number";
    qtyInput.step = "0.001";
    qtyInput.min = "0.001";
    qtyInput.value = Number(f.quantity).toFixed(3);
    qtyInput.style.maxWidth = "120px";
    qtyLabel.appendChild(qtyInput);
    qtyField.appendChild(qtyLabel);

    const reasonField = document.createElement("div");
    const reasonLabel = document.createElement("label");
    reasonLabel.textContent = "Reason ";
    const reasonSelect = document.createElement("select");
    for (const r of reasons) {
      const opt = document.createElement("option");
      opt.value = r.reasonId;
      opt.textContent = `${r.reasonCode} — ${r.reasonDescription}`;
      if (r.reasonId === f.reasonId) opt.selected = true;
      reasonSelect.appendChild(opt);
    }
    reasonLabel.appendChild(reasonSelect);
    reasonField.appendChild(reasonLabel);

    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "secondary";
    retryBtn.textContent = "Retry";

    const msgEl = document.createElement("span");
    msgEl.style.fontSize = "0.8rem";

    retryBtn.addEventListener("click", async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = "Retrying…";
      msgEl.style.color = "#6b7280";
      msgEl.textContent = "Posting to SAP…";
      try {
        const res = await api(`/scrap/${f.scrapId}/retry`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quantity: qtyInput.value ? Number(qtyInput.value) : null,
            reasonId: reasonSelect.value ? Number(reasonSelect.value) : null,
          }),
        });
        const docs = (res.data?.materialDocuments || []).join(", ") || "—";
        msgEl.style.color = "#059669";
        msgEl.textContent = `✓ Posted — MatDocs: ${docs}`;
        retryBtn.disabled = false;
        retryBtn.textContent = "Retry";
        card.style.opacity = "0.4";
        card.style.pointerEvents = "none";
      } catch (err) {
        msgEl.style.color = "#b91c1c";
        msgEl.textContent = err.message;
        retryBtn.disabled = false;
        retryBtn.textContent = "Retry";
      }
    });

    form.append(qtyField, reasonField, retryBtn, msgEl);
    card.append(titleRow, errorBox, form);
    return card;
  }

  load();
})();
