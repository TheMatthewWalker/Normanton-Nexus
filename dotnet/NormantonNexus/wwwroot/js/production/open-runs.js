// Open Runs tile — port of runOpenRuns in production-nexus.js. Cross-
// process supervisor view of every record stuck at Status=1 (open, not
// yet completed), with a cancel action. Grouped into the shared
// `.ps-section` collapsible-bucket pattern by process — see
// order-suggestions.js's Tracked Orders for the original.
(function () {
  const msgEl = document.getElementById("or-msg");
  const listEl = document.getElementById("or-list");

  const PROCESS_LABELS = { MX: "Mixing", EX: "Extrusion", CO: "Convoluting", BR: "Braiding", CL: "Coverline", TW: "Tape Wrap", DR: "Drumming", EW: "Ewald", HA: "Hose Assembly" };

  function wireCollapseToggles(root) {
    root.querySelectorAll(".ps-section-header").forEach((h) => {
      h.addEventListener("click", (e) => {
        if (e.target.closest("button, input, select, a")) return;
        h.closest(".ps-section").classList.toggle("ps-section--collapsed");
      });
    });
  }

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

  async function load() {
    msgEl.className = "";
    msgEl.textContent = "";
    listEl.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await api("/open-runs");
      if (data.length === 0) {
        listEl.innerHTML = '<div class="nx-empty">No open runs.</div>';
        return;
      }

      listEl.innerHTML = "";

      const toolbar = document.createElement("div");
      toolbar.className = "nx-toolbar";
      const toolbarTitle = document.createElement("span");
      toolbarTitle.className = "nx-toolbar-title";
      toolbarTitle.textContent = `${data.length} open run${data.length === 1 ? "" : "s"}`;
      toolbar.appendChild(toolbarTitle);
      listEl.appendChild(toolbar);

      const byProcess = new Map();
      for (const row of data) {
        if (!byProcess.has(row.processCode)) byProcess.set(row.processCode, []);
        byProcess.get(row.processCode).push(row);
      }

      const sectionsWrap = document.createElement("div");
      sectionsWrap.className = "ps-sections";
      let first = true;
      for (const [pc, rows] of byProcess) {
        sectionsWrap.appendChild(buildProcessSection(pc, rows, first));
        first = false;
      }
      listEl.appendChild(sectionsWrap);
      wireCollapseToggles(listEl);
    } catch (err) {
      listEl.innerHTML = "";
      const errBox = document.createElement("div");
      errBox.className = "nx-empty";
      errBox.textContent = err.message;
      listEl.appendChild(errBox);
    }
  }

  function buildProcessSection(processCode, rows, isFirst) {
    const section = document.createElement("div");
    section.className = "ps-section" + (isFirst ? "" : " ps-section--collapsed");

    const header = document.createElement("div");
    header.className = "ps-section-header";
    const dot = document.createElement("span");
    dot.className = "ps-section-dot ps-section-dot--backlog";
    const title = document.createElement("span");
    title.className = "ps-section-title";
    title.textContent = PROCESS_LABELS[processCode] || processCode;
    const count = document.createElement("span");
    count.className = "ps-section-count";
    count.textContent = String(rows.length);
    const chevron = document.createElement("span");
    chevron.className = "ps-chevron";
    chevron.innerHTML = "&#9660;";
    header.append(dot, title, count, chevron);
    section.appendChild(header);

    const body = document.createElement("div");
    body.className = "ps-section-body";

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Ref", "Material", "Created", "Created By", ""]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    for (const row of rows) tbody.appendChild(buildRow(row));
    table.append(thead, tbody);
    body.appendChild(table);
    section.appendChild(body);
    return section;
  }

  function buildRow(row) {
    const tr = document.createElement("tr");
    const refTd = document.createElement("td");
    refTd.textContent = row.batchRef;
    const matTd = document.createElement("td");
    matTd.textContent = row.material;
    const createdTd = document.createElement("td");
    createdTd.textContent = fmtDate(row.createdAt);
    const byTd = document.createElement("td");
    byTd.textContent = row.createdBy || "—";

    const actionTd = document.createElement("td");
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => cancelRun(row.processCode, row.recordId));
    actionTd.appendChild(cancelBtn);

    tr.append(refTd, matTd, createdTd, byTd, actionTd);
    return tr;
  }

  async function cancelRun(processCode, recordId) {
    const reason = prompt("Reason for cancelling this open run (optional):") || "";
    if (!(await NexusModal.confirm("Cancel this open run?", { danger: true, confirmLabel: "Cancel Run", cancelLabel: "Back" }))) return;
    msgEl.className = "";
    msgEl.textContent = "";
    try {
      await api(`/open-runs/${processCode}/${recordId}/cancel`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      await load();
    } catch (err) {
      msgEl.className = "tf-inline-error";
      msgEl.textContent = err.message;
    }
  }

  load();
})();
