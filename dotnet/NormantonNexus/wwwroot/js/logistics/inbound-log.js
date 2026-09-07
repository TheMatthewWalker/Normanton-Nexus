// Inbound Log tile — list of log.PurchaseOrderShipment records (tracked-order
// shipments + manual shipments) with a detail view for edit, mark
// received/undo, cancel, manual items, documents, and associated costs.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance/order-suggestions/shipments");
  const itemApi = NexusApi.make("/api/performance/order-suggestions");
  const costApi = NexusApi.make("/api/inboundcosts");
  const refApi = NexusApi.make("/api");

  let rows = [];
  let searchQuery = "";
  let costTypes = [];
  let forwarders = [];

  function fmtDate(d) {
    return d ? new Date(d).toLocaleDateString("en-GB") : "";
  }

  function bucketFor(s) {
    if (s.cancelledAtUtc) return { key: "cancelled", label: "Cancelled" };
    if (s.receivedAtUtc) return { key: "completed", label: "Received" };
    if (!s.expectedEta) return { key: "upcoming", label: "Upcoming" };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const eta = new Date(s.expectedEta); eta.setHours(0, 0, 0, 0);
    if (eta.getTime() < today.getTime()) return { key: "late", label: "Late" };
    if (eta.getTime() === today.getTime()) return { key: "today", label: "Today" };
    return { key: "upcoming", label: "Upcoming" };
  }

  function matchesSearch(s, q) {
    if (!q) return true;
    const needle = q.toLowerCase();
    return [s.shipmentReference, s.haulier, s.trackingNumber, s.containerNumber, s.billOfLading,
      s.orderMaterials, s.manualMaterials, s.poNumbers, s.supplierReferences, s.suppliers]
      .some((f) => String(f || "").toLowerCase().includes(needle));
  }

  async function loadList() {
    const el = document.getElementById("il-list");
    el.textContent = "Loading…";
    try {
      const { data } = await api("");
      rows = data || [];
      renderList();
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function renderList() {
    const el = document.getElementById("il-list");
    const q = searchQuery.trim();
    const filtered = q ? rows.filter((r) => matchesSearch(r, q)) : rows;
    document.getElementById("il-count").textContent = q ? `${filtered.length} of ${rows.length} matching` : `${rows.length} shipments`;

    el.innerHTML = filtered.length === 0 ? "<p>No shipments.</p>" : `
      <table>
        <thead><tr><th>Reference</th><th>Status</th><th>ETA</th><th>Haulier</th><th>Tracking</th><th>Orders</th><th>Materials</th><th></th></tr></thead>
        <tbody>
          ${filtered.map((r) => {
            const b = bucketFor(r);
            return `<tr>
              <td>${esc(r.shipmentReference)}${r.isManual ? ' <span class="badge">Manual</span>' : ""}</td>
              <td><span class="badge">${esc(b.label)}</span></td>
              <td>${fmtDate(r.expectedEta)}</td>
              <td>${esc(r.haulier)}</td>
              <td>${esc(r.trackingNumber)}</td>
              <td>${esc(r.orderCount)}</td>
              <td>${esc(r.orderMaterials || r.manualMaterials)}</td>
              <td><button type="button" class="btn secondary" data-view="${r.shipmentId}">View</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
    el.querySelectorAll("button[data-view]").forEach((btn) => {
      btn.addEventListener("click", () => openDetail(Number(btn.dataset.view)));
    });
  }

  document.getElementById("il-search").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderList();
  });

  // ── Manual shipment creation ─────────────────────────────────────
  document.getElementById("il-manual-btn").addEventListener("click", () => {
    document.getElementById("il-manual-form-wrap").style.display = "";
  });
  document.getElementById("ilm-cancel").addEventListener("click", () => {
    document.getElementById("il-manual-form-wrap").style.display = "none";
  });

  async function loadForwarders() {
    try {
      const { data } = await refApi("/forwarders");
      forwarders = data || [];
      const sel = document.getElementById("ilm-forwarder");
      sel.innerHTML = '<option value="">—</option>' + forwarders.map((f) => `<option value="${f.forwarderId}">${esc(f.forwarderName)}</option>`).join("");
    } catch { /* reference data best-effort */ }
  }

  document.getElementById("il-manual-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originDestinationId: document.getElementById("ilm-origin").value ? Number(document.getElementById("ilm-origin").value) : null,
          forwarderId: document.getElementById("ilm-forwarder").value ? Number(document.getElementById("ilm-forwarder").value) : null,
          modeOfTransport: document.getElementById("ilm-mode").value || null,
          dispatchDate: document.getElementById("ilm-dispatch").value || null,
          expectedEta: document.getElementById("ilm-eta").value || null,
          trackingNumber: document.getElementById("ilm-tracking").value || null,
          notes: document.getElementById("ilm-notes").value || null,
          price: document.getElementById("ilm-price").value ? Number(document.getElementById("ilm-price").value) : null,
          costCentre: document.getElementById("ilm-costcentre").value || null,
          tier: document.getElementById("ilm-tier").value || null,
        }),
      });
      e.target.reset();
      document.getElementById("il-manual-form-wrap").style.display = "none";
      await loadList();
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  // ── Detail view ───────────────────────────────────────────────────
  async function openDetail(shipmentId) {
    const el = document.getElementById("il-detail");
    el.style.display = "";
    el.innerHTML = "Loading…";
    el.scrollIntoView({ behavior: "smooth" });
    try {
      const { data } = await api(`/${shipmentId}`);
      renderDetail(data);
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function renderDetail(s) {
    const el = document.getElementById("il-detail");
    el.innerHTML = `
      <div class="card">
        <h3>Shipment ${esc(s.shipmentReference)} ${s.isManual ? '<span class="badge">Manual</span>' : ""}</h3>
        <button type="button" class="btn" id="il-close">Close</button>

        <form id="il-edit-form" style="margin-top:0.75rem;">
          <label>Dispatch Date<input type="date" id="ile-dispatch" value="${s.dispatchDate ? s.dispatchDate.substring(0, 10) : ""}"></label>
          <label>Expected ETA<input type="date" id="ile-eta" value="${s.expectedEta ? s.expectedEta.substring(0, 10) : ""}"></label>
          <label>Haulier<input type="text" id="ile-haulier" value="${esc(s.haulier)}"></label>
          <label>Mode of Transport<input type="text" id="ile-mode" value="${esc(s.modeOfTransport)}"></label>
          <label>Tracking Number<input type="text" id="ile-tracking" value="${esc(s.trackingNumber)}"></label>
          <label>Bill of Lading<input type="text" id="ile-bol" value="${esc(s.billOfLading)}"></label>
          <label>Container Number<input type="text" id="ile-container" value="${esc(s.containerNumber)}"></label>
          <label>Notes<input type="text" id="ile-notes" value="${esc(s.notes)}"></label>
          <button type="submit" class="btn secondary">Save</button>
        </form>

        <div style="margin-top:0.75rem; display:flex; gap:0.5rem;">
          ${!s.receivedAtUtc && !s.cancelledAtUtc ? '<button type="button" class="btn secondary" id="il-receive">Mark Received</button>' : ""}
          ${s.receivedAtUtc ? '<button type="button" class="btn" id="il-undo-receive">Undo Received</button>' : ""}
          ${!s.receivedAtUtc && !s.cancelledAtUtc ? '<button type="button" class="btn" id="il-cancel">Cancel Shipment</button>' : ""}
        </div>
        <p style="margin-top:0.5rem;">
          ${s.receivedAtUtc ? `Received ${new Date(s.receivedAtUtc).toLocaleString("en-GB")} by ${esc(s.receivedBy)}` : ""}
          ${s.cancelledAtUtc ? `Cancelled ${new Date(s.cancelledAtUtc).toLocaleString("en-GB")} by ${esc(s.cancelledBy)}` : ""}
        </p>
      </div>

      <div class="card" style="margin-top:0.75rem;">
        <h4>Orders</h4>
        ${s.orders.length === 0 ? "<p>No linked orders.</p>" : `
          <table>
            <thead><tr><th>Material</th><th>Vendor</th><th>Order Qty</th><th>Received Qty</th><th>Status</th><th>PO</th><th>SAP Doc</th></tr></thead>
            <tbody>
              ${s.orders.map((o) => `
                <tr>
                  <td>${esc(o.material)} ${esc(o.materialText)}</td>
                  <td>${esc(o.vendorName)}</td>
                  <td>${esc(o.orderQty)} ${esc(o.uom)}</td>
                  <td>${o.receivedQty != null ? esc(o.receivedQty) : "—"}</td>
                  <td>${esc(o.status)}</td>
                  <td>${esc(o.poNumber)}</td>
                  <td>${o.sapMaterialDocument ? esc(o.sapMaterialDocument) : (o.sapGrError ? `<span style="color:#b00">${esc(o.sapGrError)}</span>` : "—")}</td>
                </tr>`).join("")}
            </tbody>
          </table>`}
      </div>

      ${s.isManual ? `
      <div class="card" style="margin-top:0.75rem;">
        <h4>Manual Items</h4>
        <div id="il-manual-items"></div>
        <form id="il-manual-item-form" style="margin-top:0.5rem;">
          <label>Material<input type="text" id="ilmi-material"></label>
          <label>Description<input type="text" id="ilmi-desc"></label>
          <label>Quantity<input type="number" step="0.01" id="ilmi-qty" required></label>
          <label>UoM<input type="text" id="ilmi-uom"></label>
          <button type="submit" class="btn secondary">Add Item</button>
        </form>
      </div>` : ""}

      <div class="card" style="margin-top:0.75rem;">
        <h4>Documents</h4>
        <div id="il-documents">Loading…</div>
        <form id="il-doc-upload" style="margin-top:0.5rem;">
          <input type="file" id="il-doc-file" required>
          <button type="submit" class="btn secondary">Upload</button>
        </form>
      </div>

      <div class="card" style="margin-top:0.75rem;">
        <h4>Associated Costs</h4>
        <div id="il-costs">Loading…</div>
        <form id="il-cost-form" style="margin-top:0.5rem;">
          <label>Cost Type
            <select id="ilc-type" required><option value="">—</option>${costTypes.map((t) => `<option value="${esc(t.typeDescription)}">${esc(t.typeDescription)}</option>`).join("")}</select>
          </label>
          <label>Tier<input type="text" id="ilc-tier"></label>
          <label>Amount<input type="number" step="0.01" id="ilc-amount" required></label>
          <label>Mode of Transport<input type="text" id="ilc-mode"></label>
          ${s.isManual ? '<label>Cost Centre<input type="text" id="ilc-costcentre"></label>' : ""}
          <label>Information<input type="text" id="ilc-info"></label>
          <button type="submit" class="btn secondary">Add Cost</button>
        </form>
      </div>`;

    document.getElementById("il-close").addEventListener("click", () => {
      el.style.display = "none";
      el.innerHTML = "";
    });

    document.getElementById("il-edit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api(`/${s.shipmentId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dispatchDate: document.getElementById("ile-dispatch").value || null,
            expectedEta: document.getElementById("ile-eta").value || null,
            haulier: document.getElementById("ile-haulier").value || null,
            forwarderId: s.forwarderId,
            modeOfTransport: document.getElementById("ile-mode").value || null,
            trackingNumber: document.getElementById("ile-tracking").value || null,
            billOfLading: document.getElementById("ile-bol").value || null,
            containerNumber: document.getElementById("ile-container").value || null,
            notes: document.getElementById("ile-notes").value || null,
          }),
        });
        await Promise.all([loadList(), openDetail(s.shipmentId)]);
      } catch (err) {
        alert("Error: " + err.message);
      }
    });

    const receiveBtn = document.getElementById("il-receive");
    if (receiveBtn) receiveBtn.addEventListener("click", async () => {
      if (!confirm("Mark this shipment received? This posts a real SAP goods receipt for each linked order unless skipped.")) return;
      const skipSap = confirm("Skip SAP posting for this receive? OK = skip SAP, Cancel = post to SAP normally.");
      try {
        const { data } = await api(`/${s.shipmentId}/receive`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ receivedAt: new Date().toISOString(), skipSap }),
        });
        const failed = (data.sapResults || []).filter((r) => !r.success);
        if (failed.length) alert(`Received with ${failed.length} SAP error(s):\n` + failed.map((f) => `${f.material}: ${f.error}`).join("\n"));
        await Promise.all([loadList(), openDetail(s.shipmentId)]);
      } catch (err) {
        alert("Error: " + err.message);
      }
    });

    const undoBtn = document.getElementById("il-undo-receive");
    if (undoBtn) undoBtn.addEventListener("click", async () => {
      if (!confirm("Undo Mark Received? This reverses the SAP goods receipt for each linked order unless skipped.")) return;
      const skipSap = confirm("Skip SAP reversal? OK = skip SAP, Cancel = reverse in SAP normally.");
      try {
        const { data } = await api(`/${s.shipmentId}/undo-receive`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skipSap }),
        });
        if (data.stillPostedCount > 0) alert(`${data.stillPostedCount} line(s) could not be reversed in SAP and remain posted — retry needed.`);
        await Promise.all([loadList(), openDetail(s.shipmentId)]);
      } catch (err) {
        alert("Error: " + err.message);
      }
    });

    const cancelBtn = document.getElementById("il-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", async () => {
      if (!confirm("Cancel this shipment? Linked orders are unlinked, not deleted.")) return;
      try {
        await api(`/${s.shipmentId}/cancel`, { method: "POST" });
        await Promise.all([loadList(), openDetail(s.shipmentId)]);
      } catch (err) {
        alert("Error: " + err.message);
      }
    });

    if (s.isManual) loadManualItems(s.shipmentId);
    loadDocuments(s.shipmentId);
    loadCosts(s.shipmentId);

    const itemForm = document.getElementById("il-manual-item-form");
    if (itemForm) itemForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api(`/${s.shipmentId}/manual-items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            material: document.getElementById("ilmi-material").value || null,
            description: document.getElementById("ilmi-desc").value || null,
            quantity: Number(document.getElementById("ilmi-qty").value),
            unitOfMeasure: document.getElementById("ilmi-uom").value || null,
          }),
        });
        e.target.reset();
        await loadManualItems(s.shipmentId);
      } catch (err) {
        alert("Error: " + err.message);
      }
    });

    document.getElementById("il-doc-upload").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById("il-doc-file");
      const file = fileInput.files[0];
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        await api(`/${s.shipmentId}/documents/upload?fileName=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: buf,
        });
        fileInput.value = "";
        await loadDocuments(s.shipmentId);
      } catch (err) {
        alert("Error: " + err.message);
      }
    });

    document.getElementById("il-cost-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await costApi("", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            poShipmentId: s.shipmentId,
            tier: document.getElementById("ilc-tier").value || null,
            amount: Number(document.getElementById("ilc-amount").value),
            costType: document.getElementById("ilc-type").value || null,
            information: document.getElementById("ilc-info").value || null,
            modeOfTransport: document.getElementById("ilc-mode").value || null,
            costCenter: s.isManual ? (document.getElementById("ilc-costcentre").value || null) : null,
          }),
        });
        e.target.reset();
        await loadCosts(s.shipmentId);
      } catch (err) {
        alert("Error: " + err.message);
      }
    });
  }

  async function loadManualItems(shipmentId) {
    const el = document.getElementById("il-manual-items");
    if (!el) return;
    try {
      const { data } = await api(`/${shipmentId}/manual-items`);
      const items = data || [];
      el.innerHTML = items.length === 0 ? "<p>No manual items.</p>" : `
        <table>
          <thead><tr><th>Material</th><th>Description</th><th>Qty</th><th>UoM</th><th></th></tr></thead>
          <tbody>
            ${items.map((i) => `
              <tr>
                <td>${esc(i.material)}</td><td>${esc(i.description)}</td><td>${esc(i.quantity)}</td><td>${esc(i.unitOfMeasure)}</td>
                <td><button type="button" class="btn secondary" data-remove-item="${i.itemId}">Remove</button></td>
              </tr>`).join("")}
          </tbody>
        </table>`;
      el.querySelectorAll("button[data-remove-item]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Remove this item?")) return;
          try {
            await itemApi(`/manual-items/${btn.dataset.removeItem}`, { method: "DELETE" });
          } catch (err) {
            alert("Error: " + err.message);
          }
          await loadManualItems(shipmentId);
        });
      });
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  }

  async function loadDocuments(shipmentId) {
    const el = document.getElementById("il-documents");
    try {
      const { data } = await api(`/${shipmentId}/documents/folder`);
      const files = data.files || [];
      el.innerHTML = files.length === 0 ? "<p>No documents.</p>" : `
        <ul>${files.map((f) => `<li><a href="${esc(f.downloadUrl)}" target="_blank" rel="noopener">${esc(f.fileName)}</a> (${Math.round(f.sizeBytes / 1024)} KB)</li>`).join("")}</ul>`;
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  }

  async function loadCosts(shipmentId) {
    const el = document.getElementById("il-costs");
    try {
      const { data } = await costApi(`/shipment/${shipmentId}`);
      const rows2 = data || [];
      el.innerHTML = rows2.length === 0 ? "<p>No cost lines.</p>" : `
        <table>
          <thead><tr><th>Element</th><th>Tier</th><th>Cost Centre</th><th>Type</th><th>Expected</th><th>Actual</th><th>Posted</th><th></th></tr></thead>
          <tbody>
            ${rows2.map((c) => `
              <tr>
                <td>${esc(c.costElement)} ${esc(c.elementDescription)}</td>
                <td>${esc(c.tier)}</td>
                <td>${esc(c.costCenter)}</td>
                <td>${esc(c.costType)}</td>
                <td>${esc(c.expectedCost)}</td>
                <td>${c.actualCost != null ? esc(c.actualCost) : "—"}</td>
                <td>${c.migoStatus ? "Yes" : "No"}</td>
                <td>${c.migoStatus ? "" : `<button type="button" class="btn secondary" data-remove-cost="${c.costId}">Delete</button>`}</td>
              </tr>`).join("")}
          </tbody>
        </table>`;
      el.querySelectorAll("button[data-remove-cost]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this cost line?")) return;
          try {
            await costApi(`/${btn.dataset.removeCost}`, { method: "DELETE" });
            await loadCosts(shipmentId);
          } catch (err) {
            alert("Error: " + err.message);
          }
        });
      });
    } catch (err) {
      el.textContent = "Error: " + err.message;
    }
  }

  async function loadCostTypes() {
    try {
      const { data } = await refApi("/costtypes");
      costTypes = data || [];
    } catch { /* best-effort */ }
  }

  loadForwarders();
  loadCostTypes();
  loadList();
})();
