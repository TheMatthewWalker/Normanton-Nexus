// Stock Investigations (LOG_SUPER only) — port of runStockInvestigations()
// and the wsm*-prefixed Batch Discrepancies functions it shares with Stock
// Management, from private/js/warehouse.js (lines ~906-2472 there). Covers:
//   - Batch Discrepancies: a full-warehouse scan for any batch with a
//     negative-quantity line or sitting in more than one bin, with three
//     resolution paths — zero-sum clean-up (batches whose bins net to
//     zero, auto-combined), single-bin consolidation (multi-bin batches
//     that don't net to zero — Move to Holding or Consolidate), and
//     pull-from-holding (a batch that's just one negative line).
//   - Stock in Investigation card: whatever's currently parked in the
//     holding bin (999/TEMP), with Transfer or Stock Adjustment
//     (711/712/717/718, BAPI_GOODSMVT_CREATE) actions.
//
// Deliberately NOT built this pass, flagged rather than silently dropped:
//   - Card 2's "bulk consolidate across every batch at once" power tool
//     (Node's wsmOpenBulkConsolidateModal/wsmComputeBulkPlan/
//     wsmExecuteBulkPlan, ~180 lines) — the single-batch Resolve modal
//     built here already lets a supervisor resolve every Card 2 batch,
//     just one at a time rather than all at once.
//   - Stock Count Discrepancies (log.StockCountDiscrepancy, fed by
//     Finished Goods Count's guided scan) — that count-line-entry
//     workflow itself was never built in this migration (see
//     dotnet/CLAUDE.md's Warehouse frontend notes), so nothing would ever
//     populate this table; building the read/resolve UI now would show
//     an always-empty list with no way to ever exercise it.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/warehouse");
  const root = document.getElementById("si-root");

  const HOLDING_TYPE = "999";
  const HOLDING_BIN = "TEMP";
  const EPS = 0.0005;

  function isHolding(row) {
    return row.storageType === HOLDING_TYPE && row.bin === HOLDING_BIN;
  }

  // Identity key for "the same physical stock, just a different bin" — rows
  // differing in stock category or special stock indicator/number are a
  // different stock status in SAP and can't be merged by one transfer order.
  function categoryKey(row) {
    return [row.material, row.batch, row.storageLocation, row.stockCategory, row.specialStockInd, row.specialStockNum].join("¦");
  }

  function rowId(row) {
    return [row.storageLocation, row.storageType, row.bin, row.material, row.batch, row.stockCategory, row.specialStockInd, row.specialStockNum].join("¦");
  }

  async function fetchStock(params) {
    const qs = new URLSearchParams(params).toString();
    const { data } = await api(`/stock${qs ? `?${qs}` : ""}`);
    return (data || []).map((r) => ({ ...r, availableQty: Number(r.availableQty) || 0 }));
  }

  // ── Progress banner (same shape as stock-management.js's own copy) ───────
  function groupErrors(messages) {
    const counts = new Map();
    messages.forEach((msg) => counts.set(msg, (counts.get(msg) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  function showProgressBanner(containerEl, total, label) {
    const banner = document.createElement("div");
    banner.className = "wsm-progress-banner";
    banner.innerHTML = `
      <div class="wsm-progress-head">
        <span class="wsm-progress-label">${esc(label)}</span>
        <span class="wsm-progress-count-wrap">
          <span class="wsm-progress-count">0 / ${total}</span>
          <span class="wsm-progress-pct">0%</span>
        </span>
      </div>
      <div class="wsm-progress-track"><div class="wsm-progress-bar"></div></div>
      <div class="wsm-progress-summary">Sending to SAP…</div>`;
    containerEl.insertBefore(banner, containerEl.firstChild);
    banner.scrollIntoView({ behavior: "smooth", block: "nearest" });

    return {
      update(done) {
        const pct = total ? Math.round((done / total) * 100) : 100;
        banner.querySelector(".wsm-progress-bar").style.width = `${pct}%`;
        banner.querySelector(".wsm-progress-count").textContent = `${done} / ${total}`;
        banner.querySelector(".wsm-progress-pct").textContent = `${pct}%`;
      },
      finish(ok, fail, failureMessages) {
        const bar = banner.querySelector(".wsm-progress-bar");
        const summary = banner.querySelector(".wsm-progress-summary");
        bar.style.width = "100%";
        bar.classList.toggle("wsm-progress-bar--warn", fail > 0);
        if (fail) {
          const breakdown = groupErrors(failureMessages).map(([msg, count]) => `${count}× ${msg}`).join("; ");
          summary.classList.add("wsm-progress-summary--warn");
          summary.textContent = `${ok} succeeded, ${fail} failed — ${breakdown}`;
        } else {
          summary.classList.add("wsm-progress-summary--ok");
          summary.textContent = `✓ All ${ok} succeeded.`;
        }
      },
    };
  }

  // ── Batch-cleanup SAP calls (LOG_SUPER-gated wrapper — see
  // WarehouseBatchCleanupHelper) — the dotnet backend already interprets
  // the SAP response into {success, message, transferOrderNumber}, so
  // unlike Node this frontend doesn't need its own wsmInterpretCleanupResult.
  function buildCleanupItem(params) {
    const isConsignment = params.specialStockIndicator === "K" && params.destinationType === "SA";
    if (isConsignment) {
      return {
        kind: "consignment",
        consignment: {
          material: params.material, quantity: params.quantity, header: "Batch Discrepancy Clean-up",
          specialStockNumber: params.specialStockNumber, storageLocation: params.storageLocation,
          destinationType: params.destinationType, destinationBin: params.destinationBin,
          sourceType: params.sourceType, sourceBin: params.sourceBin,
        },
      };
    }
    return { kind: "transfer", transfer: params };
  }

  async function createBatchCleanupTransfer(params) {
    try {
      const { data } = await api("/batch-cleanup-transfer", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildCleanupItem(params)),
      });
      return { success: true, message: data.message, transferOrderNumber: data.transferOrderNumber };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  async function createBatchCleanupTransfersBulk(paramsList) {
    try {
      const { data } = await api("/batch-cleanup-transfer-bulk", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: paramsList.map(buildCleanupItem) }),
      });
      return data.map((r) => ({ success: r.success, message: r.message, transferOrderNumber: r.transferOrderNumber }));
    } catch (err) {
      return paramsList.map(() => ({ success: false, message: err.message }));
    }
  }

  // ── Batch analysis (pure) ─────────────────────────────────────────────────
  function analyzeBatches(rows) {
    const groups = new Map();
    rows.forEach((r) => {
      if (!r.batch) return;
      if (!groups.has(r.batch)) groups.set(r.batch, []);
      groups.get(r.batch).push(r);
    });

    const allFlagged = [], card1 = [], card2 = [], card3 = [];

    groups.forEach((groupRows, batch) => {
      const hasNegative = groupRows.some((r) => r.availableQty < 0);
      if (!(groupRows.length > 1 || hasNegative)) return;

      const subtotal = groupRows.reduce((s, r) => s + r.availableQty, 0);
      const nonHolding = groupRows.filter((r) => !isHolding(r));
      const isZeroSum = Math.abs(subtotal) < EPS;

      allFlagged.push({ batch, rows: groupRows, subtotal, hasNegative, isZeroSum });

      if (isZeroSum) {
        card1.push({ batch, rows: groupRows, subtotal });
      } else if (nonHolding.length === 1 && nonHolding[0].availableQty < 0) {
        card3.push({ batch, row: nonHolding[0] });
      } else if (nonHolding.length > 1) {
        card2.push({ batch, rows: groupRows, nonHolding, subtotal });
      }
    });

    allFlagged.sort((a, b) => a.batch.localeCompare(b.batch));
    return { allFlagged, card1, card2, card3 };
  }

  function netSubgroup(batch, subRows) {
    const moves = [];
    const positives = subRows.filter((r) => r.availableQty > 0).map((r) => ({ ...r, remaining: r.availableQty }));
    const negatives = subRows.filter((r) => r.availableQty < 0).map((r) => ({ ...r, remaining: -r.availableQty }));
    let pi = 0, ni = 0;
    while (pi < positives.length && ni < negatives.length) {
      const p = positives[pi], n = negatives[ni];
      const qty = Math.min(p.remaining, n.remaining);
      if (qty > EPS) {
        moves.push({
          batch, material: p.material, sourceType: p.storageType, sourceBin: p.bin,
          destType: n.storageType, destBin: n.bin, qty: Math.round(qty * 1000) / 1000,
          storageLocation: p.storageLocation, stockCategory: p.stockCategory,
          specialStockInd: p.specialStockInd, specialStockNum: p.specialStockNum,
        });
        p.remaining -= qty;
        n.remaining -= qty;
      }
      if (p.remaining <= EPS) pi++;
      if (n.remaining <= EPS) ni++;
    }
    return moves;
  }

  function buildZeroSumPlan(card1) {
    const plan = [], unresolved = [];
    card1.forEach(({ batch, rows }) => {
      const subgroups = new Map();
      rows.forEach((r) => {
        const key = categoryKey(r);
        if (!subgroups.has(key)) subgroups.set(key, []);
        subgroups.get(key).push(r);
      });

      let allZero = true;
      const moves = [];
      subgroups.forEach((subRows) => {
        const subtotal = subRows.reduce((s, r) => s + r.availableQty, 0);
        if (Math.abs(subtotal) > EPS) { allZero = false; return; }
        moves.push(...netSubgroup(batch, subRows));
      });

      if (allZero && moves.length) plan.push({ batch, moves });
      else if (!allZero) unresolved.push({ batch, reason: "Nets to zero overall, but its bins span different stock categories/special stock statuses that can't be auto-combined — needs manual review." });
    });
    return { plan, unresolved };
  }

  function moveToParams(m, batch) {
    return {
      storageLocation: m.storageLocation, material: m.material, batch,
      quantity: m.qty, sourceType: m.sourceType, sourceBin: m.sourceBin,
      destinationType: m.destType, destinationBin: m.destBin,
      stockCategory: m.stockCategory || "", specialStockIndicator: m.specialStockInd || "", specialStockNumber: m.specialStockNum || "",
    };
  }

  // ── Home view ─────────────────────────────────────────────────────────────
  function renderHome() {
    root.innerHTML = `
      <div class="wsm-panel-title">Batch Discrepancies</div>
      <div class="wsm-panel-sub">Scans the full warehouse for any batch with a negative-quantity line, or sitting in more than one bin, and helps clean it up.</div>
      <div class="tf-actions" style="margin-bottom:24px">
        <button type="button" class="btn-submit" id="si-disc-open-btn">Open Batch Discrepancies</button>
      </div>
      <div id="si-investigation-card">
        <div class="sap-loading"><div class="spinner"></div>Loading holding-bin stock…</div>
      </div>`;

    document.getElementById("si-disc-open-btn").addEventListener("click", () => runDiscrepancyScan());
    refreshInvestigationCard();
  }

  // ── Batch Discrepancies scan + dashboard ─────────────────────────────────
  async function runDiscrepancyScan() {
    root.innerHTML = `<div class="sap-loading"><div class="spinner"></div>Connecting to SAP…</div>`;
    try {
      const rows = await fetchStock({}); // full, unfiltered pull — independent of Stock Management's own search
      renderDiscrepancyDashboard(analyzeBatches(rows));
    } catch (err) {
      root.innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
    }
  }

  function renderDiscrepancyDashboard(analysis) {
    const { allFlagged, card1, card2, card3 } = analysis;

    const flaggedRows = allFlagged.map((g) => {
      const status = g.isZeroSum ? "Zero-sum" : (g.rows.filter((r) => !isHolding(r)).length > 1 ? "Multi-bin conflict" : "—");
      return `<tr class="${g.hasNegative ? "wsm-row--negative" : ""}">
        <td>${esc(g.batch)}</td>
        <td>${esc(g.rows[0]?.material || "")}</td>
        <td>${g.rows.length}</td>
        <td>${Math.round(g.subtotal * 1000) / 1000}</td>
        <td>${esc(status)}</td>
      </tr>`;
    }).join("");

    root.innerHTML = `
      <div class="wsm-disc-toolbar">
        <button type="button" class="btn-secondary" id="wsm-disc-back">&larr; Back to Stock Investigations</button>
        <button type="button" class="btn-secondary" id="wsm-disc-rescan">Rescan</button>
      </div>

      <div class="wsm-panel-title">Flagged Batches (${allFlagged.length})</div>
      <div class="wsm-panel-sub">Any batch with a negative-quantity line, or in more than one bin.</div>
      ${allFlagged.length ? `
      <div class="wsm-mass-table-wrap" style="margin-bottom:20px">
        <table class="wsm-mass-table">
          <thead><tr><th>Batch</th><th>Material</th><th>Rows</th><th>Subtotal</th><th>Status</th></tr></thead>
          <tbody>${flaggedRows}</tbody>
        </table>
      </div>` : `<div class="wsm-empty">No negative or multi-bin batches found.</div>`}

      <div class="wsm-disc-cards">
        <div class="wsm-disc-card">
          <div class="wsm-disc-card-num">${card1.length}</div>
          <div class="wsm-disc-card-label">batch(es) net to zero across their bins — can be combined to remove</div>
          <button type="button" class="btn-submit" id="wsm-disc-card1-btn" ${card1.length ? "" : "disabled"}>Preview Combine</button>
        </div>
        <div class="wsm-disc-card">
          <div class="wsm-disc-card-num">${card2.length}</div>
          <div class="wsm-disc-card-label">batch(es) have stock in multiple bins that doesn't net to zero — resolve one at a time below</div>
        </div>
        <div class="wsm-disc-card">
          <div class="wsm-disc-card-num">${card3.length}</div>
          <div class="wsm-disc-card-label">batch(es) are a single negative line — nothing to net against, resolve from holding</div>
        </div>
      </div>

      <div id="wsm-disc-card1-area"></div>
      <div id="wsm-disc-card2-area"></div>
      <div id="wsm-disc-card3-area"></div>
    `;

    document.getElementById("wsm-disc-back").addEventListener("click", () => renderHome());
    document.getElementById("wsm-disc-rescan").addEventListener("click", () => runDiscrepancyScan());
    const card1Btn = document.getElementById("wsm-disc-card1-btn");
    if (card1Btn) card1Btn.addEventListener("click", () => showZeroSumPreview(card1));

    renderCard2List(card2);
    renderCard3List(card3);
  }

  // ── Card 1 — zero-sum clean-up ────────────────────────────────────────────
  function showZeroSumPreview(card1) {
    const { plan, unresolved } = buildZeroSumPlan(card1);
    const container = document.getElementById("wsm-disc-card1-area");
    if (!container) return;

    const rowsHtml = plan.flatMap(({ batch, moves }) => moves.map((m) => `<tr>
      <td>${esc(batch)}</td><td>${esc(m.material)}</td>
      <td class="wsm-mono">${esc(m.sourceType)}/${esc(m.sourceBin)}</td>
      <td class="wsm-mono">${esc(m.destType)}/${esc(m.destBin)}</td>
      <td>${m.qty}</td>
    </tr>`)).join("");

    const unresolvedHtml = unresolved.length ? `
      <div class="wsm-disc-warn">
        ${unresolved.length} batch(es) net to zero overall but can't be auto-combined (mixed stock category/special stock) — left untouched:
        <ul>${unresolved.map((u) => `<li>${esc(u.batch)} — ${esc(u.reason)}</li>`).join("")}</ul>
      </div>` : "";

    const totalMoves = plan.reduce((s, p) => s + p.moves.length, 0);

    container.innerHTML = `
      <div class="wsm-resolve-box">
        <div class="wsm-panel-title">Preview: Zero-Sum Clean-Up</div>
        <div class="wsm-panel-sub">${plan.length} batch(es) · ${totalMoves} transfer order(s) planned</div>
        ${unresolvedHtml}
        ${totalMoves ? `
          <div class="wsm-mass-table-wrap">
            <table class="wsm-mass-table">
              <thead><tr><th>Batch</th><th>Material</th><th>From</th><th>To</th><th>Qty</th></tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
          <div class="tf-actions">
            <div id="wsm-disc-exec-result"></div>
            <button type="button" class="btn-secondary" id="wsm-disc-cancel">Cancel</button>
            <button type="button" class="btn-submit" id="wsm-disc-confirm">Confirm &amp; Execute ${totalMoves} Move(s)</button>
          </div>` : `<div class="wsm-empty">Nothing that can be auto-combined right now.</div>`}
      </div>`;

    const cancelBtn = document.getElementById("wsm-disc-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", () => { container.innerHTML = ""; });
    const confirmBtn = document.getElementById("wsm-disc-confirm");
    if (confirmBtn) confirmBtn.addEventListener("click", () => executeZeroSumPlan(plan));
  }

  async function executeZeroSumPlan(plan) {
    const resultEl = document.getElementById("wsm-disc-exec-result");
    const confirmBtn = document.getElementById("wsm-disc-confirm");
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Executing…";

    const entries = [];
    plan.forEach(({ batch, moves }) => moves.forEach((m) => entries.push({ batch, m })));

    const progress = showProgressBanner(resultEl, entries.length, "Executing zero-sum clean-up");
    const paramsList = entries.map(({ batch, m }) => moveToParams(m, batch));
    const results = await createBatchCleanupTransfersBulk(paramsList);

    let ok = 0, fail = 0;
    const failures = [];
    results.forEach((result, i) => {
      if (result.success) { ok++; return; }
      fail++;
      const { batch, m } = entries[i];
      failures.push(`${batch} ${m.sourceType}/${m.sourceBin} → ${m.destType}/${m.destBin}: ${result.message}`);
    });

    progress.update(entries.length);
    progress.finish(ok, fail, failures);
    confirmBtn.textContent = "Done — press Rescan above to refresh";
  }

  // ── Card 2 — multiple bins, non-zero (single-batch resolve modal) ────────
  function renderCard2List(card2) {
    const container = document.getElementById("wsm-disc-card2-area");
    if (!container) return;
    if (!card2.length) { container.innerHTML = ""; return; }

    const rowsHtml = card2.map((g) => `<tr data-batch="${esc(g.batch)}">
      <td>${esc(g.batch)}</td>
      <td>${esc(g.rows[0]?.material || "")}</td>
      <td>${g.nonHolding.length}</td>
      <td>${Math.round(g.subtotal * 1000) / 1000}</td>
      <td><button type="button" class="btn-secondary wsm-disc-resolve-btn" data-batch="${esc(g.batch)}">Resolve</button></td>
    </tr>`).join("");

    container.innerHTML = `
      <div class="wsm-panel-title" style="margin-top:8px">Multiple Bins, Non-Zero</div>
      <div class="wsm-mass-table-wrap">
        <table class="wsm-mass-table" id="wsm-disc-card2-table">
          <thead><tr><th>Batch</th><th>Material</th><th>Active Bins</th><th>Subtotal</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;

    container.querySelectorAll(".wsm-disc-resolve-btn").forEach((btn) => {
      btn.addEventListener("click", () => openResolveModal(card2.find((g) => g.batch === btn.dataset.batch), card2));
    });
  }

  function removeCard2Row(card2, batch) {
    const idx = card2.findIndex((g) => g.batch === batch);
    if (idx !== -1) card2.splice(idx, 1);
    document.querySelector(`#wsm-disc-card2-table tr[data-batch="${CSS.escape(batch)}"]`)?.remove();
  }

  function resolveSubText(group) {
    const holdingRows = group.rows.filter(isHolding);
    const holdingQty = holdingRows.reduce((s, r) => s + r.availableQty, 0);
    return `Subtotal ${Math.round(group.subtotal * 1000) / 1000} across ${group.nonHolding.length} active bin(s)` +
      (holdingRows.length ? ` · ${Math.round(holdingQty * 1000) / 1000} already in holding (${HOLDING_TYPE}/${HOLDING_BIN}), shown below` : "");
  }

  function resolveRowsHtml(group) {
    const holdingHtml = group.rows.filter(isHolding).map((r) => `<tr class="wsm-row--holding" data-row-id="${esc(rowId(r))}">
      <td></td><td class="wsm-mono">${esc(r.storageType)}/${esc(r.bin)}</td><td>${Math.round(r.availableQty * 1000) / 1000}</td><td>Already in holding</td>
    </tr>`).join("");

    const activeHtml = group.nonHolding.map((r) => {
      const id = rowId(r);
      return `<tr data-row-id="${esc(id)}">
        <td><input type="radio" name="wsm-resolve-target" value="${esc(id)}"></td>
        <td class="wsm-mono">${esc(r.storageType)}/${esc(r.bin)}</td>
        <td>${r.availableQty}</td>
        <td><button type="button" class="btn-secondary wsm-resolve-holding-btn" data-row-id="${esc(id)}" ${r.availableQty > 0 ? "" : "disabled"}>Move to Holding</button></td>
      </tr>`;
    }).join("");

    return holdingHtml + activeHtml;
  }

  function renderResolveTable(group) {
    const tbody = document.querySelector("#wsm-resolve-table tbody");
    if (!tbody) return;
    tbody.innerHTML = resolveRowsHtml(group);
    tbody.querySelectorAll('input[name="wsm-resolve-target"]').forEach((radio) => radio.addEventListener("change", () => renderConsolidatePrecheck(group)));
    tbody.querySelectorAll(".wsm-resolve-holding-btn").forEach((btn) => {
      btn.addEventListener("click", () => moveToHolding(group, group.nonHolding.find((r) => rowId(r) === btn.dataset.rowId)));
    });
  }

  function openResolveModal(group, card2) {
    if (!group) return;
    document.getElementById("wsm-resolve-modal")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "wsm-resolve-modal";
    overlay.className = "wsm-resolve-overlay";
    overlay.innerHTML = `
      <div class="wsm-resolve-modal">
        <div class="wsm-resolve-modal-hdr">
          <div class="wsm-panel-title">Resolve Batch ${esc(group.batch)}</div>
          <button type="button" class="wsm-resolve-close" aria-label="Close">&times;</button>
        </div>
        <div class="wsm-panel-sub" id="wsm-resolve-sub">${resolveSubText(group)}</div>
        <div class="wsm-mass-table-wrap">
          <table class="wsm-mass-table" id="wsm-resolve-table">
            <thead><tr><th>Keep</th><th>Bin</th><th>Qty</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div id="wsm-resolve-precheck"></div>
        <div class="tf-actions">
          <div id="wsm-resolve-result"></div>
          <button type="button" class="btn-secondary" id="wsm-resolve-cancel">Close</button>
          <button type="button" class="btn-submit" id="wsm-resolve-consolidate-btn">Consolidate Into Selected Bin</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector(".wsm-resolve-close").addEventListener("click", close);
    overlay.querySelector("#wsm-resolve-cancel").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.getElementById("wsm-resolve-consolidate-btn").addEventListener("click", () => consolidateGroup(group, card2));

    renderResolveTable(group);
  }

  function computeConsolidatePlan(group, target) {
    const targetKey = categoryKey(target);
    const others = group.nonHolding.filter((r) => rowId(r) !== rowId(target));

    const movable = [], skipped = [];
    others.forEach((r) => {
      if (r.availableQty > 0 && categoryKey(r) === targetKey) { movable.push(r); return; }
      const reasons = [];
      if (!(r.availableQty > 0)) reasons.push("negative/zero quantity");
      if (categoryKey(r) !== targetKey) {
        if (r.material !== target.material) reasons.push("different material");
        else if (r.stockCategory !== target.stockCategory) reasons.push("different stock category");
        else if (r.specialStockInd !== target.specialStockInd || r.specialStockNum !== target.specialStockNum) reasons.push("different special stock");
        else reasons.push("different storage location/batch");
      }
      skipped.push({ row: r, reason: reasons.join(" & ") || "category mismatch" });
    });
    return { target, movable, skipped };
  }

  function renderConsolidatePrecheck(group) {
    const container = document.getElementById("wsm-resolve-precheck");
    if (!container) return;
    const radio = document.querySelector('input[name="wsm-resolve-target"]:checked');
    if (!radio) { container.innerHTML = ""; return; }
    const target = group.nonHolding.find((r) => rowId(r) === radio.value);
    if (!target) { container.innerHTML = ""; return; }

    const { movable, skipped } = computeConsolidatePlan(group, target);
    if (!skipped.length) {
      container.innerHTML = movable.length
        ? `<div class="wsm-disc-note">All ${movable.length} other active bin(s) match ${esc(target.storageType)}/${esc(target.bin)} and would be moved in.</div>`
        : "";
      return;
    }
    container.innerHTML = `
      <div class="wsm-disc-warn">
        ${skipped.length} bin(s) would NOT be moved into ${esc(target.storageType)}/${esc(target.bin)} if you consolidate now:
        <ul>${skipped.map((s) => `<li>${esc(s.row.storageType)}/${esc(s.row.bin)} (qty ${s.row.availableQty}) — ${esc(s.reason)}</li>`).join("")}</ul>
      </div>`;
  }

  async function consolidateGroup(group, card2) {
    const radio = document.querySelector('input[name="wsm-resolve-target"]:checked');
    const resultEl = document.getElementById("wsm-resolve-result");
    if (!radio) { resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Pick a bin to keep first.</div>`; return; }

    const target = group.nonHolding.find((r) => rowId(r) === radio.value);
    if (!target) { resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ That bin is no longer active — pick another.</div>`; return; }

    const { movable, skipped } = computeConsolidatePlan(group, target);
    if (!movable.length) {
      resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Nothing movable into that bin — other rows are either negative or a different stock category/special stock, which need manual handling.</div>`;
      return;
    }

    resultEl.innerHTML = "";
    const consolidateBtn = document.getElementById("wsm-resolve-consolidate-btn");
    if (consolidateBtn) consolidateBtn.disabled = true;

    const progress = showProgressBanner(resultEl, movable.length, "Consolidating into selected bin");
    const paramsList = movable.map((r) => ({
      storageLocation: r.storageLocation, material: r.material, batch: group.batch,
      quantity: r.availableQty, sourceType: r.storageType, sourceBin: r.bin,
      destinationType: target.storageType, destinationBin: target.bin,
      stockCategory: r.stockCategory || "", specialStockIndicator: r.specialStockInd || "", specialStockNumber: r.specialStockNum || "",
    }));
    const results = await createBatchCleanupTransfersBulk(paramsList);

    let ok = 0, fail = 0;
    const failures = [];
    results.forEach((result, i) => {
      if (result.success) { ok++; return; }
      fail++;
      const r = movable[i];
      failures.push(`${r.storageType}/${r.bin}: ${result.message}`);
    });

    progress.update(movable.length);
    progress.finish(ok, fail, failures);
    if (skipped.length) {
      const note = document.createElement("div");
      note.className = "wsm-progress-summary";
      note.textContent = `${skipped.length} row(s) left untouched (negative qty or different stock category/special stock).`;
      resultEl.appendChild(note);
    }

    if (fail === 0) {
      if (consolidateBtn) consolidateBtn.textContent = "Done";
      setTimeout(() => {
        document.getElementById("wsm-resolve-modal")?.remove();
        removeCard2Row(card2, group.batch);
      }, 1000);
      return;
    }
    if (consolidateBtn) consolidateBtn.textContent = "Done — press Rescan above to refresh";
  }

  async function moveToHolding(group, row) {
    if (!row) return;
    const resultEl = document.getElementById("wsm-resolve-result");
    if (!(row.availableQty > 0)) {
      if (resultEl) resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Only a positive-quantity bin can be moved into holding.</div>`;
      return;
    }
    if (!await NexusModal.confirm(`Move ${row.availableQty} of batch ${group.batch} from ${row.storageType}/${row.bin} into the holding bin (${HOLDING_TYPE}/${HOLDING_BIN}), awaiting stock investigation?`, { title: "Move to Holding", confirmLabel: "Move", danger: true })) return;

    const id = rowId(row);
    const btn = document.querySelector(`.wsm-resolve-holding-btn[data-row-id="${CSS.escape(id)}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Moving…"; }

    const result = await createBatchCleanupTransfer({
      storageLocation: row.storageLocation, material: row.material, batch: group.batch,
      quantity: row.availableQty, sourceType: row.storageType, sourceBin: row.bin,
      destinationType: HOLDING_TYPE, destinationBin: HOLDING_BIN,
      stockCategory: row.stockCategory || "", specialStockIndicator: row.specialStockInd || "", specialStockNumber: row.specialStockNum || "",
    });

    if (!result.success) {
      if (resultEl) resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(result.message)}</div>`;
      if (btn) { btn.disabled = false; btn.textContent = "Move to Holding"; }
      return;
    }

    const idx = group.nonHolding.findIndex((r) => rowId(r) === id);
    if (idx !== -1) group.nonHolding.splice(idx, 1);
    const holdingMatch = group.rows.find((r) => isHolding(r) && categoryKey(r) === categoryKey(row));
    if (holdingMatch) holdingMatch.availableQty += row.availableQty;
    else group.rows.push({ ...row, storageType: HOLDING_TYPE, bin: HOLDING_BIN });

    renderResolveTable(group);
    const subEl = document.getElementById("wsm-resolve-sub");
    if (subEl) subEl.textContent = resolveSubText(group);
    if (resultEl) resultEl.innerHTML = `<div class="tf-success tf-inline-error">Moved ${row.availableQty} from ${esc(row.storageType)}/${esc(row.bin)} to holding.</div>`;

    const consolidateBtn = document.getElementById("wsm-resolve-consolidate-btn");
    if (group.nonHolding.length < 2) {
      if (consolidateBtn) { consolidateBtn.disabled = true; consolidateBtn.textContent = "Nothing left to consolidate"; }
      const precheck = document.getElementById("wsm-resolve-precheck");
      if (precheck) precheck.innerHTML = "";
    } else {
      renderConsolidatePrecheck(group);
    }

    refreshInvestigationCard();
  }

  // ── Card 3 — single-line negative ────────────────────────────────────────
  function renderCard3List(card3) {
    const container = document.getElementById("wsm-disc-card3-area");
    if (!container) return;
    if (!card3.length) { container.innerHTML = ""; return; }

    const rowsHtml = card3.map((entry) => {
      const { batch, row } = entry;
      const id = rowId(row);
      return `<tr data-row-id="${esc(id)}">
        <td>${esc(batch)}</td><td>${esc(row.material)}</td>
        <td class="wsm-mono">${esc(row.storageType)}/${esc(row.bin)}</td>
        <td>${row.availableQty}</td>
        <td id="wsm-card3-result-${esc(id)}"><button type="button" class="btn-secondary wsm-card3-resolve-btn" data-row-id="${esc(id)}">Pull From Holding</button></td>
      </tr>`;
    }).join("");

    container.innerHTML = `
      <div class="wsm-panel-title" style="margin-top:8px">Single-Line Negative</div>
      <div class="wsm-panel-sub">Just one bin for the whole batch, and it's negative — nothing else in the batch to net or consolidate against. Resolved by pulling the shortfall in from the holding bin (${HOLDING_TYPE}/${HOLDING_BIN}), which leaves the holding bin negative by the same amount instead.</div>
      <div class="wsm-mass-table-wrap">
        <table class="wsm-mass-table" id="wsm-disc-card3-table">
          <thead><tr><th>Batch</th><th>Material</th><th>Bin</th><th>Qty</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;

    container.querySelectorAll(".wsm-card3-resolve-btn").forEach((btn) => {
      btn.addEventListener("click", () => resolveNegativeLine(card3.find((e) => rowId(e.row) === btn.dataset.rowId)));
    });
  }

  async function resolveNegativeLine(entry) {
    if (!entry) return;
    const { batch, row } = entry;
    const qty = Math.abs(row.availableQty);
    const id = rowId(row);
    const resultCell = document.getElementById(`wsm-card3-result-${id}`);

    if (!await NexusModal.confirm(`Batch ${batch} has only one line, ${row.storageType}/${row.bin}, currently showing ${row.availableQty}. Pull ${qty} in from the holding bin (${HOLDING_TYPE}/${HOLDING_BIN}) to bring this bin to zero? This leaves the holding bin negative by ${qty} instead.`, { title: "Resolve Single-Line Negative", confirmLabel: "Pull From Holding", danger: true })) return;

    const btn = document.querySelector(`.wsm-card3-resolve-btn[data-row-id="${CSS.escape(id)}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Moving…"; }

    const result = await createBatchCleanupTransfer({
      storageLocation: row.storageLocation, material: row.material, batch,
      quantity: qty, sourceType: HOLDING_TYPE, sourceBin: HOLDING_BIN,
      destinationType: row.storageType, destinationBin: row.bin,
      stockCategory: row.stockCategory || "", specialStockIndicator: row.specialStockInd || "", specialStockNumber: row.specialStockNum || "",
    });

    if (!result.success) {
      if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ ${esc(result.message)}</span>`;
      if (btn) { btn.disabled = false; btn.textContent = "Pull From Holding"; }
      return;
    }

    document.querySelector(`#wsm-disc-card3-table tr[data-row-id="${CSS.escape(id)}"]`)?.remove();
    refreshInvestigationCard();
  }

  // ── Stock in Investigation card (holding bin 999/TEMP) ───────────────────
  let investigation = null; // { rows, selected: Set<rowId> }

  async function refreshInvestigationCard() {
    const container = document.getElementById("si-investigation-card");
    if (!container) return; // not currently mounted (e.g. inside the discrepancy dashboard sub-view)
    container.innerHTML = `<div class="sap-loading"><div class="spinner"></div>Loading holding-bin stock…</div>`;
    try {
      const rows = await fetchStock({ storageType: HOLDING_TYPE, bin: HOLDING_BIN });
      investigation = { rows, selected: new Set() };
    } catch (err) {
      container.innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
      investigation = null;
      return;
    }
    renderInvestigationCard();
  }

  function renderInvestigationCard() {
    const container = document.getElementById("si-investigation-card");
    if (!container || !investigation) return;
    const { rows } = investigation;

    if (!rows.length) {
      container.innerHTML = `
        <div class="wsm-panel-title">Stock in Investigation</div>
        <div class="wsm-panel-sub">Stock currently parked in the holding bin (${HOLDING_TYPE}/${HOLDING_BIN}), awaiting write-off/correction.</div>
        <div class="wsm-empty">Nothing currently in holding.</div>`;
      return;
    }

    const allChecked = rows.every((r) => investigation.selected.has(rowId(r)));
    const rowsHtml = rows.map((row) => {
      const id = rowId(row);
      const neg = row.availableQty < 0;
      const checked = investigation.selected.has(id) ? " checked" : "";
      return `<tr class="wsm-row${neg ? " wsm-row--negative" : ""}" data-id="${esc(id)}">
        <td class="wsm-td-check"><input type="checkbox" class="si-row-check" data-id="${esc(id)}"${checked}></td>
        <td>${esc(row.storageLocation)}</td><td>${esc(row.material)}</td><td>${row.availableQty}</td>
        <td>${esc(row.batch || "—")}</td><td>${esc(row.stockCategory || "—")}</td>
        <td>${esc(row.specialStockInd || "—")}</td><td>${esc(row.specialStockNum || "—")}</td>
      </tr>`;
    }).join("");

    container.innerHTML = `
      <div class="wsm-panel-title">Stock in Investigation</div>
      <div class="wsm-panel-sub">Stock currently parked in the holding bin (${HOLDING_TYPE}/${HOLDING_BIN}), awaiting write-off/correction — select one or more rows.</div>
      <div class="wsm-mass-table-wrap">
        <table class="wsm-mass-table">
          <thead><tr>
            <th class="wsm-td-check"><input type="checkbox" id="si-select-all"${allChecked ? " checked" : ""}></th>
            <th>Storage Loc.</th><th>Material</th><th>Qty</th><th>Batch</th><th>Stock Cat.</th><th>Special Stock</th><th>Special Stock No.</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="tf-actions">
        <div id="si-action-result"></div>
        <button type="button" class="btn-secondary" id="si-refresh-btn">Refresh</button>
        <button type="button" class="btn-secondary" id="si-transfer-btn" ${investigation.selected.size ? "" : "disabled"}>Create Transfer Order</button>
        <button type="button" class="btn-submit" id="si-adjust-btn" ${investigation.selected.size ? "" : "disabled"}>Create Stock Adjustment</button>
      </div>
      <div id="si-action-panel"></div>`;

    document.getElementById("si-select-all").addEventListener("change", (e) => {
      if (e.target.checked) rows.forEach((r) => investigation.selected.add(rowId(r)));
      else rows.forEach((r) => investigation.selected.delete(rowId(r)));
      renderInvestigationCard();
    });
    container.querySelectorAll(".si-row-check").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) investigation.selected.add(cb.dataset.id); else investigation.selected.delete(cb.dataset.id);
        renderInvestigationCard();
      });
    });
    document.getElementById("si-refresh-btn").addEventListener("click", () => refreshInvestigationCard());
    document.getElementById("si-transfer-btn")?.addEventListener("click", () => showTransferPanel());
    document.getElementById("si-adjust-btn")?.addEventListener("click", () => showAdjustmentPanel());
  }

  function selectedRows() {
    if (!investigation) return [];
    return investigation.rows.filter((r) => investigation.selected.has(rowId(r)));
  }

  function showTransferPanel() {
    const rows = selectedRows();
    const panel = document.getElementById("si-action-panel");
    if (!panel || !rows.length) return;

    const rowsHtml = rows.map((row) => {
      const id = rowId(row);
      return `<tr data-id="${esc(id)}">
        <td>${esc(row.material)}</td>
        <td class="wsm-mono">${esc(row.storageLocation)}${row.batch ? ` · ${esc(row.batch)}` : ""}</td>
        <td><input class="tf-input si-transfer-qty" type="number" step="any" value="${esc(Math.abs(row.availableQty))}" data-id="${esc(id)}"></td>
        <td class="wsm-mass-result" id="si-transfer-result-${esc(id)}"></td>
      </tr>`;
    }).join("");

    panel.innerHTML = `
      <div class="wsm-resolve-box">
        <div class="wsm-panel-title">Create Transfer Order — ${rows.length} row(s) out of holding</div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Dest. Bin Type <span class="tf-req">*</span></label><input class="tf-input" id="si-transfer-desttype" type="text" placeholder="e.g. 001"></div>
          <div class="tf-field"><label class="tf-label">Dest. Bin <span class="tf-req">*</span></label><input class="tf-input" id="si-transfer-destbin" type="text" placeholder="e.g. B-02-03"></div>
        </div>
        <div class="wsm-mass-table-wrap">
          <table class="wsm-mass-table"><thead><tr><th>Material</th><th>Loc./Batch</th><th>Qty</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table>
        </div>
        <div class="tf-actions">
          <div id="si-transfer-summary"></div>
          <button type="button" class="btn-secondary" id="si-transfer-cancel">Cancel</button>
          <button type="button" class="btn-submit" id="si-transfer-submit">Create ${rows.length} Transfer Order(s)</button>
        </div>
      </div>`;

    document.getElementById("si-transfer-cancel").addEventListener("click", () => { panel.innerHTML = ""; });
    document.getElementById("si-transfer-submit").addEventListener("click", async () => {
      const destType = document.getElementById("si-transfer-desttype").value.trim();
      const destBin = document.getElementById("si-transfer-destbin").value.trim();
      const summaryEl = document.getElementById("si-transfer-summary");
      if (!destType || !destBin) {
        summaryEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Destination bin type and bin are required.</div>`;
        return;
      }

      const submitBtn = document.getElementById("si-transfer-submit");
      submitBtn.disabled = true;
      const progress = showProgressBanner(summaryEl, rows.length, "Creating transfer orders");
      let ok = 0, fail = 0;
      const failures = [];

      const sendable = [];
      for (const row of rows) {
        const id = rowId(row);
        const qtyInput = document.querySelector(`.si-transfer-qty[data-id="${CSS.escape(id)}"]`);
        const resultCell = document.getElementById(`si-transfer-result-${id}`);
        const quantity = parseFloat((qtyInput?.value || "").replace(",", "."));
        if (!quantity || quantity <= 0) {
          fail++; failures.push("Missing/invalid qty");
          if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ Missing/invalid qty</span>`;
          continue;
        }
        sendable.push({ row, resultCell, quantity });
      }
      progress.update(rows.length - sendable.length);

      if (sendable.length) {
        const paramsList = sendable.map(({ row, quantity }) => ({
          storageLocation: row.storageLocation, material: row.material, batch: row.batch || "",
          quantity, sourceType: row.storageType, sourceBin: row.bin,
          destinationType: destType, destinationBin: destBin,
          stockCategory: row.stockCategory || "", specialStockIndicator: row.specialStockInd || "", specialStockNumber: row.specialStockNum || "",
        }));
        const results = await createBatchCleanupTransfersBulk(paramsList);
        results.forEach((result, i) => {
          const { resultCell } = sendable[i];
          if (result.success) { ok++; if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-ok">✓ ${esc(result.message)}</span>`; }
          else { fail++; failures.push(result.message); if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ ${esc(result.message)}</span>`; }
        });
      }

      progress.update(rows.length);
      progress.finish(ok, fail, failures);
      if (ok) {
        submitBtn.textContent = "Done — refreshing…";
        await refreshInvestigationCard();
      } else {
        submitBtn.disabled = false;
      }
    });
  }

  // Movement type depends on both direction (top up vs. write down) and
  // stock category — plain unrestricted stock uses 711/712, but SAP won't
  // post 711/712 against category 'S' (blocked) stock, which needs 717/718
  // instead. Shared by the preview table and the actual submit loop.
  function movementTypeFor(row) {
    const isBlocked = row.stockCategory === "S";
    if (row.availableQty < 0) return isBlocked ? "718" : "712";
    return isBlocked ? "717" : "711";
  }

  function showAdjustmentPanel() {
    const rows = selectedRows();
    const panel = document.getElementById("si-action-panel");
    if (!panel || !rows.length) return;

    const rowsHtml = rows.map((row) => {
      const id = rowId(row);
      return `<tr data-id="${esc(id)}">
        <td>${esc(row.material)}</td>
        <td class="wsm-mono">${esc(row.storageLocation)}${row.batch ? ` · ${esc(row.batch)}` : ""}</td>
        <td>${row.availableQty}</td>
        <td class="wsm-mono">${movementTypeFor(row)}</td>
        <td class="wsm-mass-result" id="si-adjust-result-${esc(id)}"></td>
      </tr>`;
    }).join("");

    panel.innerHTML = `
      <div class="wsm-resolve-box">
        <div class="wsm-panel-title">Create Stock Adjustment — ${rows.length} row(s)</div>
        <div class="wsm-panel-sub">Negative quantities post a 712 to bring the bin up to zero; positive quantities post a 711 to bring it down to zero — except stock category 'S' (blocked), which uses 718/717 instead. Each row is corrected by exactly the amount it's currently off by — nothing else is adjusted.</div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Reference / Reason <span class="tf-req">*</span></label><input class="tf-input" id="si-adjust-reference" type="text" placeholder="e.g. stocktake corr."></div>
        </div>
        <div class="wsm-mass-table-wrap">
          <table class="wsm-mass-table"><thead><tr><th>Material</th><th>Loc./Batch</th><th>Qty</th><th>Movement</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table>
        </div>
        <div class="tf-actions">
          <div id="si-adjust-summary"></div>
          <button type="button" class="btn-secondary" id="si-adjust-cancel">Cancel</button>
          <button type="button" class="btn-submit" id="si-adjust-submit">Post ${rows.length} Adjustment(s)</button>
        </div>
      </div>`;

    document.getElementById("si-adjust-cancel").addEventListener("click", () => { panel.innerHTML = ""; });
    document.getElementById("si-adjust-submit").addEventListener("click", async () => {
      const reference = document.getElementById("si-adjust-reference").value.trim();
      const summaryEl = document.getElementById("si-adjust-summary");
      if (!reference) {
        summaryEl.innerHTML = `<div class="sap-error tf-inline-error">✕ A reference/reason is required.</div>`;
        return;
      }
      if (!await NexusModal.confirm(`Post ${rows.length} stock adjustment(s) to zero out the selected holding-bin stock? This posts directly to SAP and can't be undone from here.`, { title: "Post Stock Adjustment", confirmLabel: "Post", danger: true })) return;

      const submitBtn = document.getElementById("si-adjust-submit");
      submitBtn.disabled = true;
      const progress = showProgressBanner(summaryEl, rows.length, "Posting stock adjustments");

      const entries = rows.map((row) => ({
        resultCell: document.getElementById(`si-adjust-result-${rowId(row)}`),
        params: {
          material: row.material, storageLocation: row.storageLocation, storageType: row.storageType, storageBin: row.bin,
          movementType: movementTypeFor(row), quantity: Math.abs(row.availableQty), unit: "", reference,
        },
      }));

      const results = await createStockAdjustmentsBulk(entries.map((e) => e.params));
      let ok = 0, fail = 0;
      const failures = [];
      results.forEach((result, i) => {
        const { resultCell } = entries[i];
        if (result.success) { ok++; if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-ok">✓ Doc ${esc(result.materialDocument || "")}</span>`; }
        else { fail++; failures.push(result.message); if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ ${esc(result.message)}</span>`; }
      });

      progress.update(rows.length);
      progress.finish(ok, fail, failures);
      if (ok) {
        submitBtn.textContent = "Done — refreshing…";
        await refreshInvestigationCard();
      } else {
        submitBtn.disabled = false;
      }
    });
  }

  async function createStockAdjustmentsBulk(items) {
    try {
      const { data } = await api("/stock-adjustment-bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
      return data.map((item) => {
        if (!item.success) return { success: false, message: item.error };
        if (!item.data.success) return { success: false, message: "SAP rejected the adjustment." };
        return { success: true, materialDocument: item.data.materialDocument, message: "Posted" };
      });
    } catch (err) {
      return items.map(() => ({ success: false, message: err.message }));
    }
  }

  renderHome();
})();
