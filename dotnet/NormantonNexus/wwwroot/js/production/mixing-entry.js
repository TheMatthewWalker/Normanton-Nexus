// Mixing tile — port of runMixingEntry in private/js/production-nexus.js.
// Each tub posts its own independent SAP backflush; a submission can
// partially succeed (some tubs post, others fail) — the response's
// `status` field ("COMPLETE" vs "SAP_FAILED") reflects that, matching the
// backend exactly. Label printing (labelPrint() in Node) is deliberately
// not wired up yet — the label/PDF/barcode/TCP-printer subsystem is its
// own not-yet-ported piece of Sub-phase 6b.
(function () {
  const MAX_TUB_WEIGHT_KG = 38;
  let tubs = [{ weightKg: "" }];

  const tubListEl = document.getElementById("mx-tub-list");
  const totalEl = document.getElementById("mx-total");
  const resultEl = document.getElementById("mx-result");
  const submitBtn = document.getElementById("mx-submit-btn");

  function renderTubs() {
    tubListEl.innerHTML = "";
    let total = 0;
    tubs.forEach((tub, idx) => {
      total += Number(tub.weightKg) || 0;

      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "0.5rem";
      row.style.padding = "0.25rem 0";

      const label = document.createElement("span");
      label.style.width = "1.5rem";
      label.style.textAlign = "right";
      label.style.color = "#6b7280";
      label.textContent = `${idx + 1}.`;

      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.001";
      input.min = "0.001";
      input.max = String(MAX_TUB_WEIGHT_KG);
      input.placeholder = "Weight (KG)";
      input.value = tub.weightKg;
      input.style.maxWidth = "160px";
      input.addEventListener("input", () => {
        tub.weightKg = input.value;
        renderTotal();
      });

      const unit = document.createElement("span");
      unit.style.fontSize = "0.8rem";
      unit.style.color = "#6b7280";
      unit.textContent = "KG";

      row.append(label, input, unit);

      if (tubs.length > 1) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "secondary";
        removeBtn.textContent = "×";
        removeBtn.addEventListener("click", () => {
          tubs.splice(idx, 1);
          renderTubs();
        });
        row.appendChild(removeBtn);
      }

      tubListEl.appendChild(row);
    });
    totalEl.textContent = `${total.toFixed(3)} KG`;
  }

  function renderTotal() {
    const total = tubs.reduce((s, t) => s + (Number(t.weightKg) || 0), 0);
    totalEl.textContent = `${total.toFixed(3)} KG`;
  }

  document.getElementById("mx-add-tub").addEventListener("click", () => {
    tubs.push({ weightKg: "" });
    renderTubs();
  });

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

  function setResult(text, color) {
    resultEl.style.color = color;
    resultEl.textContent = text;
  }

  submitBtn.addEventListener("click", async () => {
    const mixCode = document.getElementById("mx-mixcode").value.trim();
    const supplierBatchNo = document.getElementById("mx-suppbatch").value.trim();
    const supplierTubNo = document.getElementById("mx-supptub").value.trim();
    const notes = document.getElementById("mx-notes").value.trim();

    const validTubs = tubs.filter((t) => Number(t.weightKg) > 0);
    const overweightIdx = validTubs.findIndex((t) => Number(t.weightKg) > MAX_TUB_WEIGHT_KG);

    if (!mixCode) {
      setResult("Mix Code is required.", "#b91c1c");
      return;
    }
    if (!supplierBatchNo || !supplierTubNo) {
      setResult("Supplier batch number and supplier tub number are required.", "#b91c1c");
      return;
    }
    if (validTubs.length === 0) {
      setResult("At least one tub weight is required.", "#b91c1c");
      return;
    }
    if (overweightIdx !== -1) {
      setResult(`Tub ${overweightIdx + 1} cannot exceed ${MAX_TUB_WEIGHT_KG} KG.`, "#b91c1c");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Posting to SAP…";
    setResult(`Inserting record and posting ${validTubs.length} tub(s) to SAP…`, "#6b7280");

    try {
      const { data } = await api("/mixing/entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mixCode,
          supplierBatchNo,
          supplierTubNo,
          tubs: validTubs.map((t) => ({ weightKg: Number(t.weightKg) })),
          notes: notes || null,
        }),
      });

      const ref = data.batchRef || `MX${String(data.recordId).padStart(8, "0")}`;

      if (data.status === "SAP_FAILED") {
        const failCount = data.tubs.filter((t) => !t.success).length;
        setResult(`⚠ ${ref} saved but ${failCount} tub(s) failed SAP. See Failed Backflush queue for supervisor retry.`, "#d97706");
      } else {
        const docs = data.tubs
          .map((t) => t.materialDocument)
          .filter(Boolean)
          .join(", ");
        setResult(`✓ ${ref} — ${validTubs.length} tub(s) posted · MatDocs: ${docs || "—"}`, "#059669");
        tubs = [{ weightKg: "" }];
        for (const id of ["mx-mixcode", "mx-suppbatch", "mx-supptub", "mx-notes"]) {
          document.getElementById(id).value = "";
        }
        renderTubs();
      }
    } catch (err) {
      setResult(err.message, "#b91c1c");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Post to SAP";
    }
  });

  renderTubs();
})();
