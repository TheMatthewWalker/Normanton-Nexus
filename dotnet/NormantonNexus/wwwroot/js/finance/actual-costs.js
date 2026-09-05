// Actual Costs tile — port of private/js/finance.js's showActualCostsForm()/
// runActualCosts()/renderAcResults(). The period-net/cumulative-balance
// recalculation deliberately ignores SAP's own year-to-date `balance`
// field (period net = debit + |credit|, cumulative = running sum from
// zero) — ported verbatim, this is real business logic. AC_COLORS is
// ported as-is (cheap, and matching the exact palette is worth it). The
// GL Account Source predefined-group/manual-entry toggle is preserved;
// visual polish (fonts, per-column filter inputs on the detail grid) is
// simplified, matching every earlier department's precedent.
(function () {
  const yearInput = document.getElementById("ac-year");
  const periodFromSelect = document.getElementById("ac-period-from");
  const periodToSelect = document.getElementById("ac-period-to");
  const modeGroupBtn = document.getElementById("ac-mode-group");
  const modeManualBtn = document.getElementById("ac-mode-manual");
  const groupSection = document.getElementById("ac-group-section");
  const manualSection = document.getElementById("ac-manual-section");
  const groupSelect = document.getElementById("ac-group");
  const groupPreviewEl = document.getElementById("ac-group-preview");
  const manualAccountsInput = document.getElementById("ac-manual-accounts");
  const runBtn = document.getElementById("ac-run");
  const msgEl = document.getElementById("ac-msg");
  const resultEl = document.getElementById("ac-result");

  const AC_COLORS = ["#059669", "#2563EB", "#D97706", "#7C3AED", "#DC2626", "#0891B2", "#65A30D", "#C026D3", "#EA580C", "#0D9488"];

  let mode = "group";
  let groups = [];
  let chart = null;

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
    const num = Number(n);
    return isNaN(num) ? "—" : num.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function initForm() {
    const now = new Date();
    yearInput.value = now.getFullYear();

    for (let i = 1; i <= 12; i++) {
      const label = `P${String(i).padStart(2, "0")}`;
      const fromOpt = new Option(label, i, i === 1, i === 1);
      const toOpt = new Option(label, i, i === now.getMonth() + 1, i === now.getMonth() + 1);
      periodFromSelect.add(fromOpt);
      periodToSelect.add(toOpt);
    }
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
      for (const g of groups) {
        groupSelect.add(new Option(g.label, String(g.id)));
      }
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

  function destroyChart() {
    if (chart) {
      chart.destroy();
      chart = null;
    }
  }

  function renderResults(data) {
    const glAccounts = [...new Set(data.map((r) => r.glAccount))];
    const periods = [...new Set(data.map((r) => r.period))].sort();

    const enriched = {};
    for (const gl of glAccounts) {
      let cum = 0;
      enriched[gl] = data
        .filter((r) => r.glAccount === gl)
        .sort((a, b) => a.period.localeCompare(b.period))
        .map((r) => {
          const debit = Number(r.debit) || 0;
          const creditAbs = Math.abs(Number(r.credit) || 0);
          cum += debit - creditAbs;
          return { period: r.period, debit, creditAbs, cumBal: cum };
        });
    }

    resultEl.innerHTML = "";

    const chartWrap = document.createElement("div");
    chartWrap.style.maxHeight = "320px";
    chartWrap.style.marginBottom = "1.25rem";
    const canvas = document.createElement("canvas");
    canvas.id = "ac-chart";
    chartWrap.appendChild(canvas);
    resultEl.appendChild(chartWrap);

    let grandDebit = 0;
    let grandCredit = 0;

    for (const gl of glAccounts) {
      const label = gl.replace(/^0+/, "") || "0";
      const rows = enriched[gl];
      const totD = rows.reduce((s, r) => s + r.debit, 0);
      const totC = rows.reduce((s, r) => s + r.creditAbs, 0);
      const totBal = rows.length ? rows[rows.length - 1].cumBal : 0;
      grandDebit += totD;
      grandCredit += totC;

      const heading = document.createElement("h3");
      heading.textContent = `GL ${label}`;
      resultEl.appendChild(heading);

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const colLabel of ["Period", "Debit (£)", "Credit (£)", "Balance (£)"]) {
        const th = document.createElement("th");
        th.textContent = colLabel;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = document.createElement("tbody");
      for (const r of rows) {
        const tr = document.createElement("tr");
        const periodTd = document.createElement("td");
        periodTd.textContent = `P${r.period}`;
        const debitTd = document.createElement("td");
        debitTd.style.textAlign = "right";
        debitTd.textContent = fmtGBP(r.debit);
        const creditTd = document.createElement("td");
        creditTd.style.textAlign = "right";
        creditTd.textContent = fmtGBP(r.creditAbs);
        const balTd = document.createElement("td");
        balTd.style.textAlign = "right";
        balTd.style.color = r.cumBal >= 0 ? "#059669" : "#dc2626";
        balTd.textContent = fmtGBP(r.cumBal);
        tr.append(periodTd, debitTd, creditTd, balTd);
        tbody.appendChild(tr);
      }
      const tfoot = document.createElement("tfoot");
      const totalRow = document.createElement("tr");
      const totalLabelTd = document.createElement("td");
      totalLabelTd.textContent = "Total";
      totalLabelTd.style.fontWeight = "700";
      const totalDebitTd = document.createElement("td");
      totalDebitTd.style.textAlign = "right";
      totalDebitTd.style.fontWeight = "700";
      totalDebitTd.textContent = fmtGBP(totD);
      const totalCreditTd = document.createElement("td");
      totalCreditTd.style.textAlign = "right";
      totalCreditTd.style.fontWeight = "700";
      totalCreditTd.textContent = fmtGBP(totC);
      const totalBalTd = document.createElement("td");
      totalBalTd.style.textAlign = "right";
      totalBalTd.style.fontWeight = "700";
      totalBalTd.style.color = totBal >= 0 ? "#059669" : "#dc2626";
      totalBalTd.textContent = fmtGBP(totBal);
      totalRow.append(totalLabelTd, totalDebitTd, totalCreditTd, totalBalTd);
      tfoot.appendChild(totalRow);
      table.append(thead, tbody, tfoot);
      resultEl.appendChild(table);
    }

    if (glAccounts.length > 1) {
      const grandBal = grandDebit - grandCredit;
      const grandTotalEl = document.createElement("p");
      grandTotalEl.style.fontWeight = "700";
      grandTotalEl.textContent = `Group Total — Debit £${fmtGBP(grandDebit)} · Credit £${fmtGBP(grandCredit)} · Balance £${fmtGBP(grandBal)}`;
      grandTotalEl.style.color = grandBal >= 0 ? "#059669" : "#dc2626";
      resultEl.appendChild(grandTotalEl);
    }

    destroyChart();
    if (window.Chart) {
      const datasets = glAccounts.map((gl, idx) => {
        const label = gl.replace(/^0+/, "") || "0";
        const col = AC_COLORS[idx % AC_COLORS.length];
        return {
          label,
          data: periods.map((p) => {
            const row = enriched[gl].find((r) => r.period === p);
            return row ? row.cumBal : null;
          }),
          borderColor: col,
          backgroundColor: col + "18",
          borderWidth: 2,
          pointRadius: 4,
          tension: 0.3,
          fill: true,
          spanGaps: true,
        };
      });

      chart = new window.Chart(canvas, {
        type: "line",
        data: { labels: periods.map((p) => `P${p}`), datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: { tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: £${fmtGBP(ctx.parsed.y)}` } } },
          scales: { y: { ticks: { callback: (v) => "£" + v.toLocaleString("en-GB") } } },
        },
      });
    }
  }

  runBtn.addEventListener("click", async () => {
    msgEl.textContent = "";
    resultEl.innerHTML = "";

    const year = yearInput.value.trim();
    const periodFrom = periodFromSelect.value;
    const periodTo = periodToSelect.value;
    const glAccounts = currentGlAccounts();

    if (!year) {
      msgEl.textContent = "Please enter a fiscal year.";
      return;
    }
    if (glAccounts.length === 0) {
      msgEl.textContent = "Please select a group or enter at least one GL account.";
      return;
    }
    if (Number(periodFrom) > Number(periodTo)) {
      msgEl.textContent = "Period From must be on or before Period To.";
      return;
    }

    runBtn.disabled = true;
    runBtn.textContent = "Running…";
    try {
      const { data } = await api("/costing/period-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fiscalYear: year, periodFrom, periodTo, glAccounts }),
      });

      if (!data.length) {
        resultEl.textContent = "No data returned for the selected parameters.";
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
