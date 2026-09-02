// New Customer Packaging Creation tile — ported from private/js/engineering.js's
// renderNewPackaging() (lines 226-297 in the Node original).
(function () {
  const partInput = document.getElementById("np-part");
  const createBtn = document.getElementById("np-create");
  const msgEl = document.getElementById("np-msg");
  const resultTableEl = document.getElementById("np-result-table");

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

  function renderResultTable(results) {
    resultTableEl.innerHTML = "";
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Code</th><th>Material</th><th>Result</th><th>Message</th></tr>";
    const tbody = document.createElement("tbody");
    for (const r of results) {
      const ok = r.materialCreated ? r.bomCreated : r.alreadyExisted;
      const label = r.alreadyExisted ? "SKIPPED" : ok ? "CREATED" : "FAILED";
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${r.code}</td><td>${r.material ?? ""}</td><td class="${ok ? "result-ok" : "result-fail"}">${label}</td><td>${r.message ?? ""}</td>`;
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    resultTableEl.appendChild(table);
  }

  createBtn.addEventListener("click", async () => {
    msgEl.textContent = "";
    resultTableEl.innerHTML = "";

    const customerPart = partInput.value.trim();
    const codes = Array.from(document.querySelectorAll(".np-code:checked")).map((cb) => cb.value);

    if (!customerPart) {
      msgEl.textContent = "Enter a customer number.";
      return;
    }
    if (codes.length === 0) {
      msgEl.textContent = "Select at least one packaging code.";
      return;
    }

    createBtn.disabled = true;
    try {
      const { data } = await api("/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerPart, codes }),
      });
      renderResultTable(data);
    } catch (err) {
      msgEl.textContent = err.message;
    } finally {
      createBtn.disabled = false;
    }
  });
})();
