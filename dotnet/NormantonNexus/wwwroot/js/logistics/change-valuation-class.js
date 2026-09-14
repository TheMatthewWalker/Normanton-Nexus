// Change Valuation Class — a genuinely missing tile found by a later gap
// audit against the Node tile inventory (private/js/logistics.js's own
// runChangeValuationClass()), not a deliberate deferral. Search materials,
// pick a new valuation class per row, submit a real SAP write. See
// PerformanceController.ChangeValuationClass's own comment and
// ChangeValuationClassResponse's header comment in PerformanceModels.cs —
// this repo has no local SapServer checkout to confirm the response shape
// against, unverified against a live SapServer.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/performance");

  const valClassCache = {}; // materialType -> catalog rows

  function fmtGbp(n) {
    if (n === null || n === undefined || n === "") return "—";
    return "£" + Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  async function fetchValClassCatalog(materialType) {
    const key = materialType || "";
    if (valClassCache[key]) return valClassCache[key];
    const qs = materialType ? `?materialType=${encodeURIComponent(materialType)}` : "";
    const { data } = await api(`/turns-valclass/valuation-classes${qs}`);
    valClassCache[key] = data || [];
    return valClassCache[key];
  }

  async function searchMaterials() {
    const bodyEl = document.getElementById("cvc-materials-body");
    const search = document.getElementById("cvc-search").value.trim();
    bodyEl.innerHTML = '<div class="nx-toolbar-hint">Searching…</div>';
    document.getElementById("cvc-submit-row").hidden = true;
    document.getElementById("cvc-results-body").innerHTML = "";
    try {
      const qs = search ? `?search=${encodeURIComponent(search)}` : "";
      const { data } = await api(`/turns-valclass${qs}`);
      renderMaterials((data || []).slice(0, 50));
    } catch (err) {
      bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function renderMaterials(rows) {
    const bodyEl = document.getElementById("cvc-materials-body");
    if (rows.length === 0) {
      bodyEl.innerHTML = '<div class="nx-empty">No materials match this search.</div>';
      return;
    }

    bodyEl.innerHTML = `
      <p style="font-size:12px;color:var(--text-muted)">${rows.length} material(s) — select the rows to change, then pick a new valuation class for each</p>
      <div style="overflow-x:auto">
        <table class="table--compact">
          <thead><tr>
            <th></th><th>Material</th><th>Plant</th><th>Type</th><th>Current Val. Class</th><th>New Valuation Class</th>
          </tr></thead>
          <tbody id="cvc-materials-tbody">
            ${rows.map((r, i) => `
              <tr data-idx="${i}">
                <td><input type="checkbox" class="cvc-row-check" data-idx="${i}"></td>
                <td><strong>${esc(r.material)}</strong><div style="font-size:10.5px;color:var(--text-muted)">${esc(r.materialText || "")}</div></td>
                <td>${esc(r.plant)}</td>
                <td>${esc(r.materialType || "—")}</td>
                <td>${esc(r.valuationClass || "—")}</td>
                <td><select class="tf-input cvc-newclass" data-idx="${i}" disabled><option value="">Loading…</option></select></td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;

    rows.forEach((r, i) => populateNewClassSelect(i, r));

    bodyEl.querySelectorAll(".cvc-row-check").forEach((cb) => {
      cb.addEventListener("change", () => {
        const idx = Number(cb.dataset.idx);
        const sel = bodyEl.querySelector(`.cvc-newclass[data-idx="${idx}"]`);
        sel.disabled = !cb.checked;
        updateSubmitVisibility();
      });
    });

    window.__cvcRows = rows;
  }

  async function populateNewClassSelect(idx, row) {
    const sel = document.querySelector(`.cvc-newclass[data-idx="${idx}"]`);
    if (!sel) return;
    try {
      const catalog = await fetchValClassCatalog(row.materialType);
      const options = catalog.filter((c) => c.valuationClass !== row.valuationClass);
      sel.innerHTML =
        `<option value="">(keep ${esc(row.valuationClass || "—")})</option>` +
        options.map((c) => `<option value="${esc(c.valuationClass)}">${esc(c.valuationClass)} — ${esc(c.description || "")}</option>`).join("");
    } catch (err) {
      sel.innerHTML = `<option value="">Error: ${esc(err.message)}</option>`;
    }
  }

  function updateSubmitVisibility() {
    const anyChecked = document.querySelectorAll(".cvc-row-check:checked").length > 0;
    document.getElementById("cvc-submit-row").hidden = !anyChecked;
  }

  async function submitChange() {
    const order = document.getElementById("cvc-order").value.trim();
    const plant = document.getElementById("cvc-plant").value.trim();
    const rows = window.__cvcRows || [];
    const changes = [];
    document.querySelectorAll(".cvc-row-check:checked").forEach((cb) => {
      const idx = Number(cb.dataset.idx);
      const sel = document.querySelector(`.cvc-newclass[data-idx="${idx}"]`);
      const newValuationClass = sel.value;
      if (newValuationClass) changes.push({ material: rows[idx].material, newValuationClass });
    });

    if (!order) { alert("SAP Order is required."); return; }
    if (changes.length === 0) { alert("Pick a new valuation class for at least one selected row."); return; }

    const btn = document.getElementById("cvc-submit-btn");
    btn.disabled = true; btn.textContent = "Submitting…";
    const resultsEl = document.getElementById("cvc-results-body");
    resultsEl.innerHTML = "";
    try {
      // Raw fetch, not the shared NexusApi.make() helper — a 422 rejection
      // still carries a structured `data` payload (per-material messages)
      // that api()'s error path discards, keeping only the flat message.
      const r = await fetch("/api/performance/turns-valclass/change-valuation-class", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order, plant: plant || null, changes }),
      });
      const json = await r.json();
      if (json.data) {
        renderResults(json.data);
      } else if (!r.ok || json.success === false) {
        throw new Error(json?.error?.message || `Request failed (HTTP ${r.status})`);
      }
    } catch (err) {
      resultsEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = "Submit Change";
    }
  }

  function renderResults(data) {
    const resultsEl = document.getElementById("cvc-results-body");
    const results = (data && data.results) || [];
    resultsEl.innerHTML = `
      <h3>Result — ${data.success ? '<span style="color:var(--accent)">Success</span>' : '<span class="tf-inline-error">Failed</span>'}${data.totalValueChange !== null && data.totalValueChange !== undefined ? ` (Total value change: ${fmtGbp(data.totalValueChange)})` : ""}</h3>
      ${data.errorMessage ? `<p class="tf-inline-error">${esc(data.errorMessage)}</p>` : ""}
      ${results.length === 0 ? "" : `
        <div style="overflow-x:auto">
          <table class="table--compact">
            <thead><tr>
              <th>Material</th><th>Plant</th><th>Old Val. Class</th><th>New Val. Class</th><th>Old Book Value</th><th>New Book Value</th><th>Value Change</th><th></th>
            </tr></thead>
            <tbody>
              ${results.map((r) => `
                <tr title="${esc(r.message || "")}">
                  <td><strong>${esc(r.material)}</strong>${r.materialText ? `<div style="font-size:10.5px;color:var(--text-muted)">${esc(r.materialText)}</div>` : ""}</td>
                  <td>${esc(r.plant || "—")}</td>
                  <td>${esc(r.oldValuationClass || "—")}</td>
                  <td>${esc(r.newValuationClass || "—")}</td>
                  <td>${fmtGbp(r.oldBookValue)}</td>
                  <td>${fmtGbp(r.newBookValue)}</td>
                  <td>${fmtGbp(r.valueChange)}</td>
                  <td>${r.success ? '<span class="badge badge--ok">OK</span>' : '<span class="badge badge--error">Failed</span>'}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>`}`;
  }

  document.getElementById("cvc-search-btn").addEventListener("click", searchMaterials);
  document.getElementById("cvc-search").addEventListener("keydown", (e) => { if (e.key === "Enter") searchMaterials(); });
  document.getElementById("cvc-submit-btn").addEventListener("click", submitChange);
})();
