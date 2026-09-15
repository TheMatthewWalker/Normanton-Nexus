// Transfer Requirements (LT04) tile — port of runTransferRequirements() in
// private/js/warehouse.js. Lists open TRs (LTBK/LTBP) and confirms one via
// LT04. TR Cleanup Assistant is a separate, more advanced supervisor tool
// (routes/sap.js's batch-cleanup-transfer, LOG_SUPER-only) — not built in
// this pass, flagged as a remaining gap.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/warehouse");

  const bodyEl = document.getElementById("tr-body");
  let rows = [];

  async function load() {
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api("/open-transfer-requirements");
      rows = data || [];
      render();
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render() {
    if (rows.length === 0) {
      bodyEl.textContent = "No open transfer requirements.";
      return;
    }
    bodyEl.innerHTML = `
      <p>${rows.length} open TR(s)</p>
      <table>
        <thead><tr><th>TR</th><th>Material</th><th>Batch</th><th>Qty</th><th>UoM</th><th>Storage Loc</th><th>MRP Ctrl</th><th>Created</th><th></th></tr></thead>
        <tbody id="tr-tbody"></tbody>
      </table>
      <div class="nx-pager" id="tr-pager"></div>`;

    NexusTable.paginate({
      container: document.getElementById("tr-tbody"),
      pagerContainer: document.getElementById("tr-pager"),
      pageSize: 25,
      renderRows: (pageRows) => pageRows.map((r) => `
            <tr>
              <td>${esc(r.trNumber)}</td>
              <td>${esc(r.material)}</td>
              <td>${esc(r.batch)}</td>
              <td>${esc(r.quantity)}</td>
              <td>${esc(r.uom)}</td>
              <td>${esc(r.storageLocation)}</td>
              <td>${esc(r.mrpController)}</td>
              <td>${esc(r.createdDate)} ${esc(r.createdTime)}</td>
              <td><button type="button" class="btn secondary" data-tr="${esc(r.trNumber)}">LT04</button></td>
            </tr>`).join(""),
      onRendered: () => {
        bodyEl.querySelectorAll("button[data-tr]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const row = rows.find((r) => String(r.trNumber) === btn.dataset.tr);
            if (row) openPanel(row);
          });
        });
      },
    }).setRows(rows);
  }

  const LT04_FIELDS = [
    { key: "trNumber", label: "TR Number", readonly: true },
    { key: "material", label: "Material", readonly: true },
    { key: "quantity", label: "Quantity" },
    { key: "destType", label: "Destination Type" },
    { key: "pallet", label: "Pallet/Batch" },
    { key: "destBin", label: "Destination Bin" },
  ];

  function openPanel(row) {
    const record = {
      trNumber: row.trNumber,
      material: row.material,
      quantity: String(row.quantity),
      destType: "",
      destBin: "",
      pallet: row.batch || "",
    };

    const card = AdminEditModal.open("Confirm via LT04", `TR ${row.trNumber}`, LT04_FIELDS, record, async (values) => {
      const body = {
        trNumber: row.trNumber,
        material: row.material,
        quantity: Number(values.quantity),
        destinationType: values.destType.trim(),
        destinationBin: values.destBin.trim(),
        palletOrBatch: values.pallet.trim(),
        storageLocation: row.storageLocation,
      };
      const { data } = await api("/create-lt04", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
      if (data?.type !== "S") throw new Error(`Result: ${data?.message || "unknown"}`);
    });

    card.classList.add("ps-modal--transfer-requirement");

    const destBinEl = card.querySelector("#aed-destBin");
    const destTypeEl = card.querySelector("#aed-destType");
    if (!destBinEl || !destTypeEl) return;

    card.querySelectorAll("input, select, textarea").forEach((el) => { el.disabled = true; });
    destBinEl.disabled = false;
    destTypeEl.disabled = true;

    const choiceEl = document.createElement("div");
    choiceEl.className = "aed-dest-choice";
    destTypeEl.parentElement.appendChild(choiceEl);

    let lookupTimer;
    let lookupVersion = 0;
    const lookup = async () => {
      const bin = destBinEl.value.trim();
      const version = ++lookupVersion;
      destTypeEl.value = "";
      choiceEl.innerHTML = "";
      if (!bin) return;

      let types;
      try {
        const response = await api(`/bin-storage-types?bin=${encodeURIComponent(bin)}`);
        types = response.data || [];
      } catch {
        return;
      }
      if (version !== lookupVersion) return;

      if (types.length === 1) {
        destTypeEl.value = types[0];
        return;
      }

      if (types.length > 1) {
        choiceEl.innerHTML = `<div class="tf-locked">Choose storage type</div>` +
          types.map((type) => `<label><input type="radio" name="aed-destType-choice" value="${esc(type)}"> ${esc(type)}</label>`).join(" ");
        choiceEl.querySelectorAll("input").forEach((input) => input.addEventListener("change", () => {
          destTypeEl.value = input.value;
        }));
      }
    };

    destBinEl.addEventListener("input", () => {
      clearTimeout(lookupTimer);
      lookupVersion++;
      destTypeEl.value = "";
      choiceEl.innerHTML = "";
      lookupTimer = setTimeout(lookup, 300);
    });
    destBinEl.addEventListener("blur", () => {
      clearTimeout(lookupTimer);
      lookup();
    });
  }

  document.getElementById("tr-refresh").addEventListener("click", load);
  load();
})();
