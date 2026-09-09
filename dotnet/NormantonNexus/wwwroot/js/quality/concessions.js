// Traceability Concessions tile — ported from private/js/quality.js's
// runConcessions()/loadConcessions()/reviewConcession() (lines ~830-947).
(function () {
  const tableEl = document.getElementById("qc-table");
  const msgEl = document.getElementById("qc-msg");
  const statusButtons = document.querySelectorAll(".qc-status-btn");

  let currentStatus = "PENDING";

  async function api(path, opts) {
    const r = await fetch(path, opts);
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

  function jobLabel(processCode, recordId) {
    return `${processCode}${String(recordId).padStart(8, "0")}`;
  }

  function formatDate(value) {
    return value ? new Date(value).toLocaleString("en-GB") : "—";
  }

  function highlightActiveStatusButton() {
    statusButtons.forEach((btn) => {
      btn.style.background = btn.dataset.status === currentStatus ? "var(--accent, #2563eb)" : "";
      btn.style.color = btn.dataset.status === currentStatus ? "#fff" : "";
    });
  }

  async function loadConcessions() {
    highlightActiveStatusButton();
    msgEl.textContent = "";
    tableEl.innerHTML = "Loading…";
    try {
      const { data } = await api(`/api/quality/concessions?status=${currentStatus}`);
      renderTable(data);
    } catch (err) {
      tableEl.innerHTML = "";
      msgEl.textContent = err.message;
    }
  }

  function renderTable(rows) {
    tableEl.innerHTML = "";
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = `No ${currentStatus.toLowerCase()} concessions.`;
      tableEl.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Job", "Linked Batch", "Expected Component", "Actual Material", "Reason", "Raised By", "Raised At", ""]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");

    // component/actualMaterial/reason/raisedByUsername are free text
    // (reason in particular is typed by a Production user raising the
    // concession) — every cell is built via textContent, never innerHTML,
    // so none of it is ever parsed as markup.
    for (const c of rows) {
      const tr = document.createElement("tr");

      const jobTd = document.createElement("td");
      jobTd.textContent = jobLabel(c.processCode, c.recordId);
      const batchTd = document.createElement("td");
      batchTd.textContent = jobLabel(c.parentProcessCode, c.parentRecordId);
      const componentTd = document.createElement("td");
      componentTd.textContent = c.component;
      const actualMaterialTd = document.createElement("td");
      actualMaterialTd.textContent = c.actualMaterial;
      const reasonTd = document.createElement("td");
      reasonTd.textContent = c.reason;
      const raisedByTd = document.createElement("td");
      raisedByTd.textContent = c.raisedByUsername || "—";
      const raisedAtTd = document.createElement("td");
      raisedAtTd.textContent = formatDate(c.raisedAt);

      const actionTd = document.createElement("td");
      if (c.status === "PENDING") {
        const approveBtn = document.createElement("button");
        approveBtn.type = "button";
        approveBtn.className = "qc-approve";
        approveBtn.textContent = "Approve";
        approveBtn.addEventListener("click", () => reviewConcession(c.concessionId, "approve"));

        const rejectBtn = document.createElement("button");
        rejectBtn.type = "button";
        rejectBtn.className = "secondary qc-reject";
        rejectBtn.textContent = "Reject";
        rejectBtn.addEventListener("click", () => reviewConcession(c.concessionId, "reject"));

        actionTd.append(approveBtn, rejectBtn);
      } else {
        actionTd.textContent = c.reviewedByUsername || "—";
      }

      tr.append(jobTd, batchTd, componentTd, actualMaterialTd, reasonTd, raisedByTd, raisedAtTd, actionTd);
      tbody.appendChild(tr);
    }

    table.append(thead, tbody);
    tableEl.appendChild(table);
  }

  async function reviewConcession(id, action) {
    let notes = null;
    if (action === "reject") {
      notes = prompt("Rejection notes (optional):");
      if (notes === null) return; // cancelled
    }

    msgEl.textContent = "";
    try {
      await api(`/api/quality/concessions/${id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      await loadConcessions();
    } catch (err) {
      msgEl.textContent = err.message;
    }
  }

  statusButtons.forEach((btn) =>
    btn.addEventListener("click", () => {
      currentStatus = btn.dataset.status;
      loadConcessions();
    })
  );

  loadConcessions();
})();
