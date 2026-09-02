// Mass Packaging Update tile — ported from private/js/engineering.js's
// renderMassUpdate() (lines 79-220 in the Node original), now its own page
// instead of an innerHTML-injected section. Behavior unchanged: selection
// persists across search refreshes, results capped at 200 rows server-side.
(function () {
  const searchInput = document.getElementById("mu-search");
  const resultsEl = document.getElementById("mu-results");
  const selectedCountEl = document.getElementById("mu-selected-count");
  const packMatInput = document.getElementById("mu-packmat");
  const runBtn = document.getElementById("mu-run");
  const msgEl = document.getElementById("mu-msg");
  const resultTableEl = document.getElementById("mu-result-table");

  // material -> materialText, survives search refreshes.
  const selected = new Map();
  let debounceTimer = null;

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

  function renderResults(materials) {
    resultsEl.innerHTML = "";
    if (materials.length === 0) {
      resultsEl.textContent = "No materials found.";
      return;
    }

    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    for (const m of materials) {
      const tr = document.createElement("tr");
      const checkboxTd = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(m.material);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.set(m.material, m.materialText);
        else selected.delete(m.material);
        updateSelectedCount();
      });
      checkboxTd.appendChild(checkbox);

      const materialTd = document.createElement("td");
      materialTd.textContent = m.material;
      const textTd = document.createElement("td");
      textTd.textContent = m.materialText;

      tr.append(checkboxTd, materialTd, textTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    resultsEl.appendChild(table);
  }

  function updateSelectedCount() {
    selectedCountEl.textContent = `${selected.size} selected`;
  }

  async function runSearch() {
    const search = searchInput.value.trim();
    const query = search ? `?search=${encodeURIComponent(search)}` : "";
    try {
      const { data } = await api(`/materials${query}`);
      renderResults(data);
    } catch (err) {
      resultsEl.textContent = err.message;
    }
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 250);
  });

  document.getElementById("mu-select-all").addEventListener("click", () => {
    resultsEl.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.checked = true;
      cb.dispatchEvent(new Event("change"));
    });
  });

  document.getElementById("mu-clear").addEventListener("click", () => {
    selected.clear();
    updateSelectedCount();
    resultsEl.querySelectorAll("input[type=checkbox]").forEach((cb) => (cb.checked = false));
  });

  function renderResultTable(results) {
    resultTableEl.innerHTML = "";
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Material</th><th>Result</th><th>Message</th></tr>";
    const tbody = document.createElement("tbody");
    for (const r of results) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${r.material}</td><td class="${r.success ? "result-ok" : "result-fail"}">${r.success ? "OK" : "FAILED"}</td><td>${r.message ?? ""}</td>`;
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    resultTableEl.appendChild(table);
  }

  runBtn.addEventListener("click", async () => {
    msgEl.textContent = "";
    resultTableEl.innerHTML = "";

    const packMaterial = packMatInput.value.trim();
    if (selected.size === 0) {
      msgEl.textContent = "Select at least one material.";
      return;
    }
    if (!packMaterial) {
      msgEl.textContent = "Enter the new packaging material.";
      return;
    }

    const rows = Array.from(selected.keys()).map((material) => ({ material, packMaterial }));
    runBtn.disabled = true;
    try {
      const { data } = await api("/mass-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      renderResultTable(data);
    } catch (err) {
      msgEl.textContent = err.message;
    } finally {
      runBtn.disabled = false;
    }
  });

  runSearch();
})();
