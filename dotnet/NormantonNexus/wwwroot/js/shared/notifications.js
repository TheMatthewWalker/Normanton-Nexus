// Notification tray — self-mounting, ported from private/js/notifications.js.
// Injects a bell button into .header-right (before the Sign Out link) on
// every page that loads this script (see _Layout.cshtml) and manages the
// tray lifecycle (poll, open/close, mark-read, dismiss).
//
// Deliberate shape difference from Node: this app's ApiResponse<T> envelope
// is always exactly {success,data,error} — Node's GET / puts unreadCount as
// a sibling of data at the top level, which doesn't fit that uniform shape,
// so here it's nested as data.notifications/data.unreadCount instead (see
// Models/Dto/NotificationModels.cs's own comment on this).
(function () {
  const esc = window.NexusApi.esc;
  const POLL_INTERVAL_MS = 60_000;
  const HISTORY_URL = "/NotificationsHistory";
  const API_BASE = "/api/notifications";

  let trayOpen = false;
  let state = [];
  let lastUnreadCount = 0;

  document.addEventListener("DOMContentLoaded", () => {
    injectBell();
    poll();
    setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") poll();
    });
  });

  function injectBell() {
    const headerRight = document.querySelector(".header-right");
    if (!headerRight) return;

    const bell = document.createElement("button");
    bell.type = "button";
    bell.className = "notif-bell-btn";
    bell.id = "notif-bell";
    bell.title = "Notifications";
    bell.setAttribute("aria-label", "Notifications");
    bell.innerHTML = bellSvg() + '<span class="notif-badge" id="notif-badge" style="display:none">0</span>';
    bell.addEventListener("click", toggleTray);

    const signOut = headerRight.querySelector('a[href="/Logout"], a[href="/logout"]');
    if (signOut) headerRight.insertBefore(bell, signOut);
    else headerRight.appendChild(bell);
  }

  async function poll() {
    try {
      const res = await fetch(API_BASE);
      const json = await res.json();
      if (!json.success) return;
      state = json.data.notifications || [];
      updateBadge(json.data.unreadCount || 0);
      if (trayOpen) renderTray();
    } catch { /* network — silent, matches Node */ }
  }

  function updateBadge(count) {
    const badge = document.getElementById("notif-badge");
    const bell = document.getElementById("notif-bell");
    if (!badge || !bell) return;

    const hasNew = count > lastUnreadCount && lastUnreadCount > 0;
    if (count > 0) {
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.style.display = "flex";
      bell.classList.add("notif-bell--active");
      if (hasNew) {
        bell.classList.remove("notif-bell--ring");
        void bell.offsetWidth;
        bell.classList.add("notif-bell--ring");
      }
    } else {
      badge.style.display = "none";
      bell.classList.remove("notif-bell--active", "notif-bell--ring");
    }
    lastUnreadCount = count;
  }

  function toggleTray() { trayOpen ? closeTray() : openTray(); }
  function openTray() { trayOpen = true; renderTray(); markAllRead(); }
  function closeTray() { trayOpen = false; document.getElementById("notif-tray")?.remove(); }

  function renderTray() {
    document.getElementById("notif-tray")?.remove();

    const tray = document.createElement("div");
    tray.id = "notif-tray";
    tray.className = "notif-tray";

    const cards = state.map((n) => cardHtml(n)).join("");
    tray.innerHTML = `
      <div class="notif-tray-header">
        <span class="notif-tray-title">Notifications</span>
        <div class="notif-tray-actions">
          <a href="${HISTORY_URL}" class="notif-tray-link">View all</a>
          <button type="button" class="notif-tray-close" id="notif-tray-close" title="Close">&times;</button>
        </div>
      </div>
      <div class="notif-tray-list" id="notif-tray-list">${cards || emptyHtml()}</div>`;

    document.body.appendChild(tray);
    document.getElementById("notif-tray-close").addEventListener("click", closeTray);

    tray.querySelectorAll(".notif-dismiss-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await dismiss(Number(btn.dataset.id));
      });
    });

    setTimeout(() => document.addEventListener("click", outsideClickClose, { once: true }), 0);
  }

  function outsideClickClose(e) {
    const tray = document.getElementById("notif-tray");
    const bell = document.getElementById("notif-bell");
    if (!tray) return;
    if (!tray.contains(e.target) && !bell.contains(e.target)) {
      closeTray();
    } else {
      setTimeout(() => document.addEventListener("click", outsideClickClose, { once: true }), 0);
    }
  }

  function cardHtml(n) {
    const readCls = n.isRead ? "notif-card--read" : "";
    const unreadDot = n.isRead ? "" : '<span class="notif-unread-dot"></span>';
    const meta = [
      n.category ? `<span class="notif-cat-pill">${esc(n.category)}</span>` : "",
      `<span>${relativeTime(n.createdAt)}</span>`,
    ].filter(Boolean).join("");
    const action = n.actionUrl
      ? `<a href="${esc(n.actionUrl)}" class="notif-action-btn">${esc(n.actionLabel || "View")}</a>`
      : "";

    return `
      <div class="notif-card notif-sev-${n.severity} ${readCls}">
        <div class="notif-card-top">
          <div class="notif-card-title">${unreadDot}${esc(n.title)}</div>
          <button type="button" class="notif-dismiss-btn" data-id="${n.deliveryId}" title="Dismiss">&times;</button>
        </div>
        <div class="notif-card-body">${esc(n.body)}</div>
        <div class="notif-card-footer">
          <div class="notif-card-meta">${meta}</div>
          ${action}
        </div>
      </div>`;
  }

  function emptyHtml() {
    return `<div class="notif-empty"><div class="notif-empty-icon">&#128276;</div>You're all caught up.</div>`;
  }

  async function markAllRead() {
    try {
      await fetch(`${API_BASE}/read-all`, { method: "PATCH" });
      state.forEach((n) => { n.isRead = true; });
      updateBadge(0);
    } catch { /* silent */ }
  }

  async function dismiss(deliveryId) {
    try {
      await fetch(`${API_BASE}/${deliveryId}/dismiss`, { method: "PATCH" });
      state = state.filter((n) => n.deliveryId !== deliveryId);
      updateBadge(state.filter((n) => !n.isRead).length);
      if (trayOpen) renderTray();
    } catch { /* silent */ }
  }

  function relativeTime(dt) {
    if (!dt) return "";
    const diff = Math.floor((Date.now() - new Date(dt).getTime()) / 1000);
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function bellSvg() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>`;
  }
})();
