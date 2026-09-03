// Open Runs tile — port of runOpenRuns in production-nexus.js. Cross-
// process supervisor view of every record stuck at Status=1 (open, not
// yet completed), with a cancel action.
(function () {
  const msgEl = document.getElementById("or-msg");
  const listEl = document.getElementById("or-list");

  const PROCESS_LABELS = { MX: "Mixing", EX: "Extrusion", CO: "Convoluting", BR: "Braiding", CL: "Coverline", TW: "Tape Wrap", DR: "Drumming", EW: "Ewald", HA: "Hose Assembly" };

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

  async function load() {
    msgEl.textContent = "";
    listEl.textContent = "Loading…";
    try {
      const { data } = await api("/open-runs");
      if (data.length === 0) {
        listEl.textContent = "No open runs.";
        return;
      }

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of ["Process", "Ref", "Material", "Created", "Created By", ""]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = document.createElement("tbody");
      for (const row of data) {
        tbody.appendChild(buildRow(row));
      }
      table.append(thead, tbody);
      listEl.innerHTML = "";
      listEl.appendChild(table);
    } catch (err) {
      listEl.textContent = err.message;
    }
  }

  function buildRow(row) {
    const tr = document.createElement("tr");
    const pcTd = document.createElement("td");
    pcTd.textContent = PROCESS_LABELS[row.processCode] || row.processCode;
    const refTd = document.createElement("td");
    refTd.textContent = row.batchRef;
    const matTd = document.createElement("td");
    matTd.textContent = row.material;
    const createdTd = document.createElement("td");
    createdTd.textContent = fmtDate(row.createdAt);
    const byTd = document.createElement("td");
    byTd.textContent = row.createdBy || "—";

    const actionTd = document.createElement("td");
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => cancelRun(row.processCode, row.recordId));
    actionTd.appendChild(cancelBtn);

    tr.append(pcTd, refTd, matTd, createdTd, byTd, actionTd);
    return tr;
  }

  async function cancelRun(processCode, recordId) {
    const reason = prompt("Reason for cancelling this open run (optional):") || "";
    if (!confirm("Cancel this open run?")) return;
    msgEl.textContent = "";
    try {
      await api(`/open-runs/${processCode}/${recordId}/cancel`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      await load();
    } catch (err) {
      msgEl.textContent = err.message;
    }
  }

  load();
})();
