// Shared metre-process (EX/CO/BR/CL/TW) entry tile — port of the direct
// one-step path through runMeterProcessEntry in production-nexus.js.
// Additional operators/parent batches/scrap entry are not exposed by this
// simplified form yet (Node's own wizard collects them via the shared
// multi-phase entry engine, not built in this slice) — the backend
// (MetreProcessHelper.EnterAsync) already accepts them, so this form can
// grow into the fuller wizard without a backend change once that UI work
// is prioritized.
(function () {
  const processCode = document.querySelector("[data-process-code]").dataset.processCode;
  const materialInput = document.getElementById("mp-material");
  const lengthInput = document.getElementById("mp-length");
  const notesInput = document.getElementById("mp-notes");
  const resultEl = document.getElementById("mp-result");
  const submitBtn = document.getElementById("mp-submit-btn");

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
    const material = materialInput.value.trim();
    const lengthMetres = Number(lengthInput.value);

    if (!material) {
      setResult("Material is required.", "#b91c1c");
      return;
    }
    if (!(lengthMetres > 0)) {
      setResult("Length (Metres) must be greater than 0.", "#b91c1c");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Posting to SAP…";
    setResult("Inserting record and posting to SAP…", "#6b7280");

    try {
      const { data } = await api(`/process/${processCode}/entry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          material,
          lengthMetres,
          notes: notesInput.value.trim() || null,
        }),
      });

      if (data.status === "SAP_FAILED") {
        setResult(`⚠ ${data.batchRef} saved but SAP posting failed: ${data.error}. See Failed Backflush queue for supervisor retry.`, "#d97706");
      } else {
        setResult(`✓ ${data.batchRef} posted — MatDoc: ${data.materialDocument}${data.warning ? ` (${data.warning})` : ""}`, "#059669");
        materialInput.value = "";
        lengthInput.value = "";
        notesInput.value = "";
      }
    } catch (err) {
      setResult(err.message, "#b91c1c");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Post to SAP";
    }
  });
})();
