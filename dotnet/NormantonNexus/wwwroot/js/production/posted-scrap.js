// Posted Scrap — approved/SAP-posted scrap summary by work centre and
// reason, plus a failed-postings retry queue. Port of runPostedScrap in
// production-nexus.js. The drill-down modal in Node's original is
// simplified here to an inline expand under the clicked reason row (no
// shared modal component exists yet in this port — visual-polish
// simplification, same precedent as reports-common.js skipping charts).
// Failed postings and each process's own summary now render as the shared
// `.ps-section` collapsible-bucket pattern (see order-suggestions.js's
// Tracked Orders for the original) rather than the hand-styled `.sd-section`
// cards this used before — same component, applied consistently.
(function () {
  const bodyEl = document.getElementById("ps-body");

  function wireCollapseToggles(root) {
    root.querySelectorAll(".ps-section-header").forEach((h) => {
      h.addEventListener("click", (e) => {
        if (e.target.closest("button, input, select, a")) return;
        h.closest(".ps-section").classList.toggle("ps-section--collapsed");
      });
    });
  }

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
    bodyEl.innerHTML = '<div class="nx-empty">Loading scrap data…</div>';
    try {
      const [summaryRes, failedRes] = await Promise.all([api("/scrap/summary"), api("/scrap/failed")]);
      const summary = summaryRes.data || [];
      const failed = failedRes.data || [];

      bodyEl.innerHTML = "";

      if (failed.length) {
        const reasons = (await api("/scrap-reasons")).data || [];
        const failedWrap = document.createElement("div");
        failedWrap.className = "ps-sections";
        failedWrap.style.marginBottom = "16px";
        failedWrap.appendChild(buildFailedSection(failed, reasons));
        bodyEl.appendChild(failedWrap);
      }

      const postedHeader = document.createElement("h3");
      postedHeader.textContent = "Posted Scrap (SAP confirmed)";
      bodyEl.appendChild(postedHeader);

      if (!summary.length) {
        const empty = document.createElement("div");
        empty.className = "nx-empty";
        empty.textContent = "No SAP-posted scrap recorded yet.";
        bodyEl.appendChild(empty);
        wireCollapseToggles(bodyEl);
        return;
      }

      const byProcess = new Map();
      for (const r of summary) {
        if (!byProcess.has(r.processCode)) byProcess.set(r.processCode, []);
        byProcess.get(r.processCode).push(r);
      }

      const sectionsWrap = document.createElement("div");
      sectionsWrap.className = "ps-sections";
      let first = true;
      for (const [pc, rows] of byProcess) {
        sectionsWrap.appendChild(buildProcessSummary(pc, rows, first));
        first = false;
      }
      bodyEl.appendChild(sectionsWrap);
      wireCollapseToggles(bodyEl);
    } catch (err) {
      bodyEl.innerHTML = "";
      const errBox = document.createElement("div");
      errBox.className = "nx-empty";
      errBox.textContent = err.message;
      bodyEl.appendChild(errBox);
    }
  }

  function buildProcessSummary(processCode, rows, isFirst) {
    const total = rows.reduce((s, r) => s + Number(r.totalScrap || 0), 0);
    const uom = rows[0].unitOfMeasure;

    const section = document.createElement("div");
    section.className = "ps-section" + (isFirst ? "" : " ps-section--collapsed");

    const header = document.createElement("div");
    header.className = "ps-section-header";
    const dot = document.createElement("span");
    dot.className = "ps-section-dot ps-section-dot--backlog";
    const title = document.createElement("span");
    title.className = "ps-section-title";
    title.textContent = PROCESS_LABELS[processCode] || processCode;
    const totalEl = document.createElement("span");
    totalEl.style.cssText = "color:var(--error);font-size:11px;font-weight:700";
    totalEl.textContent = `${total.toFixed(3)} ${uom} total`;
    const count = document.createElement("span");
    count.className = "ps-section-count";
    count.textContent = String(rows.length);
    const chevron = document.createElement("span");
    chevron.className = "ps-chevron";
    chevron.innerHTML = "&#9660;";
    header.append(dot, title, totalEl, count, chevron);
    section.appendChild(header);

    const body = document.createElement("div");
    body.className = "ps-section-body";
    section.appendChild(body);

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
      totalTd.style.color = "var(--error)";
      totalTd.textContent = Number(r.totalScrap).toFixed(3);
      const uomTd = document.createElement("td");
      uomTd.textContent = r.unitOfMeasure;
      const drillTd = document.createElement("td");
      drillTd.style.color = "var(--text-muted)";
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
          drillCell.innerHTML = '<div class="nx-empty">Loading…</div>';
          await loadDrilldown(drillCell, processCode, r.reasonCode);
        }
      });

      tr.append(reasonTd, countTd, totalTd, uomTd, drillTd);
      tbody.append(tr, drillRow);
    }

    table.append(thead, tbody);
    body.appendChild(table);
    return section;
  }

  async function loadDrilldown(container, processCode, reasonCode) {
    try {
      const { data } = await api(`/scrap/entries?processCode=${encodeURIComponent(processCode)}&reasonCode=${encodeURIComponent(reasonCode)}`);
      container.innerHTML = "";
      if (!data.length) {
        container.innerHTML = '<div class="nx-empty">No entries found.</div>';
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
      container.innerHTML = "";
      const errBox = document.createElement("div");
      errBox.className = "nx-empty";
      errBox.textContent = err.message;
      container.appendChild(errBox);
    }
  }

  function buildFailedSection(failed, reasons) {
    const section = document.createElement("div");
    section.className = "ps-section";

    const header = document.createElement("div");
    header.className = "ps-section-header";
    const dot = document.createElement("span");
    dot.className = "ps-section-dot ps-section-dot--priority";
    const title = document.createElement("span");
    title.className = "ps-section-title";
    title.style.color = "var(--error)";
    title.textContent = "Failed SAP Postings — approved but not posted";
    const count = document.createElement("span");
    count.className = "ps-section-count";
    count.textContent = String(failed.length);
    const chevron = document.createElement("span");
    chevron.className = "ps-chevron";
    chevron.innerHTML = "&#9660;";
    header.append(dot, title, count, chevron);
    section.appendChild(header);

    const body = document.createElement("div");
    body.className = "ps-section-body";
    body.style.padding = "12px 14px";
    for (const f of failed) {
      body.appendChild(buildFailedCard(f, reasons));
    }
    section.appendChild(body);
    return section;
  }

  function buildFailedCard(f, reasons) {
    const card = document.createElement("div");
    card.id = `ps-failed-${f.scrapId}`;
    card.className = "sd-section";
    card.style.marginBottom = "10px";

    const titleRow = document.createElement("div");
    titleRow.style.cssText = "display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px";
    const titleEl = document.createElement("div");
    const titleStrong = document.createElement("strong");
    titleStrong.textContent = `${batchRefOf(f)} · ${PROCESS_LABELS[f.processCode] || f.processCode}`;
    const subEl = document.createElement("div");
    subEl.style.cssText = "font-size:0.8rem;color:var(--text-muted);margin-top:2px";
    subEl.textContent = `${f.material || "—"} · ${f.reasonDescription || f.reasonCode} · ${Number(f.quantity).toFixed(3)} ${f.unitOfMeasure}`;
    titleEl.append(titleStrong, subEl);
    const badge = document.createElement("span");
    badge.className = "badge badge--error";
    badge.textContent = "SAP Failed";
    titleRow.append(titleEl, badge);

    const errorBox = document.createElement("div");
    errorBox.style.cssText = "background:var(--error-dim);color:var(--error);border-radius:6px;padding:6px 8px;font-size:0.8rem;margin-bottom:10px";
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
      msgEl.style.color = "var(--text-muted)";
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
        msgEl.style.color = "var(--success)";
        msgEl.textContent = `✓ Posted — MatDocs: ${docs}`;
        retryBtn.disabled = false;
        retryBtn.textContent = "Retry";
        card.style.opacity = "0.4";
        card.style.pointerEvents = "none";
      } catch (err) {
        msgEl.style.color = "var(--error)";
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
