// Profit Center Data tile — port of private/js/finance.js's
// showProfitCenterForm()/runProfitCenter()/renderProfitCenterResults().
// PC_SEGMENT_MAP/PC_SEGMENT_ORDER are ported verbatim from the real Node
// source (re-checked directly, not taken from a paraphrase) — a hardcoded
// business-rule table with no server-side equivalent, must not be derived
// or guessed. Detail-grid per-column filters are dropped (visual polish,
// same simplification every earlier department made); the segment
// bucketing/grand-total logic and CSV-shaped column set are preserved.
(function () {
  const fromMSelect = document.getElementById("pc-from-m");
  const fromYInput = document.getElementById("pc-from-y");
  const toMSelect = document.getElementById("pc-to-m");
  const toYInput = document.getElementById("pc-to-y");
  const modeGroupBtn = document.getElementById("pc-mode-group");
  const modeManualBtn = document.getElementById("pc-mode-manual");
  const groupSection = document.getElementById("pc-group-section");
  const manualSection = document.getElementById("pc-manual-section");
  const groupSelect = document.getElementById("pc-group");
  const groupPreviewEl = document.getElementById("pc-group-preview");
  const manualAccountsInput = document.getElementById("pc-manual-accounts");
  const runBtn = document.getElementById("pc-run");
  const msgEl = document.getElementById("pc-msg");
  const summaryEl = document.getElementById("pc-summary");
  const detailEl = document.getElementById("pc-detail");

  const PC_SEGMENT_MAP = {
    PV: new Set(["2008", "2010", "2011", "2014", "2015", "2017", "2018", "2024", "2025", "2028", "2029", "2030"]),
    PTFE: new Set(["2000", "2001", "2002", "2003", "2004", "2005", "2006", "2007", "2009", "2012", "2016", "2021", "2022", "9912"]),
  };
  const PC_SEGMENT_ORDER = ["PTFE", "PV", "Other"];

  let mode = "group";
  let groups = [];

  async function api(path, opts) {
    const r = await fetch("/api/finance" + path, opts);
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

  function fmtGBP(n) {
    const num = Number(n) || 0;
    return num.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function getSegment(profitCenter) {
    const pc = String(profitCenter || "").trim();
    if (PC_SEGMENT_MAP.PV.has(pc)) return "PV";
    if (PC_SEGMENT_MAP.PTFE.has(pc)) return "PTFE";
    return "Other";
  }

  function initForm() {
    const now = new Date();
    for (let m = 1; m <= 12; m++) {
      const label = String(m).padStart(2, "0");
      fromMSelect.add(new Option(label, m, m === now.getMonth() + 1, m === now.getMonth() + 1));
      toMSelect.add(new Option(label, m, m === now.getMonth() + 1, m === now.getMonth() + 1));
    }
    fromYInput.value = now.getFullYear();
    toYInput.value = now.getFullYear();
  }

  function updateGroupPreview() {
    const group = groups.find((g) => String(g.id) === groupSelect.value);
    groupPreviewEl.textContent = group ? group.accounts.join(", ") : "";
  }

  async function loadGroups() {
    try {
      const { data } = await api("/gl-groups");
      groups = data;
    } catch {
      groups = [];
    }
    groupSelect.innerHTML = "";
    if (groups.length === 0) {
      groupSelect.add(new Option("No groups configured", ""));
    } else {
      for (const g of groups) groupSelect.add(new Option(g.label, String(g.id)));
    }
    updateGroupPreview();
  }

  groupSelect.addEventListener("change", updateGroupPreview);

  modeGroupBtn.addEventListener("click", () => {
    mode = "group";
    modeGroupBtn.classList.remove("secondary");
    modeManualBtn.classList.add("secondary");
    groupSection.style.display = "";
    manualSection.style.display = "none";
  });
  modeManualBtn.addEventListener("click", () => {
    mode = "manual";
    modeManualBtn.classList.remove("secondary");
    modeGroupBtn.classList.add("secondary");
    manualSection.style.display = "";
    groupSection.style.display = "none";
  });

  function currentGlAccounts() {
    if (mode === "group") {
      const group = groups.find((g) => String(g.id) === groupSelect.value);
      return group ? group.accounts : [];
    }
    return manualAccountsInput.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function renderResults(data) {
    const enriched = data.map((r) => ({ ...r, _segment: getSegment(r.profitCenter) }));

    const segMap = {};
    for (const r of enriched) {
      const seg = r._segment;
      const pc = r.profitCenter || "—";
      if (!segMap[seg]) segMap[seg] = { count: 0, total: 0, pcs: {} };
      if (!segMap[seg].pcs[pc]) segMap[seg].pcs[pc] = { count: 0, total: 0 };
      const val = Number(r.companyCodeValue) || 0;
      segMap[seg].count++;
      segMap[seg].total += val;
      segMap[seg].pcs[pc].count++;
      segMap[seg].pcs[pc].total += val;
    }
    const grandTotal = enriched.reduce((s, r) => s + (Number(r.companyCodeValue) || 0), 0);

    summaryEl.innerHTML = "";
    for (const seg of PC_SEGMENT_ORDER) {
      const s = segMap[seg];
      if (!s) continue;

      const heading = document.createElement("h3");
      heading.textContent = seg;
      summaryEl.appendChild(heading);

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of ["Profit Center", "Transactions", "Total Value (£)"]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = document.createElement("tbody");
      const pcEntries = Object.entries(s.pcs).sort(([, a], [, b]) => Math.abs(b.total) - Math.abs(a.total));
      for (const [pc, p] of pcEntries) {
        const tr = document.createElement("tr");
        const pcTd = document.createElement("td");
        pcTd.textContent = pc;
        const countTd = document.createElement("td");
        countTd.style.textAlign = "right";
        countTd.textContent = p.count;
        const totalTd = document.createElement("td");
        totalTd.style.textAlign = "right";
        totalTd.style.color = p.total >= 0 ? "#059669" : "#dc2626";
        totalTd.textContent = fmtGBP(p.total);
        tr.append(pcTd, countTd, totalTd);
        tbody.appendChild(tr);
      }
      const tfoot = document.createElement("tfoot");
      const totalRow = document.createElement("tr");
      const totalLabelTd = document.createElement("td");
      totalLabelTd.textContent = `Total ${seg}`;
      totalLabelTd.style.fontWeight = "700";
      const totalCountTd = document.createElement("td");
      totalCountTd.style.textAlign = "right";
      totalCountTd.style.fontWeight = "700";
      totalCountTd.textContent = s.count;
      const totalValTd = document.createElement("td");
      totalValTd.style.textAlign = "right";
      totalValTd.style.fontWeight = "700";
      totalValTd.style.color = s.total >= 0 ? "#059669" : "#dc2626";
      totalValTd.textContent = fmtGBP(s.total);
      totalRow.append(totalLabelTd, totalCountTd, totalValTd);
      tfoot.appendChild(totalRow);
      table.append(thead, tbody, tfoot);
      summaryEl.appendChild(table);
    }

    const grandEl = document.createElement("p");
    grandEl.style.fontWeight = "700";
    grandEl.style.color = grandTotal >= 0 ? "#059669" : "#dc2626";
    const parts = PC_SEGMENT_ORDER.filter((seg) => segMap[seg]).map((seg) => `${seg} £${fmtGBP(segMap[seg].total)}`);
    grandEl.textContent = `Total — ${parts.join(" · ")} · All £${fmtGBP(grandTotal)}`;
    summaryEl.appendChild(grandEl);

    // Detail table.
    detailEl.innerHTML = "";
    const cols = [
      { key: "postingDate", label: "Posting Date" },
      { key: "_segment", label: "Segment" },
      { key: "profitCenter", label: "Profit Center" },
      { key: "glAccount", label: "GL Account" },
      { key: "companyCodeValue", label: "Value (£)" },
      { key: "materialNumber", label: "Material" },
      { key: "customer", label: "Customer" },
      { key: "salesOrder", label: "Sales Order" },
      { key: "salesOrderItem", label: "SO Item" },
      { key: "invoiceNumber", label: "Invoice" },
      { key: "invoiceItem", label: "Inv. Item" },
      { key: "fiscalYear", label: "Year" },
    ];

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const c of cols) {
      const th = document.createElement("th");
      th.textContent = c.label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    for (const r of enriched) {
      const tr = document.createElement("tr");
      for (const c of cols) {
        const td = document.createElement("td");
        if (c.key === "companyCodeValue") {
          const val = Number(r.companyCodeValue) || 0;
          td.style.textAlign = "right";
          td.style.color = val >= 0 ? "#059669" : "#dc2626";
          td.textContent = fmtGBP(val);
        } else {
          td.textContent = r[c.key] ?? "";
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    detailEl.appendChild(table);
  }

  runBtn.addEventListener("click", async () => {
    msgEl.textContent = "";
    summaryEl.innerHTML = "";
    detailEl.innerHTML = "";

    const fromM = Number(fromMSelect.value);
    const fromY = Number(fromYInput.value);
    const toM = Number(toMSelect.value);
    const toY = Number(toYInput.value);
    const glAccounts = currentGlAccounts();

    if (!fromM || !fromY || !toM || !toY) {
      msgEl.textContent = "Please select a period range.";
      return;
    }
    if (fromY * 12 + fromM > toY * 12 + toM) {
      msgEl.textContent = "From period must be on or before To period.";
      return;
    }
    if (glAccounts.length === 0) {
      msgEl.textContent = "Please select a group or enter at least one GL account.";
      return;
    }

    const pad = (n) => String(n).padStart(2, "0");
    const lastDay = (y, m) => new Date(y, m, 0).getDate();
    const dateFrom = `01.${pad(fromM)}.${fromY}`;
    const dateTo = `${lastDay(toY, toM)}.${pad(toM)}.${toY}`;

    runBtn.disabled = true;
    runBtn.textContent = "Running…";
    try {
      const { data } = await api("/costing/profit-center", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateFrom, dateTo, glAccounts }),
      });

      if (!data.length) {
        summaryEl.textContent = "No postings found for the selected parameters.";
        return;
      }
      renderResults(data);
    } catch (err) {
      msgEl.textContent = err.message;
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "Run Query";
    }
  });

  initForm();
  loadGroups();
})();
