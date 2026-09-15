// Stock Management tile — full port of private/js/warehouse.js's
// runStockManagement()/wsm* functions (single/mass Transfer Order creation,
// negative-stock reversal, consignment MB1B branching, bin-type auto-lookup,
// CSV export). Deliberately matches Node's exact CSS classes (wsm-*/tf-*) and
// interaction model — split-screen list + transfer panel, no modal — per
// explicit user direction to keep the look as close to Node as possible.
//
// Batch Discrepancies (Node's wsmAnalyzeBatches/wsmRenderDiscrepancyDashboard
// and friends) is a Stock Investigations concern, not Stock Management's own
// — see stock-investigations.js.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/warehouse");
  const root = document.getElementById("sm-root");

  const wsm = { rows: [], lastParams: {}, selected: new Set() };
  let pager = null;

  // ── Filter fields ──────────────────────────────────────────────────────
  const FILTER_FIELDS = [
    { key: "material", label: "Material", placeholder: "e.g. TSHV% for wildcard" },
    { key: "batch", label: "Batch" },
    { key: "storageType", label: "Storage Type" },
    { key: "bin", label: "Bin" },
    { key: "storageLocation", label: "Storage Loc." },
    { key: "stockCategory", label: "Stock Cat." },
    { key: "profitCentre", label: "Profit Centre" },
  ];

  function rowId(row) {
    return [row.storageLocation, row.storageType, row.bin, row.material, row.batch, row.stockCategory, row.specialStockInd, row.specialStockNum].join("¦");
  }

  function readFilterParams() {
    const params = {};
    root.querySelectorAll(".wsm-filter-input").forEach((input) => {
      const val = input.value.trim();
      if (val) params[input.dataset.key] = val;
    });
    return params;
  }

  async function fetchStock(params) {
    const qs = new URLSearchParams(params).toString();
    const { data } = await api(`/stock${qs ? `?${qs}` : ""}`);
    return (data || []).map((r) => ({ ...r, availableQty: Number(r.availableQty) || 0 }));
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  function renderLayout() {
    root.innerHTML = `
      <div class="wsm-layout">
        <div class="wsm-list-panel">
          <div class="wsm-filters">
            ${FILTER_FIELDS.map((f) => `
              <div class="wsm-filter-field">
                <label class="tf-label">${esc(f.label)}</label>
                <input class="tf-input wsm-filter-input" type="text" data-key="${f.key}" placeholder="${esc(f.placeholder || f.label)}">
              </div>`).join("")}
            <button type="button" class="btn-submit wsm-search-btn" id="wsm-search-btn">Search</button>
            <button type="button" class="btn-secondary wsm-clear-btn" id="wsm-clear-filters">Clear</button>
            <button type="button" class="btn-secondary wsm-export-btn" id="wsm-export-btn">Download CSV</button>
          </div>
          <div id="wsm-row-badge" class="row-badge hidden" style="margin-bottom:8px;"></div>
          <div class="wsm-table-wrap" id="wsm-table-wrap">
            <div class="wsm-empty">Enter search criteria above and press Search — nothing is pulled from SAP until you do.</div>
          </div>
          <div id="wsm-pager" class="nx-pager hidden"></div>
        </div>
        <div class="wsm-transfer-panel" id="wsm-transfer-panel">${emptyPanelHtml()}</div>
      </div>`;

    document.getElementById("wsm-search-btn").addEventListener("click", () => runSearch());
    root.querySelectorAll(".wsm-filter-input").forEach((input) => {
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(); } });
    });
    document.getElementById("wsm-clear-filters").addEventListener("click", () => {
      root.querySelectorAll(".wsm-filter-input").forEach((i) => { i.value = ""; });
    });
    document.getElementById("wsm-export-btn").addEventListener("click", () => exportCsv());
  }

  function emptyPanelHtml() {
    return `<div class="wsm-panel-empty">Select one or more rows from the list to create a Transfer Order.</div>`;
  }

  async function runSearch() {
    const params = readFilterParams();
    wsm.lastParams = params;
    wsm.selected = new Set();

    const wrap = document.getElementById("wsm-table-wrap");
    wrap.innerHTML = `<div class="sap-loading"><div class="spinner"></div>Querying SAP…</div>`;
    document.getElementById("wsm-row-badge").classList.add("hidden");
    renderTransferPanel();

    try {
      wsm.rows = await fetchStock(params);
      renderTable();
    } catch (err) {
      wrap.innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
    }
  }

  function fmtGrDate(v) {
    if (!v || !/^\d{8}$/.test(v) || v === "00000000") return "—";
    return `${v.slice(6, 8)}.${v.slice(4, 6)}.${v.slice(0, 4)}`;
  }

  function exportCsv() {
    if (!wsm.rows.length) return;
    const columns = [
      ["storageLocation", "Storage Location"], ["storageType", "Storage Type"], ["bin", "Bin"],
      ["material", "Material"], ["availableQty", "Available Qty"], ["batch", "Batch"],
      ["stockCategory", "Stock Category"], ["specialStockInd", "Special Stock"], ["specialStockNum", "Special Stock No."],
      ["profitCentre", "Profit Centre"], ["grDate", "GR Date"],
    ];
    const lines = [
      columns.map(([, label]) => label).join(","),
      ...wsm.rows.map((row) => columns.map(([key]) => `"${String(row[key] ?? "").replace(/"/g, '""')}"`).join(",")),
    ];
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `stock-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Table ───────────────────────────────────────────────────────────────
  function renderTable() {
    const wrap = document.getElementById("wsm-table-wrap");
    const pagerEl = document.getElementById("wsm-pager");
    const badge = document.getElementById("wsm-row-badge");

    if (!wsm.rows.length) {
      wrap.innerHTML = `<div class="wsm-empty">No stock matches this search.</div>`;
      pagerEl.classList.add("hidden");
      badge.textContent = "0 rows";
      badge.classList.remove("hidden");
      return;
    }

    wrap.innerHTML = `
      <table class="wsm-table">
        <thead>
          <tr>
            <th class="wsm-td-check"><input type="checkbox" id="wsm-select-all"></th>
            <th>Storage Loc.</th><th>Storage Type</th><th>Bin</th><th>Material</th>
            <th>Available Qty</th><th>Batch</th><th>Stock Cat.</th><th>Special Stock</th><th>Special Stock No.</th>
            <th>Profit Centre</th><th>GR Date</th>
          </tr>
        </thead>
        <tbody id="wsm-tbody"></tbody>
      </table>`;

    pager = NexusTable.paginate({
      container: document.getElementById("wsm-tbody"),
      pagerContainer: pagerEl,
      pageSize: 25,
      renderRows: (pageRows) => pageRows.map((row) => {
        const id = rowId(row);
        const neg = row.availableQty < 0;
        const checked = wsm.selected.has(id) ? " checked" : "";
        return `<tr class="wsm-row${neg ? " wsm-row--negative" : ""}" data-id="${esc(id)}">
          <td class="wsm-td-check"><input type="checkbox" class="wsm-row-check" data-id="${esc(id)}"${checked}></td>
          <td>${esc(row.storageLocation)}</td>
          <td>${esc(row.storageType)}</td>
          <td>${esc(row.bin)}</td>
          <td>${esc(row.material)}</td>
          <td>${row.availableQty}</td>
          <td>${esc(row.batch || "—")}</td>
          <td>${esc(row.stockCategory || "—")}</td>
          <td>${esc(row.specialStockInd || "—")}</td>
          <td>${esc(row.specialStockNum || "—")}</td>
          <td>${esc(row.profitCentre || "—")}</td>
          <td>${fmtGrDate(row.grDate)}</td>
        </tr>`;
      }).join(""),
      onRendered: () => wireTableInteractions(),
    });
    pager.setRows(wsm.rows);

    syncSelectionUI();
  }

  function wireTableInteractions() {
    const selectAll = document.getElementById("wsm-select-all");
    if (selectAll) {
      selectAll.checked = wsm.rows.length > 0 && wsm.rows.every((r) => wsm.selected.has(rowId(r)));
      selectAll.addEventListener("change", (e) => {
        if (e.target.checked) wsm.rows.forEach((r) => wsm.selected.add(rowId(r)));
        else wsm.rows.forEach((r) => wsm.selected.delete(rowId(r)));
        syncSelectionUI();
        pager && pager.goTo(pager.currentPage);
      });
    }

    document.querySelectorAll(".wsm-row-check").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        e.stopPropagation();
        const id = cb.dataset.id;
        if (cb.checked) wsm.selected.add(id); else wsm.selected.delete(id);
        syncSelectionUI();
      });
    });

    document.querySelectorAll(".wsm-row").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".wsm-row-check")) return;
        const id = tr.dataset.id;
        if (wsm.selected.has(id)) wsm.selected.delete(id); else wsm.selected.add(id);
        syncSelectionUI();
        tr.querySelector(".wsm-row-check").checked = wsm.selected.has(id);
      });
    });
  }

  function syncSelectionUI() {
    const badge = document.getElementById("wsm-row-badge");
    if (badge) {
      badge.textContent = `${wsm.rows.length} rows${wsm.selected.size ? ` · ${wsm.selected.size} selected` : ""}`;
      badge.classList.remove("hidden");
    }
    renderTransferPanel();
  }

  function selectedRows() {
    return wsm.rows.filter((r) => wsm.selected.has(rowId(r)));
  }

  // ── Transfer panel ──────────────────────────────────────────────────────
  function renderTransferPanel() {
    const panel = document.getElementById("wsm-transfer-panel");
    if (!panel) return;
    const rows = selectedRows();
    if (!rows.length) { panel.innerHTML = emptyPanelHtml(); return; }
    if (rows.length === 1) { panel.innerHTML = singleTransferHtml(rows[0]); wireSingleTransfer(rows[0]); return; }
    panel.innerHTML = massTransferHtml(rows);
    wireMassTransfer(rows);
  }

  function prefillItem(label, value) {
    return `<div class="tf-field"><label class="tf-label">${esc(label)}</label><div class="tf-prefill-value">${esc(value)}</div></div>`;
  }

  function singleTransferHtml(row) {
    const isNegative = row.availableQty < 0;
    return `
      <div class="wsm-panel-title">Create Transfer Order</div>
      <div class="wsm-panel-sub">${esc(row.material)} · ${esc(row.storageType)}/${esc(row.bin)}</div>
      ${isNegative ? `<div class="wsm-disc-note">This bin is negative (${esc(row.availableQty)}). Stock can't be moved out of a bin that's already short, so this posts in reverse — the quantity below is pulled IN from the bin you choose below, moving the negative there instead of out of it.</div>` : ""}
      <form class="transfer-form" id="wsm-single-form">
        <div class="tf-prefill-grid">
          ${prefillItem("Storage Location", row.storageLocation)}
          ${prefillItem("Storage Type", row.storageType)}
          ${prefillItem("Bin", row.bin)}
          ${prefillItem("Material", row.material)}
          ${prefillItem("Batch", row.batch || "—")}
          ${prefillItem("Stock Category", row.stockCategory || "—")}
          ${prefillItem("Special Stock", row.specialStockInd || "—")}
          ${prefillItem("Special Stock No.", row.specialStockNum || "—")}
        </div>

        <div class="tf-section-label">Quantity</div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Quantity <span class="tf-req">*</span></label>
            <input class="tf-input" id="wsm-qty" type="number" step="any" value="${esc(Math.abs(row.availableQty))}" required>
          </div>
        </div>

        <div class="tf-section-label">${isNegative ? "Bin to Pull Stock From" : "Destination Bin"}</div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">${isNegative ? "Bin" : "Dest. Bin"} <span class="tf-req">*</span></label>
            <input class="tf-input" id="wsm-destbin" type="text" placeholder="e.g. B-02-03" required>
          </div>
          <div class="tf-field">
            <label class="tf-label">${isNegative ? "Type" : "Dest. Bin Type"} <span class="tf-req">*</span></label>
            <input class="tf-input" id="wsm-desttype" type="text" placeholder="Auto from bin" required disabled>
            <div id="wsm-destchoice"></div>
          </div>
        </div>

        <div class="tf-actions">
          <div id="wsm-single-result"></div>
          <button type="submit" class="btn-submit" id="wsm-single-submit">Create Transfer Order</button>
        </div>
      </form>`;
  }

  function wireSingleTransfer(row) {
    const form = document.getElementById("wsm-single-form");
    if (!form) return;

    wireBinTypeAutoLookup(document.getElementById("wsm-destbin"), document.getElementById("wsm-desttype"), {
      choiceEl: document.getElementById("wsm-destchoice"),
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById("wsm-single-submit");
      const resultEl = document.getElementById("wsm-single-result");
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending to SAP…";
      resultEl.innerHTML = "";

      const params = {
        storageLocation: row.storageLocation,
        material: row.material,
        batch: row.batch || "",
        quantity: parseFloat(document.getElementById("wsm-qty").value.replace(",", ".")),
        sourceType: row.storageType,
        sourceBin: row.bin,
        destinationType: document.getElementById("wsm-desttype").value.trim(),
        destinationBin: document.getElementById("wsm-destbin").value.trim(),
        stockCategory: row.stockCategory || "",
        specialStockIndicator: row.specialStockInd || "",
        specialStockNumber: row.specialStockNum || "",
        negativeStock: row.availableQty < 0,
      };

      const result = await createTransferOrder(params);
      resultEl.innerHTML = resultHtml(result);
      submitBtn.disabled = false;
      submitBtn.textContent = "Create Transfer Order";

      if (result.success) await refreshAfterTransfer();
    });
  }

  function massTransferHtml(rows) {
    const anyNegative = rows.some((r) => r.availableQty < 0);
    const rowsHtml = rows.map((row) => {
      const id = rowId(row);
      const isNegative = row.availableQty < 0;
      return `
        <tr data-id="${esc(id)}" class="${isNegative ? "wsm-row--negative" : ""}">
          <td>${esc(row.material)}${isNegative ? ' <span class="wsm-neg-tag" title="Negative stock — will pull IN from the bin below instead of moving out">reversed</span>' : ""}</td>
          <td class="wsm-mono">${esc(row.storageType)}/${esc(row.bin)}${row.batch ? ` · ${esc(row.batch)}` : ""}</td>
          <td><input class="tf-input wsm-mass-qty" type="number" step="any" value="${esc(Math.abs(row.availableQty))}" data-id="${esc(id)}"></td>
          <td class="wsm-mass-dest-cell" data-id="${esc(id)}">
            <input class="tf-input wsm-mass-destbin" type="text" placeholder="Bin" data-id="${esc(id)}">
             <input class="tf-input wsm-mass-desttype" type="text" placeholder="Type" data-id="${esc(id)}" disabled>
             <div class="wsm-mass-destchoice" data-id="${esc(id)}"></div>
          </td>
          <td class="wsm-mass-result" id="wsm-mass-result-${esc(id)}"></td>
        </tr>`;
    }).join("");

    return `
      <div class="wsm-panel-title">Mass Movement</div>
      <div class="wsm-panel-sub">${rows.length} rows selected</div>
      ${anyNegative ? `<div class="wsm-disc-note">Rows marked "reversed" are negative stock — since you can't move stock out of a bin that's already short, those are posted in reverse: the quantity is pulled IN from the bin you enter, moving the negative there instead.</div>` : ""}

      <div class="wsm-mass-mode">
        <label><input type="radio" name="wsm-mass-mode" value="shared" checked> Shared destination</label>
        <label><input type="radio" name="wsm-mass-mode" value="perrow"> Per-row destination</label>
      </div>

      <div class="wsm-mass-shared" id="wsm-mass-shared">
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Dest. Bin <span class="tf-req">*</span></label>
            <input class="tf-input" id="wsm-mass-shared-bin" type="text" placeholder="e.g. B-02-03">
          </div>
        <div class="tf-field">
            <label class="tf-label">Dest. Bin Type <span class="tf-req">*</span></label>
            <input class="tf-input" id="wsm-mass-shared-type" type="text" placeholder="Auto from bin" disabled>
            <div id="wsm-mass-shared-choice"></div>
          </div>
        </div>
      </div>

      <div class="wsm-mass-table-wrap">
        <table class="wsm-mass-table">
          <thead><tr><th>Material</th><th>From</th><th>Qty</th><th>Destination</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>

      <div class="tf-actions">
        <div id="wsm-mass-summary"></div>
        <button type="button" class="btn-submit" id="wsm-mass-submit">Create ${rows.length} Transfer Orders</button>
      </div>`;
  }

  // ── Progress banner ─────────────────────────────────────────────────────
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

  function wireMassTransfer(rows) {
    const modeRadios = document.querySelectorAll('input[name="wsm-mass-mode"]');
    const sharedFields = document.getElementById("wsm-mass-shared");
    const destCells = document.querySelectorAll(".wsm-mass-dest-cell");
    const massTable = document.querySelector(".wsm-mass-table");

    function applyMode() {
      const mode = document.querySelector('input[name="wsm-mass-mode"]:checked').value;
      sharedFields.style.display = mode === "shared" ? "" : "none";
      destCells.forEach((td) => { td.style.display = mode === "perrow" ? "" : "none"; });
      document.querySelector(".wsm-layout")?.classList.toggle("wsm-layout--mass", mode === "perrow");
      massTable?.classList.toggle("wsm-mass-table--shared", mode === "shared");
    }
    modeRadios.forEach((r) => r.addEventListener("change", applyMode));
    applyMode();

    wireBinTypeAutoLookup(document.getElementById("wsm-mass-shared-bin"), document.getElementById("wsm-mass-shared-type"), {
      choiceEl: document.getElementById("wsm-mass-shared-choice"),
    });
    rows.forEach((row) => {
      const id = rowId(row);
      wireBinTypeAutoLookup(
        document.querySelector(`.wsm-mass-destbin[data-id="${CSS.escape(id)}"]`),
        document.querySelector(`.wsm-mass-desttype[data-id="${CSS.escape(id)}"]`),
        {
          choiceEl: document.querySelector(`.wsm-mass-destchoice[data-id="${CSS.escape(id)}"]`),
        }
      );
    });

    document.getElementById("wsm-mass-submit").addEventListener("click", async () => {
      const mode = document.querySelector('input[name="wsm-mass-mode"]:checked').value;
      const submitBtn = document.getElementById("wsm-mass-submit");
      const summaryEl = document.getElementById("wsm-mass-summary");
      submitBtn.disabled = true;
      summaryEl.innerHTML = "";

      let sharedType = "", sharedBin = "";
      if (mode === "shared") {
        sharedType = document.getElementById("wsm-mass-shared-type").value.trim();
        sharedBin = document.getElementById("wsm-mass-shared-bin").value.trim();
        if (!sharedType || !sharedBin) {
          summaryEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Destination bin type and bin are required.</div>`;
          submitBtn.disabled = false;
          return;
        }
      }

      let successCount = 0, failCount = 0;
      const failMessages = [];
      const progress = showProgressBanner(summaryEl, rows.length, "Creating transfer orders");

      const sendable = [];
      rows.forEach((row) => {
        const id = rowId(row);
        const qtyInput = document.querySelector(`.wsm-mass-qty[data-id="${CSS.escape(id)}"]`);
        const resultCell = document.getElementById(`wsm-mass-result-${id}`);
        const quantity = parseFloat((qtyInput?.value || "").replace(",", "."));

        let destType = sharedType, destBin = sharedBin;
        if (mode === "perrow") {
          destType = document.querySelector(`.wsm-mass-desttype[data-id="${CSS.escape(id)}"]`)?.value.trim() || "";
          destBin = document.querySelector(`.wsm-mass-destbin[data-id="${CSS.escape(id)}"]`)?.value.trim() || "";
        }

        if (!quantity || quantity <= 0 || !destType || !destBin) {
          failCount++;
          failMessages.push("Missing qty/destination");
          if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ Missing qty/destination</span>`;
          return;
        }

        sendable.push({
          resultCell,
          params: {
            storageLocation: row.storageLocation, material: row.material, batch: row.batch || "",
            quantity, sourceType: row.storageType, sourceBin: row.bin,
            destinationType: destType, destinationBin: destBin,
            stockCategory: row.stockCategory || "", specialStockIndicator: row.specialStockInd || "",
            specialStockNumber: row.specialStockNum || "", negativeStock: row.availableQty < 0,
          },
        });
      });
      progress.update(rows.length - sendable.length);

      if (sendable.length) {
        const results = await createTransferOrdersBulk(sendable.map((s) => s.params));
        results.forEach((result, i) => {
          const { resultCell } = sendable[i];
          if (result.success) {
            successCount++;
            if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-ok">✓ ${esc(result.transferOrderNumber || "Done")}</span>`;
          } else {
            failCount++;
            failMessages.push(result.message);
            if (resultCell) resultCell.innerHTML = `<span class="wsm-mass-fail">✕ ${esc(result.message)}</span>`;
          }
        });
      }

      progress.update(rows.length);
      progress.finish(successCount, failCount, failMessages);
      if (successCount) {
        submitBtn.textContent = "Done — reselect rows to run again";
      } else {
        submitBtn.disabled = false;
        submitBtn.textContent = `Create ${rows.length} Transfer Orders`;
      }

      if (successCount) await refreshAfterTransfer();
    });
  }

  function resultHtml(result) {
    if (result.success) {
      return `<div class="tf-success">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
        <div><div class="tf-success-title">Transfer Order Created</div><div class="tf-success-to">${result.message}</div></div>
      </div>`;
    }
    return `<div class="sap-error tf-inline-error">✕ ${esc(result.message)}</div>`;
  }

  // ── SAP calls ───────────────────────────────────────────────────────────
  function buildTransferItem(rawParams) {
    let params = rawParams;
    if (params.negativeStock) {
      const { sourceType, sourceBin, destinationType, destinationBin } = params;
      params = { ...params, sourceType: destinationType, sourceBin: destinationBin, destinationType: sourceType, destinationBin: sourceBin };
    }
    const isConsignment = params.specialStockIndicator === "K" && params.destinationType === "SA";
    return { params, isConsignment };
  }

  function interpretTransferResult(params, isConsignment, data, error) {
    if (error) return { success: false, message: error };

    if (isConsignment) {
      const parts = [data?.mb1bMessage, data?.toNonConsignMessage, data?.toConsignMessage].filter(Boolean);
      return { success: true, message: parts.map(esc).join("<br>") || "Consignment processed", transferOrderNumber: null };
    }

    const transferOrder = data?.transferOrderNumber || "";
    const messages = data?.messages || [];
    const ok = data?.success;
    if (!ok) return { success: false, message: messages.map((m) => m.message || m).join("; ") || "SAP rejected the transfer order." };

    const lines = [];
    if (params.negativeStock) lines.push(`Negative stock — moved ${params.quantity} from ${esc(params.sourceType)}/${esc(params.sourceBin)} into ${esc(params.destinationType)}/${esc(params.destinationBin)} instead.`);
    if (transferOrder) lines.push(`Transfer Order: ${esc(transferOrder)}`);
    if (messages.length) lines.push(...messages.map((m) => esc(m.message || m)));
    return { success: true, message: lines.join("<br>") || "SAP returned no message", transferOrderNumber: transferOrder };
  }

  async function createTransferOrder(rawParams) {
    const { params, isConsignment } = buildTransferItem(rawParams);
    try {
      const { negativeStock, ...transferBody } = params;
      const { data } = await api(isConsignment ? "/consignment-mb1b" : "/transfer-order", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isConsignment
          ? { material: params.material, quantity: params.quantity, header: "Consignment", specialStockNumber: params.specialStockNumber, storageLocation: params.storageLocation, sourceType: params.sourceType, sourceBin: params.sourceBin, destinationType: params.destinationType, destinationBin: params.destinationBin }
          : transferBody),
      });
      return interpretTransferResult(params, isConsignment, data, null);
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  // Splits sendable rows into a bulk transfer-order-bulk call (SapServer's
  // STA worker pool load-balances these concurrently) and individually
  // awaited (but still Promise.all-concurrent) consignment-mb1b calls, since
  // the dotnet transfer-order-bulk endpoint — unlike Node's — only accepts
  // plain transfer items, not a mixed transfer/consignment item shape.
  // Functionally identical concurrency to Node's single mixed bulk call.
  async function createTransferOrdersBulk(rawParamsList) {
    const built = rawParamsList.map((raw) => ({ raw, ...buildTransferItem(raw) }));
    const results = new Array(built.length);

    const transferIdxs = built.map((b, i) => (b.isConsignment ? -1 : i)).filter((i) => i >= 0);
    const consignIdxs = built.map((b, i) => (b.isConsignment ? i : -1)).filter((i) => i >= 0);

    const tasks = [];

    if (transferIdxs.length) {
      tasks.push((async () => {
        try {
          const { data } = await api("/transfer-order-bulk", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: transferIdxs.map((i) => { const { negativeStock, ...body } = built[i].params; return body; }) }),
          });
          transferIdxs.forEach((i, k) => {
            const item = data[k];
            results[i] = item.success
              ? interpretTransferResult(built[i].params, false, item.data, null)
              : interpretTransferResult(built[i].params, false, null, item.error || "SAP call failed");
          });
        } catch (err) {
          transferIdxs.forEach((i) => { results[i] = { success: false, message: err.message }; });
        }
      })());
    }

    consignIdxs.forEach((i) => {
      tasks.push((async () => {
        results[i] = await createTransferOrder(built[i].raw);
      })());
    });

    await Promise.all(tasks);
    return results;
  }

  async function refreshAfterTransfer() {
    try {
      wsm.rows = await fetchStock(wsm.lastParams || {});
    } catch {
      return;
    }
    renderTable();
  }

  // ── Bin type auto-lookup ───────────────────────────────────────────────
  async function fetchBinStorageTypes(bin) {
    const { data } = await api(`/bin-storage-types?bin=${encodeURIComponent(bin)}`);
    return data || [];
  }

  function wireBinTypeAutoLookup(binInputEl, typeInputEl, opts = {}) {
    const { choiceEl, onResolved } = opts;
    if (!binInputEl || !typeInputEl) return;
    let lookupTimer;
    let lookupVersion = 0;

    async function run() {
      const bin = binInputEl.value.trim();
      const version = ++lookupVersion;
      typeInputEl.disabled = true;
      typeInputEl.readOnly = false;
      typeInputEl.value = "";
      if (choiceEl) choiceEl.innerHTML = "";
      if (!bin) return;

      let types;
      try { types = await fetchBinStorageTypes(bin); }
      catch { return; }
      if (version !== lookupVersion) return;

      if (types.length === 1) {
        typeInputEl.value = types[0];
        typeInputEl.disabled = true;
        onResolved?.(types[0]);
      } else if (types.length > 1 && choiceEl) {
        choiceEl.innerHTML = `<div class="tf-locked">Choose storage type</div>` +
          types.map((t) => `<label><input type="radio" name="bintype-${esc(binInputEl.id)}" value="${esc(t)}"> ${esc(t)}</label>`).join(" ");
        choiceEl.querySelectorAll("input[type=radio]").forEach((r) => r.addEventListener("change", () => {
          typeInputEl.value = r.value;
          typeInputEl.disabled = true;
          onResolved?.(r.value);
        }));
      }
    }

    binInputEl.addEventListener("input", () => {
      clearTimeout(lookupTimer);
      lookupVersion++;
      typeInputEl.disabled = true;
      typeInputEl.value = "";
      if (choiceEl) choiceEl.innerHTML = "";
      lookupTimer = setTimeout(run, 300);
    });
    binInputEl.addEventListener("blur", () => {
      clearTimeout(lookupTimer);
      run();
    });
    binInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(lookupTimer);
        run();
      }
    });
  }

  renderLayout();
})();
