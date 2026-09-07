// Reference Data tile — Destinations, Forwarders, Forwarder Mode Mapping,
// Cost Centres, GL Accounts (Cost Elements), Material Request Units, and
// (view + edit-in-place, no create/delete — fixed master sets) Pallet/
// Packaging Data. Each section lazy-loads the first time it's shown.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api");

  const sections = ["destinations", "forwarders", "fmm", "costcenters", "costelements", "mru", "palletpack"];
  const loaded = new Set();

  document.querySelectorAll("button[data-section]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.section;
      sections.forEach((s) => { document.getElementById(`rd-${s}`).hidden = s !== target; });
      if (!loaded.has(target)) {
        loaded.add(target);
        loaders[target]();
      }
    });
  });

  // ── Destinations ────────────────────────────────────────────────
  let destRows = [];
  async function loadDestinations() {
    const el = document.getElementById("rd-dest-list");
    el.textContent = "Loading…";
    try {
      const { data } = await api("/destinations");
      destRows = data || [];
      renderDestinations();
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function renderDestinations() {
    const q = document.getElementById("rd-dest-search").value.trim().toLowerCase();
    const rows = q ? destRows.filter((r) => (r.destinationName || "").toLowerCase().includes(q) || (r.destinationCity || "").toLowerCase().includes(q)) : destRows;
    const el = document.getElementById("rd-dest-list");
    el.innerHTML = rows.length === 0 ? "<p>No destinations.</p>" : `
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>City</th><th>Country</th><th>Zone</th><th>Forwarder</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${esc(r.destinationId)}</td><td>${esc(r.destinationName)}</td><td>${esc(r.destinationCity)}</td>
              <td>${esc(r.destinationCountry)}</td><td>${esc(r.destinationZone)}</td><td>${esc(r.defaultForwarder)}</td>
              <td><button type="button" class="btn secondary" data-edit="${r.destinationId}">Edit</button></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    el.querySelectorAll("button[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const r = destRows.find((x) => String(x.destinationId) === btn.dataset.edit);
        if (!r) return;
        document.getElementById("rd-dest-form-title").textContent = `Edit Destination ${r.destinationId}`;
        document.getElementById("rd-dest-id-hidden").value = r.destinationId;
        document.getElementById("rd-dest-id").value = r.destinationId;
        document.getElementById("rd-dest-id").disabled = true;
        document.getElementById("rd-dest-name").value = r.destinationName || "";
        document.getElementById("rd-dest-street").value = r.destinationStreet || "";
        document.getElementById("rd-dest-city").value = r.destinationCity || "";
        document.getElementById("rd-dest-postcode").value = r.destinationPostCode || "";
        document.getElementById("rd-dest-country").value = r.destinationCountry || "";
        document.getElementById("rd-dest-incoterms").value = r.defaultIncoterms || "";
        document.getElementById("rd-dest-zone").value = r.destinationZone || "";
        document.getElementById("rd-dest-service").value = r.defaultDeliveryService || "";
        document.getElementById("rd-dest-forwarder").value = r.defaultForwarder || "";
        document.getElementById("rd-dest-comment").value = r.destinationComment || "";
      });
    });
  }

  document.getElementById("rd-dest-search").addEventListener("input", renderDestinations);

  function resetDestForm() {
    document.getElementById("rd-dest-form").reset();
    document.getElementById("rd-dest-form-title").textContent = "Add Destination";
    document.getElementById("rd-dest-id-hidden").value = "";
    document.getElementById("rd-dest-id").disabled = false;
  }
  document.getElementById("rd-dest-cancel").addEventListener("click", resetDestForm);

  document.getElementById("rd-dest-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const editingId = document.getElementById("rd-dest-id-hidden").value;
    const body = {
      destinationName: document.getElementById("rd-dest-name").value || null,
      destinationStreet: document.getElementById("rd-dest-street").value || null,
      destinationCity: document.getElementById("rd-dest-city").value || null,
      destinationPostCode: document.getElementById("rd-dest-postcode").value || null,
      destinationCountry: document.getElementById("rd-dest-country").value || null,
      defaultIncoterms: document.getElementById("rd-dest-incoterms").value || null,
      destinationZone: document.getElementById("rd-dest-zone").value || null,
      defaultDeliveryService: document.getElementById("rd-dest-service").value || null,
      defaultForwarder: document.getElementById("rd-dest-forwarder").value || null,
      destinationComment: document.getElementById("rd-dest-comment").value || null,
    };
    try {
      if (editingId) {
        await api(`/destinations/${editingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } else {
        await api("/destinations", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ destinationId: Number(document.getElementById("rd-dest-id").value), ...body }),
        });
      }
      resetDestForm();
      await loadDestinations();
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  // ── Forwarders ───────────────────────────────────────────────────
  let fwdRows = [];
  async function loadForwarders() {
    const el = document.getElementById("rd-fwd-list");
    el.textContent = "Loading…";
    try {
      const { data } = await api("/forwarders");
      fwdRows = data || [];
      el.innerHTML = fwdRows.length === 0 ? "<p>No forwarders.</p>" : `
        <table>
          <thead><tr><th>ID</th><th>Name</th><th>Mode</th><th>Approved</th><th></th></tr></thead>
          <tbody>
            ${fwdRows.map((r) => `
              <tr>
                <td>${esc(r.forwarderId)}</td><td>${esc(r.forwarderName)}</td><td>${esc(r.forwarderMode)}</td><td>${r.forwarderApproval ? "Yes" : "No"}</td>
                <td><button type="button" class="btn secondary" data-edit="${r.forwarderId}" data-mode="${esc(r.forwarderMode || "")}">Edit</button></td>
              </tr>`).join("")}
          </tbody>
        </table>`;
      el.querySelectorAll("button[data-edit]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const r = fwdRows.find((x) => String(x.forwarderId) === btn.dataset.edit && (x.forwarderMode || "") === btn.dataset.mode);
          if (!r) return;
          document.getElementById("rd-fwd-form-title").textContent = `Edit Forwarder ${r.forwarderId}`;
          document.getElementById("rd-fwd-original-mode").value = r.forwarderMode || "";
          document.getElementById("rd-fwd-id").value = r.forwarderId;
          document.getElementById("rd-fwd-id").disabled = true;
          document.getElementById("rd-fwd-name").value = r.forwarderName || "";
          document.getElementById("rd-fwd-mode").value = r.forwarderMode || "";
          document.getElementById("rd-fwd-approved").checked = !!r.forwarderApproval;
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function resetFwdForm() {
    document.getElementById("rd-fwd-form").reset();
    document.getElementById("rd-fwd-form-title").textContent = "Add Forwarder";
    document.getElementById("rd-fwd-original-mode").value = "";
    document.getElementById("rd-fwd-id").disabled = false;
  }
  document.getElementById("rd-fwd-cancel").addEventListener("click", resetFwdForm);

  document.getElementById("rd-fwd-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const isEdit = document.getElementById("rd-fwd-id").disabled;
    const forwarderId = Number(document.getElementById("rd-fwd-id").value);
    const forwarderName = document.getElementById("rd-fwd-name").value;
    const forwarderMode = document.getElementById("rd-fwd-mode").value || null;
    const forwarderApproval = document.getElementById("rd-fwd-approved").checked;
    try {
      if (isEdit) {
        await api(`/forwarders/${forwarderId}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forwarderName, forwarderApproval, forwarderMode, originalMode: document.getElementById("rd-fwd-original-mode").value || null }),
        });
      } else {
        await api("/forwarders", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forwarderId, forwarderName, forwarderApproval, forwarderMode }),
        });
      }
      resetFwdForm();
      await loadForwarders();
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  // ── Forwarder Mode Mapping ──────────────────────────────────────
  let fmmRows = [];
  async function loadFmm() {
    const el = document.getElementById("rd-fmm-list");
    el.textContent = "Loading…";
    try {
      const [mappings, types] = await Promise.all([api("/forwarder-mode-mapping"), api("/forwarder-mode-mapping/forwarder-types")]);
      fmmRows = mappings.data || [];
      const typeSel = document.getElementById("rd-fmm-type");
      typeSel.innerHTML = (types.data || []).map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
      el.innerHTML = fmmRows.length === 0 ? "<p>No mappings.</p>" : `
        <table>
          <thead><tr><th>Forwarder Type</th><th>Mode of Transport</th><th>Description</th><th></th></tr></thead>
          <tbody>
            ${fmmRows.map((r) => `
              <tr>
                <td>${esc(r.forwarderMode)}</td><td>${esc(r.modeOfTransport)}</td><td>${esc(r.description)}</td>
                <td>
                  <button type="button" class="btn secondary" data-edit="${r.mappingId}">Edit</button>
                  <button type="button" class="btn secondary" data-delete="${r.mappingId}">Delete</button>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>`;
      el.querySelectorAll("button[data-edit]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const r = fmmRows.find((x) => String(x.mappingId) === btn.dataset.edit);
          if (!r) return;
          document.getElementById("rd-fmm-form-title").textContent = `Edit Mapping #${r.mappingId}`;
          document.getElementById("rd-fmm-id-hidden").value = r.mappingId;
          document.getElementById("rd-fmm-type").value = r.forwarderMode;
          document.getElementById("rd-fmm-mot").value = r.modeOfTransport || "";
          document.getElementById("rd-fmm-desc").value = r.description || "";
        });
      });
      el.querySelectorAll("button[data-delete]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this mapping?")) return;
          try {
            await api(`/forwarder-mode-mapping/${btn.dataset.delete}`, { method: "DELETE" });
            await loadFmm();
          } catch (err) {
            alert("Error: " + err.message);
          }
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function resetFmmForm() {
    document.getElementById("rd-fmm-form").reset();
    document.getElementById("rd-fmm-form-title").textContent = "Add Mapping";
    document.getElementById("rd-fmm-id-hidden").value = "";
  }
  document.getElementById("rd-fmm-cancel").addEventListener("click", resetFmmForm);

  document.getElementById("rd-fmm-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const editingId = document.getElementById("rd-fmm-id-hidden").value;
    const body = {
      forwarderMode: document.getElementById("rd-fmm-type").value,
      modeOfTransport: document.getElementById("rd-fmm-mot").value,
      description: document.getElementById("rd-fmm-desc").value || null,
    };
    try {
      if (editingId) await api(`/forwarder-mode-mapping/${editingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      else await api("/forwarder-mode-mapping", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      resetFmmForm();
      await loadFmm();
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  // ── Cost Centres ─────────────────────────────────────────────────
  let ccRows = [];
  async function loadCostCenters() {
    const el = document.getElementById("rd-cc-list");
    el.textContent = "Loading…";
    try {
      const { data } = await api("/costcenters");
      ccRows = data || [];
      el.innerHTML = ccRows.length === 0 ? "<p>No cost centres.</p>" : `
        <table>
          <thead><tr><th>Code</th><th>Description</th><th></th></tr></thead>
          <tbody>
            ${ccRows.map((r) => `
              <tr><td>${esc(r.centerCode)}</td><td>${esc(r.centerDescription)}</td>
              <td>
                <button type="button" class="btn secondary" data-edit="${r.centerId}">Edit</button>
                <button type="button" class="btn secondary" data-delete="${r.centerId}">Delete</button>
              </td></tr>`).join("")}
          </tbody>
        </table>`;
      el.querySelectorAll("button[data-edit]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const r = ccRows.find((x) => String(x.centerId) === btn.dataset.edit);
          if (!r) return;
          document.getElementById("rd-cc-form-title").textContent = `Edit Cost Centre`;
          document.getElementById("rd-cc-id-hidden").value = r.centerId;
          document.getElementById("rd-cc-code").value = r.centerCode || "";
          document.getElementById("rd-cc-desc").value = r.centerDescription || "";
        });
      });
      el.querySelectorAll("button[data-delete]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this cost centre?")) return;
          try { await api(`/costcenters/${btn.dataset.delete}`, { method: "DELETE" }); await loadCostCenters(); } catch (err) { alert("Error: " + err.message); }
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function resetCcForm() {
    document.getElementById("rd-cc-form").reset();
    document.getElementById("rd-cc-form-title").textContent = "Add Cost Centre";
    document.getElementById("rd-cc-id-hidden").value = "";
  }
  document.getElementById("rd-cc-cancel").addEventListener("click", resetCcForm);

  document.getElementById("rd-cc-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const editingId = document.getElementById("rd-cc-id-hidden").value;
    const body = { centerCode: document.getElementById("rd-cc-code").value, centerDescription: document.getElementById("rd-cc-desc").value };
    try {
      if (editingId) await api(`/costcenters/${editingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      else await api("/costcenters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      resetCcForm();
      await loadCostCenters();
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  // ── Cost Elements (GL Accounts) ─────────────────────────────────
  let ceRows = [];
  async function loadCostElements() {
    const el = document.getElementById("rd-ce-list");
    el.textContent = "Loading…";
    try {
      const { data } = await api("/costelements");
      ceRows = data || [];
      el.innerHTML = ceRows.length === 0 ? "<p>No GL accounts.</p>" : `
        <table>
          <thead><tr><th>Code</th><th>Description</th><th>Direction</th><th>Tier</th><th></th></tr></thead>
          <tbody>
            ${ceRows.map((r) => `
              <tr><td>${esc(r.elementCode)}</td><td>${esc(r.elementDescription)}</td><td>${esc(r.direction)}</td><td>${esc(r.tier)}</td>
              <td>
                <button type="button" class="btn secondary" data-edit="${r.elementId}">Edit</button>
                <button type="button" class="btn secondary" data-delete="${r.elementId}">Delete</button>
              </td></tr>`).join("")}
          </tbody>
        </table>`;
      el.querySelectorAll("button[data-edit]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const r = ceRows.find((x) => String(x.elementId) === btn.dataset.edit);
          if (!r) return;
          document.getElementById("rd-ce-form-title").textContent = "Edit GL Account";
          document.getElementById("rd-ce-id-hidden").value = r.elementId;
          document.getElementById("rd-ce-code").value = r.elementCode || "";
          document.getElementById("rd-ce-desc").value = r.elementDescription || "";
          document.getElementById("rd-ce-direction").value = r.direction || "";
          document.getElementById("rd-ce-tier").value = r.tier || "";
        });
      });
      el.querySelectorAll("button[data-delete]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this GL account?")) return;
          try { await api(`/costelements/${btn.dataset.delete}`, { method: "DELETE" }); await loadCostElements(); } catch (err) { alert("Error: " + err.message); }
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function resetCeForm() {
    document.getElementById("rd-ce-form").reset();
    document.getElementById("rd-ce-form-title").textContent = "Add GL Account";
    document.getElementById("rd-ce-id-hidden").value = "";
  }
  document.getElementById("rd-ce-cancel").addEventListener("click", resetCeForm);

  document.getElementById("rd-ce-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const editingId = document.getElementById("rd-ce-id-hidden").value;
    const body = {
      elementCode: document.getElementById("rd-ce-code").value,
      elementDescription: document.getElementById("rd-ce-desc").value,
      direction: document.getElementById("rd-ce-direction").value || null,
      tier: document.getElementById("rd-ce-tier").value || null,
    };
    try {
      if (editingId) await api(`/costelements/${editingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      else await api("/costelements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      resetCeForm();
      await loadCostElements();
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  // ── Material Request Units ──────────────────────────────────────
  let mruRows = [];
  async function loadMru() {
    const el = document.getElementById("rd-mru-list");
    el.textContent = "Loading…";
    try {
      const { data } = await api("/material-request-units");
      mruRows = data || [];
      el.innerHTML = mruRows.length === 0 ? "<p>No request units.</p>" : `
        <table>
          <thead><tr><th>Material</th><th>Unit</th><th>Conversion Qty</th><th></th></tr></thead>
          <tbody>
            ${mruRows.map((r) => `
              <tr><td>${esc(r.material)}</td><td>${esc(r.unit)}</td><td>${esc(r.conversionQty)}</td>
              <td>
                <button type="button" class="btn secondary" data-edit="${r.requestUnitId}">Edit</button>
                <button type="button" class="btn secondary" data-delete="${r.requestUnitId}">Delete</button>
              </td></tr>`).join("")}
          </tbody>
        </table>`;
      el.querySelectorAll("button[data-edit]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const r = mruRows.find((x) => String(x.requestUnitId) === btn.dataset.edit);
          if (!r) return;
          document.getElementById("rd-mru-form-title").textContent = "Edit Request Unit";
          document.getElementById("rd-mru-id-hidden").value = r.requestUnitId;
          document.getElementById("rd-mru-material").value = r.material || "";
          document.getElementById("rd-mru-unit").value = r.unit || "";
          document.getElementById("rd-mru-qty").value = r.conversionQty;
        });
      });
      el.querySelectorAll("button[data-delete]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this request unit?")) return;
          try { await api(`/material-request-units/${btn.dataset.delete}`, { method: "DELETE" }); await loadMru(); } catch (err) { alert("Error: " + err.message); }
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function resetMruForm() {
    document.getElementById("rd-mru-form").reset();
    document.getElementById("rd-mru-form-title").textContent = "Add Request Unit";
    document.getElementById("rd-mru-id-hidden").value = "";
  }
  document.getElementById("rd-mru-cancel").addEventListener("click", resetMruForm);

  document.getElementById("rd-mru-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const editingId = document.getElementById("rd-mru-id-hidden").value;
    const body = {
      material: document.getElementById("rd-mru-material").value,
      unit: document.getElementById("rd-mru-unit").value,
      conversionQty: Number(document.getElementById("rd-mru-qty").value),
    };
    try {
      if (editingId) await api(`/material-request-units/${editingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      else await api("/material-request-units", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      resetMruForm();
      await loadMru();
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  // ── Pallet & Packaging Data (view + edit-in-place, no create/delete) ──
  async function loadPalletPack() {
    const palletEl = document.getElementById("rd-pallet-list");
    const packEl = document.getElementById("rd-pack-list");
    palletEl.textContent = "Loading…";
    packEl.textContent = "Loading…";
    try {
      const [pallets, packs] = await Promise.all([api("/palletdata"), api("/packagingdata")]);
      renderPalletTable(palletEl, pallets.data || []);
      renderPackTable(packEl, packs.data || []);
    } catch (err) {
      palletEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  }

  function renderPalletTable(el, rows) {
    el.innerHTML = rows.length === 0 ? "<p>No pallet data.</p>" : `
      <table>
        <thead><tr><th>Pallet ID</th><th>Description</th><th>Weight</th><th>L</th><th>W</th><th>H</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr data-row="${esc(r.palletId)}">
              <td>${esc(r.palletId)}</td>
              <td><input type="text" value="${esc(r.palletDescription)}" data-f="palletDescription" style="width:8em;"></td>
              <td><input type="number" step="0.01" value="${r.palletWeight ?? ""}" data-f="palletWeight" style="width:5em;"></td>
              <td><input type="number" value="${r.palletLength ?? ""}" data-f="palletLength" style="width:4em;"></td>
              <td><input type="number" value="${r.palletWidth ?? ""}" data-f="palletWidth" style="width:4em;"></td>
              <td><input type="number" value="${r.palletHeight ?? ""}" data-f="palletHeight" style="width:4em;"></td>
              <td><button type="button" class="btn secondary" data-save="${esc(r.palletId)}">Save</button></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    el.querySelectorAll("button[data-save]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tr = el.querySelector(`tr[data-row="${btn.dataset.save}"]`);
        const body = {
          palletDescription: tr.querySelector('[data-f="palletDescription"]').value || null,
          palletWeight: tr.querySelector('[data-f="palletWeight"]').value ? Number(tr.querySelector('[data-f="palletWeight"]').value) : null,
          palletLength: tr.querySelector('[data-f="palletLength"]').value ? Number(tr.querySelector('[data-f="palletLength"]').value) : null,
          palletWidth: tr.querySelector('[data-f="palletWidth"]').value ? Number(tr.querySelector('[data-f="palletWidth"]').value) : null,
          palletHeight: tr.querySelector('[data-f="palletHeight"]').value ? Number(tr.querySelector('[data-f="palletHeight"]').value) : null,
        };
        try {
          await api(`/palletdata/${encodeURIComponent(btn.dataset.save)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        } catch (err) {
          alert("Error: " + err.message);
        }
      });
    });
  }

  function renderPackTable(el, rows) {
    el.innerHTML = rows.length === 0 ? "<p>No packaging data.</p>" : `
      <table>
        <thead><tr><th>Pack ID</th><th>Material</th><th>Description</th><th>Weight</th><th>L</th><th>W</th><th>H</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr data-row="${esc(r.packId)}">
              <td>${esc(r.packId)}</td>
              <td><input type="text" value="${esc(r.packMaterial)}" data-f="packMaterial" style="width:6em;"></td>
              <td><input type="text" value="${esc(r.packDescription)}" data-f="packDescription" style="width:8em;"></td>
              <td><input type="number" step="0.01" value="${r.packWeight ?? ""}" data-f="packWeight" style="width:5em;"></td>
              <td><input type="number" value="${r.packLength ?? ""}" data-f="packLength" style="width:4em;"></td>
              <td><input type="number" value="${r.packWidth ?? ""}" data-f="packWidth" style="width:4em;"></td>
              <td><input type="number" value="${r.packHeight ?? ""}" data-f="packHeight" style="width:4em;"></td>
              <td><button type="button" class="btn secondary" data-save="${esc(r.packId)}">Save</button></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    el.querySelectorAll("button[data-save]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tr = el.querySelector(`tr[data-row="${btn.dataset.save}"]`);
        const body = {
          packMaterial: tr.querySelector('[data-f="packMaterial"]').value || null,
          packDescription: tr.querySelector('[data-f="packDescription"]').value || null,
          packWeight: tr.querySelector('[data-f="packWeight"]').value ? Number(tr.querySelector('[data-f="packWeight"]').value) : null,
          packLength: tr.querySelector('[data-f="packLength"]').value ? Number(tr.querySelector('[data-f="packLength"]').value) : null,
          packWidth: tr.querySelector('[data-f="packWidth"]').value ? Number(tr.querySelector('[data-f="packWidth"]').value) : null,
          packHeight: tr.querySelector('[data-f="packHeight"]').value ? Number(tr.querySelector('[data-f="packHeight"]').value) : null,
        };
        try {
          await api(`/packagingdata/${encodeURIComponent(btn.dataset.save)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        } catch (err) {
          alert("Error: " + err.message);
        }
      });
    });
  }

  const loaders = {
    destinations: loadDestinations,
    forwarders: loadForwarders,
    fmm: loadFmm,
    costcenters: loadCostCenters,
    costelements: loadCostElements,
    mru: loadMru,
    palletpack: loadPalletPack,
  };

  // Show Destinations by default.
  document.querySelector('button[data-section="destinations"]').click();
})();
