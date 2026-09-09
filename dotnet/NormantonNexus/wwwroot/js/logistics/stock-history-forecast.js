// Stock History & Forecast tile — port of private/js/logistics.js's
// runStockHistoryForecast/shfLoadChart/shfOnVendorChange/shfRenderVendorRow
// family. See StockHistoryForecast.cshtml.cs's own header comment for what's
// deliberately not built in this pass (the "+ Add Demand Adjustment" quick-link).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance");

  let mrpController = "";
  let bucketMode = "weeks";
  let currentMaterial = null;
  let excludedDeliveryIds = new Set();
  let charts = [];
  // Bumped on every loadChart call, checked after the await — a stale call
  // (superseded by a newer one before its fetch resolved: e.g. clicking
  // "Show All" right after page load, before the initial load finished)
  // must not draw its charts on top of the newer call's, which is exactly
  // what "Canvas is already in use" was — two in-flight loadChart calls each
  // called destroyCharts() at their own start (before either had created
  // anything yet), so neither ever destroyed the other's chart.
  let loadChartGeneration = 0;
  let vendorId = "";
  let vendorRowExcludedIds = new Map();
  let vendorRowCharts = new Map(); // material -> { consumption, stock } Chart instances

  function destroyVendorRowCharts(material) {
    const existing = vendorRowCharts.get(material);
    if (!existing) return;
    [existing.consumption, existing.stock].forEach((c) => c && c.destroy());
    vendorRowCharts.delete(material);
  }

  function destroyAllVendorRowCharts() {
    [...vendorRowCharts.keys()].forEach(destroyVendorRowCharts);
  }

  function destroyCharts() {
    charts.forEach((c) => c.destroy());
    charts = [];
  }

  function clampStock(v) {
    return Math.max(0, v);
  }

  function buildConsumptionChartConfig(row, accuracy) {
    const history = (row.consumptionHistory || []).map((v) => Number(v) || 0);
    const forecast = (row.demandForecast || []).map((v) => Number(v) || 0);
    const predicted = (row.predictedUsage || []).map((v) => Number(v) || 0);
    const recordedSapDemand = (accuracy.recordedSapDemand || new Array(13).fill(null)).map((v) => (v == null ? null : Number(v)));
    const recordedPredicted = (accuracy.recordedPredicted || new Array(13).fill(null)).map((v) => (v == null ? null : Number(v)));

    const labels = [
      ...Array.from({ length: 12 }, (_, i) => `M-${12 - i}`),
      "Current",
      ...Array.from({ length: 12 }, (_, i) => `M+${i + 1}`),
    ];
    const historySeries = [...history, ...Array(12).fill(null)];
    const forecastSeries = [...Array(12).fill(null), ...forecast];
    const predictedSeries = [...Array(12).fill(null), ...predicted];
    const recordedSapSeries = [...recordedSapDemand, ...Array(12).fill(null)];
    const recordedPredictedSeries = [...recordedPredicted, ...Array(12).fill(null)];

    return {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Consumption History", data: historySeries, borderColor: "#0891B2", backgroundColor: "rgba(8,145,178,0.08)", fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: "#0891B2", spanGaps: false },
          { label: "SAP Demand Forecast", data: forecastSeries, borderColor: "#F59E0B", backgroundColor: "rgba(245,158,11,0.08)", fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: "#F59E0B", borderDash: [5, 4], spanGaps: false },
          { label: "Predicted Usage", data: predictedSeries, borderColor: "#16A34A", backgroundColor: "rgba(22,163,74,0.08)", fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: "#16A34A", borderDash: [5, 4], spanGaps: false },
          { label: "SAP Demand (recorded)", data: recordedSapSeries, borderColor: "#F59E0B", backgroundColor: "transparent", fill: false, tension: 0.3, pointRadius: 2, pointBackgroundColor: "#F59E0B", borderDash: [1, 3], borderWidth: 1.5, spanGaps: false },
          { label: "Predicted (recorded)", data: recordedPredictedSeries, borderColor: "#16A34A", backgroundColor: "transparent", fill: false, tension: 0.3, pointRadius: 2, pointBackgroundColor: "#16A34A", borderDash: [1, 3], borderWidth: 1.5, spanGaps: false },
        ],
      },
      options: {
        plugins: { legend: { position: "bottom", labels: { color: "#4D6380", font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: "#8DA3BE", font: { size: 10 } }, grid: { color: "rgba(0,0,0,0.06)" } },
          y: { ticks: { color: "#8DA3BE", font: { size: 10 } }, grid: { color: "rgba(0,0,0,0.06)" } },
        },
      },
    };
  }

  function buildStockChartConfig(stockForecast) {
    const isDaily = stockForecast.bucketDays === 1;
    const usageLabel = isDaily ? "Daily Usage" : "Weekly Usage";
    const stockLabels = [stockForecast.asOfDate, ...stockForecast.weeks.map((w) => w.weekEnding)];
    const rawStock = [stockForecast.currentStock, ...stockForecast.weeks.map((w) => w.expectedStock)];
    const stockSeries = rawStock.map(clampStock);
    const usageSeries = [null, ...stockForecast.weeks.map((w) => w.weeklyUsage)];
    const hasDelivery = [false, ...stockForecast.weeks.map((w) => (w.deliveries || []).length > 0)];
    const pointRadius = hasDelivery.map((d) => (d ? 6 : 2));
    const pointStyle = hasDelivery.map((d) => (d ? "rectRot" : "circle"));

    return {
      type: "line",
      data: {
        labels: stockLabels,
        datasets: [
          { label: "Expected Stock Level", data: stockSeries, borderColor: "#7C3AED", backgroundColor: "rgba(124,58,237,0.10)", fill: true, tension: 0.2, pointRadius, pointStyle, pointBackgroundColor: "#7C3AED", yAxisID: "y" },
          { label: usageLabel, data: usageSeries, borderColor: "#DC2626", backgroundColor: "transparent", fill: false, borderDash: [3, 3], borderWidth: 1.5, pointRadius: 0, yAxisID: "y1" },
        ],
      },
      options: {
        plugins: { legend: { position: "bottom", labels: { color: "#4D6380", font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: "#8DA3BE", font: { size: 10 }, maxRotation: 60, minRotation: 60 }, grid: { color: "rgba(0,0,0,0.06)" } },
          y: { position: "left", min: 0, ticks: { color: "#8DA3BE", font: { size: 10 } }, grid: { color: "rgba(0,0,0,0.06)" }, title: { display: true, text: "Stock", color: "#8DA3BE", font: { size: 10 } } },
          y1: { position: "right", ticks: { color: "#8DA3BE", font: { size: 10 } }, grid: { display: false }, title: { display: true, text: usageLabel, color: "#8DA3BE", font: { size: 10 } } },
        },
      },
    };
  }

  function setActiveBucketBtn(bucket) {
    document.querySelectorAll(".shf-bucket-btn").forEach((btn) => {
      const active = btn.dataset.bucket === bucket;
      btn.style.background = active ? "var(--accent)" : "";
      btn.style.color = active ? "#fff" : "";
      btn.style.borderColor = active ? "var(--accent)" : "";
    });
  }

  function updateStockChartHeading(stockForecast, singleMaterial) {
    const heading = document.getElementById("shf-stock-chart-heading");
    const desc = document.getElementById("shf-stock-chart-desc");
    const toggle = document.getElementById("shf-bucket-toggle");
    toggle.classList.toggle("hidden", !singleMaterial);
    const isDaily = stockForecast.bucketDays === 1;
    setActiveBucketBtn(isDaily ? "days" : "weeks");
    if (isDaily) {
      heading.textContent = `Expected Stock Level (Next ${stockForecast.weeks.length} Days)`;
      desc.textContent = "Projected forward day by day using predicted usage, plus open incoming deliveries — a weekly view can hide a stockout or overfill that actually lands mid-week. Untick a delivery below to simulate it arriving late or being lost.";
    } else {
      heading.textContent = "Expected Stock Level (Next 26 Weeks)";
      desc.textContent = "Projected forward from current stock using predicted usage, spread across weeks, plus open incoming deliveries. Untick a delivery below to simulate it arriving late or being lost.";
    }
  }

  function renderDeliveriesList(stockForecast) {
    const container = document.getElementById("shf-stock-deliveries");
    const deliveries = [];
    stockForecast.weeks.forEach((w) => (w.deliveries || []).forEach((d) => deliveries.push({ ...d, weekEnding: w.weekEnding })));

    if (!deliveries.length) {
      container.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">No open incoming deliveries in this window.</div>';
      return;
    }

    container.innerHTML = `
      <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">Incoming Deliveries</div>
      <div style="display:flex;flex-direction:column;gap:4px">
        ${deliveries.map((d) => `
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer">
            <input type="checkbox" class="shf-delivery-toggle" data-id="${d.id}" ${excludedDeliveryIds.has(d.id) ? "" : "checked"}>
            <span style="font-family:'JetBrains Mono',monospace">${esc(d.weekEnding)}</span>
            <span>${esc(String(d.qty))} units${d.vendorName ? " — " + esc(d.vendorName) : ""}${d.poNumber ? " — PO " + esc(d.poNumber) : ""}${d.material ? " — " + esc(d.material) : ""}</span>
          </label>`).join("")}
      </div>`;

    container.querySelectorAll(".shf-delivery-toggle").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = Number(cb.dataset.id);
        if (cb.checked) excludedDeliveryIds.delete(id);
        else excludedDeliveryIds.add(id);
        loadChart(currentMaterial, document.getElementById("shf-chart-title").textContent);
      });
    });
  }

  async function fetchHistory({ material, bucket } = {}) {
    const params = new URLSearchParams();
    if (material) params.set("materials", material);
    if (mrpController) params.set("mrpController", mrpController);
    if (excludedDeliveryIds.size) params.set("excludeDeliveryIds", [...excludedDeliveryIds].join(","));
    if (material && bucket === "days") params.set("bucket", "days");
    const qs = params.toString();
    // api() returns the full {success,data,error} envelope — the route's own
    // payload (Node's flat {data,accuracy,stockForecast}) lives one level
    // deeper, inside .data (ApiResponse<TurnsValClassHistoryResult>.Ok(...)
    // wraps it as a single object, unlike Node's three top-level siblings).
    const envelope = await api(`/turns-valclass/history${qs ? "?" + qs : ""}`);
    return envelope.data;
  }

  async function loadChart(material, title) {
    // Vendor mode is mutually exclusive with material search / MRP controller /
    // Show All — switch back to the single-chart view first.
    if (vendorId) {
      vendorId = "";
      const vendorSel = document.getElementById("shf-vendor");
      if (vendorSel) vendorSel.value = "";
      destroyAllVendorRowCharts();
      document.getElementById("shf-vendor-view").classList.add("hidden");
      document.getElementById("shf-vendor-view").innerHTML = "";
      document.getElementById("shf-single-view").classList.remove("hidden");
    }

    destroyCharts();
    const myGeneration = ++loadChartGeneration;
    excludedDeliveryIds = material === currentMaterial ? excludedDeliveryIds : new Set();
    currentMaterial = material || null;
    const titleEl = document.getElementById("shf-chart-title");
    titleEl.textContent = "Loading…";
    const mrpLink = document.getElementById("shf-mrp-link");
    mrpLink.classList.toggle("hidden", !currentMaterial);
    if (currentMaterial) mrpLink.href = `/Logistics/OrderSuggestions?material=${encodeURIComponent(currentMaterial)}`;
    const adjustmentLink = document.getElementById("shf-adjustment-link");
    adjustmentLink.classList.toggle("hidden", !currentMaterial);
    if (currentMaterial) adjustmentLink.href = `/Logistics/DemandAdjustments?material=${encodeURIComponent(currentMaterial)}`;

    try {
      const json = await fetchHistory({ material, bucket: bucketMode });
      // A newer loadChart call started while this one's fetch was in flight
      // — bail out without touching the DOM/canvases at all, the newer call
      // owns them now (and will have already called destroyCharts() itself).
      if (myGeneration !== loadChartGeneration) return;

      let row;
      if (material) {
        row = json.data[0];
        if (!row) throw new Error("No history/forecast data for that material.");
      } else {
        const history = new Array(13).fill(0), forecast = new Array(13).fill(0), predicted = new Array(13).fill(0);
        json.data.forEach((r) => {
          (r.consumptionHistory || []).forEach((v, i) => { history[i] += Number(v) || 0; });
          (r.demandForecast || []).forEach((v, i) => { forecast[i] += Number(v) || 0; });
          (r.predictedUsage || []).forEach((v, i) => { predicted[i] += Number(v) || 0; });
        });
        row = { consumptionHistory: history, demandForecast: forecast, predictedUsage: predicted };
      }

      titleEl.textContent = title;

      let noteEl = document.getElementById("shf-history-note");
      if (!noteEl) {
        noteEl = document.createElement("div");
        noteEl.id = "shf-history-note";
        noteEl.style.cssText = "font-size:12px;color:var(--text-muted);margin-top:8px";
        titleEl.parentElement.appendChild(noteEl);
      }
      const noHistory = (row.consumptionHistory || []).every((v) => !v);
      noteEl.textContent = noHistory
        ? "No consumption history recorded in SAP (MVER) for this selection — the material's consumption-values indicator may not be maintained, or it genuinely has no consumption yet."
        : "";

      // Defensive backstop alongside the generation guard above — destroys
      // whatever Chart.js instance (if any) is actually still attached to
      // each canvas, independent of which JS array/variable was tracking it.
      Chart.getChart("shf-chart")?.destroy();
      charts.push(new Chart(document.getElementById("shf-chart"), buildConsumptionChartConfig(row, json.accuracy || {})));

      const stockForecast = json.stockForecast;
      if (stockForecast) {
        updateStockChartHeading(stockForecast, !!material);
        Chart.getChart("shf-stock-chart")?.destroy();
        charts.push(new Chart(document.getElementById("shf-stock-chart"), buildStockChartConfig(stockForecast)));
        renderDeliveriesList(stockForecast);
      }
    } catch (err) {
      if (myGeneration !== loadChartGeneration) return;
      titleEl.textContent = "Error";
      document.getElementById("shf-stock-deliveries").innerHTML = "";
      await NexusModal.alert(err.message);
    }
  }

  async function loadMrpControllers() {
    const sel = document.getElementById("shf-mrp-controller");
    try {
      const { data } = await api("/turns-valclass/mrp-controllers");
      (data || []).forEach((row) => {
        const opt = document.createElement("option");
        opt.value = row.controller;
        opt.textContent = `${row.controller} (${row.materialCount})`;
        sel.appendChild(opt);
      });
    } catch { /* dropdown just stays at "All controllers" */ }
  }

  async function searchMaterials() {
    const material = document.getElementById("shf-search-material").value.trim();
    const materialText = document.getElementById("shf-search-desc").value.trim();
    const picker = document.getElementById("shf-picker");
    if (!material && !materialText) { picker.innerHTML = ""; return; }

    picker.innerHTML = '<div class="nx-toolbar-hint">Searching…</div>';
    try {
      const params = new URLSearchParams();
      if (material) params.set("material", material);
      if (materialText) params.set("materialText", materialText);
      if (mrpController) params.set("mrpController", mrpController);
      const { data } = await api(`/turns-valclass?${params.toString()}`);
      const rows = (data || []).slice(0, 30);
      if (!rows.length) { picker.innerHTML = '<div class="nx-empty">No materials matched.</div>'; return; }

      picker.innerHTML = `
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">
          ${rows.length} material${rows.length !== 1 ? "s" : ""} found — click a row to load its chart (showing the first below):
        </div>
        <div style="overflow-x:auto">
          <table>
            <thead><tr><th>Material</th><th>Description</th></tr></thead>
            <tbody>
              ${rows.map((r) => `<tr class="shf-pick" style="cursor:pointer" data-material="${esc(r.material)}" data-desc="${esc(r.materialText || "")}">
                <td style="font-family:'JetBrains Mono',monospace;font-weight:700">${esc(r.material)}</td>
                <td>${esc(r.materialText || "—")}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>`;

      picker.querySelectorAll(".shf-pick").forEach((tr) => {
        tr.addEventListener("click", () => {
          loadChart(tr.dataset.material, `${tr.dataset.material}${tr.dataset.desc ? " — " + tr.dataset.desc : ""}`);
        });
      });

      const first = rows[0];
      loadChart(first.material, `${first.material}${first.materialText ? " — " + first.materialText : ""}`);
    } catch (err) {
      picker.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  // ── Vendor filter — one chart-pair row per material the vendor supplies ──

  async function loadVendors() {
    const sel = document.getElementById("shf-vendor");
    try {
      const { data } = await api("/vendors");
      (data || []).filter((v) => Number(v.materialCount) > 0).forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v.vendorId;
        opt.textContent = `${v.vendorName} (${v.materialCount})`;
        sel.appendChild(opt);
      });
    } catch { /* dropdown just stays at "— none —" */ }
  }

  async function onVendorChange(newVendorId) {
    vendorId = newVendorId;
    const singleView = document.getElementById("shf-single-view");
    const vendorView = document.getElementById("shf-vendor-view");
    destroyCharts();
    destroyAllVendorRowCharts();
    vendorRowExcludedIds = new Map();

    if (!vendorId) {
      vendorView.classList.add("hidden");
      vendorView.innerHTML = "";
      singleView.classList.remove("hidden");
      return;
    }

    // Mutually exclusive with the other two filters.
    document.getElementById("shf-search-material").value = "";
    document.getElementById("shf-search-desc").value = "";
    document.getElementById("shf-picker").innerHTML = "";
    document.getElementById("shf-mrp-controller").value = "";
    mrpController = "";
    currentMaterial = null;

    singleView.classList.add("hidden");
    vendorView.classList.remove("hidden");
    vendorView.innerHTML = '<div class="nx-toolbar-hint">Loading vendor materials…</div>';

    try {
      const { data } = await api(`/vendors/${vendorId}/materials`);
      const materials = data || [];
      if (!materials.length) {
        vendorView.innerHTML = '<div class="nx-empty">This vendor has no materials assigned in MRP master data.</div>';
        return;
      }

      vendorView.innerHTML = materials.map((m) => `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-top:14px" data-shf-row="${esc(m.material)}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px">
            <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em">${esc(m.material)}${m.materialText ? " — " + esc(m.materialText) : ""}</div>
            <div style="display:flex;gap:14px;flex-shrink:0">
              <a href="/Logistics/DemandAdjustments?material=${encodeURIComponent(m.material)}" style="font-size:11px;color:var(--accent);white-space:nowrap">+ Add Demand Adjustment</a>
              <a href="/Logistics/OrderSuggestions?material=${encodeURIComponent(m.material)}" style="font-size:11px;color:var(--accent);white-space:nowrap">View in MRP &rarr;</a>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">
            <div><canvas id="shf-vc-${esc(m.material)}" style="max-height:260px"></canvas></div>
            <div>
              <canvas id="shf-vs-${esc(m.material)}" style="max-height:260px"></canvas>
              <div id="shf-vd-${esc(m.material)}" style="margin-top:10px"></div>
            </div>
          </div>
        </div>`).join("");

      materials.forEach((m) => renderVendorRow(m.material));
    } catch (err) {
      vendorView.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  async function renderVendorRow(material) {
    const consumptionCanvas = document.getElementById(`shf-vc-${material}`);
    const stockCanvas = document.getElementById(`shf-vs-${material}`);
    const deliveriesEl = document.getElementById(`shf-vd-${material}`);
    if (!consumptionCanvas || !stockCanvas) return;

    const excludedIds = vendorRowExcludedIds.get(material) || new Set();
    vendorRowExcludedIds.set(material, excludedIds);

    try {
      const json = await fetchHistory({ material, excludeDeliveryIds: excludedIds });
      const row = json.data[0];
      if (!row) throw new Error("No data for this material.");

      // Must destroy this row's own previous chart instances before re-creating —
      // Chart.js throws "Canvas is already in use" if a new Chart attaches to a
      // canvas that still has a live instance (hit for real when toggling a
      // delivery re-renders just this one row without touching the others).
      destroyVendorRowCharts(material);
      Chart.getChart(consumptionCanvas)?.destroy();
      Chart.getChart(stockCanvas)?.destroy();

      const consumptionChart = new Chart(consumptionCanvas, buildConsumptionChartConfig(row, json.accuracy || {}));
      const rowCharts = { consumption: consumptionChart, stock: null };
      vendorRowCharts.set(material, rowCharts);

      if (json.stockForecast) {
        const stockChart = new Chart(stockCanvas, buildStockChartConfig(json.stockForecast));
        rowCharts.stock = stockChart;
        if (deliveriesEl) {
          renderVendorRowDeliveries(deliveriesEl, json.stockForecast, excludedIds, (id, included) => {
            if (included) excludedIds.delete(id); else excludedIds.add(id);
            renderVendorRow(material);
          });
        }
      }
    } catch (err) {
      const wrapper = consumptionCanvas.closest("[data-shf-row]");
      if (wrapper) wrapper.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function renderVendorRowDeliveries(container, stockForecast, excludedIds, onToggle) {
    const deliveries = [];
    stockForecast.weeks.forEach((w) => (w.deliveries || []).forEach((d) => deliveries.push({ ...d, weekEnding: w.weekEnding })));

    if (!deliveries.length) {
      container.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">No open incoming deliveries in this window.</div>';
      return;
    }

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:4px">
        ${deliveries.map((d) => `
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer">
            <input type="checkbox" class="shf-vendor-delivery-toggle" data-id="${d.id}" ${excludedIds.has(d.id) ? "" : "checked"}>
            <span style="font-family:'JetBrains Mono',monospace">${esc(d.weekEnding)}</span>
            <span>${esc(String(d.qty))} units${d.vendorName ? " — " + esc(d.vendorName) : ""}${d.poNumber ? " — PO " + esc(d.poNumber) : ""}</span>
          </label>`).join("")}
      </div>`;

    container.querySelectorAll(".shf-vendor-delivery-toggle").forEach((cb) => {
      cb.addEventListener("change", () => onToggle(Number(cb.dataset.id), cb.checked));
    });
  }

  document.getElementById("shf-vendor").addEventListener("change", (e) => onVendorChange(e.target.value));

  document.getElementById("shf-search-btn").addEventListener("click", searchMaterials);
  ["shf-search-material", "shf-search-desc"].forEach((id) => {
    document.getElementById(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); searchMaterials(); }
    });
  });
  document.getElementById("shf-all-btn").addEventListener("click", () => loadChart(null, "All Materials (combined)"));
  document.getElementById("shf-mrp-controller").addEventListener("change", (e) => {
    mrpController = e.target.value;
    loadChart(null, mrpController ? `All Materials — MRP Controller ${mrpController} (combined)` : "All Materials (combined)");
  });
  document.querySelectorAll(".shf-bucket-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.bucket === bucketMode) return;
      bucketMode = btn.dataset.bucket;
      setActiveBucketBtn(bucketMode);
      if (currentMaterial) loadChart(currentMaterial, document.getElementById("shf-chart-title").textContent);
    });
  });

  loadMrpControllers();
  loadVendors();

  // Deep-link from Order Suggestions' row context menu (?material=X — see
  // window.__shfInitialMaterial, set inline by StockHistoryForecast.cshtml).
  if (window.__shfInitialMaterial) {
    document.getElementById("shf-search-material").value = window.__shfInitialMaterial;
    const title = window.__shfInitialMaterial + (window.__shfInitialMaterialText ? " — " + window.__shfInitialMaterialText : "");
    loadChart(window.__shfInitialMaterial, title);
  } else {
    loadChart(null, "All Materials (combined)");
  }
})();
