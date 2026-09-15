// Pallet Builder — port of private/js/warehouse.js's openPalletBuilder/
// openPalletBuilderOnExisting/renderBuilderPhase1/renderBuilderPhase2/
// addPackage and friends. Opened from picked-pallets-modal.js's "+ Add
// Pallet"/"Continue" buttons as its own full-screen overlay (.pb-overlay),
// not nested inside NexusModal's card — matches Node's own separate
// top-level overlay design.
//
// Deliberately NOT built in this pass, flagged rather than silently
// dropped:
//   - Batch-scan-confirmation and pallet-finish-manifest LABEL PRINTING
//     (Node's routes/labels.js /pallet/scan/:id/print and /pallet/finish/:id/print).
//     Production's own label-printing subsystem (Sub-phase 6b) explicitly
//     scoped these two routes OUT as a Warehouse/Logistics concern, and
//     building them here would mean standing up a second, differently-keyed
//     copy of the LabelDataHelper/LabelHtmlHelper/LabelPdfHelper machinery —
//     real, separately-scoped follow-up work, not a small addition.
//   - The Bulk Edit modal (Node's openBulkEditModal — a checklist letting
//     several packages have their layer/packaging changed at once). The
//     right-click context menu below (Change Layer.../Change Packaging...)
//     covers the same underlying capability one package at a time, which is
//     the essential need; a bulk power-tool on top of it is deferred, same
//     "defer the bulk power-tool, ship the per-item action" precedent
//     Stock Investigations' own Card 2 already established for this exact
//     class of decision.
// Everything else — pallet-type selection, the required-materials/stock
// panel (SAP LIPS+LQUA via the already-built picksheet-materials endpoint),
// batch scan-and-stage (SAP transfer order), profit-centre-2007 container
// packing (SB/MB/LB outer box + C2 inner batches), custom dimensions for
// packaging types with no configured defaults, per-package layer/packaging
// correction, and Finish/Delete — is real, working, and wired to the same
// backend Node's own builder calls.
(function () {
  const esc = NexusApi.esc;
  const rootApi = NexusApi.make("/api");
  const dmApi = NexusApi.make("/api/deliverymain");
  const pmApi = NexusApi.make("/api/palletmain");
  const ppApi = NexusApi.make("/api/palletpackages");

  const CONTAINER_PACKAGING_IDS = ["SB", "MB", "LB"];
  const INNER_PACKAGING_ID = "C2";

  let pb = null; // active builder state

  function isContainerPackagingId(id) {
    return CONTAINER_PACKAGING_IDS.includes(id);
  }

  function materialUsesContainerPacking(material) {
    return !!pb?.requiredMaterials?.find((m) => m.material === material)?.usesContainerPacking;
  }

  // Packaging instruction (e.g. "IB_363660_MD") encodes the packaging type
  // it was built for as its last underscore-delimited segment — used to
  // auto-select the matching radio the moment a batch is scanned/matched.
  const PACKAGING_TYPE_SUFFIX_RE = /_([A-Za-z0-9]+)$/;
  function packagingInstructionType(packagingMaterial) {
    const match = String(packagingMaterial || "").match(PACKAGING_TYPE_SUFFIX_RE);
    return match ? match[1].toUpperCase() : null;
  }

  function applySuggestedPackaging(material, packagingMaterial) {
    if (!material || materialUsesContainerPacking(material)) return;
    const suggested = packagingInstructionType(packagingMaterial);
    if (!suggested) return;
    const radio = document.querySelector(`input[name="pb-pack"][value="${CSS.escape(suggested)}"]`);
    if (!radio || radio.checked) return;
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getOverlay() {
    let el = document.getElementById("pb-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "pb-overlay";
      el.className = "pb-overlay hidden";
      document.body.appendChild(el);
    }
    return el;
  }

  function close() {
    const overlay = document.getElementById("pb-overlay");
    if (overlay) overlay.classList.add("hidden");
    closePackageContextMenu();
    document.getElementById("pb-prompt-modal")?.remove();
    pb = null;
  }

  // ── Required Materials & Stock panel (left column, both phases) ────────
  function applyStockResult(result) {
    if (result && result.success !== false) {
      pb.requiredMaterials = result.data?.materials || [];
      if (result.data?.customerId != null) pb.customerId = result.data.customerId;
      pb.stockError = null;
    } else {
      pb.requiredMaterials = [];
      pb.stockError = result?.error || "Failed to load required materials from SAP.";
    }
  }

  function renderStockPanel() {
    if (pb.stockError) {
      return `<div class="pb-stock-panel" id="pb-stock-panel">
        <div class="pb-section-label">Required Materials &amp; Stock</div>
        <div class="pb-stock-error">✕ ${esc(pb.stockError)}</div>
      </div>`;
    }
    if (!pb.requiredMaterials || !pb.requiredMaterials.length) {
      return `<div class="pb-stock-panel" id="pb-stock-panel">
        <div class="pb-section-label">Required Materials &amp; Stock</div>
        <div class="pb-stock-empty">No SAP line items found for this delivery.</div>
      </div>`;
    }

    const showAddBtn = pb.phase === 2;
    const GROUP_LABELS = { unassigned: "unassigned", restricted: "restricted", wrongCustomer: "other customer" };

    const renderBatch = (m, b) => {
      const restrictedCls = b.allowed ? "" : " pb-stock-batch--restricted";
      const action = b.allowed
        ? (showAddBtn
            ? `<button type="button" class="pb-stock-add" title="Add this batch"
                 data-add-material="${esc(m.material)}" data-add-batch="${esc(b.batch)}"
                 data-add-delivery-item="${esc(m.deliveryItem || "")}" data-add-qty="${Number(b.totalQty || 0)}"
                 data-add-packaging-material="${esc(b.packagingMaterial || "")}">+</button>`
            : "")
        : `<span class="pb-stock-restricted-tag" title="${esc(b.reason || "Allocated elsewhere")}">${esc(GROUP_LABELS[b.group] || "restricted")}</span>`;
      return `<div class="pb-stock-batch${restrictedCls}">
        <span class="pb-stock-batch-no">${esc(b.batch || "—")}</span>
        <span class="pb-stock-batch-bin">${esc(b.storageType || "")} ${esc(b.bin || "")}</span>
        <span class="pb-stock-batch-qty">${Number(b.availableQty || 0).toFixed(0)}</span>
        ${action}
      </div>`;
    };

    const groups = pb.requiredMaterials.map((m) => {
      const batches = m.batches || [];
      const available = batches.filter((b) => b.group === "available");
      const unassigned = batches.filter((b) => b.group === "unassigned");
      const restricted = batches.filter((b) => b.group === "restricted");
      const wrongCustomer = batches.filter((b) => b.group === "wrongCustomer");

      const availableSection = available.length
        ? `<div class="pb-stock-batches">${available.map((b) => renderBatch(m, b)).join("")}</div>`
        : (batches.length ? `<div class="pb-stock-nobatch">No available stock (see groups below)</div>` : "");

      const collapsed = (list, label) => list.length
        ? `<details class="pb-stock-restricted-group">
             <summary class="pb-stock-restricted-summary">${list.length} ${esc(label)} batch${list.length !== 1 ? "es" : ""}</summary>
             <div class="pb-stock-batches">${list.map((b) => renderBatch(m, b)).join("")}</div>
           </details>`
        : "";

      const batchRows = batches.length
        ? `${availableSection}${collapsed(unassigned, "unassigned")}${collapsed(restricted, "restricted")}${collapsed(wrongCustomer, "other-customer")}`
        : `<div class="pb-stock-nobatch">No stock found</div>`;

      const remaining = Math.max(0, Number(m.requiredQty || 0));
      const isComplete = remaining <= 0;
      const materialHdr = `<div class="pb-stock-material-hdr">
          <span class="pb-stock-material-code">${esc(m.material)}</span>
          <span class="pb-stock-material-req${isComplete ? " pb-stock-material-req--done" : ""}">${isComplete ? "✓ done" : `req. ${remaining.toFixed(0)}`}</span>
        </div>`;

      return isComplete
        ? `<details class="pb-stock-material pb-stock-material--done"><summary>${materialHdr}</summary>${batchRows}</details>`
        : `<div class="pb-stock-material">${materialHdr}${batchRows}</div>`;
    }).join("");

    return `<div class="pb-stock-panel" id="pb-stock-panel">
      <div class="pb-section-label">Required Materials &amp; Stock</div>
      <div class="pb-stock-list">${groups}</div>
    </div>`;
  }

  function wireStockPanel() {
    document.querySelectorAll("[data-add-material]").forEach((btn) => {
      btn.addEventListener("click", () => {
        addPackageFromFoundBatch(
          btn.dataset.addMaterial, btn.dataset.addBatch, btn.dataset.addDeliveryItem,
          Number(btn.dataset.addQty), btn.dataset.addPackagingMaterial
        );
      });
    });
  }

  function refreshStockPanel() {
    const el = document.getElementById("pb-stock-panel");
    if (el) { el.outerHTML = renderStockPanel(); wireStockPanel(); }
  }

  // ── Open (create-new) / openOnExisting (continue) ───────────────────────
  function freshState(overrides) {
    return Object.assign({
      customerId: null, palletLocation: "", packagingWeight: 0,
      palletId: null, palletType: null, palletTypeData: null, allPalletTypes: [],
      allPackaging: [], allowedPackaging: [], packages: [], nextLayer: 1,
      requiredMaterials: [], stockError: null,
      pendingSapMaterial: null, pendingSapDeliveryItem: null, pendingSapQuantity: null, pendingPackagingInstruction: null,
      layerContainers: {}, picksheetComment: "",
    }, overrides);
  }

  // packagingdata rows carry the code as packId, not packagingId (see
  // WarehouseMasterDataModels.cs) — palletvalidation rows (pb.allowedPackaging)
  // DO carry packagingId. findPackagingType/eligiblePackagingOptions need a
  // uniform field across both arrays for the SB/MB/LB/C2 fallback lookup to
  // work when a pallet type's own PalletValidation rows don't include them.
  function normalizePackagingData(rows) {
    return (rows || []).map((p) => ({ ...p, packagingId: p.packId }));
  }

  async function open(deliveryId, destName, onChanged) {
    pb = freshState({ deliveryId, destName, onChanged, phase: 1 });

    const overlay = getOverlay();
    overlay.classList.remove("hidden");
    overlay.innerHTML = `
      <div class="pb-modal">
        <div class="pb-header">
          <div>
            <div class="pb-title">Build New Pallet</div>
            <div class="pb-sub">Delivery #${esc(String(deliveryId))} · ${esc(destName)}</div>
          </div>
          <button type="button" class="pb-close" id="pb-close-btn">✕</button>
        </div>
        <div class="pb-body" id="pb-body"><div class="sap-loading"><div class="spinner"></div>Loading pallet types…</div></div>
      </div>`;
    document.getElementById("pb-close-btn").addEventListener("click", close);

    try {
      const [ptRes, pkRes, stockRes, dmRow] = await Promise.all([
        rootApi("/palletdata"),
        rootApi("/packagingdata"),
        dmApi(`/${encodeURIComponent(deliveryId)}/picksheet-materials`).catch((err) => ({ success: false, error: err.message })),
        dmApi(`/id/${encodeURIComponent(deliveryId)}`).catch(() => ({ data: null })),
      ]);
      pb.allPalletTypes = ptRes.data || [];
      pb.allPackaging = normalizePackagingData(pkRes.data);
      applyStockResult(stockRes);
      pb.picksheetComment = dmRow?.data?.picksheetComment || "";
      renderPhase1();
    } catch (err) {
      document.getElementById("pb-body").innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
    }
  }

  async function openOnExisting(palletId, deliveryId, destName, onChanged) {
    pb = freshState({ deliveryId, destName, onChanged, phase: 2, palletId });

    const overlay = getOverlay();
    overlay.classList.remove("hidden");
    overlay.innerHTML = `
      <div class="pb-modal">
        <div class="pb-header">
          <div>
            <div class="pb-title">Continue Building &nbsp;<span style="font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--accent)">#${esc(String(palletId))}</span></div>
            <div class="pb-sub">Delivery #${esc(String(deliveryId))} · ${esc(destName)}</div>
          </div>
          <button type="button" class="pb-close" id="pb-close-btn">✕</button>
        </div>
        <div class="pb-body" id="pb-body"><div class="sap-loading"><div class="spinner"></div>Loading…</div></div>
      </div>`;
    document.getElementById("pb-close-btn").addEventListener("click", close);

    try {
      const palRes = await pmApi(`/id/${encodeURIComponent(palletId)}`);
      const palletRecord = (palRes.data || [])[0];
      const palletTypeId = palletRecord?.palletType;

      const [ptRes, pkRes, pkgsRes, valRes, stockRes, dmRow] = await Promise.all([
        rootApi("/palletdata"),
        rootApi("/packagingdata"),
        ppApi(`/pallet/${encodeURIComponent(palletId)}`),
        palletTypeId ? rootApi(`/palletvalidation/pallet/${encodeURIComponent(palletTypeId)}`) : Promise.resolve({ data: [] }),
        dmApi(`/${encodeURIComponent(deliveryId)}/picksheet-materials`).catch((err) => ({ success: false, error: err.message })),
        dmApi(`/id/${encodeURIComponent(deliveryId)}`).catch(() => ({ data: null })),
      ]);

      pb.allPalletTypes = ptRes.data || [];
      pb.allPackaging = normalizePackagingData(pkRes.data);
      applyStockResult(stockRes);
      pb.picksheetComment = dmRow?.data?.picksheetComment || "";

      if (palletRecord) {
        pb.palletType = palletRecord.palletType;
        pb.palletTypeData = pb.allPalletTypes.find((t) => t.palletId === pb.palletType);
        pb.palletLocation = palletRecord.palletLocation || "";
        pb.packagingWeight = Number(palletRecord.packagingWeight || 0);
      }

      const existing = pkgsRes.data || [];
      pb.packages = existing;
      pb.nextLayer = existing.length ? Math.max(...existing.map((p) => p.palletLayer || 0)) + 1 : 1;

      existing
        .filter((p) => isContainerPackagingId(p.packagingId) && !p.sapBatch)
        .forEach((p) => { pb.layerContainers[p.palletLayer] = p.packagingId; });

      pb.allowedPackaging = valRes.data || [];

      renderPhase2();
    } catch (err) {
      document.getElementById("pb-body").innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
    }
  }

  // ── Phase 1: create pallet ───────────────────────────────────────────────
  function renderPhase1() {
    const typeCards = pb.allPalletTypes.map((t) => {
      const dims = [t.palletLength, t.palletWidth, t.palletHeight].filter(Boolean).join("×");
      return `<div class="pb-type-card" data-type="${esc(t.palletId)}">
          <div class="pb-type-code">${esc(t.palletId)}</div>
          <div class="pb-type-desc">${esc(t.palletDescription || "—")}</div>
          ${dims ? `<div class="pb-type-dims">${esc(dims)} cm</div>` : ""}
          ${t.palletWeight != null ? `<div class="pb-type-wt">${esc(String(t.palletWeight))} kg</div>` : ""}
        </div>`;
    }).join("");

    document.getElementById("pb-body").innerHTML = `
      <div class="pb-merged">
        ${renderStockPanel()}
        <div class="pb-main">
          <div class="pb-phase1">
            <div class="pb-section-label">Select Pallet Type</div>
            <div class="pb-type-grid">${typeCards || '<div style="color:var(--text-muted);font-size:13px;padding:16px 0">No pallet types configured yet.</div>'}</div>
            <div class="pb-row" style="margin-top:8px">
              <div class="pb-field">
                <label class="pb-label">Location <span style="opacity:.5;font-weight:400">(optional — required before finishing)</span></label>
                <input class="pb-input" id="pb-location" type="text" maxlength="50" placeholder="e.g. WH-A1" autocomplete="off">
              </div>
            </div>
            <div class="pb-actions">
              <span id="pb-pkg-msg" class="pb-pkg-msg"></span>
              <button type="button" class="btn-secondary" id="pb-cancel-btn">Cancel</button>
              <button type="button" class="btn-submit" id="pb-create-btn" disabled>Create Pallet →</button>
            </div>
          </div>
        </div>
      </div>`;

    wireStockPanel();
    document.getElementById("pb-cancel-btn").addEventListener("click", close);
    document.getElementById("pb-create-btn").addEventListener("click", createPallet);
    document.querySelectorAll(".pb-type-card").forEach((card) => {
      card.addEventListener("click", () => selectPalletType(card.dataset.type));
    });
  }

  function selectPalletType(typeId) {
    pb.palletType = typeId;
    pb.palletTypeData = pb.allPalletTypes.find((t) => t.palletId === typeId);
    document.querySelectorAll(".pb-type-card").forEach((c) => c.classList.toggle("selected", c.dataset.type === typeId));
    document.getElementById("pb-create-btn").disabled = false;
  }

  // cm³ → m³, matching the convention this app already uses elsewhere
  // (e.g. shipmentmain.js's ManualCargoItem volume calc). 0 rather than NaN
  // when a dimension is missing.
  function calcVolumeFromDims(length, width, height) {
    const l = Number(length || 0), w = Number(width || 0), h = Number(height || 0);
    return (l && w && h) ? Number(((l * w * h) / 1000000).toFixed(3)) : 0;
  }

  async function createPallet() {
    if (!pb.palletType) return;
    const td = pb.palletTypeData;
    const location = document.getElementById("pb-location").value.trim();
    const btn = document.getElementById("pb-create-btn");
    btn.disabled = true;
    btn.textContent = "Creating…";

    try {
      const palRes = await pmApi("", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          palletType: pb.palletType,
          palletFinish: false,
          packagingWeight: Number(td?.palletWeight || 0),
          grossWeight: 0,
          palletVolume: calcVolumeFromDims(td?.palletLength, td?.palletWidth, td?.palletHeight),
          palletLength: td?.palletLength ?? null,
          palletWidth: td?.palletWidth ?? null,
          palletHeight: td?.palletHeight ?? null,
          palletRemoved: false,
          palletCategory: null,
          palletLocation: location || null,
          palletCreationDate: new Date().toISOString(),
          palletFinishDate: null,
        }),
      });
      pb.palletId = palRes.data.palletId;

      await dmApi(`/${encodeURIComponent(pb.deliveryId)}/pallets`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palletId: pb.palletId }),
      });

      const valRes = await rootApi(`/palletvalidation/pallet/${encodeURIComponent(pb.palletType)}`);
      pb.allowedPackaging = valRes.data || [];
      pb.palletLocation = location;
      pb.packagingWeight = Number(td?.palletWeight || 0);
      pb.packages = [];
      pb.nextLayer = 1;
      pb.phase = 2;

      renderPhase2();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Create Pallet →";
      showPbMsg("✕ " + err.message, "error");
    }
  }

  // ── Phase 2: add packages ────────────────────────────────────────────────
  function renderPackagingGroups() {
    if (!pb.allowedPackaging.length) return "";
    const groups = {};
    pb.allowedPackaging.forEach((p) => {
      const mat = p.packMaterial || "Other";
      (groups[mat] = groups[mat] || []).push(p);
    });
    return Object.entries(groups).map(([mat, pkgs]) => `
      <div class="pb-pkg-group">
        <div class="pb-pkg-group-label">${esc(mat)}</div>
        <div class="pb-pkg-opts-row">
          ${pkgs.map((p) => `
            <label class="pb-pkg-opt">
              <input type="radio" name="pb-pack" value="${esc(p.packagingId)}">
              <span class="pb-pkg-opt-inner">
                <strong>${esc(p.packagingId)}</strong>
                <span>${esc(p.packDescription || "")}</span>
                ${p.packWeight != null ? `<span>${esc(String(p.packWeight))} kg</span>` : ""}
              </span>
            </label>`).join("")}
        </div>
      </div>`).join("");
  }

  function renderRunningList() {
    if (!pb.packages.length) return `<div class="pb-running-empty">No packages added yet</div>`;
    return pb.packages.map((p) => {
      const isContainer = isContainerPackagingId(p.packagingId) && !p.sapBatch;
      return `
      <div class="pb-running-item${isContainer ? " pb-running-item--container" : ""}" data-item="${p.palletItemId}" title="Right-click to edit">
        <span class="pb-running-layer">Layer ${esc(String(p.palletLayer))}</span>
        <span class="pb-running-pack">${esc(p.packagingId || "")}</span>
        ${isContainer ? `<span class="pb-running-container-tag">outer box</span>` : (p.sapBatch ? `<span class="pb-running-batch">${esc(p.sapBatch)}</span>` : "")}
        <button type="button" class="pb-running-remove" title="Remove this package" data-remove-item="${p.palletItemId}">✕</button>
      </div>`;
    }).join("");
  }

  function wireRunningListEvents() {
    document.querySelectorAll("#pb-running-list [data-remove-item]").forEach((btn) => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); removeBuilderPackage(parseInt(btn.dataset.removeItem, 10)); });
    });
    document.querySelectorAll("#pb-running-list [data-item]").forEach((row) => {
      row.addEventListener("contextmenu", (e) => { e.preventDefault(); showPackageContextMenu(e, parseInt(row.dataset.item, 10)); });
    });
  }

  function renderPhase2() {
    const td = pb.palletTypeData;
    const label = td ? `${td.palletId} · ${td.palletDescription || ""}` : `Pallet #${pb.palletId}`;
    const hasPackaging = pb.allowedPackaging.length > 0;
    const locRequired = !pb.palletLocation;

    document.getElementById("pb-body").innerHTML = `
      <div class="pb-merged">
        ${renderStockPanel()}
        <div class="pb-main">
      <div class="pb-phase2">

        <div class="pb-running">
          <div class="pb-running-title">${esc(label)}</div>
          ${td ? `<div class="pb-running-dims">${esc([td.palletLength, td.palletWidth, td.palletHeight].filter(Boolean).join("×"))} cm · ${esc(String(td.palletHeight ?? 0))} cm base</div>` : ""}
          <div class="pb-running-loc">
            <label class="pb-label" style="margin-bottom:4px">Location${locRequired ? ' <span style="color:var(--error)">*</span>' : ""}</label>
            <input class="pb-input${locRequired ? " pb-input--req" : ""}" id="pb-loc-running" type="text" maxlength="50" value="${esc(pb.palletLocation)}" placeholder="Required to finish">
          </div>
          <div class="pb-running-loc" style="margin-top:8px">
            <label class="pb-label" style="margin-bottom:4px">Gross Weight (kg) <span style="color:var(--error)">*</span></label>
            <input class="pb-input" id="pb-gross-weight" type="number" step="0.01" min="0.01" placeholder="Enter at finish">
          </div>
          <div class="pb-running-loc" style="margin-top:8px">
            <label class="pb-label" style="margin-bottom:4px">Job Comment</label>
            <input class="pb-input" id="pb-comment" type="text" maxlength="50" value="${esc(pb.picksheetComment || "")}" placeholder="Shown on Create Shipment">
          </div>
          <div class="pb-running-weights">
            <span>Pkg weight</span>
            <span id="pb-pkg-weight-display">${esc(Number(pb.packagingWeight).toFixed(2))} kg</span>
          </div>
          <div class="pb-running-count" id="pb-pkg-count">${pb.packages.length} package${pb.packages.length !== 1 ? "s" : ""}</div>
          <div class="pb-running-list" id="pb-running-list">${renderRunningList()}</div>
          <div class="pb-running-actions">
            <button type="button" class="btn-danger pb-delete-btn" id="pb-delete-btn">Delete</button>
            <button type="button" class="btn-submit pb-finish-btn" id="pb-finish-btn">Finish Pallet ✓</button>
          </div>
        </div>

        ${hasPackaging ? `
        <div class="pb-form">
          <div class="pb-section-label">Packaging Type</div>
          <div class="pb-pkg-groups">${renderPackagingGroups()}</div>

          <div id="pb-custom-dims" style="display:none;margin-top:10px;padding:10px 12px;border-radius:8px;background:rgba(217,119,6,0.06);border:1px solid rgba(217,119,6,0.25)">
            <div class="pb-section-label" style="color:#D97706;margin-bottom:8px">Custom Dimensions (cm) — this box has no defaults</div>
            <div class="pb-sap-grid">
              <div class="pb-field pb-field--short"><label class="pb-label">Length</label><input class="pb-input" id="pb-dim-l" type="number" step="1" min="1" placeholder="cm"></div>
              <div class="pb-field pb-field--short"><label class="pb-label">Width</label><input class="pb-input" id="pb-dim-w" type="number" step="1" min="1" placeholder="cm"></div>
              <div class="pb-field pb-field--short"><label class="pb-label">Height <span style="color:var(--error)">*</span></label><input class="pb-input pb-input--req" id="pb-dim-h" type="number" step="1" min="1" placeholder="cm — required"></div>
            </div>
          </div>

          <div class="pb-row" style="margin-top:12px">
            <div class="pb-field pb-field--short"><label class="pb-label">Pallet Layer</label><input class="pb-input" id="pb-layer" type="number" min="1" step="1" value="${pb.nextLayer}"></div>
          </div>
          <div class="pb-row" style="margin-top:8px">
            <div class="pb-field"><label class="pb-label">Batch Number <span class="pb-scan-hint">scan / type</span></label>
              <input class="pb-input pb-scan" id="pb-batch" type="text" maxlength="10" placeholder="Batch number" autocomplete="off" autocorrect="off" spellcheck="false"></div>
          </div>
          <div class="pb-form-actions">
            <span id="pb-pkg-msg" class="pb-pkg-msg"></span>
            <button type="button" class="btn-submit" id="pb-add-btn">+ Add Package</button>
          </div>
        </div>
        ` : `
        <div class="pb-no-pkg-panel">
          <div class="pb-no-pkg-msg">
            <div style="font-size:22px;margin-bottom:8px;opacity:.3">📦</div>
            <div style="font-weight:700;margin-bottom:4px">No packaging required</div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:20px">This pallet type does not carry packaged items.</div>
            <div class="pb-section-label" style="text-align:left">Scan Batch Numbers</div>
            <div class="pb-row" style="margin-top:8px">
              <div class="pb-field pb-field--short"><label class="pb-label">Layer</label><input class="pb-input" id="pb-layer" type="number" min="1" step="1" value="${pb.nextLayer}"></div>
            </div>
            <div class="pb-row" style="margin-top:8px">
              <div class="pb-field"><label class="pb-label">Batch Number <span class="pb-scan-hint">scan / type</span></label>
                <input class="pb-input pb-scan" id="pb-batch" type="text" maxlength="10" placeholder="Batch number" autocomplete="off" autocorrect="off" spellcheck="false"></div>
            </div>
            <div class="pb-form-actions" style="margin-top:12px">
              <span id="pb-pkg-msg" class="pb-pkg-msg"></span>
              <button type="button" class="btn-submit" id="pb-add-btn">+ Add Batch</button>
            </div>
          </div>
        </div>`}

      </div>
        </div>
      </div>`;

    wireStockPanel();
    wireRunningListEvents();
    document.getElementById("pb-delete-btn").addEventListener("click", deletePalletFromBuilder);
    document.getElementById("pb-finish-btn").addEventListener("click", finishBuilderPallet);
    document.getElementById("pb-add-btn").addEventListener("click", addPackage);
    wireBatchScanInput();

    if (hasPackaging) {
      document.querySelectorAll('input[name="pb-pack"]').forEach((radio) => {
        radio.addEventListener("change", () => {
          const pkg = pb.allowedPackaging.find((p) => p.packagingId === radio.value);
          const needsDims = pkg && (pkg.packHeight == null || pkg.packLength == null || pkg.packWidth == null);
          const dimsEl = document.getElementById("pb-custom-dims");
          if (dimsEl) {
            dimsEl.style.display = needsDims ? "" : "none";
            if (needsDims) {
              ["pb-dim-l", "pb-dim-w", "pb-dim-h"].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ""; });
              document.getElementById("pb-dim-l")?.focus();
            }
          }
        });
      });
      document.getElementById("pb-batch").focus();
    }
  }

  function wireBatchScanInput() {
    const input = document.getElementById("pb-batch");
    if (!input) return;

    input.addEventListener("input", () => {
      const val = input.value.trim().toUpperCase();
      let match = null;
      for (const m of pb.requiredMaterials || []) {
        const hit = (m.batches || []).find((b) => b.allowed && (b.batch || "").toUpperCase() === val);
        if (hit) { match = { material: m.material, deliveryItem: m.deliveryItem, qty: hit.totalQty, packagingMaterial: hit.packagingMaterial }; break; }
      }
      pb.pendingSapMaterial = match?.material || null;
      pb.pendingSapDeliveryItem = match?.deliveryItem || null;
      pb.pendingSapQuantity = match?.qty || null;
      pb.pendingPackagingInstruction = match?.packagingMaterial || null;
      if (match) applySuggestedPackaging(match.material, match.packagingMaterial);
    });

    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addPackage(); } });
  }

  function addPackageFromFoundBatch(material, batch, deliveryItem, qty, packagingMaterial) {
    const batchInput = document.getElementById("pb-batch");
    if (!batchInput) return;
    batchInput.value = batch;
    pb.pendingSapMaterial = material;
    pb.pendingSapDeliveryItem = deliveryItem || null;
    pb.pendingSapQuantity = qty || null;
    pb.pendingPackagingInstruction = packagingMaterial || null;
    applySuggestedPackaging(material, packagingMaterial);
    addPackage();
  }

  function calcPalletHeight() {
    const baseH = Number(pb.palletTypeData?.palletHeight || 0);
    const layerMax = {};
    for (const p of pb.packages) {
      const layer = p.palletLayer || 1;
      const h = Number(p.packHeight || 0);
      if (h > (layerMax[layer] || 0)) layerMax[layer] = h;
    }
    return baseH + Object.values(layerMax).reduce((s, h) => s + h, 0);
  }

  function calcPalletVolume(height) {
    return calcVolumeFromDims(pb.palletTypeData?.palletLength, pb.palletTypeData?.palletWidth, height ?? calcPalletHeight());
  }

  function findPackagingType(packagingId) {
    if (!packagingId) return null;
    return pb.allowedPackaging.find((p) => p.packagingId === packagingId)
      || pb.allPackaging.find((p) => p.packagingId === packagingId)
      || null;
  }

  function showPbMsg(text, type) {
    const el = document.getElementById("pb-pkg-msg");
    if (!el) return;
    el.textContent = text;
    el.className = `pb-pkg-msg${type ? " pb-pkg-msg--" + type : ""}`;
    if (type === "ok") setTimeout(() => { if (el) el.textContent = ""; }, 3000);
  }

  async function addPackage() {
    const packInput = document.querySelector('input[name="pb-pack"]:checked');
    const packType = packInput?.value || null;
    const hasPackaging = pb.allowedPackaging.length > 0;

    const layer = parseInt(document.getElementById("pb-layer").value, 10) || pb.nextLayer;
    const batch = document.getElementById("pb-batch").value.trim();

    if (batch && pb.packages.some((p) => (p.sapBatch || "").toUpperCase() === batch.toUpperCase())) {
      showPbMsg(`Batch ${batch} has already been added to this pallet`, "error");
      return;
    }

    if (pb.pendingSapMaterial && batch) {
      const reqMat = pb.requiredMaterials.find((m) => m.material === pb.pendingSapMaterial);
      const pendingQty = Number(pb.pendingSapQuantity || 0);
      const stillNeeded = Number(reqMat?.requiredQty || 0);
      if (reqMat && pendingQty > stillNeeded) {
        const proceed = await NexusModal.confirm(
          `Batch ${batch} (${pendingQty} units) is more than the ${stillNeeded} unit${stillNeeded === 1 ? "" : "s"} still needed for ${reqMat.material}.\n\nIf the order quantity has changed, update it in VL02N before continuing. Otherwise, adding this batch will take the requirement below zero.`,
          { title: "Quantity exceeds requirement", confirmLabel: "Add Anyway", danger: true }
        );
        if (!proceed) { showPbMsg("Add cancelled", ""); return; }
      }
    }

    const isContainerMaterial = !!pb.pendingSapMaterial && materialUsesContainerPacking(pb.pendingSapMaterial);
    const existingContainer = pb.layerContainers[layer] || null;
    const needsContainer = isContainerMaterial && !existingContainer;

    if (needsContainer && !isContainerPackagingId(packType)) {
      showPbMsg(`Select the outer box size (${CONTAINER_PACKAGING_IDS.join("/")}) for this layer first`, "error");
      return;
    }
    if (!isContainerMaterial && hasPackaging && !packType) {
      showPbMsg("Select a packaging type first", "error");
      return;
    }

    const chosenContainerType = needsContainer ? packType : existingContainer;
    const effectivePackagingId = isContainerMaterial ? INNER_PACKAGING_ID : packType;
    const selectedPkg = findPackagingType(effectivePackagingId);
    if (isContainerMaterial && !selectedPkg) {
      showPbMsg(`Packaging type "${INNER_PACKAGING_ID}" is not configured — cannot add this batch`, "error");
      return;
    }
    const packWeight = Number(selectedPkg?.packWeight || 0);

    const dimsEl = document.getElementById("pb-custom-dims");
    const usingCustom = !isContainerMaterial && dimsEl && dimsEl.style.display !== "none";
    let packHeight = Number(selectedPkg?.packHeight || 0);
    if (usingCustom) {
      const enteredH = parseFloat(document.getElementById("pb-dim-h")?.value) || 0;
      if (!enteredH) {
        document.getElementById("pb-dim-h")?.classList.add("pb-input--error");
        document.getElementById("pb-dim-h")?.focus();
        showPbMsg("Enter the box height (required for height calculation)", "error");
        return;
      }
      packHeight = enteredH;
    }

    showPbMsg("Adding…", "");

    let stagedQuantity = null;
    let transferOrderNumber = null;
    let binWasCreated = false;
    let sourceStorageType = null;
    let sourceBin = null;

    try {
      // First batch of a PC2007 material added to a layer — create the
      // outer box for that layer before anything else. No material/batch/
      // quantity on this row; it represents the box itself, never staged in
      // SAP, counted once per layer (not once per batch).
      if (needsContainer) {
        const containerPkg = findPackagingType(chosenContainerType);
        if (!containerPkg) throw new Error(`Packaging type "${chosenContainerType}" is not configured — cannot create the outer box`);
        showPbMsg(`Creating ${chosenContainerType} box for layer ${layer}…`, "");
        const boxRes = await ppApi("", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            palletId: pb.palletId, packagingId: chosenContainerType, palletLayer: layer,
            sapDelivery: String(pb.deliveryId), sapCustomer: pb.customerId ? String(pb.customerId) : null,
            scanTime: new Date().toISOString(),
          }),
        });
        pb.packages.push({
          palletItemId: boxRes.data.palletItemId, palletLayer: layer, packagingId: chosenContainerType,
          sapBatch: null, sapMaterial: null, originalBatchEntry: null,
          packHeight: Number(containerPkg.packHeight || 0), packWeight: Number(containerPkg.packWeight || 0),
        });
        pb.packagingWeight = (pb.packagingWeight || 0) + Number(containerPkg.packWeight || 0);
        pb.layerContainers[layer] = chosenContainerType;
      }

      // Stage the batch in SAP first — moves its full on-hand quantity into
      // this picksheet's bin. Fails closed: only reaches the app's own
      // POST /api/palletpackages below once SAP staging actually succeeded.
      if (pb.pendingSapMaterial && batch) {
        showPbMsg("Staging in SAP…", "");
        const stageRes = await dmApi(`/${encodeURIComponent(pb.deliveryId)}/stage-batch`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ material: pb.pendingSapMaterial, batch }),
        });
        stagedQuantity = stageRes.data?.quantityMoved ?? null;
        transferOrderNumber = stageRes.data?.transferOrderNumber ?? null;
        binWasCreated = !!stageRes.data?.binWasCreated;
        sourceStorageType = stageRes.data?.sourceType || null;
        sourceBin = stageRes.data?.sourceBin || null;
        showPbMsg("Adding…", "");
      }

      const res = await ppApi("", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          palletId: pb.palletId, packagingId: effectivePackagingId || null, palletLayer: layer,
          sapBatch: batch || null, sapDelivery: String(pb.deliveryId), sapCustomer: pb.customerId ? String(pb.customerId) : null,
          sapMaterial: pb.pendingSapMaterial || null, sapDeliveryItem: pb.pendingSapDeliveryItem || null,
          sapQuantity: stagedQuantity, sapSourceStorageType: sourceStorageType, sapSourceBin: sourceBin,
          sapStageTransferOrder: transferOrderNumber,
          sapPackagingInstruction: pb.pendingSapMaterial ? (pb.pendingPackagingInstruction || null) : null,
          scanTime: new Date().toISOString(),
        }),
      });

      // Remove the just-added batch from the "available batches" list —
      // staging moves its full on-hand quantity, so nothing of it is left to
      // offer. Kept on the package record (originalBatchEntry) so
      // removeBuilderPackage() can put it straight back if undone.
      let removedBatchEntry = null;
      let movedQty = 0;
      if (pb.pendingSapMaterial && batch) {
        const mat = pb.requiredMaterials.find((m) => m.material === pb.pendingSapMaterial);
        if (mat) {
          const idx = (mat.batches || []).findIndex((b) => (b.batch || "") === batch);
          if (idx !== -1) { removedBatchEntry = mat.batches[idx]; mat.batches.splice(idx, 1); }
          movedQty = Number(stagedQuantity ?? removedBatchEntry?.totalQty ?? pb.pendingSapQuantity ?? 0);
          mat.requiredQty = Math.max(0, Number(mat.requiredQty || 0) - movedQty);
        }
      }

      pb.packages.push({
        palletItemId: res.data.palletItemId, palletLayer: layer, packagingId: effectivePackagingId,
        sapBatch: batch, sapMaterial: pb.pendingSapMaterial || null, sapQuantity: movedQty || null,
        originalBatchEntry: removedBatchEntry, packHeight, packWeight,
      });

      // PC2007 container layers keep collecting batches into the SAME layer
      // until the operator explicitly re-types the layer number; every
      // other material auto-increments one layer per batch as before.
      pb.nextLayer = isContainerMaterial ? layer : layer + 1;
      pb.packagingWeight = (pb.packagingWeight || 0) + packWeight;

      refreshStockPanel();

      fetch(`/api/palletmain/${pb.palletId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packagingWeight: pb.packagingWeight }),
      }).catch(() => {});

      document.getElementById("pb-running-list").innerHTML = renderRunningList();
      wireRunningListEvents();
      document.getElementById("pb-pkg-count").textContent = `${pb.packages.length} package${pb.packages.length !== 1 ? "s" : ""}`;
      const wtEl = document.getElementById("pb-pkg-weight-display");
      if (wtEl) wtEl.textContent = `${Number(pb.packagingWeight).toFixed(2)} kg`;

      document.getElementById("pb-batch").value = "";
      document.getElementById("pb-layer").value = pb.nextLayer;
      pb.pendingSapMaterial = null; pb.pendingSapDeliveryItem = null; pb.pendingSapQuantity = null; pb.pendingPackagingInstruction = null;
      if (usingCustom) {
        ["pb-dim-l", "pb-dim-w", "pb-dim-h"].forEach((id) => { const el = document.getElementById(id); if (el) { el.value = ""; el.classList.remove("pb-input--error"); } });
      }

      const toNote = transferOrderNumber ? ` · TO ${transferOrderNumber}${binWasCreated ? " (bin created)" : ""}` : "";
      const containerNote = needsContainer ? ` · ${chosenContainerType} box created` : "";
      showPbMsg(`✓ Added (layer ${layer}, ${effectivePackagingId || "no packaging"})${containerNote}${toNote}`, "ok");
      document.getElementById("pb-batch")?.focus();
    } catch (err) {
      showPbMsg("✕ " + err.message, "error");
    }
  }

  // If this package was staged in SAP, deleting it also reverses the
  // picksheet-stage-batch transfer order server-side — fails closed, so a
  // package still stuck in SAP stays visible rather than silently vanishing.
  async function removeBuilderPackage(palletItemId) {
    const idx = pb.packages.findIndex((p) => p.palletItemId === palletItemId);
    if (idx === -1) return;
    const pkg = pb.packages[idx];

    const isContainerRow = isContainerPackagingId(pkg.packagingId) && !pkg.sapBatch;
    if (isContainerRow) {
      const stillHasBatches = pb.packages.some((p) => p !== pkg && p.palletLayer === pkg.palletLayer);
      if (stillHasBatches) {
        showPbMsg(`Remove layer ${pkg.palletLayer}'s batches before removing its outer box`, "error");
        return;
      }
    }

    if (!await NexusModal.confirm("Remove this package from the pallet?\nIf it was staged in SAP, the stock will be moved back to its original location.", { title: "Remove Package", confirmLabel: "Remove", danger: true })) return;

    try {
      await ppApi(`/${palletItemId}`, { method: "DELETE" });

      pb.packages.splice(idx, 1);
      pb.packagingWeight = Math.max(0, (pb.packagingWeight || 0) - (pkg.packWeight || 0));
      if (isContainerRow) delete pb.layerContainers[pkg.palletLayer];

      if (pkg.sapMaterial) {
        const mat = pb.requiredMaterials.find((m) => m.material === pkg.sapMaterial);
        if (mat) {
          if (pkg.originalBatchEntry) {
            mat.batches = (mat.batches || []).filter((b) => (b.batch || "") !== pkg.originalBatchEntry.batch);
            mat.batches.push(pkg.originalBatchEntry);
          }
          const movedQty = Number(pkg.sapQuantity ?? pkg.originalBatchEntry?.totalQty ?? 0);
          mat.requiredQty = Number(mat.requiredQty || 0) + movedQty;
        }
        refreshStockPanel();
      }

      document.getElementById("pb-running-list").innerHTML = renderRunningList();
      wireRunningListEvents();
      document.getElementById("pb-pkg-count").textContent = `${pb.packages.length} package${pb.packages.length !== 1 ? "s" : ""}`;
      const wtEl = document.getElementById("pb-pkg-weight-display");
      if (wtEl) wtEl.textContent = `${Number(pb.packagingWeight).toFixed(2)} kg`;

      fetch(`/api/palletmain/${pb.palletId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packagingWeight: pb.packagingWeight }),
      }).catch(() => {});

      showPbMsg("✓ Package removed", "ok");
    } catch (err) {
      showPbMsg("✕ " + err.message, "error");
    }
  }

  // ── Per-package layer/packaging correction (right-click context menu) ──
  function isPackagingFixed(pkg) {
    return pkg.packagingId === INNER_PACKAGING_ID && !!pkg.sapBatch && !!pb.layerContainers[pkg.palletLayer];
  }

  function eligiblePackagingOptions(pkg) {
    const isContainerRow = isContainerPackagingId(pkg.packagingId) && !pkg.sapBatch;
    const source = pb.allowedPackaging.length ? pb.allowedPackaging : pb.allPackaging;
    return isContainerRow
      ? source.filter((p) => CONTAINER_PACKAGING_IDS.includes(p.packagingId))
      : source.filter((p) => !CONTAINER_PACKAGING_IDS.includes(p.packagingId));
  }

  async function applyPackageLayerChange(palletItemId, newLayer) {
    const pkg = pb.packages.find((p) => p.palletItemId === palletItemId);
    if (!pkg) return { success: false, error: "Package not found" };
    const oldLayer = pkg.palletLayer;

    if (!Number.isInteger(newLayer) || newLayer < 1) return { success: false, error: "Layer must be a positive whole number" };
    if (newLayer === oldLayer) return { success: true, error: null };

    const isContainerRow = isContainerPackagingId(pkg.packagingId) && !pkg.sapBatch;
    const isC2Row = pkg.packagingId === INNER_PACKAGING_ID && !!pkg.sapBatch;

    if (isContainerRow) {
      const stillHasBatches = pb.packages.some((p) => p !== pkg && p.palletLayer === oldLayer);
      if (stillHasBatches) return { success: false, error: `Move or remove layer ${oldLayer}'s batches before moving its outer box` };
      if (pb.layerContainers[newLayer] && pb.layerContainers[newLayer] !== pkg.packagingId) return { success: false, error: `Layer ${newLayer} already has an outer box` };
    } else if (isC2Row && !pb.layerContainers[newLayer]) {
      return { success: false, error: `Layer ${newLayer} has no outer box yet — add one first` };
    }

    try {
      await ppApi(`/${palletItemId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ palletLayer: newLayer }) });
      pkg.palletLayer = newLayer;
      if (isContainerRow) { delete pb.layerContainers[oldLayer]; pb.layerContainers[newLayer] = pkg.packagingId; }
      document.getElementById("pb-running-list").innerHTML = renderRunningList();
      wireRunningListEvents();
      return { success: true, error: null };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function applyPackagePackagingChange(palletItemId, newPackagingId) {
    const pkg = pb.packages.find((p) => p.palletItemId === palletItemId);
    if (!pkg) return { success: false, error: "Package not found" };
    if (!newPackagingId) return { success: false, error: "Select a packaging type" };
    if (newPackagingId === pkg.packagingId) return { success: true, error: null };

    if (isPackagingFixed(pkg)) return { success: false, error: "This batch is packed inside a PC2007 outer box — packaging is fixed to C2" };
    const isContainerRow = isContainerPackagingId(pkg.packagingId) && !pkg.sapBatch;
    if (isContainerRow && !isContainerPackagingId(newPackagingId)) return { success: false, error: `Outer box can only change between ${CONTAINER_PACKAGING_IDS.join("/")}` };

    const newPkg = findPackagingType(newPackagingId);
    if (!newPkg) return { success: false, error: `Packaging type "${newPackagingId}" is not configured` };

    try {
      await ppApi(`/${palletItemId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packagingId: newPackagingId }) });
      pb.packagingWeight = Math.max(0, (pb.packagingWeight || 0) - (pkg.packWeight || 0) + Number(newPkg.packWeight || 0));
      pkg.packagingId = newPackagingId;
      pkg.packWeight = Number(newPkg.packWeight || 0);
      pkg.packHeight = Number(newPkg.packHeight || 0);
      if (isContainerRow) pb.layerContainers[pkg.palletLayer] = newPackagingId;

      document.getElementById("pb-running-list").innerHTML = renderRunningList();
      wireRunningListEvents();
      const wtEl = document.getElementById("pb-pkg-weight-display");
      if (wtEl) wtEl.textContent = `${Number(pb.packagingWeight).toFixed(2)} kg`;
      return { success: true, error: null };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function closePackageContextMenu() {
    document.getElementById("pb-pkg-ctx-menu")?.remove();
    document.removeEventListener("click", closePackageContextMenu);
  }

  function showPackageContextMenu(event, palletItemId) {
    closePackageContextMenu();
    const pkg = pb.packages.find((p) => p.palletItemId === palletItemId);
    if (!pkg) return;
    const canChangePackaging = !isPackagingFixed(pkg);

    const menu = document.createElement("div");
    menu.id = "pb-pkg-ctx-menu";
    menu.className = "pb-ctx-menu";
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - 210)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - 90)}px`;
    menu.innerHTML = `
      <div class="pb-ctx-item" data-action="layer">Change Layer…</div>
      ${canChangePackaging ? `<div class="pb-ctx-item" data-action="pack">Change Packaging…</div>` : ""}`;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("click", closePackageContextMenu), 0);

    menu.querySelector('[data-action="layer"]').addEventListener("click", async () => {
      closePackageContextMenu();
      const val = await promptValue({ title: "Change Layer", label: "New layer number", type: "number", initialValue: pkg.palletLayer });
      if (val == null || val === "") return;
      const r = await applyPackageLayerChange(palletItemId, parseInt(val, 10));
      showPbMsg(r.success ? `✓ Moved to layer ${val}` : "✕ " + r.error, r.success ? "ok" : "error");
    });

    const packBtn = menu.querySelector('[data-action="pack"]');
    if (packBtn) {
      packBtn.addEventListener("click", async () => {
        closePackageContextMenu();
        const options = eligiblePackagingOptions(pkg).map((p) => ({ value: p.packagingId, label: `${p.packagingId} — ${p.packDescription || ""}` }));
        const val = await promptValue({ title: "Change Packaging", label: "New packaging type", options, initialValue: pkg.packagingId });
        if (val == null) return;
        const r = await applyPackagePackagingChange(palletItemId, val);
        showPbMsg(r.success ? `✓ Packaging changed to ${val}` : "✕ " + r.error, r.success ? "ok" : "error");
      });
    }
  }

  // Small, self-contained text/select prompt built on the app's shared
  // .wc-overlay/.wc-modal shell (site.css — already used by
  // picked-pallets-modal.js's own link-search dialog) — NexusModal itself
  // only offers open/close/confirm/alert, no general-purpose prompt.
  function promptValue({ title, label, type = "text", initialValue = "", options = null }) {
    return new Promise((resolve) => {
      document.getElementById("pb-prompt-modal")?.remove();
      const overlay = document.createElement("div");
      overlay.id = "pb-prompt-modal";
      overlay.className = "wc-overlay";
      const fieldHtml = options
        ? `<select class="pb-input" id="pb-prompt-input" style="width:100%">${options.map((o) => `<option value="${esc(o.value)}"${o.value === initialValue ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`
        : `<input class="pb-input" id="pb-prompt-input" type="${esc(type)}" value="${esc(String(initialValue ?? ""))}" style="width:100%">`;
      overlay.innerHTML = `
        <div class="wc-modal">
          <div class="wc-title">${esc(title)}</div>
          <div class="wc-message" style="text-align:left">
            <label class="pb-label" style="margin-bottom:6px;display:block">${esc(label)}</label>
            ${fieldHtml}
          </div>
          <div class="wc-actions">
            <button type="button" class="wc-btn-cancel" id="pb-prompt-cancel">Cancel</button>
            <button type="button" class="wc-btn-confirm" id="pb-prompt-ok">OK</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector("#pb-prompt-input");
      input.focus();
      if (input.select) input.select();

      const finish = (value) => { overlay.remove(); resolve(value); };
      overlay.querySelector("#pb-prompt-cancel").addEventListener("click", () => finish(null));
      overlay.querySelector("#pb-prompt-ok").addEventListener("click", () => finish(input.value));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(null); });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finish(input.value); } });
    });
  }

  // ── Finish / Delete ──────────────────────────────────────────────────────
  async function finishBuilderPallet() {
    if (!pb?.palletId) return;

    const locInput = document.getElementById("pb-loc-running");
    const loc = locInput?.value.trim() || pb.palletLocation || "";
    if (!loc) {
      locInput?.classList.add("pb-input--error");
      locInput?.focus();
      showPbMsg("Location is required before finishing", "error");
      return;
    }

    const grossInput = document.getElementById("pb-gross-weight");
    const grossWeight = parseFloat(grossInput?.value) || 0;
    if (!grossWeight || grossWeight <= 0) {
      grossInput?.classList.add("pb-input--error");
      grossInput?.focus();
      showPbMsg("Gross weight is required before finishing", "error");
      return;
    }

    const height = Math.round(calcPalletHeight());
    const volume = calcPalletVolume(height);

    // Job comment — log.DeliveryMain.picksheetComment (one per delivery, not
    // per pallet), only sent when actually changed.
    const commentInput = document.getElementById("pb-comment");
    const comment = commentInput ? commentInput.value.trim() : pb.picksheetComment;
    const commentChanged = comment !== (pb.picksheetComment || "");
    const deliveryId = pb.deliveryId;
    const onChanged = pb.onChanged;

    try {
      await pmApi(`/${pb.palletId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palletFinish: true, palletLocation: loc, palletHeight: height, grossWeight, palletVolume: volume }),
      });

      if (commentChanged) {
        dmApi(`/${encodeURIComponent(deliveryId)}/comment`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ picksheetComment: comment }),
        }).catch(() => {});
      }

      close();
      if (onChanged) await onChanged();
    } catch (err) {
      showPbMsg("✕ " + err.message, "error");
    }
  }

  // Deleting a pallet reverses SAP staging for every one of its packages
  // server-side before it's marked removed — fails closed, so a pallet
  // with stock still stuck in SAP stays visible instead of silently
  // vanishing. Uses a raw fetch (not the throwing api() wrapper) so the
  // 422 response's per-package failures list survives to the operator.
  function formatReversalError(json) {
    let msg = json.error?.message || "Delete failed";
    const failures = json.data?.failures;
    if (Array.isArray(failures) && failures.length) {
      msg += "\n" + failures.map((f) => `• ${f.sapMaterial || "?"} / ${f.sapBatch || "?"}: ${f.error}`).join("\n");
    }
    return msg;
  }

  async function deletePalletFromBuilder() {
    if (!pb?.palletId) return;
    if (!await NexusModal.confirm("Delete this pallet and all its packages?\nAny stock staged in SAP will be moved back to its original location first.\nThis cannot be undone.", { title: "Delete Pallet", confirmLabel: "Delete", danger: true })) return;
    const onChanged = pb.onChanged;
    try {
      const res = await fetch(`/api/palletmain/${pb.palletId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palletRemoved: true }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(formatReversalError(json));
      close();
      if (onChanged) await onChanged();
    } catch (err) {
      showPbMsg("✕ " + err.message, "error");
    }
  }

  window.PalletBuilder = { open, openOnExisting };
})();
