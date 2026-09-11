// Customs tile — GET /api/shipmentmain/queue/customs-docs, POST
// .../customs/create (real ClearPort declaration submission), PATCH
// .../customs-required/bulk ("Mark Not Required" mass un-flag), split out of
// the old combined shipment-queue.js.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/shipmentmain");
  const bodyEl = document.getElementById("cq-body");
  const noticeEl = document.getElementById("cq-notice");
  const createBtn = document.getElementById("cq-create-btn");
  const notRequiredBtn = document.getElementById("cq-not-required-btn");
  let rows = [];
  const selected = new Set();

  async function load() {
    bodyEl.innerHTML = '<div class="nx-toolbar-hint">Loading…</div>';
    selected.clear();
    updateHint();
    try {
      const { data } = await api("/queue/customs-docs");
      rows = data || [];
      render();
    } catch (err) {
      bodyEl.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  function selectedRows() { return rows.filter((r) => selected.has(r.shipmentId)); }

  function updateHint() {
    const count = selected.size;
    createBtn.disabled = count === 0;
    notRequiredBtn.disabled = count === 0;
    document.getElementById("cq-hint").textContent = count
      ? `${count} shipment(s) selected.`
      : `${rows.length} shipment(s) awaiting customs documents.`;
  }

  function render() {
    if (rows.length === 0) { bodyEl.innerHTML = '<div class="nx-empty">No shipments are currently awaiting customs documents.</div>'; updateHint(); return; }
    bodyEl.innerHTML = `
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th></th><th>Shipment</th><th>Destination</th><th>Haulier</th><th>Incoterms</th><th>Planned Movement</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><input type="checkbox" class="cq-check" data-id="${r.shipmentId}"></td>
            <td><a href="#" class="cq-open" data-id="${r.shipmentId}">${esc(String(r.shipmentId).padStart(8, "0"))}</a></td>
            <td>${esc(r.destinationName || "")}, ${esc(r.destinationCountry || "")}</td>
            <td>${esc(r.forwarderName || "Unassigned")}</td>
            <td>${esc(r.incoTerms || "—")}</td>
            <td>${r.plannedMovement ? new Date(r.plannedMovement).toLocaleDateString("en-GB") : "—"}</td>
          </tr>`).join("")}</tbody>
      </table>
      </div>`;

    bodyEl.querySelectorAll(".cq-check").forEach((cb) => cb.addEventListener("change", (e) => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) selected.add(id); else selected.delete(id);
      updateHint();
    }));
    bodyEl.querySelectorAll(".cq-open").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      OutboundShipmentDetail.open(Number(a.dataset.id), load);
    }));
    updateHint();
  }

  function showNotice(type, text) {
    const color = type === "success" ? "var(--success,#16A34A)" : type === "warning" ? "#b45309" : "var(--error)";
    noticeEl.innerHTML = `<div style="margin-bottom:10px;padding:8px 12px;border-radius:6px;background:color-mix(in srgb, ${color} 12%, transparent);color:${color};font-size:12.5px">${esc(text)}</div>`;
  }

  createBtn.addEventListener("click", async () => {
    const ids = [...selected];
    if (!ids.length) return;
    createBtn.disabled = true; createBtn.textContent = "Creating…";
    noticeEl.innerHTML = "";
    try {
      const { data } = await api("/customs/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shipmentIds: ids }) });
      const completed = data?.completed || [];
      const failed = data?.failed || [];
      const lines = [
        ...completed.map((c) => `${esc(c.shipmentRef)}: declaration created (${esc(c.customsId)}).`),
        ...failed.map((f) => `${esc(f.shipmentRef)}: failed — ${esc(f.error)}.`),
      ];
      showNotice(completed.length ? (failed.length ? "warning" : "success") : "error", lines.join(" ") || "No customs entries were completed.");
      await load();
    } catch (err) {
      showNotice("error", err.message);
    } finally {
      createBtn.disabled = false; createBtn.textContent = "Create Customs Entry";
    }
  });

  notRequiredBtn.addEventListener("click", async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!(await NexusModal.confirm(`Mark ${ids.length} shipment(s) as not requiring customs? They'll drop off this list.`, { confirmLabel: "Mark Not Required" }))) return;
    notRequiredBtn.disabled = true; notRequiredBtn.textContent = "Updating…";
    noticeEl.innerHTML = "";
    try {
      const { data } = await api("/customs-required/bulk", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shipmentIds: ids, required: false }) });
      const updated = data?.updated || 0;
      const skipped = data?.skipped || [];
      const lines = [`${updated} shipment(s) marked as not requiring customs.`];
      if (skipped.length) lines.push(`${skipped.length} shipment(s) skipped — customs already complete: ${skipped.map((id) => String(id).padStart(8, "0")).join(", ")}.`);
      showNotice(skipped.length ? "warning" : "success", lines.join(" "));
      await load();
    } catch (err) {
      showNotice("error", err.message);
    } finally {
      notRequiredBtn.disabled = false; notRequiredBtn.textContent = "Mark Not Required";
    }
  });

  load();
})();
