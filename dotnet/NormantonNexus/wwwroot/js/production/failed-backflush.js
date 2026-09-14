// Failed Backflush — the supervisor retry/cancel queue for every
// Status=6 (SAP_FAILED) production record. Port of runFailedBackflush in
// production-nexus.js. Node's retry modal pre-fetches the record's current
// field values via GET /batch/:pc/:id before showing the edit form — that
// route was never ported anywhere in this migration, so every retry field
// here starts blank rather than pre-filled; FailedBackflushHelper's own
// COALESCE(@field, ExistingValue) SQL already treats a blank/omitted field
// as "leave unchanged", so retrying with nothing typed simply re-submits
// the record as-is — a real, documented simplification, not a functional
// loss. The EX-only "replace which mix tub this run traces back to" search
// widget is dropped too, for the same "no shared modal/search component to
// build this against yet" reason posted-scrap.js's drilldown already gave —
// an EX retry blocked on tub staging still works by staging the tub first
// (Billet Staging tile) and retrying as-is.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/productionnexus");
  const bodyEl = document.getElementById("fb-body");

  const PROCESS_LABELS = { MX: "Mixing", EX: "Extrusion", CO: "Convoluting", BR: "Braiding", CL: "Coverline", TW: "Tape Wrap", DR: "Drumming", EW: "Ewald", HA: "Hose Assembly" };
  const METRE_CODES = new Set(["EX", "CO", "BR", "CL", "TW"]);

  const RETRY_FIELDS = {
    MX: [
      { key: "mixCode", label: "Mix Code / Material" },
      { key: "supplierBatchNo", label: "Supplier Batch No" },
      { key: "supplierTubNo", label: "Supplier Tub No" },
      { key: "notes", label: "Notes", multiline: true, wide: true },
    ],
    DR: [
      { key: "material", label: "Material" },
      { key: "packagingId", label: "Packaging ID" },
      { key: "lengthMetres", label: "Total Length (M)", type: "number" },
      { key: "weightKg", label: "Weight (KG)", type: "number" },
      { key: "customerNumber", label: "Customer Number" },
      { key: "orderNumber", label: "Order Number" },
      { key: "comments", label: "Comments", multiline: true, wide: true },
    ],
    EW: [
      { key: "material", label: "Material" },
      { key: "notes", label: "Notes", multiline: true, wide: true },
    ],
    HA: [
      { key: "material", label: "Material" },
      { key: "salesOrderSap", label: "Sales Order" },
      { key: "notes", label: "Notes", multiline: true, wide: true },
    ],
  };
  const METRE_FIELDS = [
    { key: "material", label: "Material" },
    { key: "lengthMetres", label: "Length (M)", type: "number" },
    { key: "notes", label: "Notes", multiline: true, wide: true },
  ];

  function fmt(dt) {
    return dt ? new Date(dt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  }

  let rows = [];

  async function load() {
    bodyEl.innerHTML = '<div class="nx-empty">Loading…</div>';
    try {
      const { data } = await api("/failed-backflush");
      rows = data || [];
      render();
    } catch (err) {
      bodyEl.innerHTML = `<div class="nx-empty">Error: ${esc(err.message)}</div>`;
    }
  }

  function render() {
    if (rows.length === 0) {
      bodyEl.innerHTML = '<div class="nx-empty" style="color:var(--accent)">✓ No failed backflushes — all clear.</div>';
      return;
    }

    bodyEl.innerHTML = `
      <p>${rows.length} failed</p>
      <table>
        <thead><tr><th>Batch Ref</th><th>Process</th><th>Material</th><th>Qty</th><th>Created</th><th>Error</th><th></th></tr></thead>
        <tbody id="fb-tbody"></tbody>
      </table>
      <div class="nx-pager" id="fb-pager"></div>`;

    NexusTable.paginate({
      container: document.getElementById("fb-tbody"),
      pagerContainer: document.getElementById("fb-pager"),
      pageSize: 25,
      renderRows: (pageRows) => pageRows.map((r) => {
        const isBilletBlock = /^Blocked:/.test(r.errorMessage || "");
        return `
          <tr>
            <td>${esc(r.batchRef)}</td>
            <td>${esc(PROCESS_LABELS[r.processCode] || r.processCode)}</td>
            <td>${esc(r.material)}</td>
            <td>${Number(r.quantity).toFixed(3)} ${esc(r.uom)}</td>
            <td>${fmt(r.createdAt)}</td>
            <td style="background:${isBilletBlock ? "rgba(217,119,6,0.1)" : "rgba(220,38,38,0.08)"};font-size:0.8rem;">${esc(r.errorMessage || "No error message recorded")}</td>
            <td>
              <button type="button" class="btn secondary" data-action="retry" data-pc="${esc(r.processCode)}" data-rid="${r.recordId}">Retry</button>
              <button type="button" class="btn secondary" data-action="cancel" data-pc="${esc(r.processCode)}" data-rid="${r.recordId}">Cancel</button>
            </td>
          </tr>`;
      }).join(""),
      onRendered: () => {
        bodyEl.querySelectorAll("button[data-action='retry']").forEach((btn) => {
          btn.addEventListener("click", () => {
            const row = rows.find((r) => r.processCode === btn.dataset.pc && String(r.recordId) === btn.dataset.rid);
            if (row) openRetryForm(row);
          });
        });
        bodyEl.querySelectorAll("button[data-action='cancel']").forEach((btn) => {
          btn.addEventListener("click", () => {
            const row = rows.find((r) => r.processCode === btn.dataset.pc && String(r.recordId) === btn.dataset.rid);
            if (row) cancelRecord(row);
          });
        });
      },
    }).setRows(rows);
  }

  function openRetryForm(row) {
    const pc = row.processCode;
    const fields = METRE_CODES.has(pc) ? METRE_FIELDS : (RETRY_FIELDS[pc] || [{ key: "notes", label: "Notes", multiline: true, wide: true }]);
    const numericKeys = new Set(fields.filter((f) => f.type === "number").map((f) => f.key));
    const record = Object.fromEntries(fields.map((f) => [f.key, ""]));

    AdminEditModal.open(`Retry ${row.batchRef}`, `${PROCESS_LABELS[pc] || pc} · re-submit to SAP`, fields, record, async (values) => {
      const body = {};
      for (const f of fields) {
        const raw = values[f.key];
        if (raw === "" || raw == null) continue;
        body[f.key] = numericKeys.has(f.key) ? Number(raw) : raw;
      }

      const { data } = await api(`/failed-backflush/${pc}/${row.recordId}/retry`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
      if (data.status === "SAP_FAILED" || data.status === "BLOCKED") {
        throw new Error(data.warning || "Retry did not fully succeed — see the queue for the updated error.");
      }
    });
  }

  async function cancelRecord(row) {
    if (!(await NexusModal.confirm(`Cancel ${row.batchRef}? This sets its status to Cancelled and removes it from the queue.`, { danger: true, confirmLabel: "Cancel Record" }))) return;
    try {
      await api(`/failed-backflush/${row.processCode}/${row.recordId}/cancel`, { method: "PATCH" });
      await load();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  load();
})();
