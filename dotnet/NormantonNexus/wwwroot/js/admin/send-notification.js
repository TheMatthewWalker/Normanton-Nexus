// Send Notification — the admin-side compose/history/expire surface backing
// admin.html's "Send Notification" section (private/js/admin.js's
// setupNotifSend()/loadNotifHistory()). A genuinely missing tile found by a
// later gap audit against the Node tile inventory, not a deliberate
// deferral — only the user-facing tray endpoints (the bell) were previously
// ported. Port of routes/notifications.js's admin* routes.
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/notifications");

  const SEV_LABELS = { 1: "Info", 2: "Warning", 3: "Critical" };
  const SEV_COLOURS = { 1: "var(--accent,#3b82f6)", 2: "#D97706", 3: "#DC2626" };

  function fmtDate(d) {
    return d ? new Date(d).toLocaleString("en-GB") : "—";
  }

  async function loadTargetOptions() {
    const typeSel = document.getElementById("notif-target-type");
    const valueInput = document.getElementById("notif-target-value");
    const valueSelect = document.getElementById("notif-target-select");

    let deptOpts = "";
    let permOpts = "";
    try {
      const { data } = await api("/admin/targets");
      deptOpts = (data.departments || []).map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
      permOpts = (data.permissions || [])
        .map((p) => `<option value="${esc(p.permissionCode)}">${esc(p.permissionName)} (${esc(p.permissionCode)})</option>`)
        .join("");
    } catch { /* best-effort — target selects just stay empty if this fails */ }

    typeSel.addEventListener("change", function () {
      valueInput.style.display = "none";
      valueSelect.style.display = "none";
      valueInput.value = "";
      valueSelect.innerHTML = "";

      switch (this.value) {
        case "role":
          valueSelect.innerHTML = '<option value="operator">Operator</option><option value="admin">Admin</option><option value="superadmin">Superadmin</option>';
          valueSelect.style.display = "";
          break;
        case "department":
          valueSelect.innerHTML = deptOpts;
          valueSelect.style.display = "";
          break;
        case "permission":
          valueSelect.innerHTML = permOpts;
          valueSelect.style.display = "";
          break;
        case "user":
          valueInput.placeholder = "Username";
          valueInput.style.display = "";
          break;
      }
    });
  }

  async function loadHistory() {
    const wrap = document.getElementById("notif-history-wrap");
    wrap.innerHTML = '<div class="nx-toolbar-hint">Loading…</div>';
    try {
      const { data } = await api("/admin");
      const rows = data || [];
      if (rows.length === 0) {
        wrap.innerHTML = '<div class="nx-empty">No notifications sent yet.</div>';
        return;
      }

      wrap.innerHTML = `
        <div style="overflow-x:auto">
          <table class="table--compact">
            <thead><tr>
              <th>Sent</th><th>Title</th><th>Severity</th><th>Target</th>
              <th style="text-align:center">Sent To</th><th style="text-align:center">Read</th>
              <th>Expires</th><th></th>
            </tr></thead>
            <tbody>
              ${rows.map((n) => {
                const totalRead = n.totalRead || 0;
                const pct = n.totalSent > 0 ? Math.round((totalRead / n.totalSent) * 100) : 0;
                const target = n.targetType === "all" ? "All users" : `${n.targetType}: ${n.targetValue || "—"}`;
                const expired = n.expiresAt && new Date(n.expiresAt) < new Date();
                return `<tr>
                  <td style="font-size:12px;color:var(--text-muted);white-space:nowrap">${fmtDate(n.createdAt)}</td>
                  <td><strong>${esc(n.title)}</strong>${n.category ? `<div style="font-size:10.5px;color:var(--text-muted)">${esc(n.category)}</div>` : ""}</td>
                  <td><span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:${SEV_COLOURS[n.severity] || "#888"};flex-shrink:0"></span>${esc(SEV_LABELS[n.severity] || n.severity)}</span></td>
                  <td style="font-size:12px;color:var(--text-muted)">${esc(target)}</td>
                  <td style="text-align:center">${n.totalSent}</td>
                  <td style="text-align:center">${totalRead} <span style="font-size:11px;color:var(--text-muted)">(${pct}%)</span></td>
                  <td style="font-size:12px;color:var(--text-muted)">${fmtDate(n.expiresAt)}</td>
                  <td><button type="button" class="secondary" data-expire-id="${n.notificationId}" ${expired ? 'disabled title="Already expired"' : ""}>Expire</button></td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>`;

      wrap.querySelectorAll("[data-expire-id]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!(await NexusModal.confirm("Expire this notification immediately? It will disappear from all trays.", { danger: true, confirmLabel: "Expire" }))) return;
          btn.disabled = true; btn.textContent = "…";
          try {
            await api(`/admin/${btn.dataset.expireId}`, { method: "DELETE" });
            await loadHistory();
          } catch (err) {
            btn.disabled = false; btn.textContent = "Expire";
            alert(err.message);
          }
        });
      });
    } catch (err) {
      wrap.innerHTML = `<div class="tf-inline-error">${esc(err.message)}</div>`;
    }
  }

  async function send() {
    const btn = document.getElementById("notif-send-btn");
    const resultEl = document.getElementById("notif-send-result");
    const type = document.getElementById("notif-target-type").value;
    const valueInput = document.getElementById("notif-target-value");
    const valueSelect = document.getElementById("notif-target-select");
    const value = type === "all" ? null : (valueInput.style.display !== "none" ? valueInput.value.trim() : valueSelect.value);

    const title = document.getElementById("notif-title").value.trim();
    const body = document.getElementById("notif-body").value.trim();

    resultEl.style.color = "";
    if (!title || !body) {
      resultEl.style.color = "var(--error,#DC2626)"; resultEl.textContent = "Title and message body are required.";
      return;
    }
    if (type !== "all" && !value) {
      resultEl.style.color = "var(--error,#DC2626)"; resultEl.textContent = "Select or enter a target value.";
      return;
    }

    const payload = {
      title, body,
      severity: Number(document.getElementById("notif-severity").value),
      category: document.getElementById("notif-category").value.trim() || null,
      actionLabel: document.getElementById("notif-action-label").value.trim() || null,
      actionUrl: document.getElementById("notif-action-url").value.trim() || null,
      expiresAt: document.getElementById("notif-expires").value || null,
      target: { type, value },
    };

    btn.disabled = true; btn.textContent = "Sending…"; resultEl.textContent = "";
    try {
      const { data } = await api("/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      resultEl.style.color = "var(--accent)";
      resultEl.textContent = `✓ Sent to ${data.recipients} recipient${data.recipients !== 1 ? "s" : ""}`;
      ["notif-title", "notif-body", "notif-category", "notif-action-label", "notif-action-url", "notif-expires"].forEach((id) => {
        document.getElementById(id).value = "";
      });
      await loadHistory();
    } catch (err) {
      resultEl.style.color = "var(--error,#DC2626)"; resultEl.textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = "Send Notification";
    }
  }

  document.getElementById("notif-send-btn").addEventListener("click", send);
  document.getElementById("notif-refresh-btn").addEventListener("click", loadHistory);

  loadTargetOptions();
  loadHistory();
})();
