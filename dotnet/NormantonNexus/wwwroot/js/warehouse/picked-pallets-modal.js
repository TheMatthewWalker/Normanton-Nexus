// Picked Pallets modal — shared by Open Picksheets and Picksheets on Hold
// (both open the exact same modal on a row click, matching Node's single
// showPickedPallets() in private/js/warehouse.js, called from both
// runOpenPicksheets' and runPackagingHolding's row handlers there). Covers
// the linked-picksheets delivery picker (the piece explicitly restored this
// pass), the pallet summary list with finish/reopen/delete, package
// removal, and Complete Delivery/Confirm Packaging.
//
// Uses this app's own shared NexusModal component (wwwroot/js/shared/
// modal.js) — already built on Node's real .ps-modal-* classes — for the
// modal shell, and a nested .wc-overlay dialog (matching Node's own stacked
// w-prompt-modal) for the delivery-picker search, so both dialogs can be
// open at once exactly as Node's can (NexusModal itself only ever manages
// one overlay).
//
// Deliberately NOT built in this pass: the full "+ Add Pallet"/Pallet
// Builder wizard (creating a pallet from scratch, adding packaging, batch
// scanning, label printing) — a separate, much larger undertaking than the
// delivery picker this pass was specifically restoring. The pallet summary
// list, finish/reopen/delete, and package removal are all real and wired,
// since their backend already existed (PalletMainController/
// PalletPackagesController).
(function () {
  const esc = NexusApi.esc;
  const dmApi = NexusApi.make("/api/deliverymain");
  const pmApi = NexusApi.make("/api/palletmain");
  const ppApi = NexusApi.make("/api/palletpackages");

  let ctx = null; // { deliveryId, destName, fromHolding, onChanged }

  async function show(deliveryId, destName, fromHolding, onChanged) {
    ctx = { deliveryId, destName, fromHolding: !!fromHolding, onChanged };

    NexusModal.open(`
      <div class="ps-modal-header">
        <div>
          <div class="ps-modal-title">Picked Pallets</div>
          <div class="ps-modal-sub">Delivery #${esc(String(deliveryId))} · ${esc(destName)}${fromHolding ? " · <span style=\"color:#B45309\">Confirming packaging — already completed in SAP</span>" : ""}</div>
        </div>
        <button type="button" class="ps-modal-close" id="pp-close">✕</button>
      </div>
      <div class="ps-linked-section" id="ps-linked-section"></div>
      <div class="ps-modal-body" id="pallet-list-body" style="padding:0">
        <div class="sap-loading"><div class="spinner"></div>Fetching pallets…</div>
      </div>
      <div class="ps-modal-actions">
        <button type="button" class="btn-secondary" id="pp-complete">${fromHolding ? "Confirm Packaging ✓" : "Complete Delivery ✓"}</button>
      </div>`);

    document.getElementById("pp-close").addEventListener("click", () => NexusModal.close());
    document.getElementById("pp-complete").addEventListener("click", () => completeDelivery());

    await Promise.all([refreshPalletList(), refreshLinkedPicksheets()]);
  }

  // ── Linked picksheets (delivery picker) ─────────────────────────────────
  async function refreshLinkedPicksheets() {
    const el = document.getElementById("ps-linked-section");
    if (!el || !ctx) return;
    try {
      const { data } = await dmApi(`/${encodeURIComponent(ctx.deliveryId)}/linked-picksheets`);
      const linked = data || [];
      const chips = linked.map((l) => `
        <span class="ps-linked-chip">
          Linked to #${esc(String(l.deliveryId))} — ${esc(l.destinationName ?? "—")}
          <button type="button" class="ps-linked-unlink" title="Unlink" data-id="${esc(String(l.deliveryId))}">✕</button>
        </span>`).join("");
      el.innerHTML = `${chips}<button type="button" class="btn-secondary ps-link-btn" id="ps-link-open">${linked.length ? "+ Link Another Picksheet" : "Link to another picksheet"}</button>`;
      el.querySelectorAll(".ps-linked-unlink").forEach((btn) => btn.addEventListener("click", () => unlinkPicksheet(btn.dataset.id)));
      document.getElementById("ps-link-open").addEventListener("click", () => openLinkPicksheetSearch());
    } catch {
      el.innerHTML = "";
    }
  }

  function openLinkPicksheetSearch() {
    document.getElementById("lp-modal")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "lp-modal";
    overlay.className = "wc-overlay";
    overlay.innerHTML = `
      <div class="wc-modal">
        <div class="wc-title">Link to Another Picksheet</div>
        <div class="wc-message" style="text-align:left">
          <input class="tf-input" id="lp-search" type="text" placeholder="Search delivery # or destination…" autocomplete="off" style="width:100%">
          <div id="lp-results" class="lp-results"></div>
        </div>
        <div class="wc-actions"><button type="button" class="wc-btn-cancel" id="lp-close">Close</button></div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById("lp-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    const input = document.getElementById("lp-search");
    const results = document.getElementById("lp-results");
    input.focus();

    let debounce = null;
    input.addEventListener("input", () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (!q) { results.innerHTML = ""; return; }
      debounce = setTimeout(async () => {
        try {
          const { data } = await dmApi(`/link-search?q=${encodeURIComponent(q)}&excludeDeliveryId=${encodeURIComponent(ctx.deliveryId)}`);
          const rows = data || [];
          results.innerHTML = rows.length
            ? rows.map((r) => `<div class="lp-row" data-id="${esc(String(r.deliveryId))}">#${esc(String(r.deliveryId))} — ${esc(r.destinationName ?? "—")}</div>`).join("")
            : `<div class="lp-empty">No matches</div>`;
          results.querySelectorAll(".lp-row").forEach((row) => {
            row.addEventListener("mousedown", async (e) => {
              e.preventDefault();
              overlay.remove();
              await linkPicksheet(row.dataset.id);
            });
          });
        } catch {
          results.innerHTML = `<div class="sap-error">Search failed</div>`;
        }
      }, 250);
    });
  }

  async function linkPicksheet(otherDeliveryId) {
    if (!ctx) return;
    try {
      await dmApi(`/${encodeURIComponent(ctx.deliveryId)}/link/${encodeURIComponent(otherDeliveryId)}`, { method: "POST" });
      await Promise.all([refreshLinkedPicksheets(), refreshPalletList()]);
    } catch (err) {
      NexusModal.alert(err.message, { title: "Error" });
    }
  }

  async function unlinkPicksheet(otherDeliveryId) {
    if (!ctx) return;
    if (!await NexusModal.confirm(`Unlink Delivery #${otherDeliveryId}?\nPallets already tied to it will no longer appear on this picksheet (and vice versa).`, { title: "Unlink Picksheet", confirmLabel: "Unlink", danger: true })) return;
    try {
      await dmApi(`/${encodeURIComponent(ctx.deliveryId)}/link/${encodeURIComponent(otherDeliveryId)}`, { method: "DELETE" });
      await Promise.all([refreshLinkedPicksheets(), refreshPalletList()]);
    } catch (err) {
      NexusModal.alert(err.message, { title: "Error" });
    }
  }

  // ── Pallet list ───────────────────────────────────────────────────────────
  async function refreshPalletList() {
    const body = document.getElementById("pallet-list-body");
    if (!body || !ctx) return;
    try {
      const { data } = await dmApi(`/${encodeURIComponent(ctx.deliveryId)}/pallets`);
      const pallets = data || [];
      if (!pallets.length) {
        body.innerHTML = `<div class="ps-pcard-empty" style="padding:40px">No pallets built yet.</div>`;
        return;
      }
      body.innerHTML = `<div class="ps-pcard-list">${pallets.map((p) => renderPalletCard(p)).join("")}</div>`;
      body.querySelectorAll(".ps-pcard-hdr").forEach((hdr) => {
        hdr.addEventListener("click", (e) => {
          if (e.target.closest(".ps-pcard-btn")) return;
          togglePalletCard(hdr.closest(".ps-pcard"));
        });
      });
      body.querySelectorAll("[data-finish]").forEach((btn) => btn.addEventListener("click", () => finishPallet(btn.dataset.finish)));
      body.querySelectorAll("[data-reopen]").forEach((btn) => btn.addEventListener("click", () => reopenPallet(btn.dataset.reopen)));
      body.querySelectorAll("[data-delete]").forEach((btn) => btn.addEventListener("click", () => deletePallet(btn.dataset.delete)));
    } catch (err) {
      body.innerHTML = `<div class="sap-error" style="padding:24px">✕ ${esc(err.message)}</div>`;
    }
  }

  function renderPalletCard(p) {
    const dims = [p.palletLength, p.palletWidth, p.palletHeight].filter(Boolean).join("×");
    const wt = p.grossWeight != null ? `${Number(p.grossWeight).toFixed(1)} kg` : "—";
    const status = p.palletFinish
      ? `<span class="ps-pcard-badge ps-pcard-badge--done">Finished</span>`
      : `<span class="ps-pcard-badge ps-pcard-badge--wip">In Progress</span>`;
    const actions = p.palletFinish
      ? `<button type="button" class="ps-pcard-btn" title="Un-mark as finished and continue editing" data-reopen="${p.palletId}">Reopen</button>`
      : `<button type="button" class="ps-pcard-btn ps-pcard-btn--finish" data-finish="${p.palletId}">Finish</button>`;
    const deleteBtn = `<button type="button" class="ps-pcard-btn ps-pcard-btn--delete" title="Delete pallet" data-delete="${p.palletId}">Delete</button>`;

    return `
      <div class="ps-pcard" data-palletid="${p.palletId}">
        <div class="ps-pcard-hdr">
          <span class="ps-pcard-type">${esc(p.palletType ?? "—")}</span>
          ${dims ? `<span class="ps-pcard-dims">${esc(dims)} cm</span>` : ""}
          <span class="ps-pcard-wt">${wt}</span>
          ${p.palletLocation ? `<span class="ps-pcard-loc">${esc(p.palletLocation)}</span>` : ""}
          ${status}
          ${actions}
          ${deleteBtn}
          <span class="ps-pcard-chevron">▼</span>
        </div>
        <div class="ps-pcard-body" id="pcard-body-${p.palletId}" style="display:none"></div>
      </div>`;
  }

  async function togglePalletCard(card) {
    const palletId = card.dataset.palletid;
    const body = document.getElementById(`pcard-body-${palletId}`);
    const isOpen = body.style.display !== "none";
    body.style.display = isOpen ? "none" : "block";
    card.classList.toggle("open", !isOpen);

    if (!isOpen && body.dataset.loaded !== "1") {
      body.innerHTML = `<div class="ps-pcard-empty"><div class="spinner" style="width:12px;height:12px;display:inline-block;margin-right:6px"></div>Loading…</div>`;
      await loadPalletPackages(palletId, body);
      body.dataset.loaded = "1";
    }
  }

  async function loadPalletPackages(palletId, bodyEl) {
    try {
      const { data } = await ppApi(`/pallet/${encodeURIComponent(palletId)}`);
      const pkgs = data || [];
      if (!pkgs.length) {
        bodyEl.innerHTML = `<div class="ps-pcard-empty">No packages on this pallet yet.</div>`;
        return;
      }
      bodyEl.innerHTML = `
        <table class="ps-pcard-tbl">
          <thead><tr><th>Layer</th><th>Pack Type</th><th>SAP Material</th><th>Qty</th><th>Batch</th><th>Delivery</th><th>Del. Item</th><th>Customer</th><th></th></tr></thead>
          <tbody>${pkgs.map((pkg) => `<tr>
            <td>${esc(String(pkg.palletLayer ?? "—"))}</td>
            <td>${esc(pkg.packDescription || pkg.packagingId || "—")}</td>
            <td class="ps-pcard-mono">${esc(pkg.sapMaterial || "—")}</td>
            <td class="ps-pcard-mono">${pkg.sapQuantity != null ? Number(pkg.sapQuantity).toFixed(3) : "—"}</td>
            <td class="ps-pcard-mono">${esc(pkg.sapBatch || "—")}</td>
            <td class="ps-pcard-mono">${esc(pkg.sapDelivery || "—")}</td>
            <td class="ps-pcard-mono">${esc(pkg.sapDeliveryItem || "—")}</td>
            <td class="ps-pcard-mono">${esc(pkg.sapCustomer || "—")}</td>
            <td><button type="button" class="ps-pcard-del" title="Remove" data-remove="${pkg.palletItemId}">✕</button></td>
          </tr>`).join("")}</tbody>
        </table>`;
      bodyEl.querySelectorAll("[data-remove]").forEach((btn) => btn.addEventListener("click", () => removePackage(btn.dataset.remove, palletId)));
    } catch (err) {
      bodyEl.innerHTML = `<div class="ps-pcard-empty" style="color:var(--error)">✕ ${esc(err.message)}</div>`;
    }
  }

  async function removePackage(palletItemId, palletId) {
    if (!await NexusModal.confirm("Remove this package from the pallet?\nIf it was staged in SAP, the stock will be moved back to its original location.", { title: "Remove Package", confirmLabel: "Remove", danger: true })) return;
    try {
      await ppApi(`/${palletItemId}`, { method: "DELETE" });
      const body = document.getElementById(`pcard-body-${palletId}`);
      if (body) { body.dataset.loaded = ""; await loadPalletPackages(palletId, body); body.dataset.loaded = "1"; }
    } catch (err) {
      NexusModal.alert(err.message, { title: "Error" });
    }
  }

  async function finishPallet(palletId) {
    if (!await NexusModal.confirm("Mark this pallet as finished?\nNo more packages can be added.", { title: "Finish Pallet", confirmLabel: "Finish" })) return;
    try {
      await pmApi(`/${palletId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ palletFinish: true }) });
      await refreshPalletList();
    } catch (err) {
      NexusModal.alert(err.message, { title: "Error" });
    }
  }

  async function reopenPallet(palletId) {
    if (!await NexusModal.confirm("Un-mark this pallet as finished so it can be edited again?", { title: "Reopen Pallet", confirmLabel: "Reopen" })) return;
    try {
      await pmApi(`/${palletId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ palletFinish: false }) });
      await refreshPalletList();
    } catch (err) {
      NexusModal.alert(err.message, { title: "Error" });
    }
  }

  async function deletePallet(palletId) {
    if (!await NexusModal.confirm("Delete this pallet and all its packages?\nAny stock staged in SAP will be moved back to its original location first.\nThis cannot be undone.", { title: "Delete Pallet", confirmLabel: "Delete", danger: true })) return;
    try {
      await pmApi(`/${palletId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ palletRemoved: true }) });
      await refreshPalletList();
    } catch (err) {
      NexusModal.alert(err.message, { title: "Error" });
    }
  }

  // ── Complete Delivery ──────────────────────────────────────────────────
  // Raw fetch, not the NexusApi.make() wrapper — same deliberate bypass
  // precedent as Logistics's Change Valuation Class: the 409 BLOCKED
  // response's structured Outstanding/MismatchType payload is exactly what
  // this dialog needs to build the per-item mismatch detail, and api()'s
  // error path discards the response body on any outer-envelope failure.
  async function completeDelivery() {
    if (!ctx) return;
    const { deliveryId, fromHolding, onChanged } = ctx;
    if (!await NexusModal.confirm(
      fromHolding
        ? `Confirm packaging data for Delivery #${deliveryId}?\nThis will move it out of Picksheets on Hold and make it available for shipment creation. SAP already has this delivery marked complete, so no ZDEL/ZDELFLAG updates are sent.`
        : `Mark Delivery #${deliveryId} as complete?\nThis will remove it from the open picksheets list.`,
      { title: fromHolding ? "Confirm Packaging" : "Complete Delivery", confirmLabel: fromHolding ? "Confirm" : "Complete" }
    )) return;

    try {
      const res = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/complete`, { method: "PATCH" });
      const json = await res.json();

      if (res.status === 409 && json.error?.code === "exceeds-tolerance" && json.data?.outstanding) {
        const detail = json.data.outstanding.map((o) => `Delivery #${o.deliveryId}: ${o.items.map((i) => `${i.material} (picked ${i.pickedQty} of ${i.requiredQty})`).join(", ")}`).join("\n");
        throw new Error(`${json.error.message}\n\n${detail}`);
      }

      if (res.status === 409 && json.error?.code === "within-tolerance" && json.data?.outstanding) {
        const detail = json.data.outstanding.map((o) => `Delivery #${o.deliveryId}: ${o.items.map((i) => `${i.material} — picked ${i.pickedQty} of ${i.requiredQty} (${(i.pctDiff * 100).toFixed(1)}% ${i.diffQty < 0 ? "under" : "over"})`).join("\n")}`).join("\n");
        const proceed = await NexusModal.confirm(`${json.error.message}\n\n${detail}`, { title: "Quantities Close But Not Exact", confirmLabel: "Update SAP Quantities" });
        if (!proceed) return;

        const syncRes = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/sync-delivery-quantities`, { method: "POST" });
        const syncJson = await syncRes.json();
        if (!syncJson.success) throw new Error(syncJson.error?.message || "Could not update SAP quantities.");
        return completeDelivery();
      }

      if (!json.success) throw new Error(json.error?.message || "Update failed");

      NexusModal.close();
      if (onChanged) await onChanged();

      const warningParts = [];
      if (json.data?.primary?.sapWarning) warningParts.push(json.data.primary.sapWarning);
      if (json.data?.primary?.goodsIssueWarning) warningParts.push(`Goods Issue: ${json.data.primary.goodsIssueWarning}`);
      if (json.data?.linkedResults) {
        const others = Object.keys(json.data.linkedResults).filter((id) => String(id) !== String(deliveryId));
        if (others.length) warningParts.unshift(`Also completed ${others.length} linked picksheet${others.length !== 1 ? "s" : ""}: ${others.map((id) => `#${id}`).join(", ")}.`);
      }
      if (warningParts.length) {
        await NexusModal.alert(warningParts.join("\n\n"), { title: "Delivery Complete — SAP Not Updated" });
      }
    } catch (err) {
      NexusModal.alert(err.message, { title: "Error" });
    }
  }

  window.PickedPalletsModal = { show };
})();
