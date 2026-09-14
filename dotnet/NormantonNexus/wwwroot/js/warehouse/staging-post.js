// Staging Post (fulfil) tile — port of runStagingFulfil() in private/js/warehouse.js.
// Grouped into the shared `.ps-section` collapsible-bucket pattern by
// urgency (Overdue / Due Soon / Upcoming / No Due Date) — same shape as
// Order Suggestions' Tracked Orders urgency buckets (see
// order-suggestions.js).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/staging");
  const bodyEl = document.getElementById("sp-body");
  let rows = [];

  const DUE_SOON_HOURS = 24;

  function urgencyOf(row) {
    if (!row.dueAtUtc) return "No Due Date";
    const dueMs = new Date(row.dueAtUtc).getTime() - Date.now();
    if (dueMs < 0) return "Overdue";
    if (dueMs <= DUE_SOON_HOURS * 3600000) return "Due Soon";
    return "Upcoming";
  }

  const URGENCY_ORDER = [
    ["Overdue", "priority"],
    ["Due Soon", "backlog"],
    ["Upcoming", "week"],
    ["No Due Date", "other"],
  ];

  function wireCollapseToggles(root) {
    root.querySelectorAll(".ps-section-header").forEach((h) => {
      h.addEventListener("click", (e) => {
        if (e.target.closest("button, input, select, a")) return;
        h.closest(".ps-section").classList.toggle("ps-section--collapsed");
      });
    });
  }

  async function load() {
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api("/requests/open");
      rows = data || [];
      render();
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render() {
    if (rows.length === 0) {
      bodyEl.textContent = "No open staging requests.";
      return;
    }

    const byUrgency = new Map();
    for (const r of rows) {
      const u = urgencyOf(r);
      if (!byUrgency.has(u)) byUrgency.set(u, []);
      byUrgency.get(u).push(r);
    }

    const summary = document.createElement("p");
    summary.textContent = `${rows.length} open request(s)`;

    const sectionsWrap = document.createElement("div");
    sectionsWrap.className = "ps-sections";
    let first = true;
    for (const [urgency, dotClass] of URGENCY_ORDER) {
      const bucketRows = byUrgency.get(urgency);
      if (!bucketRows || !bucketRows.length) continue;
      sectionsWrap.appendChild(buildSection(urgency, dotClass, bucketRows, first));
      first = false;
    }

    bodyEl.innerHTML = "";
    bodyEl.append(summary, sectionsWrap);
    wireCollapseToggles(bodyEl);

    bodyEl.querySelectorAll("button[data-action='deliver']").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = rows.find((r) => String(r.requestId) === btn.dataset.id);
        if (row) openDeliver(row);
      });
    });
    bodyEl.querySelectorAll("button[data-action='cancel']").forEach((btn) => {
      btn.addEventListener("click", () => {
        const row = rows.find((r) => String(r.requestId) === btn.dataset.id);
        if (row) cancelRequest(row);
      });
    });
  }

  function buildSection(urgency, dotClass, bucketRows, isFirst) {
    const section = document.createElement("div");
    section.className = "ps-section" + (isFirst ? "" : " ps-section--collapsed");
    section.innerHTML = `
      <div class="ps-section-header">
        <span class="ps-section-dot ps-section-dot--${dotClass}"></span>
        <span class="ps-section-title">${esc(urgency)}</span>
        <span class="ps-section-count">${bucketRows.length}</span>
        <span class="ps-chevron">&#9660;</span>
      </div>
      <div class="ps-section-body">
        <table>
          <thead><tr><th>#</th><th>Material</th><th>Qty Requested</th><th>Qty Delivered</th><th>Location</th><th>Due</th><th>Requested By</th><th></th></tr></thead>
          <tbody>
            ${bucketRows.map((r) => `
              <tr>
                <td>${esc(r.requestId)}</td>
                <td>${esc(r.material)} ${esc(r.materialText)}</td>
                <td>${esc(r.quantityRequested)} ${esc(r.uom)}</td>
                <td>${esc(r.quantityDelivered)}</td>
                <td>${esc(r.location)}</td>
                <td>${r.dueAtUtc ? new Date(r.dueAtUtc).toLocaleString("en-GB") : ""}</td>
                <td>${esc(r.requestedBy)}</td>
                <td>
                  <button type="button" class="btn secondary" data-id="${r.requestId}" data-action="deliver">Deliver</button>
                  <button type="button" class="btn secondary" data-id="${r.requestId}" data-action="cancel">Cancel</button>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
    return section;
  }

  async function cancelRequest(row) {
    if (!(await NexusModal.confirm(`Cancel request #${row.requestId}?`, { danger: true, confirmLabel: "Cancel Request", cancelLabel: "Back" }))) return;
    try {
      await api(`/requests/${row.requestId}/cancel`, { method: "POST" });
      await load();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  const DELIVER_FIELDS = [
    { key: "quantity", label: "Quantity" },
    { key: "batch", label: "Batch" },
    { key: "storageLocation", label: "Storage Location" },
    { key: "sourceType", label: "Source Type" },
    { key: "sourceBin", label: "Source Bin" },
    { key: "destType", label: "Destination Type" },
    { key: "destBin", label: "Destination Bin" },
  ];

  function openDeliver(row) {
    const record = {
      quantity: String(row.quantityRequested - row.quantityDelivered),
      batch: row.requestedBatch || "",
      storageLocation: "",
      sourceType: "",
      sourceBin: "",
      destType: "",
      destBin: "",
    };

    AdminEditModal.open("Deliver Request", `Request #${row.requestId}`, DELIVER_FIELDS, record, async (values) => {
      const quantity = Number(values.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Quantity must be greater than zero.");

      const body = {
        quantity,
        batch: values.batch || null,
        storageLocation: values.storageLocation || null,
        sourceStorageType: values.sourceType || null,
        sourceBin: values.sourceBin || null,
        destinationStorageType: values.destType || null,
        destinationBin: values.destBin || null,
      };
      const { data } = await api(`/requests/${row.requestId}/deliver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
      if (data.error) throw new Error(`Status: ${data.status} — ${data.error}`);
    });
  }

  document.getElementById("sp-refresh").addEventListener("click", load);
  load();
})();
