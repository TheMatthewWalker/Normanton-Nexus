'use strict';

/**
 * Notification tray — self-mounting.
 * Include this script on any private page. It injects the bell button into
 * .header-right (before the Sign Out link) and manages the tray lifecycle.
 */

const POLL_INTERVAL_MS = 60_000;
const HISTORY_URL      = '/private/notifications.html';
const API_BASE         = '/api/notifications';

let trayOpen    = false;
let pollTimer   = null;
let _state      = [];   // current deliveries
let lastUnreadCount = 0;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  injectBell();
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
  });
});

// ── Inject bell into header ───────────────────────────────────────────────────

function injectBell() {
  const headerRight = document.querySelector('.header-right');
  if (!headerRight) return;

  const bell = document.createElement('button');
  bell.className   = 'notif-bell-btn';
  bell.id          = 'notif-bell';
  bell.title       = 'Notifications';
  bell.setAttribute('aria-label', 'Notifications');
  bell.innerHTML   = bellSVG() + '<span class="notif-badge" id="notif-badge" style="display:none">0</span>';
  bell.addEventListener('click', toggleTray);

  // Insert before the first btn-logout / Sign Out link
  const signOut = headerRight.querySelector('a[href="/logout"]');
  if (signOut) {
    headerRight.insertBefore(bell, signOut);
  } else {
    headerRight.appendChild(bell);
  }
}

// ── Poll ──────────────────────────────────────────────────────────────────────

async function poll() {
  try {
    const res  = await fetch(API_BASE);
    const json = await res.json();
    if (!json.success) return;
    _state = json.data || [];
    updateBadge(json.unreadCount || 0);
    if (trayOpen) renderTray();
  } catch (_) { /* network — silent */ }
}

// ── Badge ─────────────────────────────────────────────────────────────────────

function updateBadge(count) {

  const badge = document.getElementById('notif-badge');
  const bell = document.getElementById('notif-bell');

  if (!badge || !bell) return;

  const hasNewNotifications =
    count > lastUnreadCount && lastUnreadCount > 0;

  if (count > 0) {

    badge.textContent =
      count > 99
        ? '99+'
        : String(count);

    badge.style.display = 'flex';

    bell.classList.add('notif-bell--active');

    if (hasNewNotifications) {
      bell.classList.remove('notif-bell--ring');
      void bell.offsetWidth; // restart animation
      bell.classList.add('notif-bell--ring');
    }

  } else {

    badge.style.display = 'none';

    bell.classList.remove(
      'notif-bell--active',
      'notif-bell--ring'
    );
  }

  lastUnreadCount = count;
}

// ── Toggle tray ───────────────────────────────────────────────────────────────

function toggleTray() {
  trayOpen ? closeTray() : openTray();
}

function openTray() {
  trayOpen = true;
  renderTray();
  markAllRead();
}

function closeTray() {
  trayOpen = false;
  document.getElementById('notif-tray')?.remove();
}

// ── Render tray ───────────────────────────────────────────────────────────────

function renderTray() {
  document.getElementById('notif-tray')?.remove();

  const tray = document.createElement('div');
  tray.id        = 'notif-tray';
  tray.className = 'notif-tray';

  const cards = _state.map(n => cardHTML(n)).join('');

  tray.innerHTML = `
    <div class="notif-tray-header">
      <span class="notif-tray-title">Notifications</span>
      <div class="notif-tray-actions">
        <a href="${HISTORY_URL}" class="notif-tray-link">View all</a>
        <button class="notif-tray-close" id="notif-tray-close" title="Close">×</button>
      </div>
    </div>
    <div class="notif-tray-list" id="notif-tray-list">
      ${cards || emptyHTML()}
    </div>`;

  document.body.appendChild(tray);

  document.getElementById('notif-tray-close').addEventListener('click', closeTray);

  // Wire dismiss buttons
  tray.querySelectorAll('.notif-dismiss-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      await dismiss(id);
    });
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', outsideClickClose, { once: true });
  }, 0);
}

function outsideClickClose(e) {
  const tray = document.getElementById('notif-tray');
  const bell = document.getElementById('notif-bell');
  if (!tray) return;
  if (!tray.contains(e.target) && !bell.contains(e.target)) {
    closeTray();
  } else {
    // re-register if click was inside
    setTimeout(() => {
      document.addEventListener('click', outsideClickClose, { once: true });
    }, 0);
  }
}

// ── Card HTML ─────────────────────────────────────────────────────────────────

function cardHTML(n) {
  const readCls  = n.IsRead ? 'notif-card--read' : '';
  const unreadDot = !n.IsRead
    ? `<span class="notif-unread-dot"></span>`
    : '';

  const meta = [
    n.Category ? `<span class="notif-cat-pill">${esc(n.Category)}</span>` : '',
    `<span>${relativeTime(n.CreatedAt)}</span>`,
  ].filter(Boolean).join('');

  const action = n.ActionURL
    ? `<a href="${esc(n.ActionURL)}" class="notif-action-btn">${esc(n.ActionLabel || 'View')}</a>`
    : '';

  return `
    <div class="notif-card notif-sev-${n.Severity} ${readCls}">
      <div class="notif-card-top">
        <div class="notif-card-title">${unreadDot}${esc(n.Title)}</div>
        <button class="notif-dismiss-btn" data-id="${n.DeliveryID}" title="Dismiss">×</button>
      </div>
      <div class="notif-card-body">${esc(n.Body)}</div>
      <div class="notif-card-footer">
        <div class="notif-card-meta">${meta}</div>
        ${action}
      </div>
    </div>`;
}

function emptyHTML() {
  return `<div class="notif-empty">
    <div class="notif-empty-icon">🔔</div>
    You're all caught up.
  </div>`;
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function markAllRead() {
  try {
    await fetch(`${API_BASE}/read-all`, { method: 'PATCH' });
    _state.forEach(n => { n.IsRead = true; });
    updateBadge(0);
  } catch (_) {}
}

async function dismiss(deliveryId) {
  try {
    await fetch(`${API_BASE}/${deliveryId}/dismiss`, { method: 'PATCH' });
    _state = _state.filter(n => n.DeliveryID !== deliveryId);
    updateBadge(_state.filter(n => !n.IsRead).length);
    if (trayOpen) renderTray();
  } catch (_) {}
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function relativeTime(dt) {
  if (!dt) return '';
  const diff = Math.floor((Date.now() - new Date(dt).getTime()) / 1000);
  if (diff < 60)   return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function bellSVG() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>`;
}
