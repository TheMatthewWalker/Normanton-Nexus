// Display Stock tile — ported from private/js/quality.js's displayStock()/
// renderStockTable()/renderPage() (lines ~109-380 in the Node original).
// Simplified from a right-click context menu to an inline per-row action
// link (same underlying API calls, simpler and more discoverable) — see
// Pages/Quality/Stock.cshtml.cs's own comments.
(function () {
  const COLS = [
    ["storageLocation", "Storage Loc"],
    ["storageType", "Storage Type"],
    ["bin", "Storage Bin"],
    ["material", "Material"],
    ["availableQty", "Qty"],
    ["batch", "Batch"],
    ["stockCategory", "Stock Cat"],
    ["specialStockInd", "Spc Stock"],
    ["specialStockNum", "Spc Stock No"],
  ];
  const PAGE_SIZES = [25, 50, 100, 200];

  const rowCountEl = document.getElementById("q-row-count");
  const filterRowEl = document.getElementById("q-filter-row");
  const bodyEl = document.getElementById("q-stock-body");
  const paginationEl = document.getElementById("q-pagination");
  const selectAllCheckbox = document.getElementById("q-select-all");
  const selectionBar = document.getElementById("q-selection-bar");
  const selectionCountEl = document.getElementById("q-selection-count");
  const bulkModal = document.getElementById("q-bulk-modal");
  const bulkTitleEl = document.getElementById("q-bulk-title");
  const bulkBodyEl = document.getElementById("q-bulk-body");

  let allRows = [];
  let filteredRows = [];
  let currentPage = 1;
  let pageSize = PAGE_SIZES[0];
  const filters = {};
  const selectedKeys = new Set();

  function rowKey(row) {
    return COLS.map(([key]) => String(row[key] ?? "").trim()).join("|");
  }

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

  async function loadStock() {
    bodyEl.innerHTML = `<tr><td colspan="${COLS.length + 2}">Loading…</td></tr>`;
    try {
      const { data } = await api("/api/quality/display");
      allRows = data;
      applyFilters();
    } catch (err) {
      bodyEl.innerHTML = `<tr><td colspan="${COLS.length + 2}" class="result-fail">${err.message}</td></tr>`;
    }
  }

  function applyFilters() {
    filteredRows = allRows.filter((row) =>
      Object.entries(filters).every(
        ([col, needle]) => !needle || String(row[col] ?? "").toLowerCase().includes(needle)
      )
    );
    // Drop selections that no longer match the active filter.
    const filteredKeys = new Set(filteredRows.map(rowKey));
    for (const key of [...selectedKeys]) {
      if (!filteredKeys.has(key)) selectedKeys.delete(key);
    }
    currentPage = 1;
    renderFilterRow();
    renderPage();
    updateSelectionBar();
  }

  function renderFilterRow() {
    filterRowEl.innerHTML = "";
    filterRowEl.appendChild(document.createElement("th"));
    for (const [key] of COLS) {
      const th = document.createElement("th");
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "filter…";
      input.style.width = "100%";
      input.addEventListener("input", () => {
        filters[key] = input.value.trim().toLowerCase();
        applyFilters();
      });
      th.appendChild(input);
      filterRowEl.appendChild(th);
    }
    filterRowEl.appendChild(document.createElement("th"));
  }

  function renderPage() {
    const total = filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * pageSize;
    const slice = filteredRows.slice(start, start + pageSize);

    bodyEl.innerHTML = "";
    for (const row of slice) {
      const key = rowKey(row);
      const tr = document.createElement("tr");

      const checkTd = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedKeys.has(key);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedKeys.add(key);
        else selectedKeys.delete(key);
        updateSelectionBar();
      });
      checkTd.appendChild(checkbox);
      tr.appendChild(checkTd);

      for (const [colKey] of COLS) {
        const td = document.createElement("td");
        if (colKey === "stockCategory") {
          const badge = document.createElement("span");
          badge.textContent = row.isBlocked ? "Blocked" : "Unrestricted";
          badge.className = row.isBlocked ? "result-fail" : "result-ok";
          td.appendChild(badge);
        } else {
          td.textContent = row[colKey] ?? "";
        }
        tr.appendChild(td);
      }

      const actionTd = document.createElement("td");
      const actionLink = document.createElement("a");
      actionLink.href = "#";
      actionLink.textContent = row.isBlocked ? "Unblock" : "Block";
      actionLink.addEventListener("click", (e) => {
        e.preventDefault();
        window.location.href = `${row.isBlocked ? "UnblockStock" : "BlockStock"}?material=${encodeURIComponent(row.material)}`;
      });
      actionTd.appendChild(actionLink);
      tr.appendChild(actionTd);

      bodyEl.appendChild(tr);
    }

    rowCountEl.textContent =
      total === allRows.length ? `${total} rows` : `${total} / ${allRows.length} rows`;

    renderPagination(totalPages, total, start, slice.length);
    syncSelectAllCheckbox(slice.map(rowKey));
  }

  function renderPagination(totalPages, total, start, sliceLength) {
    paginationEl.innerHTML = "";

    const sizeSelect = document.createElement("select");
    for (const size of PAGE_SIZES) {
      const option = document.createElement("option");
      option.value = String(size);
      option.textContent = `${size} / page`;
      option.selected = size === pageSize;
      sizeSelect.appendChild(option);
    }
    sizeSelect.addEventListener("change", () => {
      pageSize = Number(sizeSelect.value);
      currentPage = 1;
      renderPage();
    });
    paginationEl.appendChild(sizeSelect);

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "secondary";
    prevBtn.textContent = "Prev";
    prevBtn.disabled = currentPage <= 1;
    prevBtn.addEventListener("click", () => {
      currentPage--;
      renderPage();
    });
    paginationEl.appendChild(prevBtn);

    const info = document.createElement("span");
    info.textContent =
      total === 0 ? "No rows match" : `Showing ${start + 1}–${start + sliceLength} of ${total} (page ${currentPage}/${totalPages})`;
    paginationEl.appendChild(info);

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "secondary";
    nextBtn.textContent = "Next";
    nextBtn.disabled = currentPage >= totalPages;
    nextBtn.addEventListener("click", () => {
      currentPage++;
      renderPage();
    });
    paginationEl.appendChild(nextBtn);
  }

  function syncSelectAllCheckbox(pageKeys) {
    const allSelected = pageKeys.length > 0 && pageKeys.every((k) => selectedKeys.has(k));
    selectAllCheckbox.checked = allSelected;
  }

  selectAllCheckbox.addEventListener("change", () => {
    const start = (currentPage - 1) * pageSize;
    const slice = filteredRows.slice(start, start + pageSize);
    for (const row of slice) {
      const key = rowKey(row);
      if (selectAllCheckbox.checked) selectedKeys.add(key);
      else selectedKeys.delete(key);
    }
    renderPage();
    updateSelectionBar();
  });

  document.getElementById("q-clear-selection").addEventListener("click", () => {
    selectedKeys.clear();
    renderPage();
    updateSelectionBar();
  });

  function selectedRows() {
    return filteredRows.filter((r) => selectedKeys.has(rowKey(r)));
  }

  function updateSelectionBar() {
    const selected = selectedRows();
    const unblocked = selected.filter((r) => !r.isBlocked);
    const blocked = selected.filter((r) => r.isBlocked);

    selectionBar.hidden = selected.length === 0;
    selectionCountEl.textContent = `${selected.length} selected`;

    const blockBtn = document.getElementById("q-bulk-block");
    const unblockBtn = document.getElementById("q-bulk-unblock");
    blockBtn.textContent = `Block Selected (${unblocked.length})`;
    blockBtn.disabled = unblocked.length === 0;
    blockBtn.onclick = () => startBulk("block", unblocked);
    unblockBtn.textContent = `Unblock Selected (${blocked.length})`;
    unblockBtn.disabled = blocked.length === 0;
    unblockBtn.onclick = () => startBulk("unblock", blocked);
  }

  function closeBulkModal() {
    bulkModal.hidden = true;
    bulkBodyEl.innerHTML = "";
  }

  function startBulk(direction, rows) {
    bulkTitleEl.textContent = direction === "block" ? "Bulk Block Stock" : "Bulk Unblock Stock";
    bulkBodyEl.innerHTML = `
      <label for="q-bulk-header">Header / Reference</label>
      <input type="text" id="q-bulk-header" maxlength="25" placeholder="e.g. Bulk hold — Q.Control" />
      <div style="display:flex; gap:0.5rem; margin-top:0.75rem;">
        <button type="button" id="q-bulk-go">Start</button>
        <button type="button" class="secondary" id="q-bulk-cancel">Cancel</button>
      </div>`;
    bulkModal.hidden = false;

    document.getElementById("q-bulk-cancel").addEventListener("click", closeBulkModal);
    document.getElementById("q-bulk-go").addEventListener("click", () => {
      const header = document.getElementById("q-bulk-header").value.trim();
      runBulk(direction, rows, header);
    });
  }

  async function runBulk(direction, rows, header) {
    bulkBodyEl.innerHTML = `
      <div id="q-bulk-progress-text">0 / ${rows.length}</div>
      <div style="background:#e5e7eb; border-radius:4px; height:10px; margin:0.5rem 0;">
        <div id="q-bulk-progress-bar" style="background:#2563eb; height:100%; width:0%; border-radius:4px;"></div>
      </div>
      <div id="q-bulk-results" style="max-height:200px; overflow-y:auto; font-size:0.85rem;"></div>
      <button type="button" id="q-bulk-close" style="margin-top:0.75rem;" disabled>Close</button>`;

    const progressText = document.getElementById("q-bulk-progress-text");
    const progressBar = document.getElementById("q-bulk-progress-bar");
    const resultsEl = document.getElementById("q-bulk-results");
    const closeBtn = document.getElementById("q-bulk-close");
    closeBtn.addEventListener("click", () => {
      closeBulkModal();
      selectedKeys.clear();
      loadStock();
    });

    const bulkRows = rows.map((r) => ({
      material: r.material,
      quantity: r.availableQty,
      batch: r.batch || null,
      storageLocation: r.storageLocation,
      storageType: r.storageType || null,
      storageBin: r.bin || null,
      specialStockIndicator: r.specialStockInd || null,
      specialStockNumber: r.specialStockNum || null,
    }));

    try {
      const response = await fetch("/api/quality/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: bulkRows, direction, header }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Request failed (HTTP ${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIndex;
        while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const evt = JSON.parse(line.slice("data: ".length));
          handleBulkEvent(evt, rows.length, progressText, progressBar, resultsEl);
        }
      }
    } catch (err) {
      resultsEl.innerHTML += `<div class="result-fail">${err.message}</div>`;
    } finally {
      closeBtn.disabled = false;
    }
  }

  function handleBulkEvent(evt, total, progressText, progressBar, resultsEl) {
    if (evt.type === "progress") {
      progressText.textContent = `${evt.done} / ${total}`;
      progressBar.style.width = `${Math.round((evt.done / total) * 100)}%`;
      const line = document.createElement("div");
      line.className = evt.success ? "result-ok" : "result-fail";
      line.textContent = evt.success ? `✓ ${evt.material} — ${evt.message}` : `✗ ${evt.material} — ${evt.error}`;
      resultsEl.prepend(line);
    } else if (evt.type === "complete") {
      progressBar.style.width = "100%";
      progressText.textContent = `${total} / ${total} — complete`;
    }
  }

  loadStock();
})();
