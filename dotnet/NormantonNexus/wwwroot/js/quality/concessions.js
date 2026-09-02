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
    if (rows.length === 0) {
      tableEl.innerHTML = `<p>No ${currentStatus.toLowerCase()} concessions.</p>`;
      return;
    }

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML =
      "<tr><th>Job</th><th>Linked Batch</th><th>Expected Component</th><th>Actual Material</th><th>Reason</th><th>Raised By</th><th>Raised At</th><th></th></tr>";
    const tbody = document.createElement("tbody");

    for (const c of rows) {
      const tr = document.createElement("tr");
      const lastCellHtml =
        c.status === "PENDING"
          ? `<button type="button" class="qc-approve" data-id="${c.concessionId}">Approve</button>
             <button type="button" class="secondary qc-reject" data-id="${c.concessionId}">Reject</button>`
          : c.reviewedByUsername || "—";

      tr.innerHTML = `
        <td>${jobLabel(c.processCode, c.recordId)}</td>
        <td>${jobLabel(c.parentProcessCode, c.parentRecordId)}</td>
        <td>${c.component}</td>
        <td>${c.actualMaterial}</td>
        <td>${c.reason}</td>
        <td>${c.raisedByUsername || "—"}</td>
        <td>${formatDate(c.raisedAt)}</td>
        <td>${lastCellHtml}</td>`;
      tbody.appendChild(tr);
    }

    table.append(thead, tbody);
    tableEl.innerHTML = "";
    tableEl.appendChild(table);

    tableEl.querySelectorAll(".qc-approve").forEach((btn) =>
      btn.addEventListener("click", () => reviewConcession(btn.dataset.id, "approve"))
    );
    tableEl.querySelectorAll(".qc-reject").forEach((btn) =>
      btn.addEventListener("click", () => reviewConcession(btn.dataset.id, "reject"))
    );
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
