// Packaging Instruction Detail tile — ported from private/js/engineering.js's
// renderInstructionDetail() (lines 303-476 in the Node original).
(function () {
  const materialInput = document.getElementById("pi-material");
  const loadBtn = document.getElementById("pi-load");
  const scopeSection = document.getElementById("pi-scope-section");
  const descriptionEl = document.getElementById("pi-description");
  const scopeSelect = document.getElementById("pi-scope");
  const formSection = document.getElementById("pi-form-section");
  const bannerEl = document.getElementById("pi-banner");
  const traceNoteEl = document.getElementById("pi-trace-note");
  const saveBtn = document.getElementById("pi-save");
  const deleteBtn = document.getElementById("pi-delete");
  const msgEl = document.getElementById("pi-msg");

  const fields = {
    packMaterial: document.getElementById("pi-packmat"),
    palletQty: document.getElementById("pi-pallqty"),
    smallBoxQty: document.getElementById("pi-sbqty"),
    packProd: document.getElementById("pi-packprod"),
    partMix: document.getElementById("pi-partmix"),
    batchSpread: document.getElementById("pi-batchspread"),
    boxGen: document.getElementById("pi-boxgen"),
    chargeReq: document.getElementById("pi-chargereq"),
    techStatReq: document.getElementById("pi-techstatreq"),
    pNumReq: document.getElementById("pi-pnumreq"),
  };

  let currentMaterial = "";
  let currentExists = false;

  async function api(path, opts) {
    const r = await fetch("/api/packaging" + path, opts);
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

  async function loadMaterial() {
    const material = materialInput.value.trim();
    if (!material) return;

    msgEl.textContent = "";
    try {
      const [descriptionRes, customersRes] = await Promise.all([
        api(`/material/${encodeURIComponent(material)}/description`),
        api(`/material/${encodeURIComponent(material)}/customers`),
      ]);
      currentMaterial = material;
      renderScopePicker(material, descriptionRes.data, customersRes.data);
    } catch (err) {
      msgEl.textContent = err.message;
    }
  }

  function renderScopePicker(material, description, customers) {
    descriptionEl.textContent = `${material} — ${description ?? "(no description)"}`;

    scopeSelect.innerHTML = "";
    const plantOption = document.createElement("option");
    plantOption.value = "";
    plantOption.textContent = "Plant Default (all customers)";
    scopeSelect.appendChild(plantOption);

    for (const c of customers) {
      const option = document.createElement("option");
      option.value = c.customer;
      option.textContent = `${c.customer} — ${c.name || c.customerGroup}`;
      scopeSelect.appendChild(option);
    }

    scopeSection.hidden = false;
    scopeSelect.onchange = () => loadInstruction(material, scopeSelect.value || null);
    loadInstruction(material, null);
  }

  async function loadInstruction(material, customer) {
    msgEl.textContent = "";
    try {
      const query = customer ? `?customer=${encodeURIComponent(customer)}` : "";
      const { data: row } = await api(`/material/${encodeURIComponent(material)}/instruction${query}`);
      renderForm(material, customer, row);
    } catch (err) {
      msgEl.textContent = err.message;
    }
  }

  function renderForm(material, customer, row) {
    currentExists = row != null;
    const v = row || {
      packMaterial: "",
      palletQty: 0,
      smallBoxQty: 0,
      packProd: false,
      boxGen: false,
      batchSpread: false,
      partMix: false,
      chargeReq: false,
      techStatReq: false,
      pNumReq: false,
    };

    fields.packMaterial.value = v.packMaterial;
    fields.palletQty.value = v.palletQty;
    fields.smallBoxQty.value = v.smallBoxQty;
    fields.packProd.checked = v.packProd;
    fields.boxGen.checked = v.boxGen;
    fields.batchSpread.checked = v.batchSpread;
    fields.partMix.checked = v.partMix;
    fields.chargeReq.checked = v.chargeReq;
    fields.techStatReq.checked = v.techStatReq;
    fields.pNumReq.checked = v.pNumReq;

    const isPlant = !customer;
    traceNoteEl.hidden = isPlant;

    bannerEl.hidden = row != null;
    bannerEl.textContent = "No instruction saved yet for this scope — fill in the form below to create one.";

    deleteBtn.hidden = row == null;

    formSection.hidden = false;
    saveBtn.onclick = () => saveInstruction(material, customer, currentExists);
    deleteBtn.onclick = () => deleteInstruction(material, customer);
  }

  async function saveInstruction(material, customer, exists) {
    msgEl.textContent = "";
    const packMaterial = fields.packMaterial.value.trim();
    if (!packMaterial) {
      msgEl.textContent = "Enter a packaging material.";
      return;
    }

    const body = {
      material,
      customer: customer || null,
      sqlAction: exists ? "U" : "I",
      packMaterial,
      palletQty: Number(fields.palletQty.value) || 0,
      smallBoxQty: Number(fields.smallBoxQty.value) || 0,
      packProd: fields.packProd.checked,
      boxGen: fields.boxGen.checked,
      batchSpread: fields.batchSpread.checked,
      partMix: fields.partMix.checked,
      chargeReq: fields.chargeReq.checked,
      techStatReq: fields.techStatReq.checked,
      pNumReq: fields.pNumReq.checked,
    };

    saveBtn.disabled = true;
    try {
      await api("/instruction", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await loadInstruction(material, customer);
    } catch (err) {
      msgEl.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function deleteInstruction(material, customer) {
    const scopeLabel = customer ? ` / ${customer}` : " (plant default)";
    if (!confirm(`Delete the packaging instruction for ${material}${scopeLabel}?`)) return;

    try {
      await api("/instruction", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ material, customer: customer || null }),
      });
      await loadInstruction(material, customer);
    } catch (err) {
      msgEl.textContent = err.message;
    }
  }

  loadBtn.addEventListener("click", loadMaterial);
  materialInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadMaterial();
  });
})();
