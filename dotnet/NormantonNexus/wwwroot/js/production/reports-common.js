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

  // Builds the shared From/To/Process/Group-by filter bar into `container`;
  // `onRun(filters)` fires when the user clicks Run Report.
  function mountFilterBar(container, onRun) {
    container.innerHTML = "";
    const today = new Date().toISOString().slice(0, 10);
    const ago30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.gap = "0.75rem";
    wrap.style.flexWrap = "wrap";
    wrap.style.alignItems = "end";
    wrap.style.marginBottom = "0.75rem";

    function field(labelText, el) {
      const div = document.createElement("div");
      const label = document.createElement("label");
      label.textContent = labelText;
      div.append(label, el);
      wrap.appendChild(div);
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

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.textContent = "Run Report";
    wrap.appendChild(runBtn);

    container.appendChild(wrap);

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

  function buildTable(headers, rows, rowRenderer) {
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
    if (rows.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = headers.length;
      td.textContent = "No data for the selected filters.";
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const row of rows) tbody.appendChild(rowRenderer(row));
    }
    table.append(thead, tbody);
    return table;
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

  return { api, PROCESS_LABELS, fmtNum, mountFilterBar, buildQuery, buildTable, downloadCsv, exportButton };
})();
