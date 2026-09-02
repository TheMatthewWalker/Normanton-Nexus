// Shared by Pages/Quality/BlockStock.cshtml and UnblockStock.cshtml — the
// direction ("block"/"unblock") comes from the form's own data-direction
// attribute. Ported from private/js/quality.js's openBlockUnblockModal()/
// submitBlockUnblock(), as a standalone page instead of a modal.
(function () {
  const form = document.getElementById("q-form");
  const direction = form.dataset.direction;
  const resultEl = document.getElementById("q-result");
  const submitBtn = document.getElementById("q-submit");

  const WM_LOCATIONS = new Set(["1710", "1711"]);
  const slocInput = document.getElementById("q-sloc");
  const binTypeWrap = document.getElementById("q-bintype-wrap");
  const binWrap = document.getElementById("q-bin-wrap");
  const binTypeInput = document.getElementById("q-bintype");
  const binInput = document.getElementById("q-bin");

  function updateWmFields() {
    const isWm = WM_LOCATIONS.has(slocInput.value.trim());
    binTypeWrap.hidden = !isWm;
    binWrap.hidden = !isWm;
    binTypeInput.required = isWm;
    binInput.required = isWm;
  }
  slocInput.addEventListener("input", updateWmFields);
  updateWmFields();

  // Pre-fill from ?material=... — set by the Display Stock page's per-row action link.
  const prefillMaterial = new URLSearchParams(window.location.search).get("material");
  if (prefillMaterial) {
    document.getElementById("q-material").value = prefillMaterial;
  }

  async function api(path, opts) {
    const r = await fetch(path, opts);
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    resultEl.innerHTML = "";

    const isWm = WM_LOCATIONS.has(slocInput.value.trim());
    const body = {
      material: document.getElementById("q-material").value.trim(),
      quantity: parseFloat(document.getElementById("q-quantity").value) || 0,
      header: document.getElementById("q-header").value.trim(),
      storageLocation: slocInput.value.trim(),
      binType: isWm ? binTypeInput.value.trim() : "",
      bin: isWm ? binInput.value.trim() : "",
      batch: document.getElementById("q-batch").value.trim() || null,
      specialStockIndicator: document.getElementById("q-spcind").value.trim() || null,
      specialStockNumber: document.getElementById("q-spcno").value.trim() || null,
    };

    submitBtn.disabled = true;
    try {
      const { data } = await api(`/api/quality/${direction}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const lines = [
        data.mb1bMessage ? `MB1B: ${data.mb1bMessage}` : null,
        data.toBlockedMessage ? `→ Blocked: ${data.toBlockedMessage}` : null,
        data.toNonBlockedMessage ? `→ Unrestricted: ${data.toNonBlockedMessage}` : null,
      ].filter(Boolean);
      resultEl.innerHTML = `<p class="result-ok">Success</p><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`;
      form.reset();
      updateWmFields();
    } catch (err) {
      resultEl.innerHTML = `<p class="result-fail">${err.message}</p>`;
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
