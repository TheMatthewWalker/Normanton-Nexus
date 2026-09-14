// Goods Issue Warnings tile — port of runGoodsIssueWarnings() in private/js/warehouse.js.
// Grouped into the shared `.ps-section` collapsible-bucket pattern by
// status (there's no "Warning" outcome for Goods Issue, only "Failed", but
// the grouping stays generic in case that ever changes) — see
// order-suggestions.js's Tracked Orders for the original.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/deliverymain");
  const bodyEl = document.getElementById("gw-body");

  const STATUS_ORDER = [
    ["Failed", "priority"],
    ["Warning", "warn"],
  ];

  function wireCollapseToggles(root) {
    root.querySelectorAll(".ps-section-header").forEach((h) => {
      h.addEventListener("click", (e) => {
        if (e.target.closest("button, input, select, a")) return;
        h.closest(".ps-section").classList.toggle("ps-section--collapsed");
      });
    });
  }

  async function load() {
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api("/goods-issue/warnings");
      render(data || []);
    } catch (err) {
      bodyEl.textContent = "Error: " + err.message;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      bodyEl.textContent = "No Goods Issue warnings.";
      return;
    }

    const byStatus = new Map();
    for (const r of rows) {
      if (!byStatus.has(r.status)) byStatus.set(r.status, []);
      byStatus.get(r.status).push(r);
    }

    const summary = document.createElement("p");
    summary.textContent = `${rows.length} warning(s)`;

    const sectionsWrap = document.createElement("div");
    sectionsWrap.className = "ps-sections";
    let first = true;
    for (const [status, dotClass] of STATUS_ORDER) {
      const bucketRows = byStatus.get(status);
      if (!bucketRows || !bucketRows.length) continue;
      sectionsWrap.appendChild(buildSection(status, dotClass, bucketRows, first));
      first = false;
      byStatus.delete(status);
    }
    for (const [status, bucketRows] of byStatus) {
      sectionsWrap.appendChild(buildSection(status, "other", bucketRows, first));
      first = false;
    }

    bodyEl.innerHTML = "";
    bodyEl.append(summary, sectionsWrap);
    wireCollapseToggles(bodyEl);

    bodyEl.querySelectorAll("button[data-action='reprocess']").forEach((btn) => {
      btn.addEventListener("click", () => act(btn.dataset.id, "reprocess"));
    });
    bodyEl.querySelectorAll("button[data-action='resolve']").forEach((btn) => {
      btn.addEventListener("click", () => act(btn.dataset.id, "resolve"));
    });
  }

  function buildSection(status, dotClass, rows, isFirst) {
    const section = document.createElement("div");
    section.className = "ps-section" + (isFirst ? "" : " ps-section--collapsed");
    section.innerHTML = `
      <div class="ps-section-header">
        <span class="ps-section-dot ps-section-dot--${dotClass}"></span>
        <span class="ps-section-title">${esc(status)}</span>
        <span class="ps-section-count">${rows.length}</span>
        <span class="ps-chevron">&#9660;</span>
      </div>
      <div class="ps-section-body">
        <table>
          <thead><tr><th>Delivery</th><th>Messages</th><th>Ran At</th><th></th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${esc(r.deliveryId)}</td>
                <td>${(r.messages || []).map((m) => esc(m.message)).join("; ")}</td>
                <td>${r.ranAtUtc ? new Date(r.ranAtUtc).toLocaleString("en-GB") : ""}</td>
                <td>
                  <button type="button" class="btn secondary" data-id="${r.deliveryId}" data-action="reprocess">Reprocess</button>
                  <button type="button" class="btn secondary" data-id="${r.deliveryId}" data-action="resolve">Resolve</button>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
    return section;
  }

  async function act(deliveryId, action) {
    try {
      const opts = { method: "POST" };
      if (action === "resolve") {
        const note = prompt("Resolution note (optional):") || null;
        opts.headers = { "Content-Type": "application/json" };
        opts.body = JSON.stringify({ note });
      }
      await api(`/${deliveryId}/goods-issue/${action}`, opts);
      await load();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  document.getElementById("gw-refresh").addEventListener("click", load);
  load();
})();
