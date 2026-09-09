// Material Costing tile — port of private/js/finance.js's
// showCostingForm()/runMaterialCosting()/showBreakdownModal(). KST_LABELS
// mapping ported verbatim (confirmed against the real Node source — the
// research summary's label count didn't quite match the field count, so
// this was re-checked directly rather than guessed). Unlike Node, values
// arrive as real JSON numbers (SapServer's CostSheetRow fields are typed
// decimal, and ASP.NET Core's System.Text.Json serializes them as plain
// numbers) — no SAP-German-number-format parsing (parseSapNumber) is
// needed here. The right-click context menu is simplified to a plain
// "Breakdown" button per row (same "no client-side hide/show, discoverable
// over clever" simplification Quality's Concessions page already made).
(function () {
  const dateInput = document.getElementById("mc-date");
  const materialsInput = document.getElementById("mc-materials");
  const runBtn = document.getElementById("mc-run");
  const msgEl = document.getElementById("mc-msg");
  const resultEl = document.getElementById("mc-result");

  const KST_LABELS = {
    kst001: "Direct Material",
    kst002: "Inbound Freight",
    kst004: "Outbound Freight",
    kst006: "Depreciation",
    kst008: "Direct Labor",
    kst017: "Variable Production Overhead",
    kst019: "Scrap",
    kst033: "Tariffs",
  };

  let rawRows = {}; // material -> raw CostSheetRow, for the breakdown view

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

  function fmt2(n) {
    const num = Number(n);
    return isNaN(num) ? "—" : num.toFixed(2);
  }

  function kstTotalOf(row) {
    return Object.keys(KST_LABELS).reduce((sum, k) => sum + (Number(row[k]) || 0), 0);
  }

  function renderBreakdown(container, material) {
    const row = rawRows[material];
    container.innerHTML = "";
    if (!row) return;

    const lotSize = row.lotSize || 1;
    const kstTotal = kstTotalOf(row);

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Component", "Value (£)", "%"]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const tbody = document.createElement("tbody");
    for (const [key, label] of Object.entries(KST_LABELS)) {
      const val = Number(row[key]) || 0;
      const tr = document.createElement("tr");
      const labelTd = document.createElement("td");
      labelTd.textContent = label;
      const valueTd = document.createElement("td");
      valueTd.style.textAlign = "right";
      valueTd.textContent = fmt2(val / lotSize);
      const pctTd = document.createElement("td");
      pctTd.style.textAlign = "right";
      pctTd.textContent = kstTotal > 0 ? `${((val / kstTotal) * 100).toFixed(1)}%` : "—";
      tr.append(labelTd, valueTd, pctTd);
      tbody.appendChild(tr);
    }

    const tfoot = document.createElement("tfoot");
    const totalRow = document.createElement("tr");
    const totalLabelTd = document.createElement("td");
    totalLabelTd.textContent = "Total";
    totalLabelTd.style.fontWeight = "700";
    const totalValueTd = document.createElement("td");
    totalValueTd.style.textAlign = "right";
    totalValueTd.style.fontWeight = "700";
    totalValueTd.textContent = fmt2(kstTotal / lotSize);
    const totalPctTd = document.createElement("td");
    totalPctTd.style.textAlign = "right";
    totalPctTd.style.fontWeight = "700";
    totalPctTd.textContent = "100%";
    totalRow.append(totalLabelTd, totalValueTd, totalPctTd);
    tfoot.appendChild(totalRow);

    table.append(thead, tbody, tfoot);
    container.appendChild(table);
  }

  function renderResult(results) {
    resultEl.innerHTML = "";
    if (results.length === 0) {
      resultEl.textContent = "No costing data returned for the selected parameters.";
      return;
    }

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Material", "Price (£) Per Unit", "Unit of Measure", ""]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const tbody = document.createElement("tbody");
    for (const r of results) {
      const tr = document.createElement("tr");
      const matTd = document.createElement("td");
      matTd.textContent = r.material;
      const priceTd = document.createElement("td");
      priceTd.style.textAlign = "right";
      priceTd.textContent = r.pricePerUnit;
      const uomTd = document.createElement("td");
      uomTd.textContent = r.unit;

      const breakdownTd = document.createElement("td");
      const breakdownBtn = document.createElement("button");
      breakdownBtn.type = "button";
      breakdownBtn.className = "secondary";
      breakdownBtn.textContent = "Breakdown";
      const breakdownPanel = document.createElement("div");
      breakdownPanel.style.marginTop = "0.4rem";
      breakdownBtn.addEventListener("click", () => {
        if (breakdownPanel.childElementCount > 0) {
          breakdownPanel.innerHTML = "";
        } else {
          renderBreakdown(breakdownPanel, r.material);
        }
      });
      breakdownTd.append(breakdownBtn, breakdownPanel);

      tr.append(matTd, priceTd, uomTd, breakdownTd);
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    resultEl.appendChild(table);
  }

  runBtn.addEventListener("click", async () => {
    msgEl.textContent = "";
    resultEl.innerHTML = "";

    const date = dateInput.value.trim();
    const materials = materialsInput.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!date) {
      msgEl.textContent = "Costing date is required.";
      return;
    }
    if (materials.length === 0) {
      msgEl.textContent = "Enter at least one material.";
      return;
    }

    runBtn.disabled = true;
    runBtn.textContent = "Running…";
    try {
      const { data } = await api("/cost-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, materials }),
      });

      rawRows = {};
      for (const row of data) {
        if (row.material) rawRows[row.material] = row;
      }

      const results = data.map((row) => {
        const kstTotal = kstTotalOf(row);
        const lotSize = row.lotSize || 1;
        return { material: row.material || "", pricePerUnit: fmt2(kstTotal / lotSize), unit: row.unit || "" };
      });

      renderResult(results);
    } catch (err) {
      msgEl.textContent = err.message;
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "Run";
    }
  });
})();
