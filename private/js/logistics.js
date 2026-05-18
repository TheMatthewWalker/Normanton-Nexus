'use strict';

let activeDT = null;
let currentResult = [];
let deliveryRows = [];
let shipmentRows = [];
let selectedDeliveryIds = new Set();
let selectedBookingShipmentIds = new Set();
let selectedCustomsShipmentIds = new Set();
let selectedCollectionIds = new Set();
let latestShipment = null;
let currentShipmentView = null;
let approvedForwarders = null;
let allForwarders = null;
let customsBatchNotice = null;
let userPermissions = [];
let sessionRole     = '';


const BUCKETS = [
  { key: 'priority', label: 'Priority', dot: 'priority', defaultOpen: true },
  { key: 'backlog', label: 'Backlog', dot: 'backlog', defaultOpen: true },
  { key: 'today', label: 'Today', dot: 'today', defaultOpen: true },
  { key: 'this-week', label: 'This Week', dot: 'week', defaultOpen: true },
  { key: 'this-month', label: 'This Month', dot: 'month', defaultOpen: false },
  { key: 'other', label: 'Everything Else', dot: 'other', defaultOpen: false },
];

const SHIPMENT_VIEWS = {
  'awaiting-collection': {
    title: 'Awaiting Collection',
    hint: 'Shipments waiting to be collected from Kongsberg.',
    actionLabel: 'Mark Collected',
    actionRoute: 'mark-collected',
    dateLabel: 'Planned Collection',
    locationLabel: 'Destination',
    locationField: 'destinationName',
  },
  inbound: {
    title: 'Inbound',
    hint: 'Collected shipments due to arrive at Kongsberg.',
    actionLabel: 'Mark Delivered',
    actionRoute: 'mark-delivered',
    dateLabel: 'Planned Delivery',
    locationLabel: 'Origin',
    locationField: 'originName',
  },
  'in-transit': {
    title: 'In Transit',
    hint: 'Outbound shipments collected and not yet delivered.',
    actionLabel: 'Mark Delivered',
    actionRoute: 'mark-delivered',
    dateLabel: 'Planned Delivery',
    locationLabel: 'Destination',
    locationField: 'destinationName',
  },
};


(async () => {
  const d = await fetch('/session-check').then(r => r.json());
  if (!d.loggedIn) { window.location.href = '/'; return; }
  document.getElementById('session-user').textContent = d.username;
  sessionRole     = d.role        || '';
  userPermissions = d.permissions || [];
  applyPermissionVisibility();
  setupTiles();
})();

function applyPermissionVisibility() {
  document.querySelectorAll('[data-permission]').forEach(el => {
    const code    = el.dataset.permission;
    const allowed = sessionRole === 'superadmin' || userPermissions.includes(code);
    el.style.display = allowed ? '' : 'none';
  });
}

function setupTiles() {
  document.querySelectorAll('.sap-tile--live[data-fn]').forEach(tile => {
    tile.addEventListener('click', () => {
      const fn = tile.dataset.fn;
      if (fn === 'openDeliveries')      runOpenDeliveries();
      if (fn === 'awaitingCollection')  runShipmentQueue('awaiting-collection');
      if (fn === 'inTransitShipments')  runShipmentQueue('in-transit');
      if (fn === 'awaitingBooking')     runShipmentBooking();
      if (fn === 'customsDocs')         runCustomsDocuments();
      if (fn === 'completedShipments')  runCompletedShipments();
      if (fn === 'customerSpecifics')   runCustomerSpecifics();
      if (fn === 'updatePalletData')    runUpdatePalletData();
      if (fn === 'updatePackagingData') runUpdatePackagingData();
      if (fn === 'updateDestinations')  runUpdateDestinations();
    });
  });

  document.querySelectorAll('.pn-section-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      hdr.closest('.pn-section').classList.toggle('pn-section--collapsed');
    });
  });
}


async function checkSession() {
  try {
    const d = await fetch('/session-check').then(r => r.json());
    if (!d.loggedIn) { alert('Your session has expired. Please log in again.'); window.location.href = '/'; return false; }
    return true;
  } catch {
    alert('Unable to verify your session. Please log in again.');
    window.location.href = '/';
    return false;
  }
}


function showResultPanel(title, hint) {
  if (activeDT) { try { activeDT.destroy(); } catch (_) {} activeDT = null; }
  document.getElementById('tile-section').classList.add('hidden');
  document.getElementById('result-section').classList.remove('hidden');
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-hint').textContent = hint;
  document.getElementById('result-row-badge').classList.add('hidden');
  document.getElementById('btn-export-csv').classList.add('hidden');
  document.getElementById('result-body').innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading...</div>';
}


function backToTiles() {
  document.getElementById('result-section').classList.add('hidden');
  document.getElementById('tile-section').classList.remove('hidden');
  document.getElementById('result-body').innerHTML = '';
  selectedDeliveryIds = new Set();
  deliveryRows = [];
  shipmentRows = [];
  selectedBookingShipmentIds = new Set();
  selectedCustomsShipmentIds = new Set();
  latestShipment = null;
  currentShipmentView = null;
  customsBatchNotice = null;
}


function getDateBucket(dueDate) {
  if (!dueDate) return 'other';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due = new Date(dueDate);
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  if (dueDay < today) return 'backlog';
  if (dueDay.getTime() === today.getTime()) return 'today';
  const dow = today.getDay() || 7;
  const monday = new Date(today); monday.setDate(today.getDate() - dow + 1);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  if (dueDay <= sunday) return 'this-week';
  if (due.getFullYear() === now.getFullYear() && due.getMonth() === now.getMonth()) return 'this-month';
  return 'other';
}


function formatDisplayDate(value) {
  return value ? new Date(value).toLocaleDateString('en-GB') : '-';
}


function getShipmentPlannedDate(row, mode) {
  if (mode === 'awaiting-collection') return row.plannedCollection;
  return row.plannedDelivery || row.plannedCollection || row.plannedMovement;
}


function getSelectedBookingRows() {
  return shipmentRows.filter(row => selectedBookingShipmentIds.has(Number(row.shipmentID)));
}


function getSelectedBookingHaulierName() {
  return getSelectedBookingRows()[0]?.forwarderName || '';
}


function hasAssignedHaulier(row) {
  return Boolean(String(row?.forwarderName || '').trim());
}


function getBookingSelectionKey(row) {
  return hasAssignedHaulier(row) ? normalizeHaulierName(row.forwarderName) : '__unassigned__';
}


function normalizeHaulierName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}


function isCustomerCollectHaulier(value) {
  const normalized = normalizeHaulierName(value);
  return normalized.includes('customercollect');
}


function isKnHaulier(value) {
  const normalized = normalizeHaulierName(value);
  return normalized.includes('kuehnenagel') || normalized.includes('kuehneandnagel');
}


async function loadApprovedForwarders() {
  if (approvedForwarders) return approvedForwarders;
  const res = await fetch('/api/forwarders/approved');
  const json = await res.json();
  approvedForwarders = Array.isArray(json) ? json : [];
  return approvedForwarders;
}


async function loadAllForwarders() {
  if (allForwarders) return allForwarders;
  const res = await fetch('/api/forwarders');
  const json = await res.json();
  allForwarders = Array.isArray(json) ? json : [];
  return allForwarders;
}


async function runShipmentQueue(mode) {
  const view = SHIPMENT_VIEWS[mode];
  if (!view) return;
  if (!await checkSession()) return;
  currentShipmentView = mode;
  showResultPanel(view.title, view.hint);
  try {
    const res = await fetch(`/api/shipmentmain/queue/${encodeURIComponent(mode)}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load shipments');
    shipmentRows = json.data || [];
    currentResult = shipmentRows;
    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${shipmentRows.length} open`;
    badge.classList.remove('hidden');
    if (!shipmentRows.length) {
      document.getElementById('result-body').innerHTML = `<div class="sap-error">No ${esc(view.title.toLowerCase())} shipments are currently available.</div>`;
      return;
    }
    if (mode === 'awaiting-collection') {
      selectedCollectionIds = new Set();
      renderAwaitingCollection();
    } else {
      renderShipmentQueue(mode);
    }
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}


async function runShipmentBooking() {
  if (!await checkSession()) return;
  currentShipmentView = 'awaiting-booking';
  selectedBookingShipmentIds = new Set();
  showResultPanel('Awaiting Booking', 'Shipments with a forwarder assigned that still need booking.');
  try {
    const res = await fetch('/api/shipmentmain/queue/awaiting-booking');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load shipments');
    shipmentRows = Array.from(new Map((json.data || []).map(row => [Number(row.shipmentID), row])).values());
    currentResult = shipmentRows;
    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${shipmentRows.length} waiting`;
    badge.classList.remove('hidden');
    if (!shipmentRows.length) {
      document.getElementById('result-body').innerHTML = '<div class="sap-error">No shipments are currently awaiting booking.</div>';
      return;
    }
    renderShipmentBooking();
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}


async function runCustomsDocuments() {
  if (!await checkSession()) return;
  currentShipmentView = 'customs-docs';
  selectedCustomsShipmentIds = new Set();
  showResultPanel('Customs Documents', 'Shipments requiring customs entries through ClearPort.');
  try {
    const res = await fetch('/api/shipmentmain/queue/customs-docs');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load customs shipments');
    shipmentRows = Array.from(new Map((json.data || []).map(row => [Number(row.shipmentID), row])).values());
    currentResult = shipmentRows;
    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${shipmentRows.length} waiting`;
    badge.classList.remove('hidden');
    if (!shipmentRows.length) {
      document.getElementById('result-body').innerHTML = '<div class="sap-error">No shipments are currently awaiting customs documents.</div>';
      customsBatchNotice = null;
      return;
    }
    renderCustomsDocuments();
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}


function renderShipmentQueue(mode) {
  const view = SHIPMENT_VIEWS[mode];
  const rows = shipmentRows.map(row => {
    const shipmentRef = String(row.shipmentID || '').padStart(8, '0');
    const locationValue = row[view.locationField] || '-';
    const plannedDate = getShipmentPlannedDate(row, mode);
    return `<tr class="ps-row shipment-row" data-id="${esc(String(row.shipmentID))}"><td>${esc(shipmentRef)}</td><td>${esc(formatDisplayDate(plannedDate))}</td><td>${esc(row.trackingNumber || '')}</td><td>${esc(row.forwarderName || '')}</td><td>${esc(locationValue)}</td><td class="shipment-action-cell"><button type="button" class="btn-submit shipment-action-btn" data-id="${esc(String(row.shipmentID))}">${esc(view.actionLabel)}</button></td></tr>`;
  }).join('');

  document.getElementById('result-body').innerHTML = `<div class="lg-actions"><div><div class="lg-selection-title">${esc(view.title)}</div><div class="toolbar-hint">${esc(view.hint)}</div></div></div><div class="ps-sections"><div class="ps-section"><div class="ps-section-header"><span class="ps-section-dot ps-section-dot--today"></span><span class="ps-section-title">${esc(view.title)}</span><span class="ps-section-count">${shipmentRows.length}</span><span class="ps-chevron">v</span></div><div class="ps-section-body"><table class="ps-table"><thead><tr><th>Shipment</th><th>${esc(view.dateLabel)}</th><th>Tracking</th><th>Forwarder</th><th>${esc(view.locationLabel)}</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div></div></div><div id="shipment-queue-msg" class="lg-selection-msg hidden"></div>`;
  bindShipmentQueueEvents(mode);
}


function renderShipmentBooking() {
  const grouped = shipmentRows.reduce((acc, row) => {
    const key = hasAssignedHaulier(row) ? row.forwarderName : 'Unassigned Haulier';
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  const sections = Object.keys(grouped).sort((a, b) => a.localeCompare(b)).map(name => {
    const rows = grouped[name]
      .slice()
      .sort((a, b) => {
        const aDate = new Date(getShipmentPlannedDate(a, 'in-transit') || 0).getTime();
        const bDate = new Date(getShipmentPlannedDate(b, 'in-transit') || 0).getTime();
        return aDate - bDate || Number(a.shipmentID || 0) - Number(b.shipmentID || 0);
      })
      .map(row => {
        const shipmentRef = String(row.shipmentID || '').padStart(8, '0');
        const plannedDate = getShipmentPlannedDate(row, 'in-transit');
        return `<tr class="ps-row booking-row" data-id="${esc(String(row.shipmentID))}" data-haulier-key="${esc(getBookingSelectionKey(row))}"><td class="lg-check-cell"><input type="checkbox" class="booking-check" data-id="${esc(String(row.shipmentID))}" data-haulier-key="${esc(getBookingSelectionKey(row))}"></td><td>${esc(shipmentRef)}</td><td>${esc(formatDisplayDate(plannedDate))}</td><td>${esc(row.trackingNumber || '')}</td><td>${esc(row.destinationName || row.originName || '-')}</td></tr>`;
      }).join('');

    return `<div class="ps-section"><div class="ps-section-header"><span class="ps-section-dot ps-section-dot--today"></span><span class="ps-section-title">${esc(name)}</span><span class="ps-section-count">${grouped[name].length}</span><span class="ps-chevron">v</span></div><div class="ps-section-body"><table class="ps-table"><thead><tr><th></th><th>Shipment</th><th>Planned Movement</th><th>Tracking</th><th>Destination</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }).join('');

  document.getElementById('result-body').innerHTML = `<div class="lg-actions"><div><div class="lg-selection-title">Awaiting Booking</div><div class="toolbar-hint" id="booking-selection-hint">Select one or more shipments for the same haulier, then book them.</div></div><div class="toolbar-spacer"></div><button type="button" class="btn-secondary" id="booking-clear-btn" disabled>Clear Selection</button><button type="button" class="btn-secondary" id="booking-cancel-btn" disabled>Cancel Shipment</button><button type="button" class="btn-submit" id="booking-confirm-btn" disabled>Book</button></div><div id="booking-selection-msg" class="lg-selection-msg hidden"></div><div class="ps-sections">${sections}</div>`;
  bindShipmentBookingEvents();
  updateShipmentBookingUI();
}


function renderCustomsDocuments() {
  const rows = shipmentRows
    .slice()
    .sort((a, b) => {
      const aDate = new Date(getShipmentPlannedDate(a, 'in-transit') || 0).getTime();
      const bDate = new Date(getShipmentPlannedDate(b, 'in-transit') || 0).getTime();
      return aDate - bDate || Number(a.shipmentID || 0) - Number(b.shipmentID || 0);
    })
    .map(row => {
      const shipmentRef = String(row.shipmentID || '').padStart(8, '0');
      const plannedDate = getShipmentPlannedDate(row, 'in-transit');
      return `<tr class="ps-row customs-row" data-id="${esc(String(row.shipmentID))}"><td class="lg-check-cell"><input type="checkbox" class="customs-check" data-id="${esc(String(row.shipmentID))}"></td><td>${esc(shipmentRef)}</td><td>${esc(formatDisplayDate(plannedDate))}</td><td>${esc(row.forwarderName || '')}</td><td>${esc(row.destinationName || '-')}</td><td>${esc(row.customsID || '')}</td></tr>`;
    }).join('');

  const noticeClass = customsBatchNotice?.type === 'success' ? ' lg-selection-msg--success' : customsBatchNotice?.type === 'warning' ? ' lg-selection-msg--warning' : '';
  const noticeHtml = customsBatchNotice
    ? `<div id="customs-selection-msg" class="lg-selection-msg${noticeClass}">${esc(customsBatchNotice.text)}</div>`
    : '<div id="customs-selection-msg" class="lg-selection-msg hidden"></div>';

  document.getElementById('result-body').innerHTML = `<div class="lg-actions"><div><div class="lg-selection-title">Customs Documents</div><div class="toolbar-hint" id="customs-selection-hint">Select one or more shipments, then create the customs entries in ClearPort.</div></div><div class="toolbar-spacer"></div><button type="button" class="btn-secondary" id="customs-clear-btn" disabled>Clear Selection</button><button type="button" class="btn-submit" id="customs-create-btn" disabled>Create Customs Entry</button></div>${noticeHtml}<div class="ps-sections"><div class="ps-section"><div class="ps-section-header"><span class="ps-section-dot ps-section-dot--week"></span><span class="ps-section-title">Awaiting Customs</span><span class="ps-section-count">${shipmentRows.length}</span><span class="ps-chevron">v</span></div><div class="ps-section-body"><table class="ps-table"><thead><tr><th></th><th>Shipment</th><th>Planned Movement</th><th>Forwarder</th><th>Destination</th><th>Customs ID</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>`;
  bindCustomsDocumentsEvents();
  updateCustomsDocumentsUI();
}


function bindShipmentQueueEvents(mode) {
  document.querySelectorAll('.ps-section-header').forEach(header => header.addEventListener('click', () => header.closest('.ps-section').classList.toggle('ps-section--collapsed')));
  document.querySelectorAll('.shipment-action-btn').forEach(button => {
    button.addEventListener('click', async e => {
      e.stopPropagation();
      await updateShipmentQueueStatus(mode, button);
    });
  });
}


function bindShipmentBookingEvents() {
  document.querySelectorAll('.ps-section-header').forEach(header => header.addEventListener('click', () => header.closest('.ps-section').classList.toggle('ps-section--collapsed')));
  document.querySelectorAll('.booking-check').forEach(input => input.addEventListener('change', onShipmentBookingToggle));
  document.querySelectorAll('.booking-row').forEach(row => row.addEventListener('click', e => {
    if (e.target.closest('.lg-check-cell')) return;
    openShipmentDetailModal(Number(row.dataset.id));
  }));
  document.getElementById('booking-clear-btn').addEventListener('click', () => {
    selectedBookingShipmentIds = new Set();
    document.querySelectorAll('.booking-check').forEach(input => { input.checked = false; });
    updateShipmentBookingUI();
  });
  document.getElementById('booking-cancel-btn').addEventListener('click', cancelSelectedShipments);
  document.getElementById('booking-confirm-btn').addEventListener('click', confirmShipmentBookings);
}


function bindCustomsDocumentsEvents() {
  document.querySelectorAll('.ps-section-header').forEach(header => header.addEventListener('click', () => header.closest('.ps-section').classList.toggle('ps-section--collapsed')));
  document.querySelectorAll('.customs-check').forEach(input => input.addEventListener('change', onCustomsToggle));
  document.getElementById('customs-clear-btn').addEventListener('click', () => {
    selectedCustomsShipmentIds = new Set();
    document.querySelectorAll('.customs-check').forEach(input => { input.checked = false; });
    updateCustomsDocumentsUI();
  });
  document.getElementById('customs-create-btn').addEventListener('click', submitCustomsDocuments);
}


async function updateShipmentQueueStatus(mode, button) {
  const view = SHIPMENT_VIEWS[mode];
  const shipmentId = button.dataset.id;
  const originalText = button.textContent;
  const msg = document.getElementById('shipment-queue-msg');
  button.disabled = true;
  button.textContent = 'Working...';
  if (msg) msg.classList.add('hidden');
  try {
    const res = await fetch(`/api/shipmentmain/${encodeURIComponent(shipmentId)}/${view.actionRoute}`, { method: 'POST' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Update failed');
    await runShipmentQueue(mode);
  } catch (err) {
    button.disabled = false;
    button.textContent = originalText;
    if (msg) {
      msg.textContent = err.message;
      msg.classList.remove('hidden');
    }
  }
}


function onShipmentBookingToggle(e) {
  const id = Number(e.target.dataset.id);
  const row = shipmentRows.find(item => Number(item.shipmentID) === id);
  if (!row) return;
  const lockedRow = getSelectedBookingRows()[0];
  const lockedKey = lockedRow ? getBookingSelectionKey(lockedRow) : '';
  const rowKey = getBookingSelectionKey(row);
  if (e.target.checked && lockedKey && lockedKey !== rowKey) {
    e.target.checked = false;
    const msg = document.getElementById('booking-selection-msg');
    if (msg) {
      msg.textContent = 'Only shipments for the same haulier can be booked together.';
      msg.classList.remove('hidden');
    }
    return;
  }
  if (e.target.checked) selectedBookingShipmentIds.add(id);
  else selectedBookingShipmentIds.delete(id);
  updateShipmentBookingUI();
}


function updateShipmentBookingUI() {
  const rows = getSelectedBookingRows();
  const lockedRow = rows[0] || null;
  const lockedHaulier = lockedRow ? (hasAssignedHaulier(lockedRow) ? lockedRow.forwarderName : 'Unassigned Haulier') : '';
  const lockedKey = lockedRow ? getBookingSelectionKey(lockedRow) : '';
  const hint = document.getElementById('booking-selection-hint');
  if (hint) hint.textContent = rows.length ? `${rows.length} shipment(s) selected for ${lockedHaulier || 'this haulier'}.` : 'Select one or more shipments for the same haulier, then book them.';
  const msg = document.getElementById('booking-selection-msg');
  if (msg && !rows.length) msg.classList.add('hidden');
  document.querySelectorAll('.booking-row').forEach(row => {
    const differentHaulier = lockedKey && row.dataset.haulierKey !== lockedKey && !selectedBookingShipmentIds.has(Number(row.dataset.id));
    row.classList.toggle('lg-row--selected', selectedBookingShipmentIds.has(Number(row.dataset.id)));
    row.classList.toggle('lg-row--disabled', Boolean(differentHaulier));
    const checkbox = row.querySelector('.booking-check');
    if (checkbox) checkbox.disabled = Boolean(differentHaulier);
  });
  const clearBtn = document.getElementById('booking-clear-btn');
  if (clearBtn) clearBtn.disabled = selectedBookingShipmentIds.size === 0;
  const cancelBtn = document.getElementById('booking-cancel-btn');
  if (cancelBtn) cancelBtn.disabled = selectedBookingShipmentIds.size === 0;
  const confirmBtn = document.getElementById('booking-confirm-btn');
  if (confirmBtn) confirmBtn.disabled = selectedBookingShipmentIds.size === 0;
}


function getSelectedCustomsRows() {
  return shipmentRows.filter(row => selectedCustomsShipmentIds.has(Number(row.shipmentID)));
}


function onCustomsToggle(e) {
  const id = Number(e.target.dataset.id);
  if (e.target.checked) selectedCustomsShipmentIds.add(id);
  else selectedCustomsShipmentIds.delete(id);
  updateCustomsDocumentsUI();
}


function updateCustomsDocumentsUI() {
  const rows = getSelectedCustomsRows();
  const hint = document.getElementById('customs-selection-hint');
  if (hint) hint.textContent = rows.length
    ? `${rows.length} shipment(s) selected for customs submission.`
    : 'Select one or more shipments, then create the customs entries in ClearPort.';
  document.querySelectorAll('.customs-row').forEach(row => {
    row.classList.toggle('lg-row--selected', selectedCustomsShipmentIds.has(Number(row.dataset.id)));
  });
  const clearBtn = document.getElementById('customs-clear-btn');
  if (clearBtn) clearBtn.disabled = rows.length === 0;
  const createBtn = document.getElementById('customs-create-btn');
  if (createBtn) createBtn.disabled = rows.length === 0;
}


async function confirmShipmentBookings() {
  const rows = getSelectedBookingRows();
  if (!rows.length) return;
  const haulier = getSelectedBookingHaulierName();
  openBookingModal(rows, haulier);
}


async function submitCustomsDocuments() {
  const rows = getSelectedCustomsRows();
  if (!rows.length) return;
  const button = document.getElementById('customs-create-btn');
  const message = document.getElementById('customs-selection-msg');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Creating...';
  if (message) {
    message.textContent = '';
    message.classList.add('hidden');
    message.classList.remove('lg-selection-msg--success');
  }

  try {
    const res = await fetch('/api/shipmentmain/customs/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipmentIDs: rows.map(row => row.shipmentID) }),
    });
    const json = await res.json();
    if (!res.ok && !json.data) throw new Error(json.error || 'Failed to create customs entries.');

    const completed = json.data?.completed || [];
    const failed = json.data?.failed || [];

    const lines = [];
    for (const item of completed) {
      if (item.pdfSaved) {
        lines.push(`${item.shipmentRef}: declaration created and PDF saved.`);
      } else {
        lines.push(`${item.shipmentRef}: declaration created in ClearPort (ID: ${item.customsID}) — PDF not yet ready: ${item.pdfError || 'unknown error'}.`);
      }
    }
    for (const item of failed) {
      lines.push(`${item.shipmentRef}: failed — ${item.error}`);
    }

    customsBatchNotice = {
      type: completed.length ? (completed.every(i => i.pdfSaved) ? 'success' : 'warning') : 'error',
      text: lines.join(' '),
    };

    await runCustomsDocuments();
  } catch (err) {
    customsBatchNotice = { type: 'error', text: err.message };
    button.disabled = false;
    button.textContent = originalText;
    if (message) {
      message.textContent = err.message;
      message.classList.remove('hidden');
    }
  }
}


async function cancelSelectedShipments() {
  const rows = getSelectedBookingRows();
  if (!rows.length) return;
  if (!window.confirm(`Cancel ${rows.length} shipment(s)? This will unlink the deliveries and return them to Open Deliveries.`)) return;
  const button = document.getElementById('booking-cancel-btn');
  const msg = document.getElementById('booking-selection-msg');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Cancelling...';
  if (msg) msg.classList.add('hidden');
  try {
    const res = await fetch('/api/shipmentmain/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipmentIDs: rows.map(row => row.shipmentID) }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to cancel shipments.');
    await runShipmentBooking();
  } catch (err) {
    button.disabled = false;
    button.textContent = originalText;
    if (msg) {
      msg.textContent = err.message;
      msg.classList.remove('hidden');
    }
  }
}


async function runOpenDeliveries() {
  if (!await checkSession()) return;
  showResultPanel('Open Deliveries', 'Completed deliveries ready for shipment creation');
  try {
    const res = await fetch('/api/deliverymain/completed-unshipped');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load deliveries');
    deliveryRows = json.data || [];
    currentResult = deliveryRows;
    selectedDeliveryIds = new Set();
    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${deliveryRows.length} ready`;
    badge.classList.remove('hidden');
    if (!deliveryRows.length) {
      document.getElementById('result-body').innerHTML = '<div class="sap-error">No completed deliveries are currently available for shipment creation.</div>';
      return;
    }
    renderOpenDeliveries();
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}


function renderOpenDeliveries() {
  const bucketMap = {}; BUCKETS.forEach(b => { bucketMap[b.key] = []; });
  deliveryRows.forEach(r => { const key = r.deliveryPriority === 1 ? 'priority' : getDateBucket(r.dueDate); bucketMap[key].push(r); });
  const sections = BUCKETS.filter(b => bucketMap[b.key].length).map(b => {
    const collapsed = b.defaultOpen ? '' : ' ps-section--collapsed';
    const rows = bucketMap[b.key].map(r => {
      const due = r.dueDate ? new Date(r.dueDate).toLocaleDateString('en-GB') : '-';
      const completed = r.completionDate ? new Date(r.completionDate).toLocaleDateString('en-GB') : '-';
      const flag = b.key === 'priority' ? '<span class="ps-priority-flag"></span>' : '';
      return `<tr class="ps-row lg-row" data-id="${esc(String(r.deliveryID))}" data-customer="${esc(String(r.customerID))}"><td class="lg-check-cell"><input type="checkbox" class="lg-check" data-id="${esc(String(r.deliveryID))}"></td><td>${flag}${esc(String(r.deliveryID))}</td><td>${esc(r.destinationName || '-')}</td><td>${esc(completed)}</td><td>${esc(due)}</td><td>${esc(r.deliveryService || '')}</td><td>${esc(String(r.palletCount ?? 0))}</td><td>${esc(String(r.grossWeight ?? 0))}</td><td>${esc(String(r.deliveryVolume ?? 0))}</td></tr>`;
    }).join('');
    return `<div class="ps-section${collapsed}"><div class="ps-section-header"><span class="ps-section-dot ps-section-dot--${b.dot}"></span><span class="ps-section-title">${b.label}</span><span class="ps-section-count">${bucketMap[b.key].length}</span><span class="ps-chevron">v</span></div><div class="ps-section-body"><table class="ps-table"><thead><tr><th></th><th>Delivery</th><th>Destination</th><th>Completed</th><th>Due</th><th>Service</th><th>Pallets</th><th>Weight</th><th>Volume</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }).join('');
  document.getElementById('result-body').innerHTML = `<div class="lg-actions"><div><div class="lg-selection-title">Completed picksheets</div><div class="toolbar-hint" id="lg-selection-hint">Select deliveries for one customer, then create a shipment.</div></div><div class="toolbar-spacer"></div><button type="button" class="btn-secondary" id="lg-clear-btn" disabled>Clear Selection</button><button type="button" class="btn-submit" id="lg-create-btn" disabled>Create Shipment</button></div><div id="lg-selection-msg" class="lg-selection-msg hidden"></div><div class="ps-sections">${sections}</div>`;
  bindOpenDeliveriesEvents();
  updateSelectionUI();
}


function bindOpenDeliveriesEvents() {
  document.querySelectorAll('.ps-section-header').forEach(h => h.addEventListener('click', () => h.closest('.ps-section').classList.toggle('ps-section--collapsed')));
  document.querySelectorAll('.lg-check').forEach(input => input.addEventListener('change', onDeliveryToggle));
  document.querySelectorAll('.lg-row').forEach(row => row.addEventListener('click', e => {
    if (e.target.closest('input')) return;
    showPickedPallets(row.dataset.id, row.children[2]?.textContent || '');
  }));
  document.getElementById('lg-clear-btn').addEventListener('click', () => {
    selectedDeliveryIds = new Set();
    document.querySelectorAll('.lg-check').forEach(input => { input.checked = false; });
    updateSelectionUI();
  });
  document.getElementById('lg-create-btn').addEventListener('click', openShipmentModal);
}


function onDeliveryToggle(e) {
  const id = Number(e.target.dataset.id);
  const row = deliveryRows.find(item => Number(item.deliveryID) === id);
  if (!row) return;
  const lockedCustomer = getSelectedCustomerId();
  if (e.target.checked && lockedCustomer && String(lockedCustomer) !== String(row.customerID)) {
    e.target.checked = false;
    showSelectionMessage('Only deliveries for the same customer can be added to one shipment.');
    return;
  }
  if (e.target.checked) selectedDeliveryIds.add(id); else selectedDeliveryIds.delete(id);
  updateSelectionUI();
}


function getSelectedRows() { return deliveryRows.filter(row => selectedDeliveryIds.has(Number(row.deliveryID))); }


function getSelectedCustomerId() { const first = getSelectedRows()[0]; return first ? first.customerID : null; }


function showSelectionMessage(message) {
  const el = document.getElementById('lg-selection-msg');
  if (!el) return;
  el.textContent = message; el.classList.remove('hidden');
}


function updateSelectionUI() {
  const rows = getSelectedRows(); const lockedCustomer = rows[0]?.customerID ?? null;
  const totals = rows.reduce((acc, row) => { acc.pallets += Number(row.palletCount || 0); acc.weight += Number(row.grossWeight || 0); acc.volume += Number(row.deliveryVolume || 0); return acc; }, { pallets: 0, weight: 0, volume: 0 });
  const hint = document.getElementById('lg-selection-hint');
  if (hint) hint.textContent = rows.length ? `${rows.length} selected - ${totals.pallets} pallets - ${totals.weight.toFixed(3)} weight - ${totals.volume.toFixed(3)} volume` : 'Select deliveries for one customer, then create a shipment.';
  const msg = document.getElementById('lg-selection-msg'); if (msg && !rows.length) msg.classList.add('hidden');
  document.querySelectorAll('.lg-row').forEach(row => {
    const differentCustomer = lockedCustomer && row.dataset.customer !== String(lockedCustomer) && !selectedDeliveryIds.has(Number(row.dataset.id));
    row.classList.toggle('lg-row--selected', selectedDeliveryIds.has(Number(row.dataset.id)));
    row.classList.toggle('lg-row--disabled', Boolean(differentCustomer));
    const checkbox = row.querySelector('.lg-check'); if (checkbox) checkbox.disabled = Boolean(differentCustomer);
  });
  const createBtn = document.getElementById('lg-create-btn'); if (createBtn) createBtn.disabled = rows.length === 0;
  const clearBtn = document.getElementById('lg-clear-btn'); if (clearBtn) clearBtn.disabled = rows.length === 0;
}


function getBookingRowsWithInputs() {
  return getSelectedBookingRows().map(row => ({
    shipmentID: row.shipmentID,
    shipmentRef: String(row.shipmentID || '').padStart(8, '0'),
    destinationName: row.destinationName || row.originName || '-',
    plannedCollection: document.getElementById(`booking-date-${row.shipmentID}`)?.value || '',
    trackingNumber: document.getElementById(`booking-track-${row.shipmentID}`)?.value.trim() || '',
    forwarderID: document.getElementById(`booking-forwarder-${row.shipmentID}`)?.value || row.forwarderID || '',
    forwarderName: document.getElementById(`booking-forwarder-${row.shipmentID}`)?.selectedOptions?.[0]?.textContent?.trim() || row.forwarderName || '',
  }));
}


async function openBookingModal(rows, haulier) {
  const isCustomerCollect = isCustomerCollectHaulier(haulier);
  const isKn = isKnHaulier(haulier);
  const needsForwarderChoice = rows.some(row => !row.forwarderID || !hasAssignedHaulier(row));
  const forwarders = needsForwarderChoice ? await loadApprovedForwarders() : [];
  const title = isCustomerCollect ? 'Customer Collect Booking' : isKn ? 'Kuehne & Nagel Booking' : `Book ${haulier || 'Shipment'}`;
  const subtitle = isCustomerCollect
    ? 'Optional tracking and collection dates. Emails will be sent before booking is confirmed.'
    : isKn
      ? 'Confirm the collection dates, send the shipments to the KN API, then mark them as booked.'
      : 'Confirm the tracking number for each shipment, and update collection dates if needed.';
  const actionLabel = isCustomerCollect ? 'Send Email and Book' : isKn ? 'Send via API and Book' : 'Book';
  const rowsHtml = rows.map(row => {
    const shipmentRef = String(row.shipmentID || '').padStart(8, '0');
    const plannedDate = getShipmentPlannedDate(row, 'in-transit');
    const forwarderField = row.forwarderID && hasAssignedHaulier(row)
      ? `${esc(row.forwarderName || '')}`
      : `<select class="tf-input booking-inline-input" id="booking-forwarder-${esc(String(row.shipmentID))}"><option value="">Select haulier</option>${forwarders.map(item => `<option value="${esc(String(item.forwarderID))}">${esc(item.forwarderName || '')}</option>`).join('')}</select>`;
    return `<tr><td>${esc(shipmentRef)}</td><td>${esc(row.destinationName || row.originName || '-')}</td><td>${forwarderField}</td><td><input class="tf-input booking-inline-input" type="date" id="booking-date-${esc(String(row.shipmentID))}" value="${esc(plannedDate ? new Date(plannedDate).toISOString().slice(0, 10) : '')}"></td><td><input class="tf-input booking-inline-input" type="text" id="booking-track-${esc(String(row.shipmentID))}" value="${esc(row.trackingNumber || '')}"></td></tr>`;
  }).join('');
  const trackingHelp = isCustomerCollect
    ? 'Tracking number is optional for customer collect shipments.'
    : isKn
      ? 'Tracking will be taken from the Kuehne & Nagel API response where available.'
      : 'Tracking number is required for each shipment before booking can be confirmed.';
  openModal(`<div class="ps-modal lg-modal"><div class="ps-modal-header"><div><div class="ps-modal-title">${esc(title)}</div><div class="ps-modal-sub">${esc(haulier || 'Unassigned Haulier')} - ${rows.length} shipment(s)</div></div><button class="ps-modal-close" onclick="closePickModal()">x</button></div><div class="ps-modal-body"><div class="toolbar-hint">${esc(subtitle)}</div><table class="ps-table booking-modal-table"><thead><tr><th>Shipment</th><th>Destination</th><th>Haulier</th><th>Planned Collection</th><th>Tracking Number</th></tr></thead><tbody>${rowsHtml}</tbody></table><div class="toolbar-hint booking-help">${esc(trackingHelp)}</div><div id="booking-submit-result"></div></div><div class="ps-modal-actions"><button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button><button type="button" class="btn-submit" id="booking-submit-btn">${esc(actionLabel)}</button></div></div>`);
  document.getElementById('booking-submit-btn').addEventListener('click', submitBookingModal);
}


async function submitBookingModal() {
  const button = document.getElementById('booking-submit-btn');
  const result = document.getElementById('booking-submit-result');
  const updates = getBookingRowsWithInputs();
  button.disabled = true;
  button.textContent = 'Working...';
  result.innerHTML = '';
  try {
    const missingForwarder = updates.find(item => !item.forwarderID);
    if (missingForwarder) throw new Error(`Haulier is required for shipment ${missingForwarder.shipmentRef}.`);
    const successfulUpdates = [];
    const failedRefs = [];

    for (const item of updates) {
      try {
        if (isKnHaulier(item.forwarderName)) {
          if (!item.plannedCollection) throw new Error('Planned collection date is required.');
          const response = await fetch(`/api/freight-booking/shipment/${encodeURIComponent(item.shipmentID)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plannedCollection: item.plannedCollection }),
          });
          const json = await response.json();
          if (!response.ok) throw new Error(json.error || 'Failed to send to Kuehne & Nagel.');
          item.trackingNumber = String(json.trackingNumber || item.trackingNumber || '').trim();
        } else if (isCustomerCollectHaulier(item.forwarderName)) {
          const response = await fetch(`/api/shipmentmain/${encodeURIComponent(item.shipmentID)}/send-collection-email`, { method: 'POST' });
          const json = await response.json();
          if (!response.ok || !json.success) throw new Error(json.error || 'Failed to send collection email.');
        } else {
          if (!item.trackingNumber) throw new Error('Tracking number is required.');
        }
        successfulUpdates.push(item);
      } catch (err) {
        failedRefs.push(`${item.shipmentRef}: ${err.message}`);
      }
    }

    if (!successfulUpdates.length) {
      throw new Error(`No shipments were booked. ${failedRefs.join(' | ')}`);
    }

    const res = await fetch('/api/shipmentmain/mark-booked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shipments: successfulUpdates.map(item => ({
          shipmentID: item.shipmentID,
          plannedCollection: item.plannedCollection || null,
          trackingNumber: item.trackingNumber || '',
          forwarderID: item.forwarderID || null,
        })),
      }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to mark shipments as booked.');
    await runShipmentBooking();
    if (failedRefs.length) {
      result.innerHTML = `<div class="sap-error tf-inline-error">Booked ${successfulUpdates.length} shipment(s). These failed: ${esc(failedRefs.join(' | '))}</div>`;
      button.disabled = false;
      button.textContent = 'Book';
      return;
    }
    closePickModal();
  } catch (err) {
    result.innerHTML = `<div class="sap-error tf-inline-error">${esc(err.message)}</div>`;
    button.disabled = false;
    button.textContent = 'Book';
  }
}


function buildShipmentDraft() {
  const rows = getSelectedRows();
  const first = rows[0];
  return rows.reduce((draft, row) => {
    draft.palletCount += Number(row.palletCount || 0);
    draft.grossWeight += Number(row.grossWeight || 0);
    draft.shipmentVolume += Number(row.deliveryVolume || 0);
    return draft;
  }, {
    destinationName: first.destinationName || '', destinationStreet: first.destinationStreet || '',
    destinationCity: first.destinationCity || '', destinationPostCode: first.destinationPostCode || '',
    destinationCountry: first.destinationCountry || '', incoTerms: first.defaultIncoterms || '',
    plannedCollection: new Date().toISOString().slice(0, 10),
    deliveryService: first.deliveryService || '',  // carried through to pre-select forwarder mode
    palletCount: 0, grossWeight: 0, shipmentVolume: 0,
  });
}
function openModal(html) {
  const overlay = document.getElementById('ps-modal-overlay');
  overlay.innerHTML = html; overlay.classList.remove('hidden');
}
function closePickModal() { const overlay = document.getElementById('ps-modal-overlay'); overlay.classList.add('hidden'); overlay.innerHTML = ''; }


function onShipmentForwarderModeChange() {
  const modeSelect = document.getElementById('lg-forwarder-mode');
  const nameSelect = document.getElementById('lg-forwarder-name');
  if (!modeSelect || !nameSelect) return;
  const selectedMode = modeSelect.value;
  const matches = (allForwarders || []).filter(item => String(item.forwarderMode || '').trim() === selectedMode);
  const uniqueForwarders = matches.filter((item, index, arr) => arr.findIndex(other => String(other.forwarderName || '').trim() === String(item.forwarderName || '').trim()) === index);
  nameSelect.innerHTML = `<option value="">Select forwarder</option>${uniqueForwarders.map(item => `<option value="${esc(String(item.forwarderID))}">${esc(String(item.forwarderName || '').trim())}</option>`).join('')}`;
  nameSelect.disabled = !selectedMode;
}


async function openShipmentModal() {
  if (!await checkSession()) return;
  const rows = getSelectedRows(); if (!rows.length) return;
  const draft = buildShipmentDraft();
  const forwarders = await loadAllForwarders();
  const modeOptions = [...new Set(forwarders.map(item => String(item.forwarderMode || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  openModal(`<div class="ps-modal lg-modal"><div class="ps-modal-header"><div><div class="ps-modal-title">Create Shipment</div><div class="ps-modal-sub">${esc(rows[0].destinationName || '')} - ${rows.length} deliveries</div></div><button class="ps-modal-close" onclick="closePickModal()">x</button></div><div class="ps-modal-body"><form id="lg-shipment-form" class="transfer-form"><div class="tf-section-label">Shipment Header</div><div class="tf-row"><div class="tf-field"><label class="tf-label">Planned Collection</label><input class="tf-input" type="date" id="lg-planned" value="${esc(draft.plannedCollection)}"></div><div class="tf-field"><label class="tf-label">Forwarder Mode</label><select class="tf-input" id="lg-forwarder-mode"><option value="">Select mode</option>${modeOptions.map(mode => `<option value="${esc(mode)}">${esc(mode)}</option>`).join('')}</select></div><div class="tf-field"><label class="tf-label">Forwarder Name</label><select class="tf-input" id="lg-forwarder-name" disabled><option value="">Select forwarder</option></select></div><div class="tf-field"><label class="tf-label">Incoterms</label><input class="tf-input" type="text" id="lg-incoterms" value="${esc(draft.incoTerms)}"></div></div><div class="tf-row"><div class="tf-field tf-field--wide"><label class="tf-label">Destination Name</label><input class="tf-input" type="text" id="lg-dest-name" value="${esc(draft.destinationName)}"></div><div class="tf-field tf-field--wide"><label class="tf-label">Destination Street</label><input class="tf-input" type="text" id="lg-dest-street" value="${esc(draft.destinationStreet)}"></div></div><div class="tf-row"><div class="tf-field"><label class="tf-label">City</label><input class="tf-input" type="text" id="lg-dest-city" value="${esc(draft.destinationCity)}"></div><div class="tf-field"><label class="tf-label">Post Code</label><input class="tf-input" type="text" id="lg-dest-postcode" value="${esc(draft.destinationPostCode)}"></div><div class="tf-field"><label class="tf-label">Country</label><input class="tf-input" type="text" id="lg-dest-country" value="${esc(draft.destinationCountry)}"></div></div><div class="tf-row"><label class="lg-flag"><input type="checkbox" id="lg-customs-required"> Customs Required</label><label class="lg-flag"><input type="checkbox" id="lg-customs-complete"> Customs Complete</label></div><div class="tf-section-label">Calculated Totals <span class="tf-locked">Read only</span></div><div class="tf-row"><div class="tf-field"><label class="tf-label">Pallet Count</label><input class="tf-input" readonly value="${esc(draft.palletCount.toFixed(3))}"></div><div class="tf-field"><label class="tf-label">Gross Weight</label><input class="tf-input" readonly value="${esc(draft.grossWeight.toFixed(3))}"></div><div class="tf-field"><label class="tf-label">Volume</label><input class="tf-input" readonly value="${esc(draft.shipmentVolume.toFixed(3))}"></div></div><div id="lg-submit-result"></div></form></div><div class="ps-modal-actions"><button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button><button type="button" class="btn-submit" id="lg-confirm-btn">Confirm Shipment</button></div></div>`);
  document.getElementById('lg-forwarder-mode').addEventListener('change', onShipmentForwarderModeChange);
  document.getElementById('lg-confirm-btn').addEventListener('click', submitShipmentCreate);

  // Pre-select forwarder mode from deliveryService — exact match then case-insensitive
  const svc = draft.deliveryService.trim();
  if (svc) {
    const modeEl = document.getElementById('lg-forwarder-mode');
    const match  = modeOptions.find(m => m === svc)
                || modeOptions.find(m => m.toLowerCase() === svc.toLowerCase());
    if (match) {
      modeEl.value = match;
      onShipmentForwarderModeChange();  // populate forwarder name dropdown immediately
    }
  }
}
async function submitShipmentCreate() {
  const button = document.getElementById('lg-confirm-btn');
  const result = document.getElementById('lg-submit-result');
  button.disabled = true; button.textContent = 'Creating...'; result.innerHTML = '';
  try {
    const payload = { deliveryIDs: [...selectedDeliveryIds], plannedCollection: document.getElementById('lg-planned').value || null, forwarderID: document.getElementById('lg-forwarder-name').value || null, incoTerms: document.getElementById('lg-incoterms').value.trim(), destinationName: document.getElementById('lg-dest-name').value.trim(), destinationStreet: document.getElementById('lg-dest-street').value.trim(), destinationCity: document.getElementById('lg-dest-city').value.trim(), destinationPostCode: document.getElementById('lg-dest-postcode').value.trim(), destinationCountry: document.getElementById('lg-dest-country').value.trim(), customsRequired: document.getElementById('lg-customs-required').checked, customsComplete: document.getElementById('lg-customs-complete').checked };
    const res = await fetch('/api/shipmentmain/create-from-deliveries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const json = await res.json(); if (!json.success) throw new Error(json.error || 'Failed to create shipment');
    latestShipment = json.data; closePickModal(); await runOpenDeliveries(); showPostCreateModal(json.data);
  } catch (err) {
    result.innerHTML = `<div class="sap-error tf-inline-error">${esc(err.message)}</div>`;
    button.disabled = false; button.textContent = 'Confirm Shipment';
  }
}
function showPostCreateModal(data) {
  openModal(`<div class="ps-modal lg-modal"><div class="ps-modal-header"><div><div class="ps-modal-title">Shipment ${esc(data.shipmentRef)}</div><div class="ps-modal-sub">Shipment created successfully</div></div><button class="ps-modal-close" onclick="closePickModal()">x</button></div><div class="ps-modal-body"><div class="lg-post-grid"><div class="lg-post-card"><div class="lg-post-title">Folder</div><div class="toolbar-hint" id="lg-folder-result">${esc(data.folderPath || '')}</div><button class="btn-secondary lg-post-btn" id="lg-folder-btn">Create Folder</button></div><div class="lg-post-card"><div class="lg-post-title">Packing List</div><div class="toolbar-hint" id="lg-doc-result">Generate shipment and delivery PDFs.</div><button class="btn-secondary lg-post-btn" id="lg-doc-btn">Create Packing List</button><div id="lg-doc-links" class="lg-doc-links"></div></div><div class="lg-post-card${data.canSendEmail ? '' : ' lg-post-card--muted'}"><div class="lg-post-title">Collection Email</div><div class="toolbar-hint" id="lg-email-result">${data.canSendEmail ? 'Send Ex Works collection email with attachments.' : 'Available only for Ex Works shipments.'}</div><button class="btn-secondary lg-post-btn" id="lg-email-btn" ${data.canSendEmail ? '' : 'disabled'}>Send Email</button></div></div></div><div class="ps-modal-actions"><button type="button" class="btn-submit" onclick="closePickModal()">Done</button></div></div>`);
  document.getElementById('lg-folder-btn').addEventListener('click', () => runShipmentAction('create-folder', 'lg-folder-result'));
  document.getElementById('lg-doc-btn').addEventListener('click', () => runShipmentAction('generate-packing-list', 'lg-doc-result', true));
  if (data.canSendEmail) document.getElementById('lg-email-btn').addEventListener('click', () => runShipmentAction('send-collection-email', 'lg-email-result'));
}
async function runShipmentAction(action, resultId, showLinks = false) {
  const result = document.getElementById(resultId); if (!latestShipment?.shipmentID) return;
  result.textContent = 'Working...';
  try {
    const res = await fetch(`/api/shipmentmain/${encodeURIComponent(latestShipment.shipmentID)}/${action}`, { method: 'POST' });
    const json = await res.json(); if (!json.success) throw new Error(json.error || 'Action failed');
    if (action === 'create-folder') result.textContent = json.data.folderPath;
    if (action === 'send-collection-email') result.textContent = `Sent to ${json.data.sentTo}`;
    if (showLinks) { result.textContent = json.data.folderPath; document.getElementById('lg-doc-links').innerHTML = (json.data.files || []).map(file => `<a class="lg-doc-link" target="_blank" href="${esc(file.downloadUrl)}">${esc(file.fileName)}</a>`).join(''); }
  } catch (err) { result.textContent = err.message; }
}
async function showPickedPallets(deliveryId, destName) {
  if (!await checkSession()) return;
  openModal(`<div class="ps-modal"><div class="ps-modal-header"><div><div class="ps-modal-title">Picked Pallets</div><div class="ps-modal-sub">Delivery #${esc(deliveryId)} - ${esc(destName)}</div></div><button class="ps-modal-close" onclick="closePickModal()">x</button></div><div class="ps-modal-body"><div class="sap-loading"><div class="spinner"></div>Fetching pallets...</div></div><div class="ps-modal-actions"><button class="btn-submit" onclick="closePickModal()">Close</button></div></div>`);
  try {
    const res = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/pallets`); const json = await res.json(); if (!json.success) throw new Error(json.error || 'Failed to load pallets');
    const body = document.querySelector('#ps-modal-overlay .ps-modal-body'); const pallets = json.data || [];
    if (!pallets.length) { body.innerHTML = '<div class="sap-error" style="padding:24px">No pallets picked for this delivery yet.</div>'; return; }
    body.innerHTML = `<table class="ps-pallet-table"><thead><tr><th>Type</th><th>Finished</th><th>Length</th><th>Width</th><th>Height</th><th>Gross Wt.</th><th>Location</th></tr></thead><tbody>${pallets.map(p => `<tr><td>${esc(p.palletType || '')}</td><td>${p.palletFinish ? 'Yes' : 'No'}</td><td>${esc(String(p.palletLength || ''))}</td><td>${esc(String(p.palletWidth || ''))}</td><td>${esc(String(p.palletHeight || ''))}</td><td>${esc(String(p.grossWeight || ''))}</td><td>${esc(p.palletLocation || '')}</td></tr>`).join('')}</tbody></table>`;
  } catch (err) {
    document.querySelector('#ps-modal-overlay .ps-modal-body').innerHTML = `<div class="sap-error" style="padding:24px">${esc(err.message)}</div>`;
  }
}
// ── Awaiting Collection — grouped/sorted renderer ─────────────────────────────

function renderAwaitingCollection() {
  const grouped = shipmentRows.reduce((acc, row) => {
    const key = row.forwarderName || 'Unassigned';
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  const sections = Object.keys(grouped).sort((a, b) => a.localeCompare(b)).map(name => {
    const rows = grouped[name]
      .slice()
      .sort((a, b) => {
        const aD = new Date(a.plannedCollection || 0).getTime();
        const bD = new Date(b.plannedCollection || 0).getTime();
        return aD - bD || Number(a.shipmentID || 0) - Number(b.shipmentID || 0);
      })
      .map(row => {
        const ref  = String(row.shipmentID || '').padStart(8, '0');
        const date = row.plannedCollection ? new Date(row.plannedCollection).toLocaleDateString('en-GB') : '—';
        return `<tr class="ps-row collection-row" data-id="${esc(String(row.shipmentID))}" data-haulier="${esc(name)}">
          <td class="lg-check-cell"><input type="checkbox" class="collection-check" data-id="${esc(String(row.shipmentID))}"></td>
          <td>${esc(ref)}</td>
          <td>${esc(date)}</td>
          <td>${esc(row.trackingNumber || '')}</td>
          <td>${esc(row.destinationName || '—')}</td>
        </tr>`;
      }).join('');

    return `<div class="ps-section"><div class="ps-section-header"><span class="ps-section-dot ps-section-dot--today"></span><span class="ps-section-title">${esc(name)}</span><span class="ps-section-count">${grouped[name].length}</span><span class="ps-chevron">v</span></div><div class="ps-section-body"><table class="ps-table"><thead><tr><th></th><th>Shipment</th><th>Planned Collection</th><th>Tracking</th><th>Destination</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }).join('');

  document.getElementById('result-body').innerHTML = `
    <div class="lg-actions">
      <div><div class="lg-selection-title">Awaiting Collection</div>
      <div class="toolbar-hint" id="collection-hint">Select shipments, then use the actions below.</div></div>
      <div class="toolbar-spacer"></div>
      <button class="btn-secondary" id="col-clear-btn"    disabled>Clear</button>
      <button class="btn-secondary" id="col-date-btn"     disabled>Update Date</button>
      <button class="btn-secondary" id="col-loading-btn"  disabled>Loading List</button>
      <button class="btn-submit"    id="col-collect-btn"  disabled>Mark Collected</button>
    </div>
    <div id="collection-msg" class="lg-selection-msg hidden"></div>
    <div class="ps-sections">${sections}</div>`;

  bindAwaitingCollectionEvents();
}

function bindAwaitingCollectionEvents() {
  document.querySelectorAll('.ps-section-header').forEach(h => h.addEventListener('click', () => h.closest('.ps-section').classList.toggle('ps-section--collapsed')));
  document.querySelectorAll('.collection-check').forEach(cb => cb.addEventListener('change', onCollectionToggle));
  document.getElementById('col-clear-btn').addEventListener('click',   clearCollectionSelection);
  document.getElementById('col-date-btn').addEventListener('click',    openUpdateCollectionDateModal);
  document.getElementById('col-loading-btn').addEventListener('click', downloadLoadingList);
  document.getElementById('col-collect-btn').addEventListener('click', markCollectedBulk);
}

function onCollectionToggle(e) {
  const id = Number(e.target.dataset.id);
  if (e.target.checked) selectedCollectionIds.add(id); else selectedCollectionIds.delete(id);
  updateCollectionUI();
}

function clearCollectionSelection() {
  selectedCollectionIds = new Set();
  document.querySelectorAll('.collection-check').forEach(cb => { cb.checked = false; });
  updateCollectionUI();
}

function getSelectedCollectionRows() {
  return shipmentRows.filter(r => selectedCollectionIds.has(Number(r.shipmentID)));
}

function collectionHauliersMixed(rows) {
  return new Set(rows.map(r => String(r.forwarderID || r.forwarderName || 'unassigned'))).size > 1;
}

function updateCollectionUI() {
  const count   = selectedCollectionIds.size;
  const hint    = document.getElementById('collection-hint');
  const msg     = document.getElementById('collection-msg');
  if (hint) hint.textContent = count ? `${count} shipment(s) selected.` : 'Select shipments, then use the actions below.';
  if (msg && !count) msg.classList.add('hidden');
  ['col-clear-btn', 'col-date-btn', 'col-loading-btn', 'col-collect-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = count === 0;
  });
}

function showCollectionMsg(text, isError = true) {
  const msg = document.getElementById('collection-msg');
  if (!msg) return;
  msg.textContent = text;
  msg.className = `lg-selection-msg${isError ? '' : ' lg-selection-msg--success'}`;
  msg.classList.remove('hidden');
}

async function downloadLoadingList() {
  const ids = [...selectedCollectionIds];
  if (!ids.length) return;
  try {
    showCollectionMsg('Generating loading list…', false);
    const res = await fetch('/api/shipmentmain/loading-list', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shipmentIDs: ids }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error || 'Failed to generate loading list');
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `loading-list-${new Date().toISOString().slice(0, 10)}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    showCollectionMsg('Loading list downloaded.', false);
  } catch (err) { showCollectionMsg(err.message); }
}

function openUpdateCollectionDateModal() {
  const ids = [...selectedCollectionIds];
  if (!ids.length) return;
  openModal(`<div class="ps-modal" style="max-width:400px">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Update Planned Collection</div><div class="ps-modal-sub">${ids.length} shipment(s)</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-field"><label class="tf-label">New Planned Collection Date</label>
        <input class="tf-input" type="date" id="col-new-date" value="${new Date().toISOString().slice(0, 10)}">
      </div>
      <div id="col-date-result" style="margin-top:8px;font-size:13px;color:var(--error)"></div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button class="btn-submit" id="col-date-submit">Update</button>
    </div>
  </div>`);
  document.getElementById('col-date-submit').addEventListener('click', () => submitUpdateCollectionDate(ids));
}

async function submitUpdateCollectionDate(ids) {
  const date   = document.getElementById('col-new-date').value;
  const result = document.getElementById('col-date-result');
  const btn    = document.getElementById('col-date-submit');
  if (!date) { result.textContent = 'Please select a date.'; return; }
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/shipmentmain/update-planned-collection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shipmentIDs: ids, date }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to update date');
    closePickModal();
    await runShipmentQueue('awaiting-collection');
  } catch (err) {
    result.textContent = err.message;
    btn.disabled = false; btn.textContent = 'Update';
  }
}

function markCollectedBulk() {
  const rows = getSelectedCollectionRows();
  if (!rows.length) return;

  const mixed = collectionHauliersMixed(rows);
  const now   = new Date().toLocaleString('en-GB');

  openModal(`<div class="ps-modal">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Mark as Collected</div>
      <div class="ps-modal-sub">${rows.length} shipment(s)${mixed ? ' — <span style="color:#b45309">multiple hauliers selected</span>' : ''}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      ${mixed ? `<div class="lg-selection-msg lg-selection-msg--warning" style="margin-bottom:16px">These shipments are assigned to different hauliers. Please confirm they are being collected together on the same vehicle.</div>` : ''}
      <div class="transfer-form">
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Operator Name</label><input class="tf-input" id="cl-operator" type="text" placeholder="e.g. Jim Smith"></div>
          <div class="tf-field"><label class="tf-label">Driver Name</label><input class="tf-input" id="cl-driver" type="text" placeholder="e.g. Dave Jones"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Vehicle Registration</label><input class="tf-input" id="cl-reg" type="text" placeholder="e.g. AB12 CDE"></div>
          <div class="tf-field"><label class="tf-label">Trailer Number</label><input class="tf-input" id="cl-trailer" type="text" placeholder="e.g. TRL-456"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide"><label class="tf-label">Timestamp (auto)</label><input class="tf-input" value="${esc(now)}" readonly></div>
        </div>
        <div id="cl-result" style="margin-top:8px;font-size:13px;color:var(--error)"></div>
      </div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button class="btn-submit" id="cl-submit-btn">${mixed ? 'Confirm (Mixed Hauliers)' : 'Confirm'}</button>
    </div>
  </div>`);

  document.getElementById('cl-submit-btn').addEventListener('click', () => submitMarkCollected(rows, mixed));
}

async function submitMarkCollected(rows, mixed) {
  const operator = document.getElementById('cl-operator').value.trim();
  const driver   = document.getElementById('cl-driver').value.trim();
  const reg      = document.getElementById('cl-reg').value.trim();
  const trailer  = document.getElementById('cl-trailer').value.trim();
  const result   = document.getElementById('cl-result');
  const btn      = document.getElementById('cl-submit-btn');

  if (!operator) { result.textContent = 'Operator name is required.'; return; }

  const description = [
    `operator=${operator}`,
    driver  ? `driver=${driver}`   : null,
    reg     ? `reg=${reg}`         : null,
    trailer ? `trailer=${trailer}` : null,
  ].filter(Boolean).join(' | ');

  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    // Write WARNING events first if mixed hauliers
    if (mixed) {
      const haulierNames = [...new Set(rows.map(r => r.forwarderName || 'Unassigned'))].join(', ');
      await fetch('/api/shipmentmain/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: rows.map(r => ({
          shipmentID:  r.shipmentID,
          category:    'WARNING',
          description: `Multi-haulier collection confirmed. Hauliers: ${haulierNames}`,
        })) }),
      });
    }

    const res = await fetch('/api/shipmentmain/mark-collected-bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipmentIDs: rows.map(r => r.shipmentID), description }),
    });
    const json = await res.json();
    if (!json.success && !json.data?.completed?.length) throw new Error(json.error || 'Failed to mark as collected');
    const { completed = [], failed = [] } = json.data || {};
    closePickModal();
    showCollectionMsg(
      [completed.length ? `${completed.length} shipment(s) marked as collected.` : '',
       failed.length    ? `${failed.length} failed: ${failed.map(f => f.error).join('; ')}` : ''].filter(Boolean).join(' '),
      failed.length === 0
    );
    await runShipmentQueue('awaiting-collection');
  } catch (err) {
    result.textContent = err.message;
    btn.disabled = false; btn.textContent = mixed ? 'Confirm (Mixed Hauliers)' : 'Confirm';
  }
}


// ── Shipment detail modal ─────────────────────────────────────────────────────

async function openShipmentDetailModal(shipmentId) {
  openModal(`<div class="ps-modal"><div class="ps-modal-header"><div><div class="ps-modal-title">Shipment Details</div></div><button class="ps-modal-close" onclick="closePickModal()">×</button></div><div class="ps-modal-body"><div class="sap-loading"><div class="spinner"></div>Loading...</div></div><div class="ps-modal-actions"><button class="btn-secondary" onclick="closePickModal()">Close</button></div></div>`);
  try {
    const res = await fetch(`/api/shipmentmain/${encodeURIComponent(shipmentId)}/details`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load shipment details');
    renderShipmentDetailModal(json.data.shipment, json.data.deliveries);
  } catch (err) {
    document.querySelector('#ps-modal-overlay .ps-modal-body').innerHTML = `<div class="sap-error" style="padding:24px">${esc(err.message)}</div>`;
  }
}

function renderShipmentDetailModal(shipment, deliveries) {
  const shipmentRef = String(shipment.shipmentID || '').padStart(8, '0');
  const incoNorm = (shipment.incoTerms || '').toUpperCase().replace(/\s/g, '');
  const isExWorks = incoNorm === 'EXW' || incoNorm === 'EXWORKS';
  const customsComplete = Boolean(shipment.customsComplete);
  const customsRequired = Boolean(shipment.customsRequired);

  let badgeClass, badgeText, toggleHtml;
  if (customsComplete) {
    badgeClass = 'sd-badge--complete'; badgeText = 'Complete'; toggleHtml = '';
  } else if (customsRequired) {
    badgeClass = 'sd-badge--required'; badgeText = 'Required';
    toggleHtml = `<button class="btn-secondary" id="sd-customs-toggle" data-target="false">Set Not Required</button>`;
  } else {
    badgeClass = 'sd-badge--none'; badgeText = 'Not Required';
    toggleHtml = `<button class="btn-secondary" id="sd-customs-toggle" data-target="true">Set Required</button>`;
  }

  const plannedRaw = shipment.plannedCollection || shipment.plannedDelivery;
  const plannedStr = plannedRaw ? new Date(plannedRaw).toLocaleDateString('en-GB') : '—';

  document.querySelector('#ps-modal-overlay').innerHTML = `<div class="ps-modal">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Shipment ${esc(shipmentRef)}</div><div class="ps-modal-sub">${esc(shipment.destinationName || '')} — ${esc(shipment.incoTerms || '')}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="sd-grid">
        <div class="sd-section">
          <div class="sd-section-title">Details</div>
          <table style="font-size:13px;width:100%;border-collapse:collapse">
            <tr><td style="padding:4px 0;color:var(--text-muted);width:110px">Destination</td><td>${esc(shipment.destinationName || '—')}</td></tr>
            <tr><td style="padding:4px 0;color:var(--text-muted)">Planned Date</td><td>${esc(plannedStr)}</td></tr>
            <tr><td style="padding:4px 0;color:var(--text-muted)">Incoterms</td><td>${esc(shipment.incoTerms || '—')}</td></tr>
            <tr><td style="padding:4px 0;color:var(--text-muted)">Gross Weight</td><td>${esc(String(shipment.grossWeight ?? '—'))} kg</td></tr>
            <tr><td style="padding:4px 0;color:var(--text-muted)">Net Weight</td><td>${esc(String(shipment.netWeight ?? '—'))} kg</td></tr>
            <tr><td style="padding:4px 0;color:var(--text-muted)">Pallets</td><td>${esc(String(shipment.palletCount ?? '—'))}</td></tr>
          </table>
        </div>
        <div class="sd-section">
          <div class="sd-section-title">Customs</div>
          <div class="sd-customs-row">
            <span class="sd-badge ${esc(badgeClass)}">${esc(badgeText)}</span>
            ${toggleHtml}
            <span id="sd-customs-result" style="font-size:12px;color:var(--error)"></span>
          </div>
          ${shipment.customsID ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">ID: ${esc(String(shipment.customsID))}</div>` : ''}
        </div>
      </div>
      <div class="sd-section" style="margin-bottom:16px">
        <div class="sd-section-title">Haulier</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Current: <strong>${esc(shipment.forwarderName || 'Unassigned')}</strong></div>
        <div class="sd-haulier-row">
          <select class="tf-input" id="sd-forwarder-select"><option value="">Loading…</option></select>
          <button class="btn-secondary" id="sd-forwarder-save">Save</button>
          <span id="sd-forwarder-result" style="font-size:12px;color:var(--text-muted)"></span>
        </div>
      </div>
      <div class="sd-section">
        <div class="sd-section-title">Actions</div>
        <div class="sd-actions">
          <button class="btn-secondary" id="sd-packing-list-btn">Recreate Packing List</button>
          <div id="sd-packing-list-result" style="font-size:12px;color:var(--text-muted)"></div>
          ${isExWorks ? `<button class="btn-secondary" id="sd-email-btn">Resend Collection Email</button><div id="sd-email-result" style="font-size:12px;color:var(--text-muted)"></div>` : ''}
          <button class="btn-submit" id="sd-deliveries-btn">Modify Deliveries →</button>
        </div>
      </div>
    </div>
    <div class="ps-modal-actions"><button class="btn-secondary" onclick="closePickModal()">Close</button></div>
  </div>`;

  // Load hauliers
  loadApprovedForwarders().then(forwarders => {
    const sel = document.getElementById('sd-forwarder-select');
    if (!sel) return;
    sel.innerHTML = `<option value="">Select haulier…</option>` +
      forwarders.map(f => `<option value="${esc(String(f.forwarderID))}" ${String(f.forwarderID) === String(shipment.forwarderID) ? 'selected' : ''}>${esc(f.forwarderName || '')}</option>`).join('');
  });

  // Customs toggle
  const customsToggleBtn = document.getElementById('sd-customs-toggle');
  if (customsToggleBtn) {
    customsToggleBtn.addEventListener('click', async () => {
      const target = customsToggleBtn.dataset.target === 'true';
      const result = document.getElementById('sd-customs-result');
      customsToggleBtn.disabled = true;
      try {
        const res = await fetch(`/api/shipmentmain/${encodeURIComponent(shipment.shipmentID)}/customs-required`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ required: target }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Failed');
        const fresh = await fetch(`/api/shipmentmain/${encodeURIComponent(shipment.shipmentID)}/details`);
        const freshJson = await fresh.json();
        if (freshJson.success) renderShipmentDetailModal(freshJson.data.shipment, freshJson.data.deliveries);
      } catch (err) {
        if (result) result.textContent = err.message;
        customsToggleBtn.disabled = false;
      }
    });
  }

  // Haulier save
  document.getElementById('sd-forwarder-save').addEventListener('click', async () => {
    const sel = document.getElementById('sd-forwarder-select');
    const result = document.getElementById('sd-forwarder-result');
    result.textContent = 'Saving…';
    try {
      const res = await fetch(`/api/shipmentmain/${encodeURIComponent(shipment.shipmentID)}/forwarder`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ forwarderID: sel.value || null }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed');
      result.textContent = 'Saved.';
      runShipmentBooking();
    } catch (err) { result.textContent = err.message; }
  });

  // Packing list
  document.getElementById('sd-packing-list-btn').addEventListener('click', async () => {
    if (!window.confirm('This will overwrite any existing packing list files for this shipment. Continue?')) return;
    const result = document.getElementById('sd-packing-list-result');
    result.textContent = 'Generating…';
    try {
      const res = await fetch(`/api/shipmentmain/${encodeURIComponent(shipment.shipmentID)}/generate-packing-list`, { method: 'POST' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed');
      result.innerHTML = (json.data.files || []).map(f => `<a class="lg-doc-link" target="_blank" href="${esc(f.downloadUrl)}">${esc(f.fileName)}</a>`).join(' ');
    } catch (err) { result.textContent = err.message; }
  });

  // Resend email
  const emailBtn = document.getElementById('sd-email-btn');
  if (emailBtn) {
    emailBtn.addEventListener('click', async () => {
      const result = document.getElementById('sd-email-result');
      result.textContent = 'Sending…';
      try {
        const res = await fetch(`/api/shipmentmain/${encodeURIComponent(shipment.shipmentID)}/send-collection-email`, { method: 'POST' });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Failed');
        result.textContent = `Sent to ${json.data.sentTo}`;
      } catch (err) { result.textContent = err.message; }
    });
  }

  // Modify deliveries → wide panel
  document.getElementById('sd-deliveries-btn').addEventListener('click', () => {
    openShipmentDeliveriesPanel(shipment.shipmentID, shipment, deliveries);
  });
}


// ── Shipment deliveries wide panel ────────────────────────────────────────────

async function openShipmentDeliveriesPanel(shipmentId, shipment, deliveries) {
  renderShipmentDeliveriesPanel(shipmentId, shipment, deliveries, [], false);
  try {
    const res = await fetch(`/api/deliverymain/available-for-shipment/${encodeURIComponent(shipment.destinationID)}`);
    const json = await res.json();
    renderShipmentDeliveriesPanel(shipmentId, shipment, deliveries, json.success ? (json.data || []) : [], true);
  } catch (err) {
    renderShipmentDeliveriesPanel(shipmentId, shipment, deliveries, [], true, err.message);
  }
}

function renderShipmentDeliveriesPanel(shipmentId, shipment, deliveries, available, loaded, availError) {
  const shipmentRef = String(shipmentId).padStart(8, '0');
  const customsComplete = Boolean(shipment.customsComplete);

  const totals = deliveries.reduce((acc, d) => {
    acc.gross   += Number(d.grossWeight    || 0);
    acc.net     += Number(d.netWeight      || 0);
    acc.pallets += Number(d.palletCount    || 0);
    acc.volume  += Number(d.deliveryVolume || 0);
    return acc;
  }, { gross: 0, net: 0, pallets: 0, volume: 0 });

  const linkedRows = deliveries.map(d => `<tr>
    <td>${esc(String(d.deliveryID))}</td>
    <td>${esc(d.destinationName || d.deliveryService || '—')}</td>
    <td>${Number(d.grossWeight    || 0).toFixed(3)}</td>
    <td>${Number(d.netWeight      || 0).toFixed(3)}</td>
    <td>${Number(d.deliveryVolume || 0).toFixed(3)}</td>
    <td>${Number(d.palletCount    || 0).toFixed(0)}</td>
    <td><button class="sd-remove-btn" data-delivery-id="${esc(String(d.deliveryID))}">Remove</button></td>
  </tr>`).join('');

  const totalsRow = `<tr class="sd-totals-row">
    <td colspan="2">Total</td>
    <td>${totals.gross.toFixed(3)}</td><td>${totals.net.toFixed(3)}</td>
    <td>${totals.volume.toFixed(3)}</td><td>${totals.pallets.toFixed(0)}</td><td></td>
  </tr>`;

  const linkedHtml = deliveries.length
    ? `<table class="sd-delivery-table"><thead><tr><th>Delivery</th><th>Destination</th><th>Gross kg</th><th>Net kg</th><th>Vol CBM</th><th>Pallets</th><th></th></tr></thead><tbody>${linkedRows}${totalsRow}</tbody></table>`
    : `<div class="sd-picker-empty">No deliveries linked.</div>`;

  let availHtml;
  if (!loaded) {
    availHtml = `<div class="sap-loading"><div class="spinner"></div>Loading…</div>`;
  } else if (availError) {
    availHtml = `<div class="sap-error">${esc(availError)}</div>`;
  } else if (!available.length) {
    availHtml = `<div class="sd-picker-empty">No available deliveries for this customer.</div>`;
  } else {
    const availRows = available.map(d => `<tr>
      <td class="lg-check-cell"><input type="checkbox" class="sd-avail-check" data-id="${esc(String(d.deliveryID))}"></td>
      <td>${esc(String(d.deliveryID))}</td>
      <td>${esc(d.destinationName || d.deliveryService || '—')}</td>
      <td>${Number(d.grossWeight || 0).toFixed(3)}</td>
      <td>${Number(d.palletCount || 0).toFixed(0)}</td>
    </tr>`).join('');
    availHtml = `<table class="sd-delivery-table">
      <thead><tr><th></th><th>Delivery</th><th>Destination</th><th>Gross kg</th><th>Pallets</th></tr></thead>
      <tbody>${availRows}</tbody>
    </table>
    <div class="sd-picker-actions"><button class="btn-submit" id="sd-add-btn">Add Selected</button></div>
    <div id="sd-add-result" style="font-size:12px;color:var(--error);margin-top:6px"></div>`;
  }

  document.querySelector('#ps-modal-overlay').innerHTML = `<div class="ps-modal ps-modal--wide">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Deliveries — Shipment ${esc(shipmentRef)}</div><div class="ps-modal-sub">${esc(shipment.destinationName || '')}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="sd-wide-grid">
        <div>
          <div class="sd-picker-title">Linked Deliveries</div>
          ${linkedHtml}
          <div id="sd-remove-result" style="font-size:12px;color:var(--error);margin-top:8px"></div>
        </div>
        <div>
          <div class="sd-picker-title">Add Deliveries</div>
          ${availHtml}
        </div>
      </div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" id="sd-back-btn">← Back</button>
      <button class="btn-secondary" onclick="closePickModal()">Close</button>
    </div>
  </div>`;

  document.getElementById('sd-back-btn').addEventListener('click', () => openShipmentDetailModal(shipmentId));

  // Remove buttons
  document.querySelectorAll('.sd-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const deliveryId = btn.dataset.deliveryId;
      const isLast = deliveries.length === 1;
      let msg = isLast
        ? 'This is the last delivery — removing it will cancel the entire shipment. Continue?'
        : 'Remove this delivery from the shipment?';
      if (customsComplete) msg = 'Warning: customs is already complete for this shipment. Removing this delivery may require re-submission.\n\n' + msg;
      if (!window.confirm(msg)) return;
      btn.disabled = true;
      const result = document.getElementById('sd-remove-result');
      try {
        const res = await fetch(`/api/shipmentmain/${encodeURIComponent(shipmentId)}/deliveries/${encodeURIComponent(deliveryId)}`, { method: 'DELETE' });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Failed to remove delivery');
        if (json.data?.cancelled) { closePickModal(); await runShipmentBooking(); return; }
        await refreshDeliveriesPanel(shipmentId);
      } catch (err) {
        if (result) result.textContent = err.message;
        btn.disabled = false;
      }
    });
  });

  // Add button
  const addBtn = document.getElementById('sd-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const selected = [...document.querySelectorAll('.sd-avail-check:checked')].map(cb => Number(cb.dataset.id));
      if (!selected.length) return;
      const result = document.getElementById('sd-add-result');
      addBtn.disabled = true; result.textContent = 'Adding…';
      try {
        const res = await fetch(`/api/shipmentmain/${encodeURIComponent(shipmentId)}/deliveries`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deliveryIDs: selected }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Failed to add deliveries');
        await refreshDeliveriesPanel(shipmentId);
      } catch (err) {
        result.textContent = err.message;
        addBtn.disabled = false;
      }
    });
  }
}

async function refreshDeliveriesPanel(shipmentId) {
  const res = await fetch(`/api/shipmentmain/${encodeURIComponent(shipmentId)}/details`);
  const json = await res.json();
  if (!json.success) return;
  const { shipment, deliveries } = json.data;
  await openShipmentDeliveriesPanel(shipmentId, shipment, deliveries);
  runShipmentBooking();
}


function exportResultCSV() {
  if (!currentResult.length) return;
  const columns = Object.keys(currentResult[0]);
  const lines = [columns.join(','), ...currentResult.map(row => columns.map(c => `"${String(row[c] ?? '').replace(/"/g, '""')}"`).join(','))];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `logistics-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
}
function esc(str) { if (str == null) return ''; return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }


// ── Stub functions for tiles pending full implementation ──────────────────────

async function runCompletedShipments() {
  showResultPanel('Completed Shipments', 'Delivered and closed shipments');
  try {
    const res  = await fetch('/api/shipmentmain?status=delivered');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load');
    const rows = json.data || [];
    if (!rows.length) { document.getElementById('result-body').innerHTML = '<div class="sap-error">No completed shipments found.</div>'; return; }
    currentResult = rows;
    const cols = ['shipmentID', 'shipmentRef', 'destinationName', 'forwarderName', 'plannedDelivery', 'status'];
    document.getElementById('result-body').innerHTML = renderSimpleTable(rows, cols);
    document.getElementById('result-row-badge').textContent = `${rows.length} rows`;
    document.getElementById('result-row-badge').classList.remove('hidden');
    document.getElementById('btn-export-csv').classList.remove('hidden');
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

function runCustomerSpecifics() {
  showResultPanel('Customer Specifics', 'Customer-specific packaging and logistics requirements');
  document.getElementById('result-body').innerHTML =
    '<div class="sap-error" style="color:var(--text-muted)">Customer Specifics — coming soon.</div>';
}

// ── Admin: shared edit modal ──────────────────────────────────────────────────
// fields: [{ key, label, type, step, wide, multiline }]
// onSave: async (values) — should throw on failure
function openAdminEditModal(title, subtitle, fields, record, onSave) {
  const fieldHtml = fields.map(f => {
    const raw = String(record[f.key] ?? '');
    const inputEl = f.multiline
      ? `<textarea id="aed-${f.key}" class="tf-input" rows="2" style="resize:vertical">${esc(raw)}</textarea>`
      : `<input id="aed-${f.key}" class="tf-input" type="${f.type || 'text'}"${f.step ? ` step="${f.step}"` : ''} value="${raw.replace(/"/g, '&quot;')}">`;
    return `<div class="tf-field${f.wide ? ' tf-field--wide' : ''}">
      <label class="tf-label">${esc(f.label)}</label>
      ${inputEl}
    </div>`;
  }).join('');

  openModal(`<div class="ps-modal ps-modal--wide">
    <div class="ps-modal-header">
      <div>
        <div class="ps-modal-title">${esc(title)}</div>
        <div class="ps-modal-sub">${esc(subtitle)}</div>
      </div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">${fieldHtml}</div>
      <div id="aed-result" style="margin-top:12px;font-size:13px"></div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button class="btn-submit" id="aed-save">Save Changes</button>
    </div>
  </div>`);

  document.getElementById('aed-save').addEventListener('click', async () => {
    const btn      = document.getElementById('aed-save');
    const resultEl = document.getElementById('aed-result');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    resultEl.textContent = '';

    const values = {};
    fields.forEach(f => {
      const el = document.getElementById(`aed-${f.key}`);
      values[f.key] = el ? el.value.trim() : '';
    });

    try {
      await onSave(values);
      resultEl.style.color = 'var(--success, #059669)';
      resultEl.textContent = 'Saved successfully.';
      btn.textContent = 'Saved ✓';
      setTimeout(closePickModal, 700);
    } catch (err) {
      resultEl.style.color = 'var(--error, #DC2626)';
      resultEl.textContent = `✕ ${err.message}`;
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  });
}

// ── Admin: Update Pallet Data ─────────────────────────────────────────────────
async function runUpdatePalletData() {
  showResultPanel('Update Pallet Data', 'Click any row to edit · Changes update the SQL table immediately');
  try {
    const rows = await fetch('/api/palletdata').then(r => r.json());
    if (!Array.isArray(rows) || !rows.length) {
      document.getElementById('result-body').innerHTML = '<div class="sap-error">No pallet types found.</div>';
      return;
    }

    document.getElementById('result-row-badge').textContent = `${rows.length} types`;
    document.getElementById('result-row-badge').classList.remove('hidden');

    const thead = `<tr><th>Code</th><th>Description</th><th>Weight (kg)</th><th>Length (cm)</th><th>Width (cm)</th><th>Height (cm)</th></tr>`;
    const tbody = rows.map((r, i) => `<tr class="admin-row" data-idx="${i}" style="cursor:pointer">
      <td><strong>${esc(r.palletID)}</strong></td>
      <td>${esc(r.palletDescription ?? '')}</td>
      <td>${r.palletWeight ?? ''}</td>
      <td>${r.palletLength ?? ''}</td>
      <td>${r.palletWidth  ?? ''}</td>
      <td>${r.palletHeight ?? ''}</td>
    </tr>`).join('');

    document.getElementById('result-body').innerHTML =
      `<div style="overflow-x:auto"><table class="pn-batch-table admin-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;

    document.querySelectorAll('.admin-row').forEach(tr => {
      tr.addEventListener('click', () => {
        const r = rows[parseInt(tr.dataset.idx, 10)];
        openAdminEditModal(
          `Edit Pallet — ${r.palletID}`,
          r.palletDescription || '',
          [
            { key: 'palletDescription', label: 'Description', wide: true },
            { key: 'palletWeight',      label: 'Weight (kg)', type: 'number', step: '0.001' },
            { key: 'palletLength',      label: 'Length (cm)', type: 'number', step: '1' },
            { key: 'palletWidth',       label: 'Width (cm)',  type: 'number', step: '1' },
            { key: 'palletHeight',      label: 'Height (cm)', type: 'number', step: '1' },
          ],
          r,
          async values => {
            const res2 = await fetch(`/api/palletdata/${encodeURIComponent(r.palletID)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                palletDescription: values.palletDescription,
                palletWeight:      parseFloat(values.palletWeight) || 0,
                palletLength:      parseInt(values.palletLength,  10) || 0,
                palletWidth:       parseInt(values.palletWidth,   10) || 0,
                palletHeight:      parseInt(values.palletHeight,  10) || 0,
              }),
            });
            const json = await res2.json();
            if (!json.success) throw new Error(json.error || 'Save failed');
            Object.assign(r, {
              palletDescription: values.palletDescription,
              palletWeight: values.palletWeight,
              palletLength: values.palletLength,
              palletWidth:  values.palletWidth,
              palletHeight: values.palletHeight,
            });
          }
        );
      });
    });
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

// ── Admin: Update Packaging Data ──────────────────────────────────────────────
async function runUpdatePackagingData() {
  showResultPanel('Update Packaging Data', 'Click any row to edit · Changes update the SQL table immediately');
  try {
    const rows = await fetch('/api/packagingdata').then(r => r.json());
    if (!Array.isArray(rows) || !rows.length) {
      document.getElementById('result-body').innerHTML = '<div class="sap-error">No packaging types found.</div>';
      return;
    }

    rows.sort((a, b) => (a.packID ?? '').localeCompare(b.packID ?? ''));

    document.getElementById('result-row-badge').textContent = `${rows.length} types`;
    document.getElementById('result-row-badge').classList.remove('hidden');

    const thead = `<tr><th>Code</th><th>Description</th><th>Material</th><th>Weight (kg)</th><th>Length (cm)</th><th>Width (cm)</th><th>Height (cm)</th></tr>`;
    const tbody = rows.map((r, i) => `<tr class="admin-row" data-idx="${i}" style="cursor:pointer">
      <td><strong>${esc(r.packID)}</strong></td>
      <td>${esc(r.packDescription ?? '')}</td>
      <td>${esc(r.packMaterial    ?? '')}</td>
      <td>${r.packWeight ?? ''}</td>
      <td>${r.packLength ?? ''}</td>
      <td>${r.packWidth  ?? ''}</td>
      <td>${r.packHeight ?? ''}</td>
    </tr>`).join('');

    document.getElementById('result-body').innerHTML =
      `<div style="overflow-x:auto"><table class="pn-batch-table admin-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;

    document.querySelectorAll('.admin-row').forEach(tr => {
      tr.addEventListener('click', () => {
        const r = rows[parseInt(tr.dataset.idx, 10)];
        openAdminEditModal(
          `Edit Packaging — ${r.packID}`,
          r.packDescription || '',
          [
            { key: 'packDescription', label: 'Description', wide: true },
            { key: 'packMaterial',    label: 'Material' },
            { key: 'packWeight',      label: 'Weight (kg)', type: 'number', step: '0.001' },
            { key: 'packLength',      label: 'Length (cm)', type: 'number', step: '1' },
            { key: 'packWidth',       label: 'Width (cm)',  type: 'number', step: '1' },
            { key: 'packHeight',      label: 'Height (cm)', type: 'number', step: '1' },
          ],
          r,
          async values => {
            const res2 = await fetch(`/api/packagingdata/${encodeURIComponent(r.packID)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                packDescription: values.packDescription,
                packMaterial:    values.packMaterial,
                packWeight:      parseFloat(values.packWeight) || 0,
                packLength:      parseInt(values.packLength,  10) || 0,
                packWidth:       parseInt(values.packWidth,   10) || 0,
                packHeight:      parseInt(values.packHeight,  10) || 0,
              }),
            });
            const json = await res2.json();
            if (!json.success) throw new Error(json.error || 'Save failed');
            Object.assign(r, {
              packDescription: values.packDescription,
              packMaterial:    values.packMaterial,
              packWeight:      values.packWeight,
              packLength:      values.packLength,
              packWidth:       values.packWidth,
              packHeight:      values.packHeight,
            });
          }
        );
      });
    });
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

// ── Admin: Update Destinations ────────────────────────────────────────────────
async function runUpdateDestinations() {
  showResultPanel('Update Destinations', 'Click any row to edit · Changes update the SQL table immediately');
  try {
    const rows = await fetch('/api/destinations').then(r => r.json());
    if (!Array.isArray(rows) || !rows.length) {
      document.getElementById('result-body').innerHTML = '<div class="sap-error">No destinations found.</div>';
      return;
    }

    rows.sort((a, b) => (a.destinationName ?? '').localeCompare(b.destinationName ?? ''));

    document.getElementById('result-row-badge').textContent = `${rows.length} destinations`;
    document.getElementById('result-row-badge').classList.remove('hidden');

    const thead = `<tr><th>ID</th><th>Name</th><th>City</th><th>Country</th><th>Zone</th><th>Def. Service</th><th>Incoterms</th></tr>`;
    const tbody = rows.map((r, i) => `<tr class="admin-row" data-idx="${i}" style="cursor:pointer">
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted)">${esc(String(r.destinationID))}</td>
      <td><strong>${esc(r.destinationName      ?? '')}</strong></td>
      <td>${esc(r.destinationCity              ?? '')}</td>
      <td>${esc(r.destinationCountry           ?? '')}</td>
      <td>${esc(r.destinationZone              ?? '')}</td>
      <td>${esc(r.defaultDeliveryService       ?? '')}</td>
      <td>${esc(r.defaultIncoterms             ?? '')}</td>
    </tr>`).join('');

    document.getElementById('result-body').innerHTML =
      `<div style="overflow-x:auto"><table class="pn-batch-table admin-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;

    document.querySelectorAll('.admin-row').forEach(tr => {
      tr.addEventListener('click', () => {
        const r = rows[parseInt(tr.dataset.idx, 10)];
        openAdminEditModal(
          `Edit Destination — ${r.destinationID}`,
          r.destinationName || '',
          [
            { key: 'destinationName',        label: 'Name',            wide: true },
            { key: 'destinationStreet',      label: 'Street',          wide: true },
            { key: 'destinationCity',        label: 'City' },
            { key: 'destinationPostCode',    label: 'Post Code' },
            { key: 'destinationCountry',     label: 'Country' },
            { key: 'destinationZone',        label: 'Zone' },
            { key: 'defaultDeliveryService', label: 'Default Service' },
            { key: 'defaultIncoterms',       label: 'Incoterms' },
            { key: 'destinationEmail',       label: 'Email',           wide: true },
            { key: 'destinationComment',     label: 'Comment',         wide: true, multiline: true },
          ],
          r,
          async values => {
            const res2 = await fetch(`/api/destinations/${encodeURIComponent(r.destinationID)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(values),
            });
            const json = await res2.json();
            if (!json.success) throw new Error(json.error || 'Save failed');
            Object.assign(r, values);
          }
        );
      });
    });
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

function renderSimpleTable(rows, cols) {
  if (!rows.length) return '<div class="sap-error">No data.</div>';
  const head = cols.map(c => `<th>${esc(c)}</th>`).join('');
  const body = rows.map(r => `<tr>${cols.map(c => `<td>${esc(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('');
  return `<div style="overflow-x:auto"><table class="pn-batch-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
