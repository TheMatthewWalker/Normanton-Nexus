// Schedule Agreement Waterfall tile — port of private/js/salesWaterfall.js +
// salesWaterfallPivot.js's window.SalesWaterfallReport. buildWaterfallPivot
// is ported verbatim (pure data transform, no DOM). The rendered grid is
// deliberately simplified from the Node original: no sticky label columns
// and no rowspan-merged repeated-value cells (the closest DOM equivalent of
// the source Excel PivotTable's frozen panes) — a straightforward table
// with the label columns repeated on every row instead, same "simplify
// visual polish while keeping behavior correct" precedent Engineering's
// pivot-adjacent tiles already established. Cumulative/raw toggle and every
// filter behave identically to the Node original.
(function () {
  const formEl = document.getElementById("wf-filters");
  const msgEl = document.getElementById("wf-msg");
  const toolbarEl = document.getElementById("wf-toolbar");
  const toggleBtn = document.getElementById("wf-toggle-cumulative");
  const rowCountEl = document.getElementById("wf-row-count");
  const gridEl = document.getElementById("wf-grid");

  const LABEL_COLS = [
    { key: "shipToParty", label: "Ship-to" },
    { key: "material", label: "Material" },
    { key: "idocWeek", label: "Idoc Week" },
    { key: "idocCreationDate", label: "Idoc Date" },
    { key: "idocNumber", label: "Release" },
  ];

  let lastRows = null;
  let cumulative = false;

  // Splits on commas, whitespace or newlines — lets a user paste a column
  // out of Excel (one value per line) or type a quick comma-separated list.
  function splitList(text) {
    return String(text || "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function formatQty(n) {
    const v = Number(n) || 0;
    return v.toLocaleString("en-GB", { maximumFractionDigits: 0 });
  }

  function buildQuery(filters) {
    const p = new URLSearchParams();
    p.set("salesOrg", filters.salesOrg);
    filters.shipToParties.forEach((v) => p.append("shipToParties", v));
    filters.materials.forEach((v) => p.append("materials", v));
    p.set("scheduleDateFrom", filters.scheduleDateFrom);
    p.set("scheduleDateTo", filters.scheduleDateTo);
    p.set("includeForecast", String(filters.includeForecast));
    p.set("includeJit", String(filters.includeJit));
    p.set("includeZeroQty", String(filters.includeZeroQty));
    if (filters.idocCreatedAfter) p.set("idocCreatedAfter", filters.idocCreatedAfter);
    return p.toString();
  }

  async function salesApi(path) {
    const r = await fetch("/api/sales" + path, { headers: { Accept: "application/json" } });
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

  // Ported verbatim from salesWaterfallPivot.js's buildWaterfallPivot.
  function buildWaterfallPivot(rows, options) {
    const opts = options || {};
    const useCumulative = !!opts.cumulative;
    const weekSet = new Set();
    const groups = new Map();

    for (const row of rows || []) {
      if (!row || !row.scheduleWeek) continue;
      weekSet.add(row.scheduleWeek);

      const releaseKey = row.isCurrent ? "current" : row.idocNumber;
      const key = [row.shipToParty, row.material, row.idocWeek, row.idocCreationDate, releaseKey].join("|");

      let group = groups.get(key);
      if (!group) {
        group = {
          shipToParty: row.shipToParty,
          material: row.material,
          materialDescription: row.materialDescription,
          idocWeek: row.idocWeek,
          idocCreationDate: row.idocCreationDate,
          idocNumber: row.isCurrent ? "Current" : row.idocNumber,
          isCurrent: !!row.isCurrent,
          cells: new Map(),
        };
        groups.set(key, group);
      }

      const value = useCumulative ? row.cumulativeRelease || 0 : row.orderQty || 0;
      const existing = group.cells.get(row.scheduleWeek);
      group.cells.set(row.scheduleWeek, existing === undefined ? value : useCumulative ? Math.max(existing, value) : existing + value);
    }

    const weeks = Array.from(weekSet).sort((a, b) => a - b);
    const pivotRows = Array.from(groups.values()).sort(
      (a, b) =>
        String(a.shipToParty).localeCompare(String(b.shipToParty)) ||
        String(a.material).localeCompare(String(b.material)) ||
        a.idocWeek - b.idocWeek ||
        String(a.idocCreationDate || "").localeCompare(String(b.idocCreationDate || "")) ||
        String(a.idocNumber).localeCompare(String(b.idocNumber))
    );

    return { weeks, rows: pivotRows };
  }

  function renderPivotTable(pivot) {
    gridEl.innerHTML = "";
    if (pivot.rows.length === 0) {
      gridEl.textContent = "No schedule agreement data for these filters.";
      return;
    }

    const wrap = document.createElement("div");
    wrap.style.overflow = "auto";
    wrap.style.maxHeight = "65vh";

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const col of LABEL_COLS) {
      const th = document.createElement("th");
      th.textContent = col.label;
      headRow.appendChild(th);
    }
    for (const w of pivot.weeks) {
      const th = document.createElement("th");
      const s = String(w);
      th.textContent = `${s.slice(0, 4)} wk${s.slice(4)}`;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const tbody = document.createElement("tbody");
    for (const row of pivot.rows) {
      const tr = document.createElement("tr");
      if (row.isCurrent) tr.style.background = "rgba(37,99,235,0.06)";

      for (const col of LABEL_COLS) {
        const td = document.createElement("td");
        if (col.key === "material") {
          td.textContent = row.materialDescription ? `${row.material} — ${row.materialDescription}` : row.material;
        } else {
          td.textContent = row[col.key] ?? "";
        }
        tr.appendChild(td);
      }
      for (const w of pivot.weeks) {
        const td = document.createElement("td");
        td.style.textAlign = "right";
        const v = row.cells.get(w);
        td.textContent = v === undefined ? "" : formatQty(v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    gridEl.appendChild(wrap);
  }

  function renderGrid() {
    if (!lastRows) return;
    const pivot = buildWaterfallPivot(lastRows, { cumulative });
    renderPivotTable(pivot);
    rowCountEl.textContent = `${lastRows.length} row(s) · ${pivot.rows.length} release(s) · ${pivot.weeks.length} schedule week(s)`;
    toggleBtn.textContent = cumulative ? "Show Raw Quantity" : "Show Cumulative";
  }

  toggleBtn.addEventListener("click", () => {
    cumulative = !cumulative;
    renderGrid();
  });

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    msgEl.textContent = "";

    const filters = {
      salesOrg: document.getElementById("wf-salesorg").value.trim(),
      shipToParties: splitList(document.getElementById("wf-shipto").value),
      materials: splitList(document.getElementById("wf-material").value),
      idocCreatedAfter: document.getElementById("wf-idocdate").value,
      scheduleDateFrom: document.getElementById("wf-datefrom").value,
      scheduleDateTo: document.getElementById("wf-dateto").value,
      includeForecast: document.getElementById("wf-forecast").checked,
      includeJit: document.getElementById("wf-jit").checked,
      includeZeroQty: document.getElementById("wf-zeroqty").checked,
    };

    if (!filters.salesOrg || !filters.shipToParties.length || !filters.scheduleDateFrom || !filters.scheduleDateTo) {
      msgEl.textContent = "Sales Org, Ship-to and the Schedule Date range are required.";
      return;
    }

    toolbarEl.style.display = "none";
    gridEl.textContent = "Querying SAP…";

    try {
      const json = await salesApi("/schedule-waterfall?" + buildQuery(filters));
      lastRows = json.data || [];
      cumulative = false;
      toolbarEl.style.display = "flex";
      renderGrid();
    } catch (err) {
      lastRows = null;
      gridEl.textContent = "";
      msgEl.textContent = err.message;
    }
  });
})();
