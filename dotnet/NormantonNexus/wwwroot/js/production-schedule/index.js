// Production Schedule tile — port of private/js/production-schedule.js's
// window.ProductionScheduleReport (mounted on both the Node Sales and
// Production pages). Behavior kept faithful: PTFE-only, 5-working-day
// window with a 2-working-day display offset on the Schedule tab, an
// Arrears tab with no offset, an OTIF KPI tab with a Chart.js bar chart.
// Simplified from the Node original: no collapsible per-date sections (all
// dates render expanded, same "clean functional approximation over pixel
// parity" simplification Engineering/Quality's own ports made), and no
// client-side canEdit/session-check gating — comment/ETA edit controls
// always render; a user lacking Perm:PROD_SCHEDULE_EDIT gets a 403 from the
// API on save, same as every other write in this app. Every dynamic value
// is built via textContent/DOM APIs, never innerHTML, per this app's
// established XSS-safe convention.
(function () {
  const tabButtons = document.querySelectorAll(".psched-tab-btn");
  const actionsEl = document.getElementById("psched-actions");
  const msgEl = document.getElementById("psched-msg");
  const bodyEl = document.getElementById("psched-body");

  let currentView = "schedule"; // 'schedule' | 'arrears' | 'kpi'
  let currentRows = [];
  let selectedKeys = new Set();
  let kpiChart = null;

  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  async function api(path, opts) {
    const r = await fetch("/api/production-schedule" + path, opts);
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

  function rowKey(r) {
    return `${r.referenceDocument}||${r.item}`;
  }

  function fmtNum(v) {
    const n = Number(v);
    if (!n) return "0";
    return n.toLocaleString("en-GB", { maximumFractionDigits: 3 });
  }

  function fmtMoney(v, currency) {
    const n = Number(v) || 0;
    return n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (currency ? " " + currency : "");
  }

  function fmtDateHeader(isoDate) {
    if (!isoDate || isoDate === "unknown") return "No date";
    const d = new Date(isoDate + "T00:00:00Z");
    return d.toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" });
  }

  function daysOverdue(isoDate) {
    if (!isoDate) return null;
    const due = new Date(String(isoDate).slice(0, 10) + "T00:00:00Z");
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
    return Math.round((todayUtc - due) / 86400000);
  }

  // ── Tabs ─────────────────────────────────────────────────────────────
  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.view === currentView) return;
      currentView = btn.dataset.view;
      selectedKeys = new Set();
      updateTabStyles();
      render();
    });
  });

  function updateTabStyles() {
    tabButtons.forEach((btn) => {
      btn.classList.toggle("secondary", btn.dataset.view !== currentView);
    });
  }

  async function render() {
    msgEl.textContent = "";
    actionsEl.innerHTML = "";
    bodyEl.textContent = "Loading…";

    try {
      if (currentView === "kpi") {
        await renderKpiView();
        return;
      }

      const path = currentView === "arrears" ? "/arrears" : "/";
      const json = await api(path);
      currentRows = currentView === "arrears" ? json.data || [] : json.data?.rows || [];
      renderTableView();
    } catch (err) {
      bodyEl.textContent = "";
      msgEl.textContent = err.message;
    }
  }

  // ── Schedule / Arrears table view ───────────────────────────────────
  function renderActions() {
    actionsEl.innerHTML = "";
    const hint = document.createElement("span");
    hint.id = "psched-selection-hint";
    hint.style.color = "#6b7280";
    hint.style.fontSize = "0.85rem";
    hint.textContent = "Select rows to save edits together.";

    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.className = "secondary";
    selectAllBtn.textContent = "Select All";
    selectAllBtn.addEventListener("click", toggleSelectAll);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.id = "psched-save-selected-btn";
    saveBtn.textContent = "Save Selected";
    saveBtn.disabled = true;
    saveBtn.addEventListener("click", saveSelected);

    actionsEl.append(hint, selectAllBtn, saveBtn);
  }

  function renderTableView() {
    bodyEl.innerHTML = "";
    if (currentRows.length === 0) {
      bodyEl.textContent = "Nothing here.";
      return;
    }

    renderActions();

    // Group by date — Schedule uses displayDate (RequestDate shifted back by
    // the working-day offset, see ProductionScheduleHelper), Arrears has no
    // offset (nothing to lead-time-adjust for something already overdue).
    const groups = new Map();
    for (const r of currentRows) {
      const groupDate = r.displayDate || r.requestDate;
      const key = groupDate ? String(groupDate).slice(0, 10) : "unknown";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const sortedKeys = [...groups.keys()].sort();
    const showOverdue = currentView === "arrears";

    for (const key of sortedKeys) {
      const rows = groups.get(key);

      const section = document.createElement("div");
      section.style.marginBottom = "1rem";

      const header = document.createElement("h3");
      header.style.margin = "0.5rem 0";
      header.textContent = `${fmtDateHeader(key)} (${rows.length})`;
      section.appendChild(header);

      const wrap = document.createElement("div");
      wrap.style.overflowX = "auto";
      const table = document.createElement("table");
      table.appendChild(buildTableHead(showOverdue));
      const tbody = document.createElement("tbody");
      for (const r of rows) {
        tbody.appendChild(buildRow(r, showOverdue));
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      section.appendChild(wrap);
      bodyEl.appendChild(section);
    }

    bodyEl.querySelectorAll(".psched-check").forEach((cb) => cb.addEventListener("change", onCheckToggle));
  }

  function buildTableHead(showOverdue) {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    const labels = ["", "Customer", "Agreement", "Item", "Material", "Description", "Qty", "Stock", "Picked", "Unit Price", "Value"];
    if (showOverdue) labels.push("Overdue");
    labels.push("ETA", "Comment");
    for (const label of labels) {
      const th = document.createElement("th");
      th.textContent = label;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    return thead;
  }

  function buildRow(r, showOverdue) {
    const key = rowKey(r);
    const orderQty = Number(r.orderQty) || 0;
    const inFull = orderQty > 0 && Number(r.stockQty) >= orderQty;

    const tr = document.createElement("tr");
    if (inFull) tr.style.opacity = "0.6";

    const checkTd = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "psched-check";
    checkbox.dataset.key = key;
    checkTd.appendChild(checkbox);

    const custTd = document.createElement("td");
    custTd.textContent = r.customerName || r.customer || "—";
    const refTd = document.createElement("td");
    refTd.textContent = r.referenceDocument;
    const itemTd = document.createElement("td");
    itemTd.textContent = r.item;
    const matTd = document.createElement("td");
    matTd.textContent = r.material;
    const descTd = document.createElement("td");
    descTd.textContent = r.materialText || "—";
    const qtyTd = document.createElement("td");
    qtyTd.style.textAlign = "right";
    qtyTd.textContent = `${fmtNum(r.orderQty)} ${r.uom || ""}`;
    const stockTd = document.createElement("td");
    stockTd.style.textAlign = "right";
    stockTd.textContent = fmtNum(r.stockQty);
    const pickedTd = document.createElement("td");
    pickedTd.style.textAlign = "right";
    pickedTd.textContent = fmtNum(r.pickedQty);
    const priceTd = document.createElement("td");
    priceTd.style.textAlign = "right";
    priceTd.textContent = r.standardPrice ? fmtMoney(r.standardPrice, "") : "—";
    const valueTd = document.createElement("td");
    valueTd.style.textAlign = "right";
    valueTd.textContent = r.amount ? fmtMoney(r.amount, r.currency) : "—";

    tr.append(checkTd, custTd, refTd, itemTd, matTd, descTd, qtyTd, stockTd, pickedTd, priceTd, valueTd);

    if (showOverdue) {
      const overdue = daysOverdue(r.requestDate);
      const overdueTd = document.createElement("td");
      overdueTd.style.color = "#b91c1c";
      overdueTd.textContent = overdue != null && overdue > 0 ? `${overdue}d` : "—";
      tr.appendChild(overdueTd);
    }

    const etaTd = document.createElement("td");
    const etaInput = document.createElement("input");
    etaInput.type = "date";
    etaInput.className = "psched-eta-input";
    etaInput.dataset.key = key;
    etaInput.value = r.eta ? String(r.eta).slice(0, 10) : "";
    etaTd.appendChild(etaInput);

    const commentTd = document.createElement("td");
    const commentInput = document.createElement("input");
    commentInput.type = "text";
    commentInput.className = "psched-comment-input";
    commentInput.dataset.key = key;
    commentInput.value = r.comment || "";
    commentInput.placeholder = "Comment…";
    commentTd.appendChild(commentInput);

    tr.append(etaTd, commentTd);
    return tr;
  }

  // ── Selection ────────────────────────────────────────────────────────
  function onCheckToggle(e) {
    const key = e.target.dataset.key;
    if (e.target.checked) selectedKeys.add(key);
    else selectedKeys.delete(key);
    updateSelectionUi();
  }

  function toggleSelectAll() {
    const boxes = bodyEl.querySelectorAll(".psched-check");
    const allSelected = [...boxes].every((cb) => cb.checked);
    boxes.forEach((cb) => {
      cb.checked = !allSelected;
      if (cb.checked) selectedKeys.add(cb.dataset.key);
      else selectedKeys.delete(cb.dataset.key);
    });
    updateSelectionUi();
  }

  function updateSelectionUi() {
    const hint = document.getElementById("psched-selection-hint");
    if (hint) {
      hint.textContent = selectedKeys.size ? `${selectedKeys.size} line${selectedKeys.size === 1 ? "" : "s"} selected` : "Select rows to save edits together.";
    }
    const btn = document.getElementById("psched-save-selected-btn");
    if (btn) btn.disabled = selectedKeys.size === 0;
  }

  // ── Save ─────────────────────────────────────────────────────────────
  async function saveOneRow(key) {
    const etaInput = bodyEl.querySelector(`.psched-eta-input[data-key="${CSS.escape(key)}"]`);
    const commentInput = bodyEl.querySelector(`.psched-comment-input[data-key="${CSS.escape(key)}"]`);
    if (!etaInput || !commentInput) return { success: false, error: "Row not on screen." };

    const [referenceDocument, item] = key.split("||");
    try {
      await api(`/${encodeURIComponent(referenceDocument)}/${encodeURIComponent(item)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comment: commentInput.value.trim() || null,
          eta: etaInput.value || null,
        }),
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function saveSelected() {
    const btn = document.getElementById("psched-save-selected-btn");
    if (!btn || selectedKeys.size === 0) return;
    const keys = [...selectedKeys];
    btn.disabled = true;
    btn.textContent = "Saving…";

    const results = [];
    for (const key of keys) {
      results.push({ key, ...(await saveOneRow(key)) });
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length) {
      msgEl.textContent = `Saved ${results.length - failed.length} of ${results.length} line(s). Failed: ` + failed.map((f) => `${f.key}: ${f.error}`).join("; ");
    } else {
      msgEl.textContent = "";
    }
    selectedKeys = new Set();
    await render();
  }

  // ── OTIF KPI view ────────────────────────────────────────────────────
  function destroyKpiChart() {
    if (kpiChart) {
      kpiChart.destroy();
      kpiChart = null;
    }
  }

  async function renderKpiView() {
    try {
      const [historyJson, lateJson] = await Promise.all([api("/kpi"), api("/kpi/late")]);
      const history = historyJson.data || [];
      const late = lateJson.data || [];

      bodyEl.innerHTML = "";

      const chartWrap = document.createElement("div");
      chartWrap.style.maxHeight = "320px";
      chartWrap.style.marginBottom = "1.25rem";
      const canvas = document.createElement("canvas");
      canvas.id = "psched-kpi-chart";
      chartWrap.appendChild(canvas);
      bodyEl.appendChild(chartWrap);

      const heading = document.createElement("h3");
      heading.textContent = "Completed Late — with Reason";
      bodyEl.appendChild(heading);

      const wrap = document.createElement("div");
      wrap.style.overflowX = "auto";
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of ["Customer", "Agreement", "Item", "Material", "Qty", "Due", "Completed", "Reason"]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = document.createElement("tbody");
      if (late.length === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 8;
        td.textContent = "Nothing completed late.";
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        for (const r of late) {
          tbody.appendChild(buildLateRow(r));
        }
      }
      table.append(thead, tbody);
      wrap.appendChild(table);
      bodyEl.appendChild(wrap);

      destroyKpiChart();
      if (window.Chart && history.length) {
        const labels = history.map((h) => `${MONTH_NAMES[h.month - 1] || h.month} ${h.year}`);
        const pct = history.map((h) => (h.onTimePct == null ? null : Math.round(h.onTimePct * 10) / 10));
        kpiChart = new window.Chart(canvas, {
          type: "bar",
          data: {
            labels,
            datasets: [
              {
                label: "On-Time %",
                data: pct,
                backgroundColor: "rgba(37,99,235,0.55)",
                borderColor: "rgba(37,99,235,1)",
                borderWidth: 1,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: { y: { beginAtZero: true, max: 100, ticks: { callback: (v) => v + "%" } } },
            plugins: { legend: { display: false } },
          },
        });
      } else if (!history.length) {
        chartWrap.textContent = "No completed lines tracked yet — the OTIF diff job runs once daily.";
      }
    } catch (err) {
      bodyEl.textContent = "";
      msgEl.textContent = err.message;
    }
  }

  function buildLateRow(r) {
    const tr = document.createElement("tr");
    const custTd = document.createElement("td");
    custTd.textContent = r.customerName || "—";
    const refTd = document.createElement("td");
    refTd.textContent = r.referenceDocument;
    const itemTd = document.createElement("td");
    itemTd.textContent = r.item;
    const matTd = document.createElement("td");
    matTd.textContent = r.material;
    const qtyTd = document.createElement("td");
    qtyTd.style.textAlign = "right";
    qtyTd.textContent = `${fmtNum(r.orderQty)} ${r.uom || ""}`;
    const dueTd = document.createElement("td");
    dueTd.textContent = r.dueDate ? String(r.dueDate).slice(0, 10) : "—";
    const completedTd = document.createElement("td");
    completedTd.textContent = r.completedDate ? String(r.completedDate).slice(0, 10) : "—";
    const reasonTd = document.createElement("td");
    reasonTd.textContent = r.reason || "—";
    tr.append(custTd, refTd, itemTd, matTd, qtyTd, dueTd, completedTd, reasonTd);
    return tr;
  }

  updateTabStyles();
  render();
})();
