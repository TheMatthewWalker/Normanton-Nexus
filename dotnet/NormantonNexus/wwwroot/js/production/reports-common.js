// Shared helpers for the 7 Production report pages — port of the common
// pieces of private/js/production-nexus.js's "REPORTS — shared helpers"
// section (rptFiltersHtml/rptWireFilters/rptParams/rptTable/wireExport).
// Loaded as a classic (non-module) script before each report page's own
// dedicated script, same load-order convention as session-guard.js.
// Charts are deliberately not ported (visual polish, same simplification
// every earlier department's report-adjacent tiles made) — every report
// still shows its real data as tables, CSV-exportable.
window.ProductionReports = (function () {
  async function api(path, opts) {
    const r = await fetch("/api/productionnexus" + path, opts);
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

  const PROCESS_LABELS = {
    MX: "Mixing",
    EX: "Extrusion",
    CO: "Convoluting",
    BR: "Braiding",
    CL: "Coverline",
    TW: "Tape Wrap",
    DR: "Drumming",
    EW: "Ewald",
    HA: "Hose Assembly",
    FW: "Firewall",
  };

  function fmtNum(n) {
    const v = Number(n);
    return isNaN(v) ? "—" : v.toLocaleString("en-GB", { maximumFractionDigits: 3 });
  }

  // Small `.badge` pill for a status-like table cell (a success/fail count,
  // a shift-name tag, etc.) — mirrors Logistics's own statusBadge/
  // directionBadge convention (see shipment-search.js). `kind` is one of
  // success/warn/error/accent, or omitted for the plain default badge.
  function badgeEl(text, kind) {
    const span = document.createElement("span");
    span.className = "badge" + (kind ? ` badge--${kind}` : "");
    span.textContent = text;
    return span;
  }

  // Builds the shared From/To/Process/Group-by filter bar into `container`,
  // as a `.tf-row`/`.tf-field` bar inside an `.nx-toolbar` (matching
  // ShipmentSearch's filter-bar convention); `onRun(filters)` fires when the
  // user clicks Run Report. Purely additive/visual over the original plain
  // flex-row layout — none of the fields built here carry an `id` any caller
  // depends on, and `onRun`'s filters shape (dateFrom/dateTo/processCode/
  // groupBy) is unchanged.
  function mountFilterBar(container, onRun) {
    container.innerHTML = "";
    const today = new Date().toISOString().slice(0, 10);
    const ago30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const toolbar = document.createElement("div");
    toolbar.className = "nx-toolbar";

    const row = document.createElement("div");
    row.className = "tf-row";
    row.style.flex = "1";
    row.style.marginBottom = "0";

    function field(labelText, el) {
      const div = document.createElement("div");
      div.className = "tf-field";
      const label = document.createElement("label");
      label.className = "tf-label";
      label.textContent = labelText;
      el.classList.add("tf-input");
      div.append(label, el);
      row.appendChild(div);
      return el;
    }

    const fromInput = field("From", Object.assign(document.createElement("input"), { type: "date", value: ago30 }));
    const toInput = field("To", Object.assign(document.createElement("input"), { type: "date", value: today }));

    const pcSelect = document.createElement("select");
    pcSelect.add(new Option("All processes", ""));
    for (const [code, label] of Object.entries(PROCESS_LABELS)) pcSelect.add(new Option(label, code));
    field("Process", pcSelect);

    const groupBySelect = document.createElement("select");
    for (const [v, label] of [
      ["day", "Day"],
      ["week", "Week"],
      ["month", "Month"],
    ]) {
      groupBySelect.add(new Option(label, v));
    }
    field("Group by", groupBySelect);

    const btnField = document.createElement("div");
    btnField.className = "tf-field";
    btnField.style.flex = "0 0 auto";
    btnField.style.justifyContent = "flex-end";
    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "btn";
    runBtn.textContent = "Run Report";
    btnField.appendChild(runBtn);
    row.appendChild(btnField);

    toolbar.appendChild(row);
    container.appendChild(toolbar);

    function collect() {
      return { dateFrom: fromInput.value, dateTo: toInput.value, processCode: pcSelect.value, groupBy: groupBySelect.value };
    }
    runBtn.addEventListener("click", () => onRun(collect()));
    return collect;
  }

  function buildQuery(filters) {
    const p = new URLSearchParams();
    if (filters.dateFrom) p.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) p.set("dateTo", filters.dateTo);
    if (filters.processCode) p.set("processCode", filters.processCode);
    if (filters.groupBy) p.set("groupBy", filters.groupBy);
    return p.toString();
  }

  // Returns a wrapping <div> (still a single appendable element, same as the
  // bare <table> this used to return — every report's own `outputEl.
  // appendChild(R.buildTable(...))` call site needs no change) containing a
  // small `.nx-toolbar` result-count line above the table, or an `.nx-empty`
  // box instead of the table when there's no data for the current filters.
  function buildTable(headers, rows, rowRenderer) {
    const wrap = document.createElement("div");
    wrap.style.marginBottom = "1.25rem";

    const toolbar = document.createElement("div");
    toolbar.className = "nx-toolbar";
    toolbar.style.padding = "8px 14px";
    toolbar.style.marginBottom = "8px";
    const title = document.createElement("span");
    title.className = "nx-toolbar-title";
    title.textContent = `${rows.length} result${rows.length === 1 ? "" : "s"}`;
    toolbar.appendChild(title);
    wrap.appendChild(toolbar);

    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "nx-empty";
      empty.textContent = "No data for the selected filters.";
      wrap.appendChild(empty);
      return wrap;
    }

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const h of headers) {
      const th = document.createElement("th");
      th.textContent = h;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const tbody = document.createElement("tbody");
    for (const row of rows) tbody.appendChild(rowRenderer(row));
    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function downloadCsv(rows, filename) {
    if (!rows.length) return;
    const columns = Object.keys(rows[0]);
    const lines = [columns.join(","), ...rows.map((row) => columns.map((c) => `"${String(row[c] ?? "").replace(/"/g, '""')}"`).join(","))];
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportButton(getRows, filename) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary";
    btn.textContent = "Export CSV";
    btn.style.marginBottom = "0.5rem";
    btn.addEventListener("click", () => downloadCsv(getRows(), filename));
    return btn;
  }

  return { api, PROCESS_LABELS, fmtNum, badgeEl, mountFilterBar, buildQuery, buildTable, downloadCsv, exportButton };
})();
