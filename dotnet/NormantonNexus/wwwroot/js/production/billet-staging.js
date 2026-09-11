// Billet Staging tile — port of the mix-tub staging routes in
// routes/productionnexus.js (queue / stage / stage-by-ref /
// return-to-conditioning / search). Every dynamic value is built via
// textContent/DOM APIs, never innerHTML.
(function () {
  const msgEl = document.getElementById("bs-msg");
  const queueEl = document.getElementById("bs-queue");
  const scanRefInput = document.getElementById("bs-scan-ref");
  const searchInput = document.getElementById("bs-search");
  const searchResultsEl = document.getElementById("bs-search-results");

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

  function fmtDate(dt) {
    return dt ? new Date(dt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  }

  const BUCKET_BADGE = { "0-24": "", "24-48": "badge--success", "48-72": "badge--warn", "72-96": "badge--error", expired: "badge--error" };

  function setMsg(text, kind) {
    if (!text) { msgEl.innerHTML = ""; return; }
    const cls = kind === "error" ? "badge--error" : kind === "success" ? "badge--success" : "";
    msgEl.innerHTML = `<span class="badge ${cls}"></span>`;
    msgEl.querySelector(".badge").textContent = text;
  }

  async function loadQueue() {
    queueEl.innerHTML = `<div class="nx-empty">Loading…</div>`;
    try {
      const { data } = await api("/mixing/staging/queue");
      if (data.length === 0) {
        queueEl.innerHTML = `<div class="nx-empty">Nothing ready to stage right now.</div>`;
        return;
      }

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of ["Mix Ref", "Material", "Tub", "Weight (KG)", "Age", "Completed", ""]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = document.createElement("tbody");
      for (const row of data) {
        tbody.appendChild(buildQueueRow(row));
      }
      table.append(thead, tbody);
      queueEl.innerHTML = "";
      queueEl.appendChild(table);
    } catch (err) {
      queueEl.innerHTML = `<div class="nx-empty">${NexusApi.esc(err.message)}</div>`;
    }
  }

  function buildQueueRow(row) {
    const tr = document.createElement("tr");
    const refTd = document.createElement("td");
    refTd.textContent = row.mixRef || `MX${String(row.mixingId).padStart(8, "0")}`;
    const matTd = document.createElement("td");
    matTd.textContent = `${row.material} (${row.mixCode})`;
    const tubTd = document.createElement("td");
    tubTd.textContent = `#${row.tubSeq} — ${row.supplierTubNo}`;
    const wtTd = document.createElement("td");
    wtTd.style.textAlign = "right";
    wtTd.textContent = Number(row.tubWeightKg).toFixed(3);
    const ageTd = document.createElement("td");
    const ageBadge = document.createElement("span");
    ageBadge.className = `badge ${BUCKET_BADGE[row.bucket] || ""}`;
    ageBadge.textContent = `${Number(row.ageHours).toFixed(1)}h (${row.bucket})`;
    ageTd.appendChild(ageBadge);
    const completedTd = document.createElement("td");
    completedTd.textContent = fmtDate(row.completedAt);

    const actionTd = document.createElement("td");
    const stageBtn = document.createElement("button");
    stageBtn.type = "button";
    stageBtn.textContent = "Stage";
    stageBtn.addEventListener("click", () => stageTub(row.tubId, () => loadQueue()));
    actionTd.appendChild(stageBtn);

    tr.append(refTd, matTd, tubTd, wtTd, ageTd, completedTd, actionTd);
    return tr;
  }

  async function stageTub(tubId, onDone) {
    setMsg("");
    try {
      const { data } = await api(`/mixing/tubs/${tubId}/stage`, { method: "PATCH" });
      setMsg(`Tub ${data.tubSeq} of ${data.mixRef} staged — ${data.stagedQuantityKg} KG.`, "success");
      await onDone();
    } catch (err) {
      setMsg(err.message, "error");
    }
  }

  document.getElementById("bs-scan-btn").addEventListener("click", async () => {
    const ref = scanRefInput.value.trim();
    if (!ref) return;
    setMsg("");
    try {
      const { data } = await api("/mixing/tubs/stage-by-ref", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref }),
      });
      setMsg(`Tub ${data.tubSeq} of ${data.mixRef} staged — ${data.stagedQuantityKg} KG.`, "success");
      scanRefInput.value = "";
      await loadQueue();
    } catch (err) {
      setMsg(err.message, "error");
    }
  });

  async function runSearch() {
    searchResultsEl.innerHTML = `<div class="nx-empty">Searching…</div>`;
    try {
      const params = new URLSearchParams();
      if (searchInput.value.trim()) params.set("q", searchInput.value.trim());
      const { data } = await api(`/mixing/tubs/search?${params}`);
      if (data.length === 0) {
        searchResultsEl.innerHTML = `<div class="nx-empty">No tubs found.</div>`;
        return;
      }

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of ["Mix Ref", "Material", "Tub", "Status", "Staged (KG)", "Age", ""]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = document.createElement("tbody");
      for (const row of data) {
        tbody.appendChild(buildSearchRow(row));
      }
      table.append(thead, tbody);
      searchResultsEl.innerHTML = "";
      searchResultsEl.appendChild(table);
    } catch (err) {
      searchResultsEl.innerHTML = `<div class="nx-empty">${NexusApi.esc(err.message)}</div>`;
    }
  }

  function buildSearchRow(row) {
    const tr = document.createElement("tr");
    const refTd = document.createElement("td");
    refTd.textContent = row.mixRef || `MX${String(row.mixingId).padStart(8, "0")}`;
    const matTd = document.createElement("td");
    matTd.textContent = `${row.material} (${row.mixCode})`;
    const tubTd = document.createElement("td");
    tubTd.textContent = `#${row.tubSeq} — ${row.supplierTubNo}`;
    const statusTd = document.createElement("td");
    const statusBadge = document.createElement("span");
    statusBadge.className = row.isScrapped ? "badge badge--error" : row.isStaged ? "badge badge--success" : "badge";
    statusBadge.textContent = row.isScrapped ? "Scrapped" : row.isStaged ? "Staged" : "Not staged";
    statusTd.appendChild(statusBadge);
    const stagedTd = document.createElement("td");
    stagedTd.style.textAlign = "right";
    stagedTd.textContent = row.stagedQuantityKg != null ? Number(row.stagedQuantityKg).toFixed(3) : "—";
    const ageTd = document.createElement("td");
    ageTd.textContent = `${Number(row.ageHours).toFixed(1)}h`;

    const actionTd = document.createElement("td");
    if (row.isStaged && Number(row.stagedQuantityKg) > 0) {
      const qtyInput = document.createElement("input");
      qtyInput.type = "number";
      qtyInput.className = "tf-input";
      qtyInput.step = "0.001";
      qtyInput.placeholder = "KG";
      qtyInput.style.maxWidth = "90px";
      const returnBtn = document.createElement("button");
      returnBtn.type = "button";
      returnBtn.className = "secondary";
      returnBtn.textContent = "Return";
      returnBtn.addEventListener("click", () => returnToConditioning(row.tubId, Number(qtyInput.value)));
      actionTd.append(qtyInput, returnBtn);
    }

    tr.append(refTd, matTd, tubTd, statusTd, stagedTd, ageTd, actionTd);
    return tr;
  }

  async function returnToConditioning(tubId, quantityKg) {
    setMsg("");
    if (!(quantityKg > 0)) {
      setMsg("Enter a quantity greater than 0 to return.", "error");
      return;
    }
    try {
      const { data } = await api(`/mixing/tubs/${tubId}/return-to-conditioning`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantityKg }),
      });
      setMsg(`Returned ${quantityKg} KG — ${data.stagedQuantityKg} KG still staged.`, "success");
      await runSearch();
      await loadQueue();
    } catch (err) {
      setMsg(err.message, "error");
    }
  }

  document.getElementById("bs-search-btn").addEventListener("click", runSearch);

  loadQueue();
})();
