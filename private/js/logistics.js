'use strict';

let activeDT = null;
let currentResult = [];
let deliveryRows = [];
let shipmentRows = [];
let selectedDeliveryIds = new Set();
let selectedBookingShipmentIds = new Set();
// Confirmed invoice/packing-list/customs file assignments for the KN
// document-verification popup, keyed by shipmentID. Never explicitly
// cleared — assignments for shipments outside the current booking batch
// are simply never looked up again, and a shipment can only be booked once.
let bookingDocumentAssignments = new Map();
// The rows/haulier the booking modal is currently showing — lets the
// verify-documents popup (opened on top of the booking modal) navigate
// back to it without the caller having to thread them through every layer.
let currentBookingRows = [];
let currentBookingHaulier = '';
let selectedCustomsShipmentIds = new Set();
let selectedCollectionIds = new Set();
let selectedInTransitIds = new Set();
let trackedRows = [];
let selectedTrackedIds = new Set();
let trackedSearchQuery = '';
let inboundShipmentRows = [];
let latestShipment = null;
let currentShipmentView = null;
let approvedForwarders = null;
let allForwarders = null;
let customsBatchNotice = null;
let userPermissions = [];
let sessionRole     = '';
let sessionUsername = '';
let freightSpendMonths = 12;
let freightCharts = [];
let turnsCharts = [];
let valClassCatalogCache = null;
let cvcSelections = new Map();


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
  sessionUsername = d.username    || '';
  applyPermissionVisibility();
  setupTiles();
})();

// data-permission accepts a comma-separated list, meaning "any of these" —
// used by the Reports section (LOG_ADMIN,LOG_MRP,LOG_REPORTS: see
// sql/migrate_log_reports_permission.sql) so it stays visible to everyone
// who already had access to its tiles under their old section names, with
// LOG_REPORTS as the new report-only way in. A single code still works
// exactly as before.
function applyPermissionVisibility() {
  document.querySelectorAll('[data-permission]').forEach(el => {
    const codes   = el.dataset.permission.split(',').map(c => c.trim()).filter(Boolean);
    const allowed = sessionRole === 'superadmin' || codes.some(code => userPermissions.includes(code));
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
      if (fn === 'shipmentSearch')      runShipmentSearch();
      if (fn === 'updatePalletData')    runUpdatePalletData();
      if (fn === 'updatePackagingData') runUpdatePackagingData();
      if (fn === 'updateDestinations')  runUpdateDestinations();
      if (fn === 'updateForwarders')    runUpdateForwarders();
      if (fn === 'materialGroupMapping')runMaterialGroupMapping();
      if (fn === 'costCentres')         runCostCentres();
      if (fn === 'glAccounts')          runGlAccounts();
      if (fn === 'forwarderModeMapping')runForwarderModeMapping();
      if (fn === 'freightSpend')        runFreightSpend();
      if (fn === 'haulierOtif')         runHaulierOtif();
      if (fn === 'unprocessedCosts')    runUnprocessedCosts();
      if (fn === 'turnsValClassTable')  runTurnsValClassTable();
      if (fn === 'turnsValClassSummary')runTurnsValClassSummary();
      if (fn === 'stockValueByPrice')   runStockValueByPrice();
      if (fn === 'changeValuationClass')runChangeValuationClass();
      if (fn === 'stockHistoryForecast')runStockHistoryForecast();
      if (fn === 'vendorMasterData')    runVendorMasterData();
      if (fn === 'consignmentTracker')  runConsignmentTracker();
      if (fn === 'orderSuggestions')    runOrderSuggestions();
      if (fn === 'inboundLog')         runInboundLog();
      if (fn === 'demandAdjustments')  runDemandAdjustments();
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
  document.getElementById('btn-refresh-turnsvalclass').classList.add('hidden');
  const tvcStatus = document.getElementById('turnsvalclass-refresh-status');
  tvcStatus.classList.add('hidden');
  tvcStatus.textContent = '';
  tvcStatus.classList.remove('tvc-refresh-status--ok', 'tvc-refresh-status--warn');
  const tvcSummary = document.getElementById('turnsvalclass-refresh-summary');
  tvcSummary.classList.add('hidden');
  tvcSummary.textContent = '';
  tvcSummary.title = '';
  tvcSummary.classList.remove('tvc-refresh-status--ok', 'tvc-refresh-status--warn');
  document.getElementById('result-body').innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading...</div>';
}


function backToTiles() {
  destroyFreightCharts();
  destroyTurnsCharts();
  document.getElementById('result-section').classList.add('hidden');
  document.getElementById('tile-section').classList.remove('hidden');
  document.getElementById('result-body').innerHTML = '';
  selectedDeliveryIds = new Set();
  deliveryRows = [];
  shipmentRows = [];
  selectedBookingShipmentIds = new Set();
  selectedCustomsShipmentIds = new Set();
  trackedRows = [];
  selectedTrackedIds = new Set();
  inboundShipmentRows = [];
  latestShipment = null;
  currentShipmentView = null;
  customsBatchNotice = null;
  cvcSelections = new Map();
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


function hasPlanning() {
  return sessionRole === 'superadmin' || userPermissions.includes('LOG_PLANNING');
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


// EXW ("Ex Works") means the customer arranges their own collection — used
// in the booking modal to auto-select Customer Collect instead of making
// the operator pick a haulier for a shipment that was never going to use one.
function isExWorksIncoterms(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  return normalized === 'EXW' || normalized === 'EXWORKS';
}


async function loadApprovedForwarders() {
  if (approvedForwarders) return approvedForwarders;
  const res = await fetch('/api/forwarders/approved');
  const json = await res.json();
  const raw = Array.isArray(json) ? json : [];
  approvedForwarders = dedupeForwardersByName(raw);
  return approvedForwarders;
}


// Forwarders can have multiple rows sharing the same display name — one per
// service/rate category (e.g. a pallet rate and a parcel rate under the same
// haulier name). The haulier-selection dropdowns (booking modal, shipment
// detail) only need one option per name; keep the lowest forwarderID for a
// stable, deterministic choice. loadAllForwarders() is deliberately NOT
// deduped here — the Create Shipment modal relies on its duplicates to
// filter forwarder name options by the chosen Forwarder Mode.
function dedupeForwardersByName(list) {
  const byName = new Map();
  list.slice()
    .sort((a, b) => Number(a.forwarderID) - Number(b.forwarderID))
    .forEach(f => {
      const key = String(f.forwarderName || '').trim().toLowerCase();
      if (!key || byName.has(key)) return;
      byName.set(key, f);
    });
  return Array.from(byName.values()).sort((a, b) => String(a.forwarderName || '').localeCompare(String(b.forwarderName || '')));
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
    } else if (mode === 'in-transit') {
      selectedInTransitIds = new Set();
      renderInTransitQueue();
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
    const actionCell = hasPlanning()
      ? `<button type="button" class="btn-submit shipment-action-btn" data-id="${esc(String(row.shipmentID))}">${esc(view.actionLabel)}</button>`
      : `<span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--text-muted)">View only</span>`;
    return `<tr class="ps-row shipment-row" data-id="${esc(String(row.shipmentID))}"><td>${esc(shipmentRef)}</td><td>${esc(formatDisplayDate(plannedDate))}</td><td>${esc(row.trackingNumber || '')}</td><td>${esc(row.forwarderName || '')}</td><td>${esc(locationValue)}</td><td class="shipment-action-cell">${actionCell}</td></tr>`;
  }).join('');

  document.getElementById('result-body').innerHTML = `<div class="lg-actions"><div><div class="lg-selection-title">${esc(view.title)}</div><div class="toolbar-hint">${esc(view.hint)}</div></div></div><div class="ps-sections"><div class="ps-section"><div class="ps-section-header"><span class="ps-section-dot ps-section-dot--today"></span><span class="ps-section-title">${esc(view.title)}</span><span class="ps-section-count">${shipmentRows.length}</span><span class="ps-chevron">v</span></div><div class="ps-section-body"><table class="ps-table"><thead><tr><th>Shipment</th><th>${esc(view.dateLabel)}</th><th>Tracking</th><th>Forwarder</th><th>${esc(view.locationLabel)}</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div></div></div><div id="shipment-queue-msg" class="lg-selection-msg hidden"></div>`;
  bindShipmentQueueEvents(mode);
}


// ── In Transit — overdue-first, then per-haulier buckets, compact rows,
// mass "mark selected as delivered on a date" (replaces the old flat list
// + per-row single-action button that renderShipmentQueue still uses for
// Awaiting Collection/Inbound). Overdue is judged on Planned Delivery vs
// today, same as everywhere else in the app; a shipment with no planned
// delivery date isn't treated as overdue (there's no date to be late
// against) and falls into its haulier bucket instead.
function itIsOverdue(row) {
  const plannedDate = getShipmentPlannedDate(row, 'in-transit');
  if (!plannedDate) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const planned = new Date(plannedDate); planned.setHours(0, 0, 0, 0);
  return planned.getTime() < today.getTime();
}

function renderInTransitQueue() {
  const view = SHIPMENT_VIEWS['in-transit'];

  const overdueRows = shipmentRows.filter(itIsOverdue)
    .slice()
    .sort((a, b) => new Date(getShipmentPlannedDate(a, 'in-transit')).getTime() - new Date(getShipmentPlannedDate(b, 'in-transit')).getTime());

  const haulierGroups = shipmentRows.filter(row => !itIsOverdue(row)).reduce((acc, row) => {
    const key = hasAssignedHaulier(row) ? row.forwarderName : 'Unassigned Haulier';
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  const itRow = row => {
    const shipmentRef = String(row.shipmentID || '').padStart(8, '0');
    const plannedDate = getShipmentPlannedDate(row, 'in-transit');
    const overdueClass = itIsOverdue(row) ? ' it-row--overdue' : '';
    return `<tr class="it-row${overdueClass}" data-id="${esc(String(row.shipmentID))}">
      <td class="lg-check-cell"><input type="checkbox" class="it-check" data-id="${esc(String(row.shipmentID))}"></td>
      <td>${esc(shipmentRef)}</td>
      <td>${esc(formatDisplayDate(plannedDate))}</td>
      <td>${esc(row.trackingNumber || '')}</td>
      <td>${esc(row.forwarderName || '-')}</td>
      <td>${esc(row[view.locationField] || '-')}</td>
    </tr>`;
  };

  const itTableHead = `<thead><tr><th></th><th>Shipment</th><th>${esc(view.dateLabel)}</th><th>Tracking</th><th>Forwarder</th><th>${esc(view.locationLabel)}</th></tr></thead>`;
  const itSection = (key, label, dot, rows, defaultOpen) => {
    if (!rows.length) return '';
    const collapsed = defaultOpen ? '' : ' ps-section--collapsed';
    return `<div class="ps-section${collapsed}" data-group-key="${esc(key)}">
      <div class="ps-section-header">
        <span class="ps-section-dot ps-section-dot--${dot}"></span>
        <span class="ps-section-title">${esc(label)}</span>
        <span class="ps-section-count">${rows.length}</span>
        <span class="ps-chevron">v</span>
      </div>
      <div class="ps-section-body">
        <div style="overflow-x:auto"><table class="it-table">${itTableHead}<tbody>${rows.map(itRow).join('')}</tbody></table></div>
      </div>
    </div>`;
  };

  const sections = [
    itSection('overdue', `Overdue (${overdueRows.length})`, 'priority', overdueRows, true),
    ...Object.keys(haulierGroups).sort((a, b) => a.localeCompare(b)).map(name =>
      itSection(name, name, 'week', haulierGroups[name].slice().sort((a, b) =>
        new Date(getShipmentPlannedDate(a, 'in-transit') || 0).getTime() - new Date(getShipmentPlannedDate(b, 'in-transit') || 0).getTime()), true)),
  ].join('');

  const writeBtns = hasPlanning()
    ? `<button type="button" class="btn-secondary" id="it-clear-btn" disabled>Clear Selection</button><button type="button" class="btn-submit" id="it-mark-delivered-btn" disabled>Mark Selected Delivered</button>`
    : `<span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--text-muted)" title="Requires LOG_PLANNING permission">View only</span>`;

  document.getElementById('result-body').innerHTML = `
    <div class="lg-actions">
      <div><div class="lg-selection-title">${esc(view.title)}</div><div class="toolbar-hint" id="it-selection-hint">${esc(view.hint)}</div></div>
      <div class="toolbar-spacer"></div>
      ${writeBtns}
    </div>
    <div id="it-selection-msg" class="lg-selection-msg hidden"></div>
    <div class="ps-sections">${sections}</div>`;

  bindInTransitEvents();
}

function getSelectedInTransitRows() {
  return shipmentRows.filter(row => selectedInTransitIds.has(Number(row.shipmentID)));
}

function updateInTransitUI() {
  const count = selectedInTransitIds.size;
  const hint = document.getElementById('it-selection-hint');
  if (hint) hint.textContent = count ? `${count} shipment(s) selected.` : SHIPMENT_VIEWS['in-transit'].hint;
  const clearBtn = document.getElementById('it-clear-btn');
  const markBtn  = document.getElementById('it-mark-delivered-btn');
  if (clearBtn) clearBtn.disabled = count === 0;
  if (markBtn)  markBtn.disabled  = count === 0;
}

function bindInTransitEvents() {
  document.querySelectorAll('.ps-section-header').forEach(header => header.addEventListener('click', () => header.closest('.ps-section').classList.toggle('ps-section--collapsed')));
  document.querySelectorAll('.it-check').forEach(input => {
    input.addEventListener('change', e => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) selectedInTransitIds.add(id);
      else selectedInTransitIds.delete(id);
      updateInTransitUI();
    });
  });
  document.querySelectorAll('.it-row').forEach(row => row.addEventListener('click', e => {
    if (e.target.closest('.lg-check-cell')) return;
    openShipmentDetailModal(Number(row.dataset.id));
  }));
  document.getElementById('it-clear-btn')?.addEventListener('click', () => {
    selectedInTransitIds = new Set();
    document.querySelectorAll('.it-check').forEach(input => { input.checked = false; });
    updateInTransitUI();
  });
  document.getElementById('it-mark-delivered-btn')?.addEventListener('click', openBulkMarkDeliveredModal);
}

function openBulkMarkDeliveredModal() {
  const rows = getSelectedInTransitRows();
  if (!rows.length) return;
  const today = new Date().toISOString().slice(0, 10);
  openModal(`<div class="ps-modal" style="max-width:420px;width:92vw">
    <div class="ps-modal-header">
      <div>
        <div class="ps-modal-title">Mark ${rows.length} Shipment${rows.length === 1 ? '' : 's'} as Delivered</div>
        <div class="ps-modal-sub">Same actual delivery date applied to all selected</div>
      </div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="transfer-form" style="padding:0">
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Actual Delivery Date <span class="tf-req">*</span></label>
            <input class="tf-input" id="bmd-date" type="date" value="${today}" required>
          </div>
        </div>
        <div id="bmd-result" style="margin-top:8px;font-size:13px"></div>
      </div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button class="btn-submit" id="bmd-confirm">Confirm Delivered</button>
    </div>
  </div>`);

  document.getElementById('bmd-confirm').addEventListener('click', async () => {
    const date     = document.getElementById('bmd-date').value;
    const resultEl = document.getElementById('bmd-result');
    const btn      = document.getElementById('bmd-confirm');
    if (!date) { resultEl.innerHTML = '<span style="color:var(--error)">Please select a date.</span>'; return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res  = await fetch('/api/shipmentmain/mark-delivered-bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shipmentIDs: rows.map(r => r.shipmentID), actualDelivery: date }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Update failed');
      const failed = json.data?.failed || [];
      closePickModal();
      selectedInTransitIds = new Set();
      await runShipmentQueue('in-transit');
      if (failed.length) {
        const msg = document.getElementById('it-selection-msg');
        if (msg) {
          msg.textContent = `${json.data.completed.length} marked delivered. ${failed.length} failed: ${failed.map(f => `#${String(f.shipmentID).padStart(8,'0')} (${f.error})`).join(', ')}`;
          msg.classList.remove('hidden');
        }
      }
    } catch (err) {
      resultEl.innerHTML = `<span style="color:var(--error)">${esc(err.message)}</span>`;
      btn.disabled = false; btn.textContent = 'Confirm Delivered';
    }
  });
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

  const bookingWriteBtns = hasPlanning()
    ? `<button type="button" class="btn-secondary" id="booking-cancel-btn" disabled>Cancel Shipment</button><button type="button" class="btn-submit" id="booking-confirm-btn" disabled>Book</button>`
    : `<span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--text-muted)" title="Requires LOG_PLANNING permission">View only</span>`;
  document.getElementById('result-body').innerHTML = `<div class="lg-actions"><div><div class="lg-selection-title">Awaiting Booking</div><div class="toolbar-hint" id="booking-selection-hint">Select one or more shipments for the same haulier, then book them.</div></div><div class="toolbar-spacer"></div><button type="button" class="btn-secondary" id="booking-clear-btn" disabled>Clear Selection</button>${bookingWriteBtns}</div><div id="booking-selection-msg" class="lg-selection-msg hidden"></div><div class="ps-sections">${sections}</div>`;
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

  const customsWriteBtn = hasPlanning()
    ? `<button type="button" class="btn-secondary" id="customs-not-required-btn" disabled style="color:var(--error,#DC2626)">Mark Not Required</button><button type="button" class="btn-submit" id="customs-create-btn" disabled>Create Customs Entry</button>`
    : `<span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--text-muted)" title="Requires LOG_PLANNING permission">View only</span>`;
  document.getElementById('result-body').innerHTML = `<div class="lg-actions"><div><div class="lg-selection-title">Customs Documents</div><div class="toolbar-hint" id="customs-selection-hint">Select one or more shipments, then create the customs entries in ClearPort.</div></div><div class="toolbar-spacer"></div><button type="button" class="btn-secondary" id="customs-clear-btn" disabled>Clear Selection</button>${customsWriteBtn}</div>${noticeHtml}<div class="ps-sections"><div class="ps-section"><div class="ps-section-header"><span class="ps-section-dot ps-section-dot--week"></span><span class="ps-section-title">Awaiting Customs</span><span class="ps-section-count">${shipmentRows.length}</span><span class="ps-chevron">v</span></div><div class="ps-section-body"><table class="ps-table"><thead><tr><th></th><th>Shipment</th><th>Planned Movement</th><th>Forwarder</th><th>Destination</th><th>Customs ID</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>`;
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
  document.getElementById('customs-not-required-btn')?.addEventListener('click', markSelectedNotRequired);
}


async function updateShipmentQueueStatus(mode, button) {
  const view       = SHIPMENT_VIEWS[mode];
  const shipmentId = button.dataset.id;

  // Mark-delivered always prompts for the actual delivery date first
  if (view.actionRoute === 'mark-delivered') {
    openMarkDeliveredModal(shipmentId, mode);
    return;
  }

  const originalText = button.textContent;
  const msg = document.getElementById('shipment-queue-msg');
  button.disabled = true;
  button.textContent = 'Working...';
  if (msg) msg.classList.add('hidden');
  try {
    const res  = await fetch(`/api/shipmentmain/${encodeURIComponent(shipmentId)}/${view.actionRoute}`, { method: 'POST' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Update failed');
    await runShipmentQueue(mode);
  } catch (err) {
    button.disabled = false;
    button.textContent = originalText;
    if (msg) { msg.textContent = err.message; msg.classList.remove('hidden'); }
  }
}

function openMarkDeliveredModal(shipmentId, mode) {
  const today = new Date().toISOString().slice(0, 10);
  openModal(`<div class="ps-modal" style="max-width:420px;width:92vw">
    <div class="ps-modal-header">
      <div>
        <div class="ps-modal-title">Mark as Delivered</div>
        <div class="ps-modal-sub">Shipment #${String(shipmentId).padStart(8, '0')}</div>
      </div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="transfer-form" style="padding:0">
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Actual Delivery Date <span class="tf-req">*</span></label>
            <input class="tf-input" id="md-date" type="date" value="${today}" required>
          </div>
        </div>
        <div id="md-result" style="margin-top:8px;font-size:13px;color:var(--error)"></div>
      </div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button class="btn-submit" id="md-confirm">Confirm Delivered</button>
    </div>
  </div>`);

  document.getElementById('md-confirm').addEventListener('click', async () => {
    const date    = document.getElementById('md-date').value;
    const resultEl= document.getElementById('md-result');
    const btn     = document.getElementById('md-confirm');
    if (!date) { resultEl.textContent = 'Please select a date.'; return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res  = await fetch(`/api/shipmentmain/${encodeURIComponent(shipmentId)}/mark-delivered`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actualDelivery: date }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Update failed');
      closePickModal();
      await runShipmentQueue(mode);
    } catch (err) {
      resultEl.textContent = err.message;
      btn.disabled = false; btn.textContent = 'Confirm Delivered';
    }
  });
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
  if (cancelBtn) cancelBtn.disabled = selectedBookingShipmentIds.size === 0 || !hasPlanning();
  const confirmBtn = document.getElementById('booking-confirm-btn');
  if (confirmBtn) confirmBtn.disabled = selectedBookingShipmentIds.size === 0 || !hasPlanning();
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
  const notRequiredBtn = document.getElementById('customs-not-required-btn');
  if (notRequiredBtn) notRequiredBtn.disabled = rows.length === 0;
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


// Mass "un-mark" — for shipments that were flagged as needing a customs
// declaration but turn out not to (wrong flag, incoterms/destination
// change, etc). Clears customsRequired for every selected row in one call
// so they don't have to be toggled off one at a time via the shipment
// detail modal; drops them straight off this queue since it's filtered on
// customsRequired = 1.
async function markSelectedNotRequired() {
  const rows = getSelectedCustomsRows();
  if (!rows.length) return;
  if (!await wConfirmLg({
    title: 'Mark as Not Required',
    message: `Mark ${rows.length} shipment(s) as not requiring customs? They'll drop off this list.`,
    confirmText: 'Mark Not Required',
    variant: '',
  })) return;

  const button = document.getElementById('customs-not-required-btn');
  const message = document.getElementById('customs-selection-msg');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Updating...';
  if (message) {
    message.textContent = '';
    message.classList.add('hidden');
    message.classList.remove('lg-selection-msg--success');
  }

  try {
    const res = await fetch('/api/shipmentmain/customs-required/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipmentIDs: rows.map(row => row.shipmentID), required: false }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to update shipments.');

    const updated = json.data?.updated || 0;
    const skipped = json.data?.skipped || [];
    const lines = [`${updated} shipment(s) marked as not requiring customs.`];
    if (skipped.length) {
      lines.push(`${skipped.length} shipment(s) skipped — customs already complete: ${skipped.map(id => String(id).padStart(8, '0')).join(', ')}.`);
    }
    customsBatchNotice = { type: skipped.length ? 'warning' : 'success', text: lines.join(' ') };

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
  if (!await wConfirmLg({ title: 'Cancel Shipments', message: `Cancel ${rows.length} shipment(s)? This will unlink the deliveries and return them to Open Deliveries.`, confirmText: 'Cancel Shipments', variant: 'danger' })) return;
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
  showResultPanel('Create Outbound Shipment', 'Completed deliveries ready for shipment creation');
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
      document.getElementById('result-body').innerHTML = '<div class="lg-actions"><div><div class="lg-selection-title">Completed picksheets</div><div class="toolbar-hint">No completed deliveries are currently available for shipment creation.</div></div><div class="toolbar-spacer"></div><button type="button" class="btn-secondary" id="lg-manual-btn">+ Manual Shipment</button></div>';
      document.getElementById('lg-manual-btn').addEventListener('click', openManualShipmentModal);
      return;
    }
    renderOpenDeliveries();
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}


function renderOpenDeliveries() {
  const bucketMap = {}; BUCKETS.forEach(b => { bucketMap[b.key] = []; });
  deliveryRows.forEach(r => { const key = r.deliveryPriority === 1 ? 'priority' : getDateBucket(r.dispatchDate); bucketMap[key].push(r); });
  const sections = BUCKETS.filter(b => bucketMap[b.key].length).map(b => {
    const collapsed = b.defaultOpen ? '' : ' ps-section--collapsed';
    const rows = bucketMap[b.key].map(r => {
      const due = r.dispatchDate ? new Date(r.dispatchDate).toLocaleDateString('en-GB') : '-';
      const completed = r.completionDate ? new Date(r.completionDate).toLocaleDateString('en-GB') : '-';
      const flag = b.key === 'priority' ? '<span class="ps-priority-flag"></span>' : '';
      return `<tr class="ps-row lg-row" data-id="${esc(String(r.deliveryID))}" data-customer="${esc(String(r.customerID))}"><td class="lg-check-cell"><input type="checkbox" class="lg-check" data-id="${esc(String(r.deliveryID))}"></td><td>${flag}${esc(String(r.deliveryID))}</td><td>${esc(r.destinationName || '-')}</td><td>${esc(completed)}</td><td>${esc(due)}</td><td>${esc(r.deliveryService || '')}</td><td>${esc(String(r.palletCount ?? 0))}</td><td>${esc(String(r.grossWeight ?? 0))}</td><td>${esc(String(r.deliveryVolume ?? 0))}</td></tr>`;
    }).join('');
    return `<div class="ps-section${collapsed}"><div class="ps-section-header"><span class="ps-section-dot ps-section-dot--${b.dot}"></span><span class="ps-section-title">${b.label}</span><span class="ps-section-count">${bucketMap[b.key].length}</span><span class="ps-chevron">v</span></div><div class="ps-section-body"><table class="ps-table"><thead><tr><th></th><th>Delivery</th><th>Destination</th><th>Completed</th><th>Due</th><th>Service</th><th>Pallets</th><th>Weight</th><th>Volume</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }).join('');
  document.getElementById('result-body').innerHTML = `<div class="lg-actions"><div><div class="lg-selection-title">Completed picksheets</div><div class="toolbar-hint" id="lg-selection-hint">Select deliveries for one customer, then create a shipment.</div></div><div class="toolbar-spacer"></div><button type="button" class="btn-secondary" id="lg-manual-btn">+ Manual Shipment</button><button type="button" class="btn-secondary" id="lg-clear-btn" disabled>Clear Selection</button><button type="button" class="btn-submit" id="lg-create-btn" disabled>Create Shipment</button></div><div id="lg-selection-msg" class="lg-selection-msg hidden"></div><div class="ps-sections">${sections}</div>`;
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
  document.querySelectorAll('.lg-row').forEach(row => row.addEventListener('contextmenu', e => {
    showLgContextMenu(e, row.dataset.id);
  }));
  document.getElementById('lg-clear-btn').addEventListener('click', () => {
    selectedDeliveryIds = new Set();
    document.querySelectorAll('.lg-check').forEach(input => { input.checked = false; });
    updateSelectionUI();
  });
  document.getElementById('lg-create-btn').addEventListener('click', openShipmentModal);
  document.getElementById('lg-manual-btn').addEventListener('click', openManualShipmentModal);
}

// Right-click menu on a Create Shipment picksheet row — mirrors the Order
// Suggestions .pb-ctx-menu pattern (showOsContextMenu above). Offers two
// ways to pull a completed-but-unshipped delivery back out of the flow:
// "uncomplete" it (send it back to Open Picksheets for re-picking) or
// cancel it outright (order was cancelled, material booked back to stock).
function closeLgContextMenu() {
  document.getElementById('lg-ctx-menu')?.remove();
  document.removeEventListener('click', closeLgContextMenu);
}

function showLgContextMenu(event, deliveryId) {
  event.preventDefault();
  closeLgContextMenu();

  const menu = document.createElement('div');
  menu.id = 'lg-ctx-menu';
  menu.className = 'pb-ctx-menu';
  menu.style.left = `${Math.min(event.clientX, window.innerWidth  - 230)}px`;
  menu.style.top  = `${Math.min(event.clientY, window.innerHeight - 80)}px`;
  menu.innerHTML = `
    <div class="pb-ctx-item" data-action="uncomplete">Return to Open Picksheets</div>
    <div class="pb-ctx-item" data-action="cancel" style="color:var(--error,#DC2626)">Mark as Cancelled</div>`;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', closeLgContextMenu), 0);

  menu.querySelector('[data-action="uncomplete"]').addEventListener('click', () => {
    closeLgContextMenu();
    uncompleteDelivery(deliveryId);
  });
  menu.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    closeLgContextMenu();
    cancelPicksheetDelivery(deliveryId);
  });
}

async function uncompleteDelivery(deliveryId) {
  if (!await wConfirmLg({
    title: 'Return to Open Picksheets',
    message: `Return Delivery #${deliveryId} to Open Picksheets? It will need to be completed again before it can be added to a shipment. Any pallets already built are kept.`,
    confirmText: 'Return',
    variant: '',
  })) return;
  try {
    const res  = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/uncomplete`, { method: 'PATCH' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to return delivery to Open Picksheets');
    runOpenDeliveries();
  } catch (err) {
    wConfirmLg({ title: 'Error', message: err.message, confirmText: 'OK', variant: '' });
  }
}

async function cancelPicksheetDelivery(deliveryId) {
  if (!await wConfirmLg({
    title: 'Mark as Cancelled',
    message: `Cancel Delivery #${deliveryId}? This reverses any SAP staging (books the picked material back into stock) and removes it from Create Shipment. This cannot be undone.`,
    confirmText: 'Cancel Delivery',
    variant: 'danger',
  })) return;
  try {
    const res  = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/cancel-picksheet`, { method: 'PATCH' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to cancel delivery');
    runOpenDeliveries();
  } catch (err) {
    wConfirmLg({ title: 'Error', message: err.message, confirmText: 'OK', variant: '' });
  }
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
  const createBtn = document.getElementById('lg-create-btn');
  if (createBtn) {
    createBtn.disabled = rows.length === 0 || !hasPlanning();
    createBtn.title    = !hasPlanning() ? 'Requires LOG_PLANNING permission' : '';
  }
  const clearBtn = document.getElementById('lg-clear-btn'); if (clearBtn) clearBtn.disabled = rows.length === 0;
}


function getBookingRowsWithInputs() {
  return getSelectedBookingRows().map(row => ({
    shipmentID: row.shipmentID,
    shipmentRef: String(row.shipmentID || '').padStart(8, '0'),
    destinationName: row.destinationName || row.originName || '-',
    plannedCollection: document.getElementById(`booking-date-${row.shipmentID}`)?.value     || '',
    plannedDelivery:   document.getElementById(`booking-delivery-${row.shipmentID}`)?.value  || '',
    trackingNumber:    document.getElementById(`booking-track-${row.shipmentID}`)?.value.trim() || '',
    forwarderID:       document.getElementById(`booking-forwarder-${row.shipmentID}`)?.value || row.forwarderID || '',
    forwarderName:     document.getElementById(`booking-forwarder-${row.shipmentID}`)?.selectedOptions?.[0]?.textContent?.trim() || row.forwarderName || '',
    // Only populated when the shipment already had a forwarder assigned
    // (row.forwarderMode, from the queue query's Forwarders join) — the
    // booking modal's own haulier dropdown is deduped by name across
    // multiple mode rows (dedupeForwardersByName), so there's no single
    // right mode to attribute to a haulier picked fresh here.
    forwarderMode:     row.forwarderMode || null,
    expectedCost:      document.getElementById(`booking-cost-${row.shipmentID}`)?.value.trim() || null,
    skipCost:          Boolean(document.getElementById(`booking-cost-${row.shipmentID}`)?.dataset.skipCost),
    elementCode:       document.getElementById(`booking-cost-${row.shipmentID}`)?.dataset.elementCode || null,
    costCenter:        document.getElementById('booking-cost-center')?.value || null,
    customsCost:       (() => { const v = document.getElementById(`booking-cost-${row.shipmentID}`)?.dataset.customsCost; return v != null && v !== '' ? Number(v) : null; })(),
    customsRequired:   Boolean(row.customsRequired),
  }));
}


// Categories a file can be tagged with in the KN document-verification
// popup, mirroring KN's DocumentTypeCode list (routes/shipmentmain.js's
// KN_DOCUMENT_TYPE_CODES): 271 Packing List, 380 Commercial Invoice,
// 944 Customs Documents. 'Ignore' lets an unrelated PDF sit in the folder
// without forcing a category onto it.
const BOOKING_DOC_CATEGORIES = [
  { value: '',             label: 'Ignore this file' },
  { value: 'packing-list', label: 'Packing List' },
  { value: 'invoice',      label: 'Commercial Invoice' },
  { value: 'customs',      label: 'Customs Declaration' },
];

function bvdCategoryForFile(assignment, fileName) {
  if (!assignment) return null;
  if (assignment.packingList === fileName) return 'packing-list';
  if (assignment.invoice === fileName) return 'invoice';
  if (assignment.customs === fileName) return 'customs';
  return null;
}

// A KN shipment is ready to book once packing list + invoice are both
// assigned, and — only when this specific shipment is marked
// customsRequired — a customs declaration too. Enforced, not hinted: this
// same check gates both the "Verify Documents" status badge and the actual
// booking call in submitBookingModal, so a shipment can never reach the KN
// booking API without it.
function bookingDocsComplete(row) {
  const assignment = bookingDocumentAssignments.get(Number(row.shipmentID));
  if (!assignment || !assignment.packingList || !assignment.invoice) return false;
  if (row.customsRequired && !assignment.customs) return false;
  return true;
}

// Disables the whole booking modal's submit button until every KN row in
// the batch has verified documents — a batch that's part-verified must not
// be partially sent, since submitBookingModal processes items in one pass.
function updateBookingSubmitGate(rows, haulier) {
  const btn = document.getElementById('booking-submit-btn');
  if (!btn) return;
  if (!isKnHaulier(haulier)) { btn.disabled = false; return; }
  btn.disabled = !rows.every(bookingDocsComplete);
}

// Lists everything currently in a shipment's export folder (packing list,
// any operator-uploaded invoice, any ClearPort customs PDF) and lets the
// operator confirm/correct a category for each file. Nothing is written to
// bookingDocumentAssignments until "Confirm Documents" is clicked — closing
// or backing out of this popup without saving leaves the shipment
// unverified, which is the safe default.
async function openVerifyDocumentsModal(row, rows, haulier) {
  const sid = row.shipmentID;
  const ref = String(sid).padStart(8, '0');
  openModal(`<div class="ps-modal" style="max-width:640px;width:94vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Verify Documents</div><div class="ps-modal-sub">${esc(ref)} — ${esc(row.destinationName || row.originName || '')}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="toolbar-hint">Packing list, invoice and (where required) customs declaration must all be present and categorised before this shipment can be booked with Kuehne &amp; Nagel — they'll be uploaded to the shipment automatically once booked.</div>
      <div id="bvd-body"><div class="sap-loading"><div class="spinner"></div>Loading...</div></div>
      <input type="file" id="bvd-file-input" accept="application/pdf" style="display:none">
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" id="bvd-back-btn">← Back</button>
      <button type="button" class="btn-secondary" id="bvd-upload-btn">Upload Invoice</button>
      <button type="button" class="btn-submit" id="bvd-save-btn" disabled>Confirm Documents</button>
    </div>
  </div>`);

  document.getElementById('bvd-back-btn').addEventListener('click', () => openBookingModal(rows, haulier));
  document.getElementById('bvd-upload-btn').addEventListener('click', () => document.getElementById('bvd-file-input').click());
  document.getElementById('bvd-file-input').addEventListener('change', async () => {
    const fileInput = document.getElementById('bvd-file-input');
    const file = fileInput.files[0];
    if (!file) return;
    const uploadBtn = document.getElementById('bvd-upload-btn');
    uploadBtn.disabled = true; uploadBtn.textContent = 'Uploading…';
    try {
      const res = await fetch(`/api/shipmentmain/${encodeURIComponent(sid)}/documents/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name) },
        body: file,
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Upload failed.');
      await bvdLoadFolder(sid, row);
    } catch (err) {
      const body = document.getElementById('bvd-body');
      if (body) body.insertAdjacentHTML('afterbegin', `<div class="sap-error tf-inline-error">${esc(err.message)}</div>`);
    } finally {
      uploadBtn.disabled = false; uploadBtn.textContent = 'Upload Invoice';
      fileInput.value = '';
    }
  });

  await bvdLoadFolder(sid, row);
}

async function bvdLoadFolder(sid, row) {
  const body = document.getElementById('bvd-body');
  body.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading...</div>';
  try {
    const res = await fetch(`/api/shipmentmain/${encodeURIComponent(sid)}/documents/folder`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load documents.');
    bvdRenderFolder(sid, row, json.data);
  } catch (err) {
    body.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

function bvdRenderFolder(sid, row, data) {
  const body = document.getElementById('bvd-body');
  const existing = bookingDocumentAssignments.get(Number(sid));

  const rowsHtml = data.files.map((f, i) => {
    const cat = (existing ? bvdCategoryForFile(existing, f.fileName) : null) ?? f.guessedCategory ?? '';
    return `<tr class="admin-row">
      <td>${esc(f.fileName)}</td>
      <td>${(Number(f.sizeBytes || 0) / 1024).toFixed(1)} KB</td>
      <td>
        <select class="tf-input bvd-cat-select" data-filename="${esc(f.fileName)}">
          ${BOOKING_DOC_CATEGORIES.map(c => `<option value="${esc(c.value)}" ${c.value === cat ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
        </select>
      </td>
      <td style="text-align:right"><a href="${esc(f.downloadUrl)}" target="_blank" rel="noopener">View</a></td>
    </tr>`;
  }).join('');

  body.innerHTML = `
    ${!data.files.length
      ? '<div class="sap-empty">No documents in this shipment’s folder yet — upload the invoice below, or check that the packing list has generated.</div>'
      : `<div style="overflow-x:auto"><table class="pn-batch-table admin-table">
          <thead><tr><th>File</th><th>Size</th><th>Category</th><th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table></div>`}
    <div id="bvd-status" style="margin-top:12px;padding:10px;border-radius:6px;font-size:13px"></div>
  `;

  function updateStatus() {
    const assignment = { packingList: null, invoice: null, customs: null };
    document.querySelectorAll('.bvd-cat-select').forEach(sel => {
      const fileName = sel.dataset.filename;
      if (sel.value === 'packing-list') assignment.packingList = fileName;
      if (sel.value === 'invoice')      assignment.invoice     = fileName;
      if (sel.value === 'customs')      assignment.customs     = fileName;
    });

    const missing = [];
    if (!assignment.packingList) missing.push('Packing List');
    if (!assignment.invoice)     missing.push('Commercial Invoice');
    if (data.customsRequired && !assignment.customs) missing.push('Customs Declaration');

    const statusEl = document.getElementById('bvd-status');
    const saveBtn  = document.getElementById('bvd-save-btn');
    if (missing.length) {
      statusEl.style.background = 'rgba(220,38,38,0.1)';
      statusEl.style.color = 'var(--error,#DC2626)';
      statusEl.textContent = `Missing: ${missing.join(', ')}. All required documents must be categorised before this shipment can be booked.`;
      if (saveBtn) saveBtn.disabled = true;
    } else {
      statusEl.style.background = 'rgba(22,163,74,0.1)';
      statusEl.style.color = 'var(--success,#16A34A)';
      statusEl.textContent = data.customsRequired
        ? 'Packing list, invoice and customs declaration all assigned — ready to book.'
        : 'Packing list and invoice assigned — ready to book.';
      if (saveBtn) saveBtn.disabled = false;
    }
    return assignment;
  }

  document.querySelectorAll('.bvd-cat-select').forEach(sel => sel.addEventListener('change', updateStatus));
  updateStatus();

  document.getElementById('bvd-save-btn').addEventListener('click', () => {
    const assignment = updateStatus();
    if (document.getElementById('bvd-save-btn').disabled) return;
    bookingDocumentAssignments.set(Number(sid), assignment);
    // currentBookingRows/currentBookingHaulier are set by openBookingModal
    // right before this popup can be reached, so they always reflect the
    // batch this shipment belongs to.
    openBookingModal(currentBookingRows, currentBookingHaulier);
  });
}


async function openBookingModal(rows, haulier) {
  currentBookingRows = rows;
  currentBookingHaulier = haulier;
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
  // Customer Collect forwarder entry, for auto-selecting it below on EXW rows.
  const customerCollectForwarder = forwarders.find(item => isCustomerCollectHaulier(item.forwarderName));
  const built = rows.map(row => {
    const shipmentRef = String(row.shipmentID || '').padStart(8, '0');
    const plannedDate = getShipmentPlannedDate(row, 'in-transit');
    const sid           = esc(String(row.shipmentID));
    // EXW ("Ex Works") means the customer arranges their own collection —
    // pre-select Customer Collect instead of making the operator pick a
    // haulier for something that was never going to use one.
    const rowIsExw = isExWorksIncoterms(row.incoTerms);
    const forwarderField = row.forwarderID && hasAssignedHaulier(row)
      ? `${esc(row.forwarderName || '')}`
      : `<select class="tf-input booking-inline-input" id="booking-forwarder-${sid}"><option value="">Select haulier</option>${forwarders.map(item => `<option value="${esc(String(item.forwarderID))}" ${rowIsExw && customerCollectForwarder && String(item.forwarderID) === String(customerCollectForwarder.forwarderID) ? 'selected' : ''}>${esc(item.forwarderName || '')}</option>`).join('')}</select>`;
    const collectionVal = plannedDate ? new Date(plannedDate).toISOString().slice(0, 10) : '';
    const deliveryVal   = row.plannedDelivery ? new Date(row.plannedDelivery).toISOString().slice(0, 10) : '';
    const isRowKH       = isKnHaulier ? false : normalizeHaulierName(row.forwarderName || '').includes('howley');
    // Cost — KN gets auto-filled after render; others get manual input
    const costCell = isKnHaulier
      ? `<div id="booking-cost-loading-${sid}" style="font-size:11px;color:var(--text-muted)">Calculating…</div>
         <input class="tf-input booking-inline-input" type="number" id="booking-cost-${sid}"
           step="0.01" min="0" style="display:none;width:90px" placeholder="£">
         <div id="booking-cost-detail-${sid}" style="font-size:10px;color:var(--text-muted);margin-top:2px"></div>`
      : isRowKH
        ? `<span id="booking-cost-${sid}" data-skip-cost="1" style="font-size:11px;color:var(--text-muted)">TPN — manual</span>`
        : `<input class="tf-input booking-inline-input" type="number" id="booking-cost-${sid}"
             step="0.01" min="0" style="width:90px" placeholder="£ required">`;
    // Documents are only meaningful for KN — that's the only booking route
    // this app actually uploads documents against.
    const docsCell = !isKn
      ? ''
      : `<button type="button" class="btn-secondary booking-verify-docs-btn" data-sid="${sid}" style="padding:4px 10px;font-size:11px;white-space:nowrap;${bookingDocsComplete(row) ? 'color:var(--success,#16A34A);border-color:var(--success,#16A34A)' : ''}">${bookingDocsComplete(row) ? '✓ Verified' : 'Verify Documents'}</button>`;
    const trHtml = `<tr>
      <td>${esc(shipmentRef)}</td>
      <td>${esc(row.destinationName || row.originName || '-')}</td>
      <td>${forwarderField}</td>
      <td><input class="tf-input booking-inline-input" type="date" id="booking-date-${sid}"
            value="${esc(collectionVal)}"
            data-shipment="${sid}"
            data-country="${esc(row.destinationCountry || '')}"
            data-postcode="${esc(row.destinationPostCode || '')}"></td>
      <td><input class="tf-input booking-inline-input" type="date" id="booking-delivery-${sid}"
            value="${esc(deliveryVal)}" placeholder="Auto from route"></td>
      <td><input class="tf-input booking-inline-input" type="text" id="booking-track-${sid}"
            value="${esc(row.trackingNumber || '')}"></td>
    </tr>`;
    // Compact per-shipment cost/documents line — lives next to Cost Centre
    // below the table instead of as two more table columns, since those two
    // (Expected Cost's detail text, and the Documents button) were the
    // widest cells and pushed the table into horizontal scroll.
    const costDocsHtml = `<div class="booking-cost-doc-item">
        <span class="booking-cost-doc-ref">${esc(shipmentRef)}</span>
        <span class="booking-cost-doc-cost">${costCell}</span>
        ${docsCell ? `<span class="booking-cost-doc-docs">${docsCell}</span>` : ''}
      </div>`;
    return { trHtml, costDocsHtml };
  });
  const rowsHtml     = built.map(b => b.trHtml).join('');
  const costDocsHtml = built.map(b => b.costDocsHtml).join('');
  const trackingHelp = isCustomerCollect
    ? 'Tracking number is optional for customer collect shipments.'
    : isKn
      ? 'Tracking will be taken from the Kuehne & Nagel API response where available.'
      : 'Tracking number is required for each shipment before booking can be confirmed.';
  openModal(`<div class="ps-modal lg-modal"><div class="ps-modal-header"><div><div class="ps-modal-title">${esc(title)}</div><div class="ps-modal-sub">${esc(haulier || 'Unassigned Haulier')} - ${rows.length} shipment(s)</div></div><button class="ps-modal-close" onclick="closePickModal()">x</button></div><div class="ps-modal-body"><div class="toolbar-hint">${esc(subtitle)}</div><table class="ps-table booking-modal-table"><thead><tr><th>Shipment</th><th>Destination</th><th>Haulier</th><th>Planned Collection</th><th>Planned Delivery</th><th>Tracking Number</th></tr></thead><tbody>${rowsHtml}</tbody></table><div class="toolbar-hint booking-help">${esc(trackingHelp)}</div><div class="booking-cost-docs-row"><div class="booking-cost-centre-field"><label style="font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted)">Cost Centre</label><select class="tf-input" id="booking-cost-center" style="max-width:280px"><option value="">Loading…</option></select></div><div class="booking-cost-doc-list"><label style="font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted)">Expected Cost &amp; Documents</label><div class="booking-cost-doc-items">${costDocsHtml}</div></div></div><div id="booking-submit-result"></div></div><div class="ps-modal-actions"><button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button><button type="button" class="btn-submit" id="booking-submit-btn">${esc(actionLabel)}</button></div></div>`);
  document.getElementById('booking-submit-btn').addEventListener('click', submitBookingModal);
  document.querySelectorAll('.booking-verify-docs-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = rows.find(r => String(r.shipmentID) === btn.dataset.sid);
      if (row) openVerifyDocumentsModal(row, rows, haulier);
    });
  });
  updateBookingSubmitGate(rows, haulier);

  // Load cost centres into dropdown
  fetch('/api/costcenters').then(r => r.json()).then(data => {
    const centres = Array.isArray(data) ? data : (data.data || []);
    const sel = document.getElementById('booking-cost-center');
    if (!sel) return;
    sel.innerHTML = centres.map(c =>
      `<option value="${esc(c.centerCode || '')}">${esc(c.centerCode || '')} — ${esc(c.centerDescription || '')}</option>`
    ).join('');
    // Default to 0000002004 if present
    const def = centres.find(c => c.centerCode === '0000002004');
    if (def) sel.value = '0000002004';
  }).catch(() => {});

  // For KN shipments: auto-fetch cost estimate and populate each row
  if (isKnHaulier) {
    rows.forEach(async row => {
      const sid = String(row.shipmentID);
      try {
        const res  = await fetch(`/api/shipmentcost/estimate/${encodeURIComponent(row.shipmentID)}`);
        const json = await res.json();
        const loadEl   = document.getElementById(`booking-cost-loading-${sid}`);
        const inputEl  = document.getElementById(`booking-cost-${sid}`);
        const detailEl = document.getElementById(`booking-cost-detail-${sid}`);
        if (!inputEl) return;
        if (json.success && json.data) {
          const d = json.data;
          if (d.rateFound) {
            inputEl.value = d.expectedCost;
            inputEl.dataset.elementCode = d.elementCode || '';
            const customsLabel = d.customsCost > 0 ? ` + £${d.customsCost} customs (DDP)` : ` + £0 customs (${d.incoTerms || 'DAP'})`;
            if (detailEl) detailEl.textContent =
              `${d.chargeableWeight} kg × £${d.agreedRate}/kg (min £${d.minimumCharge})${customsLabel}`;
          } else {
            inputEl.placeholder = '£ — no rate found';
            if (detailEl) detailEl.textContent = json.data.message || 'No rate found';
            if (detailEl) detailEl.style.color = 'var(--error)';
          }
          if (d.elementCode) inputEl.dataset.elementCode = d.elementCode;
          inputEl.dataset.customsCost = d.customsCost != null ? String(d.customsCost) : '';
        }
        if (loadEl) loadEl.style.display = 'none';
        inputEl.style.display = '';
      } catch (_) {
        const loadEl = document.getElementById(`booking-cost-loading-${sid}`);
        if (loadEl) loadEl.textContent = 'Rate lookup failed';
      }
    });
  }

  // Auto-populate planned delivery from route table, and update when collection date changes
  rows.forEach(row => {
    const collectionEl = document.getElementById(`booking-date-${row.shipmentID}`);
    const deliveryEl   = document.getElementById(`booking-delivery-${row.shipmentID}`);
    if (!collectionEl || !deliveryEl) return;

    async function calcDelivery() {
      const collectionDate = collectionEl.value;
      if (!collectionDate) return;
      try {
        const country  = collectionEl.dataset.country;
        const postcode = collectionEl.dataset.postcode;
        if (!country) return;
        const res  = await fetch(`/api/deliveryroutes/lookup?country=${encodeURIComponent(country)}&postcode=${encodeURIComponent(postcode)}`);
        const json = await res.json();
        if (!json.success || json.transitDays == null) return;
        const base = new Date(collectionDate);
        base.setDate(base.getDate() + json.transitDays);
        // Only auto-fill if the delivery field is empty or hasn't been manually changed
        if (!deliveryEl.dataset.userEdited) {
          deliveryEl.value = base.toISOString().slice(0, 10);
        }
      } catch (_) {}
    }

    deliveryEl.addEventListener('change', () => { deliveryEl.dataset.userEdited = '1'; });
    collectionEl.addEventListener('change', () => {
      deliveryEl.dataset.userEdited = '';
      calcDelivery();
    });
    calcDelivery(); // initial calculation
  });
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

    // Validate cost: non-KN, non-KH shipments require a price
    for (const item of updates) {
      if (item.skipCost) continue;
      if (isKnHaulier(item.forwarderName)) continue;
      if (normalizeHaulierName(item.forwarderName).includes('howley')) { item.skipCost = true; continue; }
      if (!item.expectedCost || isNaN(Number(item.expectedCost)) || Number(item.expectedCost) <= 0) {
        throw new Error(`Expected cost is required for shipment ${item.shipmentRef}.`);
      }
    }
    const successfulUpdates = [];
    const failedRefs = [];
    const docWarnings = [];

    for (const item of updates) {
      try {
        if (isKnHaulier(item.forwarderName)) {
          if (!item.plannedCollection) throw new Error('Planned collection date is required.');

          // Enforced, not hinted: a KN shipment whose documents haven't been
          // verified in the popup never reaches the booking API at all — no
          // partial booking followed by a document-upload failure to clean
          // up after.
          const docs = bookingDocumentAssignments.get(Number(item.shipmentID));
          if (!docs || !docs.packingList || !docs.invoice || (item.customsRequired && !docs.customs)) {
            throw new Error('Documents must be verified (Packing List, Invoice' + (item.customsRequired ? ', Customs Declaration' : '') + ') before this shipment can be booked.');
          }

          const response = await fetch(`/api/freight-booking/shipment/${encodeURIComponent(item.shipmentID)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plannedCollection: item.plannedCollection }),
          });
          const json = await response.json();
          if (!response.ok) throw new Error(json.error || 'Failed to send to Kuehne & Nagel.');
          item.trackingNumber = String(json.trackingNumber || item.trackingNumber || '').trim();

          // Booking has now actually happened and has a tracking number — a
          // document-upload failure from here on is surfaced as a warning,
          // not rolled back into a failed booking. What this app stores as
          // "trackingNumber" is KN's own bookingID (extractTrackingNumber in
          // freightbooking.js falls back to responseData.bookingID, which is
          // the only identifier KN's booking response actually returns) —
          // so it's exactly what the document-upload API's bookingID field
          // needs, no separate value to track.
          if (item.trackingNumber) {
            const files = [
              { fileName: docs.packingList, category: 'packing-list' },
              { fileName: docs.invoice,     category: 'invoice' },
              ...(docs.customs ? [{ fileName: docs.customs, category: 'customs' }] : []),
            ];
            try {
              const uploadRes  = await fetch(`/api/freight-booking/${encodeURIComponent(item.shipmentID)}/documents/upload-to-kn`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bookingID: item.trackingNumber, files }),
              });
              const uploadJson = await uploadRes.json();
              const failedFiles = uploadJson.data?.failed || [];
              if (!uploadJson.success || failedFiles.length) {
                const detail = failedFiles.map(f => `${f.fileName}: ${f.error}`).join('; ') || uploadJson.error || 'unknown error';
                docWarnings.push(`${item.shipmentRef}: booked (tracking ${item.trackingNumber}), but document upload to KN failed — ${detail}. Upload manually via the KN portal.`);
              }
            } catch (uploadErr) {
              docWarnings.push(`${item.shipmentRef}: booked (tracking ${item.trackingNumber}), but document upload to KN failed — ${uploadErr.message}. Upload manually via the KN portal.`);
            }
          }
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
          shipmentID:        item.shipmentID,
          plannedCollection: item.plannedCollection  || null,
          plannedDelivery:   item.plannedDelivery    || null,
          trackingNumber:    item.trackingNumber     || '',
          forwarderID:       item.forwarderID        || null,
          forwarderMode:     item.forwarderMode      || null,
          expectedCost:      item.expectedCost != null ? Number(item.expectedCost) : null,
          costCenter:        item.costCenter         || null,
          elementCode:       item.elementCode        || null,
          skipCost:          Boolean(item.skipCost),
          customsCost:       item.customsCost        != null ? Number(item.customsCost) : null,
        })),
      }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to mark shipments as booked.');
    await runShipmentBooking();
    if (failedRefs.length || docWarnings.length) {
      const parts = [`Booked ${successfulUpdates.length} shipment(s).`];
      if (failedRefs.length)  parts.push(`Failed: ${failedRefs.join(' | ')}`);
      if (docWarnings.length) parts.push(docWarnings.join(' | '));
      result.innerHTML = `<div class="sap-error tf-inline-error">${esc(parts.join(' '))}</div>`;
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
    destinationCountry: first.destinationCountry || '', incoTerms: first.incoterms || first.defaultIncoterms || '',
    plannedCollection: new Date().toISOString().slice(0, 10),
    deliveryService: first.deliveryService || '',
    defaultForwarder: first.defaultForwarder || '',
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
  if (uniqueForwarders.length === 1) nameSelect.value = String(uniqueForwarders[0].forwarderID);
}


async function openShipmentModal() {
  if (!await checkSession()) return;
  const rows = getSelectedRows(); if (!rows.length) return;

  // Enforce incoterms consistency before opening — delivery-level overrides destination default
  const effectiveTerms = rows.map(r => String(r.incoterms || r.defaultIncoterms || '').trim().toUpperCase());
  const uniqueTerms    = [...new Set(effectiveTerms.filter(Boolean))];
  if (uniqueTerms.length > 1) {
    const detail = rows.map(r =>
      `#${r.deliveryID} → ${String(r.incoterms || r.defaultIncoterms || '?').toUpperCase()}`
    ).join(', ');
    showSelectionMessage(`Cannot create shipment — deliveries have conflicting incoterms (${uniqueTerms.join(' vs ')}): ${detail}`);
    return;
  }

  const draft = buildShipmentDraft();
  const forwarders = await loadAllForwarders();
  const modeOptions = [...new Set(forwarders.map(item => String(item.forwarderMode || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  openModal(`<div class="ps-modal lg-modal"><div class="ps-modal-header"><div><div class="ps-modal-title">Create Shipment</div><div class="ps-modal-sub">${esc(rows[0].destinationName || '')} - ${rows.length} deliveries</div></div><button class="ps-modal-close" onclick="closePickModal()">x</button></div><div class="ps-modal-body"><form id="lg-shipment-form" class="transfer-form"><div class="tf-section-label">Shipment Header</div><div class="tf-row"><div class="tf-field"><label class="tf-label">Planned Collection</label><input class="tf-input" type="date" id="lg-planned" value="${esc(draft.plannedCollection)}"></div><div class="tf-field"><label class="tf-label">Forwarder Mode</label><select class="tf-input" id="lg-forwarder-mode"><option value="">Select mode</option>${modeOptions.map(mode => `<option value="${esc(mode)}">${esc(mode)}</option>`).join('')}</select></div><div class="tf-field"><label class="tf-label">Forwarder Name</label><select class="tf-input" id="lg-forwarder-name" disabled><option value="">Select forwarder</option></select></div><div class="tf-field"><label class="tf-label">Incoterms</label><input class="tf-input" type="text" id="lg-incoterms" value="${esc(draft.incoTerms)}"></div></div><div id="lg-forwarder-warn"></div><div class="tf-row"><div class="tf-field tf-field--wide"><label class="tf-label">Destination Name</label><input class="tf-input" type="text" id="lg-dest-name" value="${esc(draft.destinationName)}"></div><div class="tf-field tf-field--wide"><label class="tf-label">Destination Street</label><input class="tf-input" type="text" id="lg-dest-street" value="${esc(draft.destinationStreet)}"></div></div><div class="tf-row"><div class="tf-field"><label class="tf-label">City</label><input class="tf-input" type="text" id="lg-dest-city" value="${esc(draft.destinationCity)}"></div><div class="tf-field"><label class="tf-label">Post Code</label><input class="tf-input" type="text" id="lg-dest-postcode" value="${esc(draft.destinationPostCode)}"></div><div class="tf-field"><label class="tf-label">Country</label><input class="tf-input" type="text" id="lg-dest-country" value="${esc(draft.destinationCountry)}"></div></div><div class="tf-row"><label class="lg-flag"><input type="checkbox" id="lg-customs-required"> Customs Required</label><label class="lg-flag"><input type="checkbox" id="lg-customs-complete"> Customs Complete</label></div><div class="tf-section-label">Calculated Totals <span class="tf-locked">Read only</span></div><div class="tf-row"><div class="tf-field"><label class="tf-label">Pallet Count</label><input class="tf-input" readonly value="${esc(draft.palletCount.toFixed(3))}"></div><div class="tf-field"><label class="tf-label">Gross Weight</label><input class="tf-input" readonly value="${esc(draft.grossWeight.toFixed(3))}"></div><div class="tf-field"><label class="tf-label">Volume</label><input class="tf-input" readonly value="${esc(draft.shipmentVolume.toFixed(3))}"></div></div><div id="lg-submit-result"></div></form></div><div class="ps-modal-actions"><button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button><button type="button" class="btn-submit" id="lg-confirm-btn">Confirm Shipment</button></div></div>`);
  function applyDefaultForwarder() {
    const defaultForwarder = draft.defaultForwarder;
    if (!defaultForwarder) return;
    const modeEl = document.getElementById('lg-forwarder-mode');
    const nameEl = document.getElementById('lg-forwarder-name');
    const warnEl = document.getElementById('lg-forwarder-warn');
    if (!modeEl || !nameEl || !warnEl) return;
    if (!modeEl.value) { warnEl.innerHTML = ''; return; }

    const opt = [...nameEl.options].find(o =>
      o.text.trim().toLowerCase() === String(defaultForwarder).trim().toLowerCase() ||
      o.value === String(defaultForwarder).trim()
    );
    if (opt) {
      nameEl.value = opt.value;
      warnEl.innerHTML = '';
    } else {
      warnEl.innerHTML = `<div style="background:rgba(217,119,6,0.1);border:1px solid rgba(217,119,6,0.35);
        border-radius:6px;padding:8px 12px;font-size:12px;color:#D97706;margin:6px 0">
        Default haulier <strong>${esc(defaultForwarder)}</strong> not available for selected service.
      </div>`;
    }
  }

  document.getElementById('lg-forwarder-mode').addEventListener('change', () => {
    onShipmentForwarderModeChange();
    applyDefaultForwarder();
  });
  document.getElementById('lg-confirm-btn').addEventListener('click', submitShipmentCreate);

  // Pre-select forwarder mode from deliveryService — exact match then case-insensitive
  const svc = draft.deliveryService.trim();
  if (svc) {
    const modeEl = document.getElementById('lg-forwarder-mode');
    const match  = modeOptions.find(m => m === svc)
                || modeOptions.find(m => m.toLowerCase() === svc.toLowerCase());
    if (match) {
      modeEl.value = match;
      onShipmentForwarderModeChange();
      applyDefaultForwarder();
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


// ── Manual Outbound Shipment ────────────────────────────────────────────────
// For goods that never go through the picksheet/pallet-builder process (not
// managed in SAP). Mirrors openShipmentModal's header-field UX (destination,
// forwarder mode/name, incoterms, customs flags) but replaces the read-only
// "Calculated Totals" section — sourced from linked deliveries there — with
// an editable cargo-line list, since a manual shipment has no deliveries to
// total up. Posts to /api/shipmentmain/create-manual then one
// /api/shipmentmain/:id/manual-cargo call per cargo row. See
// sql/migrate_manual_outbound_shipment.sql for why this cargo lives in its
// own ManualCargoItem table rather than PalletMain.
let _moRowSeq = 0;

function moCargoRowHtml(rowId) {
  return `<tr class="mo-cargo-row" data-row-id="${rowId}">
    <td><input class="tf-input mo-c-desc" type="text" placeholder="e.g. Steel brackets"></td>
    <td><input class="tf-input mo-c-qty" type="number" min="1" step="1" value="1" style="width:64px"></td>
    <td><input class="tf-input mo-c-weight" type="number" min="0" step="0.1" placeholder="kg" style="width:80px"></td>
    <td><input class="tf-input mo-c-length" type="number" min="0" step="0.1" placeholder="cm" style="width:70px"></td>
    <td><input class="tf-input mo-c-width" type="number" min="0" step="0.1" placeholder="cm" style="width:70px"></td>
    <td><input class="tf-input mo-c-height" type="number" min="0" step="0.1" placeholder="cm" style="width:70px"></td>
    <td><button type="button" class="mo-row-remove" title="Remove row" style="background:none;border:none;color:var(--text-secondary,#888);cursor:pointer;font-size:16px;line-height:1">×</button></td>
  </tr>`;
}

function moAddCargoRow() {
  const tbody = document.getElementById('mo-cargo-body');
  if (!tbody) return;
  tbody.insertAdjacentHTML('beforeend', moCargoRowHtml(++_moRowSeq));
  const row = tbody.lastElementChild;
  row.querySelector('.mo-row-remove').addEventListener('click', () => { row.remove(); moRecalcTotals(); });
  row.querySelectorAll('input').forEach(input => input.addEventListener('input', moRecalcTotals));
}

function moRecalcTotals() {
  let totalWeight = 0, totalPackages = 0, totalVolume = 0;
  document.querySelectorAll('#mo-cargo-body .mo-cargo-row').forEach(row => {
    const weight = Number(row.querySelector('.mo-c-weight').value) || 0;
    const qty    = Number(row.querySelector('.mo-c-qty').value) || 0;
    const l = Number(row.querySelector('.mo-c-length').value) || 0;
    const w = Number(row.querySelector('.mo-c-width').value) || 0;
    const h = Number(row.querySelector('.mo-c-height').value) || 0;
    totalWeight += weight;
    totalPackages += qty;
    if (l && w && h) totalVolume += (l * w * h) / 1000000;
  });
  const wEl = document.getElementById('mo-total-weight');
  const pEl = document.getElementById('mo-total-packages');
  const vEl = document.getElementById('mo-total-volume');
  if (wEl) wEl.textContent = totalWeight.toFixed(3);
  if (pEl) pEl.textContent = String(totalPackages);
  if (vEl) vEl.textContent = totalVolume.toFixed(3);
}

function onManualShipmentForwarderModeChange() {
  const modeSelect = document.getElementById('mo-forwarder-mode');
  const nameSelect = document.getElementById('mo-forwarder-name');
  if (!modeSelect || !nameSelect) return;
  const selectedMode = modeSelect.value;
  const matches = (allForwarders || []).filter(item => String(item.forwarderMode || '').trim() === selectedMode);
  const uniqueForwarders = matches.filter((item, index, arr) => arr.findIndex(other => String(other.forwarderName || '').trim() === String(item.forwarderName || '').trim()) === index);
  nameSelect.innerHTML = `<option value="">Select forwarder</option>${uniqueForwarders.map(item => `<option value="${esc(String(item.forwarderID))}">${esc(String(item.forwarderName || '').trim())}</option>`).join('')}`;
  nameSelect.disabled = !selectedMode;
  if (uniqueForwarders.length === 1) nameSelect.value = String(uniqueForwarders[0].forwarderID);
}

async function openManualShipmentModal() {
  if (!await checkSession()) return;
  const forwarders = await loadAllForwarders();
  const modeOptions = [...new Set(forwarders.map(item => String(item.forwarderMode || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  openModal(`<div class="ps-modal lg-modal">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Manual Shipment</div><div class="ps-modal-sub">Goods not managed through SAP — enter cargo manually</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <form id="mo-shipment-form" class="transfer-form">
        <div class="tf-section-label">Shipment Header</div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide" style="position:relative">
            <label class="tf-label">Destination</label>
            <input class="tf-input" type="text" id="mo-dest-search" placeholder="Start typing a destination name…" autocomplete="off">
            <input type="hidden" id="mo-dest-id">
            <div id="mo-dest-results" class="hidden" style="position:absolute;top:100%;left:0;right:0;z-index:20;
              background:var(--surface,#fff);border:1px solid var(--border);border-radius:0 0 8px 8px;
              max-height:220px;overflow-y:auto;box-shadow:0 8px 20px rgba(0,0,0,0.12)"></div>
          </div>
          <div class="tf-field"><label class="tf-label">Planned Collection</label><input class="tf-input" type="date" id="mo-planned" value="${esc(new Date().toISOString().slice(0, 10))}"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Forwarder Mode</label><select class="tf-input" id="mo-forwarder-mode"><option value="">Select mode</option>${modeOptions.map(mode => `<option value="${esc(mode)}">${esc(mode)}</option>`).join('')}</select></div>
          <div class="tf-field"><label class="tf-label">Forwarder Name</label><select class="tf-input" id="mo-forwarder-name" disabled><option value="">Select forwarder</option></select></div>
          <div class="tf-field"><label class="tf-label">Incoterms</label><input class="tf-input" type="text" id="mo-incoterms"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide"><label class="tf-label">Destination Street</label><input class="tf-input" type="text" id="mo-dest-street"></div>
        </div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">City</label><input class="tf-input" type="text" id="mo-dest-city"></div>
          <div class="tf-field"><label class="tf-label">Post Code</label><input class="tf-input" type="text" id="mo-dest-postcode"></div>
          <div class="tf-field"><label class="tf-label">Country</label><input class="tf-input" type="text" id="mo-dest-country"></div>
        </div>
        <div class="tf-row">
          <label class="lg-flag"><input type="checkbox" id="mo-customs-required"> Customs Required</label>
          <label class="lg-flag"><input type="checkbox" id="mo-customs-complete"> Customs Complete</label>
        </div>
        <div class="tf-section-label">Cargo</div>
        <table class="ps-table" style="font-size:12px">
          <thead><tr><th>Description</th><th>Qty</th><th>Weight</th><th>Length</th><th>Width</th><th>Height</th><th></th></tr></thead>
          <tbody id="mo-cargo-body"></tbody>
        </table>
        <button type="button" class="btn-secondary" id="mo-add-row-btn" style="margin-top:8px">+ Add Line</button>
        <div class="tf-section-label">Calculated Totals <span class="tf-locked">Read only</span></div>
        <div class="tf-row">
          <div class="tf-field"><label class="tf-label">Package Count</label><input class="tf-input" readonly id="mo-total-packages" value="0"></div>
          <div class="tf-field"><label class="tf-label">Gross Weight (kg)</label><input class="tf-input" readonly id="mo-total-weight" value="0.000"></div>
          <div class="tf-field"><label class="tf-label">Volume (m³)</label><input class="tf-input" readonly id="mo-total-volume" value="0.000"></div>
        </div>
        <div id="mo-submit-result"></div>
      </form>
    </div>
    <div class="ps-modal-actions"><button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button><button type="button" class="btn-submit" id="mo-confirm-btn">Create Shipment</button></div>
  </div>`);

  moAddCargoRow();
  document.getElementById('mo-add-row-btn').addEventListener('click', moAddCargoRow);
  document.getElementById('mo-forwarder-mode').addEventListener('change', onManualShipmentForwarderModeChange);
  document.getElementById('mo-confirm-btn').addEventListener('click', submitManualShipmentCreate);

  // Destination — search-as-you-type against Logistics.dbo.Destinations,
  // same pattern as Manual Inbound Shipment's origin combobox.
  const destInput   = document.getElementById('mo-dest-search');
  const destIdInput = document.getElementById('mo-dest-id');
  const destResults = document.getElementById('mo-dest-results');
  let destDebounce = null;

  function applyDestination(d) {
    document.getElementById('mo-dest-street').value   = d.destinationStreet || '';
    document.getElementById('mo-dest-city').value      = d.destinationCity || '';
    document.getElementById('mo-dest-postcode').value  = d.destinationPostCode || '';
    document.getElementById('mo-dest-country').value   = d.destinationCountry || '';
    if (d.defaultIncoterms) document.getElementById('mo-incoterms').value = d.defaultIncoterms;
    if (d.defaultForwarder) {
      const nameSelect = document.getElementById('mo-forwarder-name');
      const modeSelect = document.getElementById('mo-forwarder-mode');
      const fwd = forwarders.find(item => String(item.forwarderName || '').trim().toLowerCase() === String(d.defaultForwarder).trim().toLowerCase());
      if (fwd && fwd.forwarderMode) {
        modeSelect.value = fwd.forwarderMode;
        onManualShipmentForwarderModeChange();
        nameSelect.value = String(fwd.forwarderID);
      }
    }
  }

  function renderDestResults(rows) {
    if (!rows.length) {
      destResults.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:var(--text-secondary,#666)">No matches</div>';
    } else {
      destResults.innerHTML = rows.map(d =>
        `<div class="mo-dest-row" data-id="${esc(String(d.destinationID))}"
           style="padding:7px 10px;font-size:13px;cursor:pointer">${esc(d.destinationName)}${d.destinationCountry ? ` — ${esc(d.destinationCountry)}` : ''}</div>`
      ).join('');
      destResults.querySelectorAll('.mo-dest-row').forEach(row => {
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--surface2,#f3f4f6)'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });
        row.addEventListener('mousedown', e => {
          e.preventDefault();
          const match = rows.find(r => String(r.destinationID) === row.dataset.id);
          destIdInput.value = row.dataset.id;
          destInput.value = match ? match.destinationName : '';
          destResults.classList.add('hidden');
          if (match) applyDestination(match);
        });
      });
    }
    destResults.classList.remove('hidden');
  }

  destInput.addEventListener('input', () => {
    destIdInput.value = ''; // typing invalidates whatever was previously selected
    clearTimeout(destDebounce);
    const q = destInput.value.trim();
    if (!q) { destResults.classList.add('hidden'); return; }
    destDebounce = setTimeout(async () => {
      try {
        const res = await fetch(`/api/destinations?search=${encodeURIComponent(q)}`);
        const rows = await res.json();
        renderDestResults(Array.isArray(rows) ? rows : []);
      } catch (err) {
        destResults.innerHTML = '<div style="padding:8px 10px;font-size:12px" class="sap-error">Search failed</div>';
        destResults.classList.remove('hidden');
      }
    }, 250);
  });
  destInput.addEventListener('focus', () => {
    if (destInput.value.trim() && destResults.innerHTML) destResults.classList.remove('hidden');
  });
  destInput.addEventListener('blur', () => {
    setTimeout(() => destResults.classList.add('hidden'), 150);
  });
}

async function submitManualShipmentCreate() {
  const button = document.getElementById('mo-confirm-btn');
  const result = document.getElementById('mo-submit-result');
  result.innerHTML = '';

  const destinationID = document.getElementById('mo-dest-id').value;
  if (!destinationID) {
    result.innerHTML = '<div class="sap-error tf-inline-error">Select a destination from the dropdown list.</div>';
    return;
  }

  const cargoRows = [...document.querySelectorAll('#mo-cargo-body .mo-cargo-row')].map(row => ({
    description:  row.querySelector('.mo-c-desc').value.trim(),
    packageCount: Number(row.querySelector('.mo-c-qty').value) || 1,
    weight:       Number(row.querySelector('.mo-c-weight').value) || 0,
    length:       row.querySelector('.mo-c-length').value || '',
    width:        row.querySelector('.mo-c-width').value || '',
    height:       row.querySelector('.mo-c-height').value || '',
  })).filter(r => r.weight > 0);

  if (!cargoRows.length) {
    result.innerHTML = '<div class="sap-error tf-inline-error">Add at least one cargo line with a weight greater than 0.</div>';
    return;
  }

  button.disabled = true; button.textContent = 'Creating...';
  try {
    const incoTerms = document.getElementById('mo-incoterms').value.trim();
    const headerPayload = {
      destinationID,
      destinationStreet: document.getElementById('mo-dest-street').value.trim(),
      destinationCity: document.getElementById('mo-dest-city').value.trim(),
      destinationPostCode: document.getElementById('mo-dest-postcode').value.trim(),
      destinationCountry: document.getElementById('mo-dest-country').value.trim(),
      plannedCollection: document.getElementById('mo-planned').value || null,
      forwarderID: document.getElementById('mo-forwarder-name').value || null,
      incoTerms,
      customsRequired: document.getElementById('mo-customs-required').checked,
      customsComplete: document.getElementById('mo-customs-complete').checked,
    };
    const res = await fetch('/api/shipmentmain/create-manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(headerPayload) });
    const json = await res.json(); if (!json.success) throw new Error(json.error || 'Failed to create shipment');
    const shipmentID = json.data.shipmentID;

    for (const row of cargoRows) {
      const cargoRes = await fetch(`/api/shipmentmain/${encodeURIComponent(shipmentID)}/manual-cargo`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row),
      });
      const cargoJson = await cargoRes.json();
      if (!cargoJson.success) throw new Error(cargoJson.error || 'Shipment created, but failed to save a cargo line — check it before booking.');
    }

    latestShipment = { ...json.data, canSendEmail: isExWorksIncoterms(incoTerms) };
    closePickModal();
    await runOpenDeliveries();
    showPostCreateModal(latestShipment);
  } catch (err) {
    result.innerHTML = `<div class="sap-error tf-inline-error">${esc(err.message)}</div>`;
    button.disabled = false; button.textContent = 'Create Shipment';
  }
}


// ── Pallet management ─────────────────────────────────────────────────────────
let _lgPalletCtx   = null;
let _lgPalletTypes = [];
let _lgSelPType    = null;

async function showPickedPallets(deliveryId, destName) {
  if (!await checkSession()) return;
  _lgPalletCtx   = { deliveryId, destName };
  _lgPalletTypes = [];
  _lgSelPType    = null;
  await showLgPalletList();
}

async function showLgPalletList() {
  const { deliveryId, destName } = _lgPalletCtx || {};
  openModal(`<div class="ps-modal" style="max-width:800px;width:92vw">
    <div class="ps-modal-header">
      <div>
        <div class="ps-modal-title">Picked Pallets</div>
        <div class="ps-modal-sub">Delivery #${esc(String(deliveryId))} · ${esc(destName)}</div>
      </div>
      <button class="ps-modal-close" onclick="closePickModal()">✕</button>
    </div>
    <div class="ps-modal-body" id="lg-pallet-body"
      style="padding:0;max-height:480px;overflow-y:auto">
      <div class="sap-loading"><div class="spinner"></div>Loading pallets…</div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="closePickModal()">Close</button>
      <button class="btn-submit" onclick="openLgAddPalletView()">+ Add Pallet</button>
    </div>
  </div>`);
  await refreshLgPallets();
}

async function refreshLgPallets() {
  const body = document.getElementById('lg-pallet-body');
  if (!body) return;
  const { deliveryId } = _lgPalletCtx || {};
  try {
    const res  = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/pallets`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load pallets');
    const pallets = json.data || [];
    if (!pallets.length) {
      body.innerHTML = `<div class="ps-pcard-empty" style="padding:32px;text-align:center">
        No pallets yet — click <strong>+ Add Pallet</strong> to create one.</div>`;
      return;
    }
    body.innerHTML = `<div class="ps-pcard-list">${pallets.map(renderLgPalletCard).join('')}</div>`;
    body.querySelectorAll('.ps-pcard-hdr').forEach(hdr =>
      hdr.addEventListener('click', () => toggleLgPalletCard(hdr.closest('.ps-pcard')))
    );
  } catch (err) {
    body.innerHTML = `<div class="sap-error" style="padding:24px">✕ ${esc(err.message)}</div>`;
  }
}

function renderLgPalletCard(p) {
  const dims   = [p.palletLength, p.palletWidth, p.palletHeight].filter(Boolean).join('×');
  const wt     = p.grossWeight != null ? `${Number(p.grossWeight).toFixed(1)} kg` : '—';
  const status = p.palletFinish
    ? `<span class="ps-pcard-badge ps-pcard-badge--done">Finished</span>`
    : `<span class="ps-pcard-badge ps-pcard-badge--wip">In Progress</span>`;
  return `
    <div class="ps-pcard" data-palletid="${p.palletID}">
      <div class="ps-pcard-hdr">
        <span class="ps-pcard-type">${esc(p.palletType ?? '—')}</span>
        ${dims ? `<span class="ps-pcard-dims">${dims} cm</span>` : ''}
        <span class="ps-pcard-wt">${wt}</span>
        ${p.palletLocation ? `<span class="ps-pcard-loc">${esc(p.palletLocation)}</span>` : ''}
        ${status}
        <button class="ps-pcard-btn" onclick="event.stopPropagation();openLgEditPalletView(${p.palletID})">Edit</button>
        <button class="ps-pcard-btn ps-pcard-btn--delete" onclick="event.stopPropagation();deleteLgPallet(${p.palletID})">Delete</button>
        <span class="ps-pcard-chevron">▼</span>
      </div>
      <div class="ps-pcard-body" id="lg-pcard-body-${p.palletID}" style="display:none"></div>
    </div>`;
}

async function toggleLgPalletCard(card) {
  const palletId = card.dataset.palletid;
  const body     = document.getElementById(`lg-pcard-body-${palletId}`);
  const isOpen   = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  card.querySelector('.ps-pcard-chevron').textContent = isOpen ? '▼' : '▲';
  if (!isOpen && body.dataset.loaded !== '1') {
    body.innerHTML = `<div class="ps-pcard-empty"><div class="spinner" style="width:12px;height:12px;display:inline-block;margin-right:6px"></div>Loading…</div>`;
    await loadLgPalletPackages(palletId, body);
    body.dataset.loaded = '1';
  }
}

async function loadLgPalletPackages(palletId, bodyEl) {
  try {
    const res  = await fetch(`/api/palletpackages/pallet/${encodeURIComponent(palletId)}`);
    const json = await res.json();
    const pkgs = json.data || [];
    if (!pkgs.length) {
      bodyEl.innerHTML = `<div class="ps-pcard-empty">No packages on this pallet.</div>`;
      return;
    }
    bodyEl.innerHTML = `
      <table class="ps-pcard-tbl">
        <thead><tr>
          <th>Layer</th><th>Type</th><th>Material</th>
          <th>Qty</th><th>Batch</th><th>SAP Delivery</th><th></th>
        </tr></thead>
        <tbody>${pkgs.map(pkg => `<tr>
          <td>${esc(String(pkg.palletLayer ?? '—'))}</td>
          <td>${esc(pkg.packDescription || pkg.packagingID || '—')}</td>
          <td class="ps-pcard-mono">${esc(pkg.sapMaterial || '—')}</td>
          <td class="ps-pcard-mono">${pkg.sapQuantity != null ? Number(pkg.sapQuantity).toFixed(3) : '—'}</td>
          <td class="ps-pcard-mono">${esc(pkg.sapBatch || '—')}</td>
          <td class="ps-pcard-mono">${esc(pkg.sapDelivery || '—')}</td>
          <td><button class="ps-pcard-del" title="Remove"
            onclick="removeLgPackage(${pkg.palletItemID}, ${palletId})">✕</button></td>
        </tr>`).join('')}</tbody>
      </table>`;
  } catch (err) {
    bodyEl.innerHTML = `<div class="ps-pcard-empty" style="color:var(--error)">✕ ${esc(err.message)}</div>`;
  }
}

async function removeLgPackage(palletItemId, palletId) {
  if (!await wConfirmLg({ title: 'Remove Package', message: 'Remove this package from the pallet?', confirmText: 'Remove', variant: 'danger' })) return;
  try {
    const res  = await fetch(`/api/palletpackages/${palletItemId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Delete failed');
    const bodyEl = document.getElementById(`lg-pcard-body-${palletId}`);
    if (bodyEl) { bodyEl.dataset.loaded = '0'; await loadLgPalletPackages(palletId, bodyEl); bodyEl.dataset.loaded = '1'; }
  } catch (err) { wAlertLg(err.message); }
}

async function deleteLgPallet(palletId) {
  if (!await wConfirmLg({ title: 'Delete Pallet', message: 'Delete this pallet and all its packages?\nThis cannot be undone.', confirmText: 'Delete', variant: 'danger' })) return;
  try {
    const res  = await fetch(`/api/palletmain/${palletId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palletRemoved: 1 }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Delete failed');
    await showLgPalletList();
  } catch (err) { wAlertLg(err.message); }
}

async function openLgEditPalletView(palletId) {
  const { deliveryId, destName } = _lgPalletCtx || {};
  openModal(`<div class="ps-modal" style="max-width:560px;width:92vw">
    <div class="ps-modal-header">
      <div>
        <div class="ps-modal-title">Edit Pallet <span style="font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--accent)">#${palletId}</span></div>
        <div class="ps-modal-sub">Delivery #${esc(String(deliveryId))} · ${esc(destName)}</div>
      </div>
      <button class="ps-modal-close" onclick="closePickModal()">✕</button>
    </div>
    <div class="ps-modal-body" id="lg-edit-pallet-body">
      <div class="sap-loading"><div class="spinner"></div>Loading…</div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="showLgPalletList()">&larr; Back</button>
      <button class="btn-submit" id="lg-edit-pallet-save" disabled>Save Changes</button>
    </div>
  </div>`);
  try {
    if (!_lgPalletTypes.length) {
      const ptRes = await fetch('/api/palletdata').then(r => r.json());
      _lgPalletTypes = ptRes.data || ptRes;
    }
    const palRes = await fetch(`/api/palletmain/id/${palletId}`).then(r => r.json());
    const pallet = (palRes.data || palRes)[0];
    if (!pallet) throw new Error('Pallet not found');

    const typeOptions = _lgPalletTypes.map(t =>
      `<option value="${esc(t.palletID)}" ${t.palletID === pallet.palletType ? 'selected' : ''}
        data-l="${t.palletLength ?? ''}" data-w="${t.palletWidth ?? ''}" data-h="${t.palletHeight ?? ''}"
      >${esc(t.palletID)} — ${esc(t.palletDescription || '')}</option>`
    ).join('');

    document.getElementById('lg-edit-pallet-body').innerHTML = `
      <form class="transfer-form" style="padding:0">
        <div class="tf-section-label">Pallet Properties</div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Type <span class="tf-req">*</span></label>
            <select class="tf-input" id="lg-ep-type">
              <option value="">— Select —</option>${typeOptions}
            </select>
          </div>
          <div class="tf-field">
            <label class="tf-label">Location</label>
            <input class="tf-input" id="lg-ep-location" type="text" maxlength="50"
              placeholder="e.g. WH-A1" value="${esc(pallet.palletLocation ?? '')}">
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Gross Weight (kg)</label>
            <input class="tf-input" id="lg-ep-weight" type="number" step="0.001" min="0"
              value="${pallet.grossWeight ?? ''}">
          </div>
          <div class="tf-field">
            <label class="tf-label">Length (cm)</label>
            <input class="tf-input" id="lg-ep-length" type="number" step="1" min="0"
              value="${pallet.palletLength ?? ''}">
          </div>
          <div class="tf-field">
            <label class="tf-label">Width (cm)</label>
            <input class="tf-input" id="lg-ep-width" type="number" step="1" min="0"
              value="${pallet.palletWidth ?? ''}">
          </div>
          <div class="tf-field">
            <label class="tf-label">Height (cm)</label>
            <input class="tf-input" id="lg-ep-height" type="number" step="1" min="0"
              value="${pallet.palletHeight ?? ''}">
          </div>
        </div>
        <div class="tf-row">
          <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;color:var(--text)">
            <input type="checkbox" id="lg-ep-finished" style="width:16px;height:16px"
              ${pallet.palletFinish ? 'checked' : ''}>
            Mark as Finished
          </label>
        </div>
        <div id="lg-ep-result" style="margin-top:10px"></div>
      </form>`;

    document.getElementById('lg-ep-type').addEventListener('change', function () {
      const opt = this.options[this.selectedIndex];
      if (opt.dataset.l) document.getElementById('lg-ep-length').value = opt.dataset.l;
      if (opt.dataset.w) document.getElementById('lg-ep-width').value  = opt.dataset.w;
      if (opt.dataset.h) document.getElementById('lg-ep-height').value = opt.dataset.h;
    });

    const saveBtn = document.getElementById('lg-edit-pallet-save');
    saveBtn.disabled = false;
    saveBtn.addEventListener('click', async () => {
      const payload = {
        palletType:     document.getElementById('lg-ep-type').value || undefined,
        palletLocation: document.getElementById('lg-ep-location').value.trim() || null,
        grossWeight:    parseFloat(document.getElementById('lg-ep-weight').value)  || undefined,
        palletLength:   parseInt(document.getElementById('lg-ep-length').value, 10) || undefined,
        palletWidth:    parseInt(document.getElementById('lg-ep-width').value,  10) || undefined,
        palletHeight:   parseInt(document.getElementById('lg-ep-height').value, 10) || undefined,
        palletFinish:   document.getElementById('lg-ep-finished').checked ? 1 : 0,
      };
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        const res  = await fetch(`/api/palletmain/${palletId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Save failed');
        await showLgPalletList();
      } catch (err) {
        document.getElementById('lg-ep-result').innerHTML =
          `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
        saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
      }
    });
  } catch (err) {
    document.getElementById('lg-edit-pallet-body').innerHTML =
      `<div class="sap-error" style="padding:24px">✕ ${esc(err.message)}</div>`;
  }
}

async function openLgAddPalletView() {
  const { deliveryId, destName } = _lgPalletCtx || {};
  openModal(`<div class="ps-modal" style="max-width:640px;width:92vw">
    <div class="ps-modal-header">
      <div>
        <div class="ps-modal-title">Add Pallet</div>
        <div class="ps-modal-sub">Delivery #${esc(String(deliveryId))} · ${esc(destName)}</div>
      </div>
      <button class="ps-modal-close" onclick="closePickModal()">✕</button>
    </div>
    <div class="ps-modal-body" id="lg-add-pallet-body">
      <div class="sap-loading"><div class="spinner"></div>Loading pallet types…</div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="showLgPalletList()">&larr; Back</button>
      <button class="btn-submit" id="lg-add-create-btn" disabled onclick="createLgPallet()">Create Pallet →</button>
    </div>
  </div>`);
  try {
    if (!_lgPalletTypes.length) {
      const ptRes    = await fetch('/api/palletdata').then(r => r.json());
      _lgPalletTypes = ptRes.data || ptRes;
    }
    _lgSelPType = null;
    const typeCards = _lgPalletTypes.map(t => {
      const dims = [t.palletLength, t.palletWidth, t.palletHeight].filter(Boolean).join('×');
      return `<div class="lg-ptype-card" data-id="${esc(t.palletID)}"
        onclick="selectLgPalletType('${esc(t.palletID)}')">
        <div class="lg-ptype-code">${esc(t.palletID)}</div>
        <div class="lg-ptype-desc">${esc(t.palletDescription || '')}</div>
        ${dims ? `<div class="lg-ptype-dims">${dims} cm</div>` : ''}
        ${t.palletWeight != null ? `<div class="lg-ptype-dims">${t.palletWeight} kg</div>` : ''}
      </div>`;
    }).join('');
    document.getElementById('lg-add-pallet-body').innerHTML = `
      <div style="padding:16px 16px 0">
        <div class="tf-section-label" style="margin-bottom:12px">Select Pallet Type</div>
        <div class="lg-ptype-grid">${typeCards}</div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Location <span class="tf-optional">(optional)</span></label>
            <input class="tf-input" id="lg-add-location" type="text"
              maxlength="50" placeholder="e.g. WH-A1" autocomplete="off">
          </div>
        </div>
        <div id="lg-add-result" style="margin-top:8px"></div>
      </div>`;
  } catch (err) {
    document.getElementById('lg-add-pallet-body').innerHTML =
      `<div class="sap-error" style="padding:24px">✕ ${esc(err.message)}</div>`;
  }
}

function selectLgPalletType(typeId) {
  _lgSelPType = typeId;
  document.querySelectorAll('.lg-ptype-card').forEach(c =>
    c.classList.toggle('selected', c.dataset.id === typeId)
  );
  const btn = document.getElementById('lg-add-create-btn');
  if (btn) btn.disabled = false;
}

async function createLgPallet() {
  if (!_lgSelPType) return;
  const { deliveryId } = _lgPalletCtx || {};
  const td       = _lgPalletTypes.find(t => t.palletID === _lgSelPType);
  const location = document.getElementById('lg-add-location')?.value.trim() || null;
  const btn      = document.getElementById('lg-add-create-btn');
  const resultEl = document.getElementById('lg-add-result');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const palRes  = await fetch('/api/palletmain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        palletType: _lgSelPType, palletFinish: 0,
        packagingWeight: Number(td?.palletWeight || 0), grossWeight: 0, palletVolume: 0,
        palletLength: td?.palletLength ?? null, palletWidth: td?.palletWidth ?? null,
        palletHeight: td?.palletHeight ?? null, palletRemoved: 0, palletCategory: null,
        palletLocation: location, palletCreationDate: new Date().toISOString(), palletFinishDate: null,
      }),
    });
    const palJson = await palRes.json();
    if (!palRes.ok) throw new Error(palJson.error || 'Failed to create pallet');

    const linkRes  = await fetch(`/api/deliverymain/${encodeURIComponent(deliveryId)}/pallets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ palletId: palJson.palletID }),
    });
    const linkJson = await linkRes.json();
    if (!linkRes.ok) throw new Error(linkJson.error || 'Failed to link pallet');
    await showLgPalletList();
  } catch (err) {
    if (resultEl) resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
    btn.disabled = false; btn.textContent = 'Create Pallet →';
  }
}

function wAlertLg(message, title = 'Error') {
  return wConfirmLg({ title, message, confirmText: 'OK', variant: 'danger' });
}

function wConfirmLg({ title, message, confirmText = 'Confirm', variant = '' }) {
  return new Promise(resolve => {
    document.getElementById('wc-lg-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'wc-lg-modal'; overlay.className = 'wc-overlay';
    const icon = variant === 'danger' ? '⚠' : variant === 'success' ? '✓' : '?';
    overlay.innerHTML = `
      <div class="wc-modal">
        <div class="wc-icon">${icon}</div>
        <div class="wc-title">${esc(title)}</div>
        <div class="wc-message">${esc(message).replace(/\n/g, '<br>')}</div>
        <div class="wc-actions">
          <button class="wc-btn-cancel">Cancel</button>
          <button class="wc-btn-confirm${variant ? ' wc-btn-confirm--' + variant : ''}">${esc(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = r => { overlay.remove(); resolve(r); };
    overlay.querySelector('.wc-btn-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.wc-btn-confirm').addEventListener('click', () => close(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
  });
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
      <button class="btn-secondary" id="col-clear-btn" disabled>Clear</button>
      ${hasPlanning() ? `
        <button class="btn-secondary" id="col-date-btn"    disabled>Update Date</button>
        <button class="btn-secondary" id="col-loading-btn" disabled>Loading List</button>
        <button class="btn-secondary" id="col-unbook-btn"  disabled style="color:var(--error,#DC2626)">Unbook</button>
        <button class="btn-submit"    id="col-collect-btn" disabled>Mark Collected</button>
      ` : `<span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--text-muted)" title="Requires LOG_PLANNING permission">View only</span>`}
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
  document.getElementById('col-unbook-btn')?.addEventListener('click', unbookSelected);
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
  document.getElementById('col-clear-btn')?.toggleAttribute('disabled', count === 0);
  ['col-date-btn', 'col-loading-btn', 'col-unbook-btn', 'col-collect-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = count === 0 || !hasPlanning();
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
          <div class="tf-field"><label class="tf-label">Operator Name</label><input class="tf-input" id="cl-operator" type="text" placeholder="e.g. Jim Smith" value="${esc(sessionUsername)}"></div>
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


// Sends a shipment back to Awaiting Booking instead of the previous manual
// route (ticking Booking Status off in Edit Dates & Status), which left its
// ShipmentCost row behind — re-booking then inserted a second one,
// duplicating the freight cost. This also clears the planned collection
// date and tracking number, since both get re-entered when it's re-booked
// (possibly with a different haulier).
async function unbookSelected() {
  const rows = getSelectedCollectionRows();
  if (!rows.length) return;
  if (!await wConfirmLg({
    title: 'Unbook Shipment(s)',
    message: `Unbook ${rows.length} shipment(s)? This clears their expected freight cost, planned collection date and tracking number, and moves them back to Awaiting Booking.`,
    confirmText: 'Unbook',
    variant: 'danger',
  })) return;
  try {
    const res = await fetch('/api/shipmentmain/unbook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipmentIDs: rows.map(r => r.shipmentID) }),
    });
    const json = await res.json();
    if (!json.success && !json.data?.completed?.length) throw new Error(json.error || 'Failed to unbook shipments.');
    const { completed = [], failed = [] } = json.data || {};
    showCollectionMsg(
      [completed.length ? `${completed.length} shipment(s) unbooked.` : '',
       failed.length    ? `${failed.length} failed: ${failed.map(f => f.error).join('; ')}` : ''].filter(Boolean).join(' '),
      failed.length === 0
    );
    await runShipmentQueue('awaiting-collection');
  } catch (err) {
    showCollectionMsg(err.message);
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
      <div class="sd-grid" style="margin-bottom:16px">
        <div class="sd-section">
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
      <div class="sd-section" style="margin-bottom:16px">
        <div class="sd-section-title">Associated Costs</div>
        <div id="sd-costs">
          <div class="sap-loading"><div class="spinner"></div>Loading...</div>
        </div>
      </div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="openShipmentEventLog(${shipment.shipmentID}, '${esc(shipmentRef)}')">Event Log</button>
      ${hasPlanning() ? `<button class="btn-secondary" onclick="openShipmentStatusEdit(${shipment.shipmentID}, '${esc(shipmentRef)}')">Edit Dates &amp; Status</button>` : ''}
      <button class="btn-secondary" onclick="closePickModal()">Close</button>
    </div>
  </div>`;

  renderShipmentAssociatedCosts(shipment.shipmentID);

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
    if (!await wConfirmLg({ title: 'Generate Packing List', message: 'This will overwrite any existing packing list files for this shipment. Continue?', confirmText: 'Generate', variant: '' })) return;
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


// ── Associated Costs (Search Shipment / Shipment Details modal, outbound) ──
// Mirrors renderAssociatedCosts (Inbound Log detail) — list, edit/remove
// while unprocessed, and show the material document + a Reverse option once
// posted. Edit only covers the amount (PATCH /api/shipmentcost/:costId) —
// GL element/cost centre are set at booking time (or on the add form below)
// and not editable afterwards.
//
// "+ Add Cost" (GL Account / Cost Type / Cost Centre / Amount, POST to
// generic POST /api/shipmentcost) covers the ad-hoc case booking-time
// freight/customs creation doesn't: an extra cost incurred after booking —
// e.g. actual customs duties charged on the shipment (GL 603100, distinct
// from 603120 "Customs Clearance", the forwarder's own handling fee that's
// already estimated automatically for KN shipments). GL Account options are
// restricted to direction='outbound' CostElements, same restriction the
// GET /shipment/:id join already applies when displaying existing lines.
async function renderShipmentAssociatedCosts(shipmentId) {
  const container = document.getElementById('sd-costs');
  if (!container) return;
  try {
    const res = await fetch(`/api/shipmentcost/shipment/${shipmentId}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load costs');
    const lines = json.data || [];

    const rows = lines.map(l => `
      <tr class="admin-row">
        <td>${esc(l.elementDescription || l.costElement || '—')}</td>
        <td>£${Number(l.expectedCost).toFixed(2)}</td>
        <td>${l.migoStatus
          ? `<span style="color:var(--success,#059669)">Posted — ${esc(l.materialDocument || '')}</span>`
          : '<span style="color:var(--text-secondary,#666)">Pending</span>'}</td>
        <td style="white-space:nowrap">${l.migoStatus
          ? `<button type="button" class="btn-secondary sd-cost-reverse" data-cost-id="${l.costID}" style="padding:2px 8px;font-size:11px">Reverse</button>`
          : `<button type="button" class="btn-secondary sd-cost-edit" data-cost-id="${l.costID}" data-amount="${esc(String(l.expectedCost))}" style="padding:2px 8px;font-size:11px">Edit</button>
             <button type="button" class="btn-secondary sd-cost-delete" data-cost-id="${l.costID}" style="padding:2px 8px;font-size:11px">Remove</button>`}</td>
      </tr>`).join('');

    container.innerHTML = `
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>GL Element</th><th>Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows.length ? rows : '<tr><td colspan="4" style="color:var(--text-secondary,#666)">No cost lines yet</td></tr>'}</tbody>
        </table>
      </div>
      <div class="tf-row" style="margin-top:10px;align-items:flex-end;flex-wrap:wrap;gap:8px">
        <div class="tf-field">
          <label class="tf-label">GL Account</label>
          <select class="tf-input" id="sd-cost-element" style="min-width:220px"></select>
        </div>
        <div class="tf-field">
          <label class="tf-label">Cost Type</label>
          <select class="tf-input" id="sd-cost-type" style="min-width:140px"></select>
        </div>
        <div class="tf-field">
          <label class="tf-label">Cost Centre</label>
          <select class="tf-input" id="sd-cost-center" style="min-width:180px"></select>
        </div>
        <div class="tf-field">
          <label class="tf-label">Amount (£)</label>
          <input class="tf-input" type="number" step="0.01" min="0.01" id="sd-cost-amount" style="width:110px">
        </div>
        <div class="tf-field">
          <button type="button" class="btn-secondary" id="sd-cost-add-btn">+ Add Cost</button>
        </div>
      </div>
      <div id="sd-cost-result" style="margin-top:8px"></div>`;

    // GL Account options — outbound CostElements only, same restriction the
    // display join above already applies. Reuses Material Group Mapping's
    // cached loader (mgmLoadCostElements) rather than a separate fetch —
    // that list already covers every direction, just filtered here.
    mgmLoadCostElements().then(elements => {
      const sel = document.getElementById('sd-cost-element');
      if (!sel) return;
      const outboundElements = elements.filter(e => e.direction === 'outbound');
      sel.innerHTML = outboundElements.map(e =>
        `<option value="${esc(e.elementCode)}">${esc(e.elementCode)} — ${esc(e.elementDescription || '')}</option>`
      ).join('');
      // Default to Customs Duties (603100) when present — the case this
      // form was built for — otherwise leave the first option selected.
      const customsDuties = outboundElements.find(e => e.elementCode === '603100');
      if (customsDuties) sel.value = '603100';
    });

    // Cost Type options — Logistics.dbo.CostTypes (1 General Freight, 2
    // Customs). Defaults to Customs to match the GL Account default above.
    fetch('/api/costtypes').then(r => r.json()).then(types => {
      const sel = document.getElementById('sd-cost-type');
      if (!sel || !Array.isArray(types)) return;
      sel.innerHTML = types.map(t =>
        `<option value="${esc(String(t.typeID))}">${esc(t.typeDescription || '')}</option>`
      ).join('');
      const customs = types.find(t => String(t.typeID) === '2');
      if (customs) sel.value = '2';
    }).catch(() => {});

    // Cost Centre options — same default (PTFE, 0000002004) as the booking
    // modal's cost-centre dropdown.
    fetch('/api/costcenters').then(r => r.json()).then(data => {
      const sel = document.getElementById('sd-cost-center');
      if (!sel) return;
      const centres = Array.isArray(data) ? data : (data.data || []);
      sel.innerHTML = centres.map(c =>
        `<option value="${esc(c.centerCode || '')}">${esc(c.centerCode || '')} — ${esc(c.centerDescription || '')}</option>`
      ).join('');
      const def = centres.find(c => c.centerCode === '0000002004');
      if (def) sel.value = '0000002004';
    }).catch(() => {});

    document.getElementById('sd-cost-add-btn').addEventListener('click', async () => {
      const btn = document.getElementById('sd-cost-add-btn');
      const result = document.getElementById('sd-cost-result');
      const costElement = document.getElementById('sd-cost-element').value;
      const costType = document.getElementById('sd-cost-type').value;
      const costCenter = document.getElementById('sd-cost-center').value;
      const amount = document.getElementById('sd-cost-amount').value;

      if (!costElement) { result.innerHTML = '<div class="sap-error">Select a GL Account.</div>'; return; }
      if (!costCenter) { result.innerHTML = '<div class="sap-error">Select a Cost Centre.</div>'; return; }
      const amountNum = Number(amount);
      if (!amountNum || amountNum <= 0) { result.innerHTML = '<div class="sap-error">Enter an amount greater than 0.</div>'; return; }

      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        // POST /api/shipmentcost is the generic create endpoint (no
        // {success:true} wrapper — see routes/shipmentcost.js) — check the
        // HTTP status / costID rather than a success flag.
        const res2 = await fetch('/api/shipmentcost', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shipmentID: shipmentId, costType, costElement, costCenter, expectedCost: amountNum }),
        });
        const json2 = await res2.json();
        if (!res2.ok || !json2.costID) throw new Error(json2.error || 'Failed to add cost');
        renderShipmentAssociatedCosts(shipmentId);
      } catch (err) {
        result.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = '+ Add Cost';
      }
    });

    document.querySelectorAll('.sd-cost-edit').forEach(b => {
      b.addEventListener('click', () => {
        openSdCostEditModal(b.dataset.costId, b.dataset.amount, shipmentId);
      });
    });

    document.querySelectorAll('.sd-cost-delete').forEach(b => {
      b.addEventListener('click', async () => {
        try {
          const res2 = await fetch(`/api/shipmentcost/${b.dataset.costId}`, { method: 'DELETE' });
          const json2 = await res2.json();
          if (!json2.success) throw new Error(json2.error || 'Failed to remove cost');
          renderShipmentAssociatedCosts(shipmentId);
        } catch (err) {
          document.getElementById('sd-cost-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
        }
      });
    });

    document.querySelectorAll('.sd-cost-reverse').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('Reverse this posting in SAP? This creates a reversing material document — the line will drop back into Unprocessed Costs afterwards.')) return;
        b.disabled = true; b.textContent = 'Reversing…';
        try {
          const res2 = await fetch(`/api/shipmentcost/${b.dataset.costId}/reverse`, { method: 'POST' });
          const json2 = await res2.json();
          if (!json2.success) throw new Error(json2.error || json2.message || 'Reversal failed');
          renderShipmentAssociatedCosts(shipmentId);
        } catch (err) {
          document.getElementById('sd-cost-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
          b.disabled = false; b.textContent = 'Reverse';
        }
      });
    });

  } catch (err) {
    container.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

// ── Edit an unprocessed outbound cost line's amount ──
// PATCH /api/shipmentcost/:costId — only the amount is editable here (GL
// element/cost centre are set automatically at booking time).
function openSdCostEditModal(costId, currentAmount, shipmentId) {
  openModal(`<div class="ps-modal" style="max-width:420px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Edit Cost Amount</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Amount (£)</label>
          <input class="tf-input" type="number" step="0.01" min="0.01" id="sd-cost-edit-amount" value="${esc(String(currentAmount))}">
        </div>
      </div>
      <div id="sd-cost-edit-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="sd-cost-edit-save-btn">Save Changes</button>
    </div>
  </div>`);

  document.getElementById('sd-cost-edit-save-btn').addEventListener('click', async () => {
    const amount = Number(document.getElementById('sd-cost-edit-amount').value);
    if (!Number.isFinite(amount) || amount <= 0) {
      document.getElementById('sd-cost-edit-result').innerHTML = '<div class="sap-error">Enter a valid amount.</div>';
      return;
    }
    const btn = document.getElementById('sd-cost-edit-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch(`/api/shipmentcost/${costId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedCost: amount }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed to save');
      closePickModal();
      renderShipmentAssociatedCosts(shipmentId);
    } catch (err) {
      document.getElementById('sd-cost-edit-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Save Changes';
    }
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
    const shipmentTerms = String(shipment.incoTerms || '').trim().toUpperCase();
    const availRows = available.map(d => {
      const effectiveTerm = String(d.incoterms || d.defaultIncoterms || '').trim().toUpperCase();
      const conflicts     = shipmentTerms && effectiveTerm && effectiveTerm !== shipmentTerms;
      const rowStyle      = conflicts ? ' style="opacity:0.45;pointer-events:none" title="Incoterms mismatch: delivery is ' + effectiveTerm + ', shipment is ' + shipmentTerms + '"' : '';
      return `<tr${rowStyle}>
        <td class="lg-check-cell"><input type="checkbox" class="sd-avail-check" data-id="${esc(String(d.deliveryID))}"${conflicts ? ' disabled' : ''}></td>
        <td>${esc(String(d.deliveryID))}</td>
        <td>${esc(d.destinationName || d.deliveryService || '—')}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${esc(effectiveTerm || '—')}</td>
        <td>${Number(d.grossWeight || 0).toFixed(3)}</td>
        <td>${Number(d.palletCount || 0).toFixed(0)}</td>
      </tr>`;
    }).join('');
    availHtml = `<table class="sd-delivery-table">
      <thead><tr><th></th><th>Delivery</th><th>Destination</th><th>Incoterms</th><th>Gross kg</th><th>Pallets</th></tr></thead>
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
      <button class="btn-secondary" id="sd-back-btn">&larr; Back</button>
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
      if (!await wConfirmLg({ title: 'Remove Delivery', message: msg, confirmText: 'Remove', variant: 'danger' })) return;
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
    let inputEl;
    if (f.type === 'select') {
      // f.options is a plain list of strings (the value doubles as the label —
      // matches how these fields are stored, e.g. Destinations.defaultForwarder
      // holds the forwarder's name, not a foreign-key id). The current value is
      // always included even if it's no longer in the options list (a stale
      // free-text value from before this was a dropdown, or a forwarder that's
      // since been unapproved/renamed) so saving without changing it is a no-op
      // rather than silently blanking the field.
      const opts = [...new Set(f.options || [])];
      if (raw && !opts.includes(raw)) opts.unshift(raw);
      const optionsHtml = ['<option value=""></option>', ...opts.map(o =>
        `<option value="${esc(o)}"${o === raw ? ' selected' : ''}>${esc(o)}</option>`
      )].join('');
      inputEl = `<select id="aed-${f.key}" class="tf-input">${optionsHtml}</select>`;
    } else if (f.multiline) {
      inputEl = `<textarea id="aed-${f.key}" class="tf-input" rows="2" style="resize:vertical">${esc(raw)}</textarea>`;
    } else {
      inputEl = `<input id="aed-${f.key}" class="tf-input" type="${f.type || 'text'}"${f.step ? ` step="${f.step}"` : ''} value="${raw.replace(/"/g, '&quot;')}">`;
    }
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
  showResultPanel('Update Destinations', 'Click a row to edit · Tick rows for bulk actions');
  try {
    const [rows, approvedForwarders, forwarderModes] = await Promise.all([
      fetch('/api/destinations').then(r => r.json()),
      fetch('/api/forwarders/approved').then(r => r.json()).catch(() => []),
      fetch('/api/forwarders/modes').then(r => r.json()).catch(() => []),
    ]);
    if (!Array.isArray(rows) || !rows.length) {
      document.getElementById('result-body').innerHTML = '<div class="sap-error">No destinations found.</div>';
      return;
    }

    // Default Forwarder is stored as the forwarder's name (not an id — matches
    // how the pallet/shipment builder already matches it against forwarder
    // options elsewhere), Default Service against the distinct delivery modes
    // of approved forwarders. Both back the dropdowns below instead of free text.
    const forwarderOptions = [...new Set(
      (Array.isArray(approvedForwarders) ? approvedForwarders : [])
        .map(f => String(f.forwarderName ?? '').trim())
        .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));
    const serviceOptions = [...new Set(
      (Array.isArray(forwarderModes) ? forwarderModes : [])
        .map(m => String(m.forwarderMode ?? '').trim())
        .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));

    rows.sort((a, b) => (a.destinationName ?? '').localeCompare(b.destinationName ?? ''));

    document.getElementById('result-row-badge').textContent = `${rows.length} destinations`;
    document.getElementById('result-row-badge').classList.remove('hidden');

    const thead = `<tr>
      <th style="width:36px;text-align:center"><input type="checkbox" id="dest-select-all" title="Select all"></th>
      <th>ID</th><th>Name</th><th>City</th><th>Country</th><th>Zone</th><th>Def. Service</th><th>Def. Forwarder</th>
    </tr>`;
    const tbody = rows.map((r, i) => `<tr class="admin-row" data-idx="${i}" data-id="${esc(String(r.destinationID))}" style="cursor:pointer">
      <td class="dest-check-cell" style="text-align:center" onclick="event.stopPropagation()">
        <input type="checkbox" class="dest-row-check" data-id="${esc(String(r.destinationID))}">
      </td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted)">${esc(String(r.destinationID))}</td>
      <td><strong>${esc(r.destinationName      ?? '')}</strong></td>
      <td>${esc(r.destinationCity              ?? '')}</td>
      <td>${esc(r.destinationCountry           ?? '')}</td>
      <td class="dest-cell-zone">${esc(r.destinationZone        ?? '')}</td>
      <td class="dest-cell-service">${esc(r.defaultDeliveryService ?? '')}</td>
      <td class="dest-cell-forwarder">${esc(r.defaultForwarder   ?? '')}</td>
    </tr>`).join('');

    document.getElementById('result-body').innerHTML = `
      <div id="dest-bulk-bar" class="hidden" style="
        display:flex;align-items:center;gap:12px;flex-wrap:wrap;
        background:var(--surface2);border:1px solid var(--border);
        border-radius:8px;padding:10px 14px;margin-bottom:12px">
        <span id="dest-bulk-count" style="font-family:'JetBrains Mono',monospace;font-size:11px;
          font-weight:700;color:var(--accent);white-space:nowrap">0 selected</span>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:1">
          <div style="display:flex;gap:5px;align-items:center">
            <select id="dest-bulk-forwarder" class="tf-input" style="width:160px">
              <option value="">Default Forwarder…</option>
              ${forwarderOptions.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
            </select>
            <button class="btn-secondary" data-bulk-field="defaultForwarder" data-bulk-input="dest-bulk-forwarder">Apply</button>
          </div>
          <div style="display:flex;gap:5px;align-items:center">
            <select id="dest-bulk-service" class="tf-input" style="width:140px">
              <option value="">Default Service…</option>
              ${serviceOptions.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
            </select>
            <button class="btn-secondary" data-bulk-field="defaultDeliveryService" data-bulk-input="dest-bulk-service">Apply</button>
          </div>
          <div style="display:flex;gap:5px;align-items:center">
            <input id="dest-bulk-zone" class="tf-input" placeholder="Zone" style="width:100px">
            <button class="btn-secondary" data-bulk-field="destinationZone" data-bulk-input="dest-bulk-zone">Apply</button>
          </div>
          <button id="dest-bulk-delete" class="btn-submit" style="margin-left:auto;background:var(--error,#DC2626)">
            Delete Selected
          </button>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
      </div>`;

    // ── Selection state ───────────────────────────────────────────────────────
    const selectedIds = new Set();

    function updateBulkBar() {
      const bar   = document.getElementById('dest-bulk-bar');
      const count = document.getElementById('dest-bulk-count');
      if (!bar || !count) return;
      if (selectedIds.size) {
        bar.classList.remove('hidden');
        count.textContent = `${selectedIds.size} selected`;
      } else {
        bar.classList.add('hidden');
      }
    }

    document.getElementById('dest-select-all').addEventListener('change', function () {
      document.querySelectorAll('.dest-row-check').forEach(cb => {
        cb.checked = this.checked;
        const id = Number(cb.dataset.id);
        if (this.checked) selectedIds.add(id); else selectedIds.delete(id);
      });
      updateBulkBar();
    });

    document.querySelectorAll('.dest-row-check').forEach(cb => {
      cb.addEventListener('change', function () {
        const id = Number(this.dataset.id);
        if (this.checked) selectedIds.add(id); else selectedIds.delete(id);
        const all = document.querySelectorAll('.dest-row-check');
        document.getElementById('dest-select-all').checked = [...all].every(c => c.checked);
        updateBulkBar();
      });
    });

    // ── Bulk apply ────────────────────────────────────────────────────────────
    document.querySelectorAll('[data-bulk-field]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!selectedIds.size) return;
        const field    = btn.dataset.bulkField;
        const inputId  = btn.dataset.bulkInput;
        const value    = document.getElementById(inputId)?.value?.trim() ?? '';
        const original = btn.textContent;
        btn.disabled = true; btn.textContent = 'Applying…';

        try {
          const res  = await fetch('/api/destinations/bulk', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [...selectedIds], field, value }),
          });
          const json = await res.json();
          if (!json.success) throw new Error(json.error || 'Update failed');

          // Patch visible cells and local data
          const cellClass = { defaultForwarder: 'dest-cell-forwarder', defaultDeliveryService: 'dest-cell-service', destinationZone: 'dest-cell-zone' }[field];
          const fieldKey  = { defaultForwarder: 'defaultForwarder', defaultDeliveryService: 'defaultDeliveryService', destinationZone: 'destinationZone' }[field];
          document.querySelectorAll(`.admin-row`).forEach(tr => {
            if (!selectedIds.has(Number(tr.dataset.id))) return;
            const cell = tr.querySelector(`.${cellClass}`);
            if (cell) cell.textContent = value;
            const idx = parseInt(tr.dataset.idx, 10);
            if (rows[idx]) rows[idx][fieldKey] = value;
          });
          btn.textContent = '✓';
          setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 1200);
        } catch (err) {
          btn.disabled = false; btn.textContent = original;
          wAlertLg(err.message);
        }
      });
    });

    // ── Bulk delete ───────────────────────────────────────────────────────────
    document.getElementById('dest-bulk-delete').addEventListener('click', async () => {
      if (!selectedIds.size) return;
      if (!await wConfirmLg({ title: 'Delete Destinations', message: `Permanently delete ${selectedIds.size} destination${selectedIds.size !== 1 ? 's' : ''}? This cannot be undone.`, confirmText: 'Delete', variant: 'danger' })) return;
      const btn = document.getElementById('dest-bulk-delete');
      btn.disabled = true; btn.textContent = 'Deleting…';
      try {
        const res  = await fetch('/api/destinations/bulk', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [...selectedIds] }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Delete failed');
        runUpdateDestinations();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Delete Selected';
        wAlertLg(err.message);
      }
    });

    // ── Row click → edit modal ────────────────────────────────────────────────
    document.querySelectorAll('.admin-row').forEach(tr => {
      tr.addEventListener('click', async e => {
        if (e.target.closest('.dest-check-cell')) return;
        const r = rows[parseInt(tr.dataset.idx, 10)];

        let currentEmails = '';
        try {
          const emailRes  = await fetch(`/api/destinations/${encodeURIComponent(r.destinationID)}/emails`);
          const emailJson = await emailRes.json();
          currentEmails   = (emailJson.addresses || []).join('\n');
        } catch (_) {}

        openAdminEditModal(
          `Edit Destination — ${r.destinationID}`,
          r.destinationName || '',
          [
            { key: 'destinationName',        label: 'Name',                          wide: true },
            { key: 'destinationStreet',      label: 'Street',                        wide: true },
            { key: 'destinationCity',        label: 'City' },
            { key: 'destinationPostCode',    label: 'Post Code' },
            { key: 'destinationCountry',     label: 'Country' },
            { key: 'destinationZone',        label: 'Zone' },
            { key: 'defaultDeliveryService', label: 'Default Service',   type: 'select', options: serviceOptions },
            { key: 'defaultIncoterms',       label: 'Incoterms' },
            { key: 'defaultForwarder',       label: 'Default Forwarder', type: 'select', options: forwarderOptions },
            { key: 'emails',                 label: 'Email Addresses (one per line)', wide: true, multiline: true },
            { key: 'destinationComment',     label: 'Comment',                       wide: true, multiline: true },
          ],
          { ...r, emails: currentEmails },
          async values => {
            const { emails, ...destValues } = values;
            const res2 = await fetch(`/api/destinations/${encodeURIComponent(r.destinationID)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(destValues),
            });
            const json = await res2.json();
            if (!json.success) throw new Error(json.error || 'Save failed');

            const addresses = emails.split('\n').map(a => a.trim()).filter(Boolean);
            const emailRes2  = await fetch(`/api/destinations/${encodeURIComponent(r.destinationID)}/emails`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ addresses }),
            });
            const emailJson2 = await emailRes2.json();
            if (!emailJson2.success) throw new Error(emailJson2.error || 'Email save failed');

            Object.assign(r, destValues);
          }
        );
      });
    });
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

// ── Admin: Update Forwarders ──────────────────────────────────────────────────
// forwarderID doubles as the SAP vendor code (confirmed with the user — no
// separate mapping column), so unlike Destinations there's an explicit
// "Add Forwarder" flow that asks for it up front rather than an
// auto-generated id.
async function runUpdateForwarders() {
  showResultPanel('Update Forwarders', 'Click a row to edit · Add Forwarder for a new haulier');
  try {
    const rows = await fetch('/api/forwarders').then(r => r.json());
    if (!Array.isArray(rows)) throw new Error('Failed to load forwarders');

    rows.sort((a, b) => (a.forwarderName ?? '').localeCompare(b.forwarderName ?? ''));

    document.getElementById('result-row-badge').textContent = `${rows.length} forwarders`;
    document.getElementById('result-row-badge').classList.remove('hidden');

    const thead = `<tr><th>Vendor Code</th><th>Name</th><th>Delivery Mode</th><th>Approved</th></tr>`;
    const tbody = rows.map((r, i) => `<tr class="admin-row" data-idx="${i}" style="cursor:pointer">
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted)">${esc(String(r.forwarderID))}</td>
      <td><strong>${esc(r.forwarderName ?? '')}</strong></td>
      <td>${esc(r.forwarderMode ?? '')}</td>
      <td>${r.forwarderApproval ? '<span style="color:var(--success,#059669)">Approved</span>' : '<span style="color:var(--text-secondary,#666)">Not approved</span>'}</td>
    </tr>`).join('');

    document.getElementById('result-body').innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
        <button type="button" class="btn-submit" id="fwd-add-btn">+ Add Forwarder</button>
      </div>
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
      </div>`;

    document.getElementById('fwd-add-btn').addEventListener('click', () => {
      openAdminEditModal(
        'Add Forwarder',
        'Vendor Code must match the SAP vendor number — reuse the same code with a different Delivery Mode to add another mode for an existing haulier',
        [
          { key: 'forwarderID',       label: 'Vendor Code (SAP)' },
          { key: 'forwarderName',     label: 'Name', wide: true },
          { key: 'forwarderMode',     label: 'Delivery Mode', type: 'select', options: OS_TRANSPORT_MODES },
          { key: 'forwarderApproval', label: 'Approved (yes/no)' },
        ],
        { forwarderID: '', forwarderName: '', forwarderMode: '', forwarderApproval: 'no' },
        async values => {
          if (!values.forwarderID || !values.forwarderName) throw new Error('Vendor Code and Name are required.');
          const res2 = await fetch('/api/forwarders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              forwarderID: values.forwarderID,
              forwarderName: values.forwarderName,
              forwarderMode: values.forwarderMode || null,
              forwarderApproval: /^y/i.test(values.forwarderApproval) ? 1 : 0,
            }),
          });
          const json = await res2.json();
          if (!json.success) throw new Error(json.error || 'Save failed');
          // Invalidate the haulier-dropdown caches (loadApprovedForwarders /
          // loadAllForwarders below) — they're only fetched once per page
          // load, so without this a newly-added/approved forwarder would be
          // correct in the DB and in this admin table (which always
          // refetches directly) but invisible in every haulier dropdown
          // until a hard page refresh.
          approvedForwarders = null;
          allForwarders = null;
          runUpdateForwarders();
        }
      );
    });

    document.querySelectorAll('.admin-row').forEach(tr => {
      tr.addEventListener('click', () => {
        const r = rows[parseInt(tr.dataset.idx, 10)];
        // originalMode pins the UPDATE to exactly this row — forwarderID
        // alone isn't unique when a vendor has one row per shipping mode
        // (see the PUT route's comment in routes/forwarders.js).
        const originalMode = r.forwarderMode || null;
        openAdminEditModal(
          `Edit Forwarder — ${r.forwarderID}`,
          `${r.forwarderName || ''}${r.forwarderMode ? ' · ' + r.forwarderMode : ''}`,
          [
            { key: 'forwarderName',     label: 'Name', wide: true },
            { key: 'forwarderMode',     label: 'Delivery Mode', type: 'select', options: OS_TRANSPORT_MODES },
            { key: 'forwarderApproval', label: 'Approved (yes/no)' },
          ],
          { ...r, forwarderApproval: r.forwarderApproval ? 'yes' : 'no' },
          async values => {
            const res2 = await fetch(`/api/forwarders/${encodeURIComponent(r.forwarderID)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                forwarderName: values.forwarderName,
                forwarderMode: values.forwarderMode || null,
                forwarderApproval: /^y/i.test(values.forwarderApproval) ? 1 : 0,
                originalMode,
              }),
            });
            const json = await res2.json();
            if (!json.success) throw new Error(json.error || 'Save failed');
            Object.assign(r, {
              forwarderName: values.forwarderName,
              forwarderMode: values.forwarderMode,
              forwarderApproval: /^y/i.test(values.forwarderApproval) ? 1 : 0,
            });
            // See the matching comment in the Add Forwarder handler above —
            // an approval/name/mode change here is just as invisible to the
            // haulier dropdowns until these caches are cleared.
            approvedForwarders = null;
            allForwarders = null;
            runUpdateForwarders();
          }
        );
      });
    });
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

// ── Admin: Material Group Mapping ─────────────────────────────────────────────
// SAP requires a real Material Group code (WGRU/MATKL, e.g. "ITLG01A") on
// every freight PO item — post-migo (routes/shipmentcost.js) used to build
// this as free text from modeOfTransport ("Road Freight" etc.), which isn't
// a valid SAP code and was the root cause of PO creation rolling back. This
// table (dbo.MaterialGroupMapping, see sql/migrate_material_group_mapping.sql)
// maps GL account + mode of transport to the real code, with a
// mode-independent default per GL account also supported (leave Mode of
// Transport blank when adding/editing).
let mgmCostElements = null; // cached GL account list — {elementCode, elementDescription, ...}[]

async function mgmLoadCostElements() {
  if (mgmCostElements) return mgmCostElements;
  const rows = await fetch('/api/costelements').then(r => r.json());
  mgmCostElements = Array.isArray(rows) ? rows : [];
  return mgmCostElements;
}

async function runMaterialGroupMapping() {
  showResultPanel('Material Group Mapping', 'Click a row to edit · Add Mapping for a new GL account / mode combination');
  try {
    const [mappingsResp] = await Promise.all([
      fetch('/api/material-groups').then(r => r.json()),
      mgmLoadCostElements(), // warm the cache the modal's GL Account dropdown needs
    ]);
    if (!mappingsResp.success) throw new Error(mappingsResp.error?.message || 'Failed to load material group mappings');
    mgmRenderList(mappingsResp.data);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

function mgmCostElementLabel(costElement) {
  // Matched by elementCode, not elementID — elementID is CostElements' own
  // surrogate PK and has no relationship to what's actually stored in
  // ShipmentCost.costElement / MaterialGroupMapping.CostElement. elementCode
  // (e.g. '602200') is the real SAP GL account short code both those columns
  // hold — see routes/shipmentmain.js's INSERT (costElement = item.elementCode).
  const match = (mgmCostElements || []).find(c => String(c.elementCode) === String(costElement));
  return match ? `${costElement} — ${match.elementDescription || ''}` : String(costElement);
}

function mgmRenderList(mappings) {
  document.getElementById('result-row-badge').textContent = `${mappings.length} mapping${mappings.length !== 1 ? 's' : ''}`;
  document.getElementById('result-row-badge').classList.remove('hidden');

  const rows = mappings.map(m => `
    <tr class="admin-row">
      <td style="font-family:'JetBrains Mono',monospace;font-size:12px">${esc(mgmCostElementLabel(m.CostElement))}</td>
      <td>${esc(m.ModeOfTransport || 'Any (default)')}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700">${esc(m.MaterialGroup)}</td>
      <td>${esc(m.Description || '—')}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn-secondary mgm-edit" data-id="${esc(String(m.MappingId))}" style="padding:3px 10px;font-size:11px">Edit</button>
        <button class="btn-secondary mgm-delete" data-id="${esc(String(m.MappingId))}" data-label="${esc(mgmCostElementLabel(m.CostElement))} / ${esc(m.ModeOfTransport || 'Any')}" style="padding:3px 10px;font-size:11px;color:var(--error,#DC2626)">Delete</button>
      </td>
    </tr>`).join('');

  document.getElementById('result-body').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button class="btn-submit" id="mgm-add-btn">+ Add Mapping</button>
    </div>
    ${mappings.length ? `
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>GL Account</th><th>Mode of Transport</th><th>Material Group</th><th>Description</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : '<div class="sap-empty">No mappings yet — add one so freight PO creation knows which SAP Material Group code to use for a GL account.</div>'}
  `;

  document.getElementById('mgm-add-btn').addEventListener('click', () => mgmOpenModal(null));
  document.querySelectorAll('.mgm-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = mappings.find(x => String(x.MappingId) === btn.dataset.id);
      if (m) mgmOpenModal(m);
    });
  });
  document.querySelectorAll('.mgm-delete').forEach(btn => {
    btn.addEventListener('click', () => mgmDeleteMapping(btn.dataset.id, btn.dataset.label));
  });
}

function mgmOpenModal(mapping) {
  const isEdit = !!mapping;

  // A mapping being edited might reference a GL account no longer in
  // costElements (deleted/renamed since) — keep it selectable rather than
  // silently swapping it for whatever option happens to be first.
  // Options are keyed on elementCode (the real GL account short code, e.g.
  // '602200') — NOT elementID, which is just CostElements' own surrogate PK
  // and has no relationship to what ShipmentCost.costElement actually holds.
  const currentInList = isEdit && (mgmCostElements || []).some(c => String(c.elementCode) === String(mapping.CostElement));
  const extraOption = isEdit && !currentInList
    ? `<option value="${esc(mapping.CostElement)}" selected>${esc(mapping.CostElement)} (not in GL Accounts list)</option>`
    : '';
  const costElementOptions = (mgmCostElements || [])
    .slice()
    .sort((a, b) => String(a.elementCode).localeCompare(String(b.elementCode)))
    .map(c => `<option value="${esc(c.elementCode)}" ${isEdit && String(mapping.CostElement) === String(c.elementCode) ? 'selected' : ''}>${esc(c.elementCode)} — ${esc(c.elementDescription || '')}</option>`)
    .join('');

  openModal(`<div class="ps-modal" style="max-width:520px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">${isEdit ? 'Edit Mapping' : 'Add Mapping'}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">GL Account</label>
          <select class="tf-input" id="mgm-cost-element">
            <option value=""></option>
            ${extraOption}
            ${costElementOptions}
          </select>
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Mode of Transport</label>
          <select class="tf-input" id="mgm-mode">
            <option value="">Any (default for this GL account)</option>
            ${OS_TRANSPORT_MODES.map(mo => `<option value="${mo}" ${isEdit && mapping.ModeOfTransport === mo ? 'selected' : ''}>${mo}</option>`).join('')}
          </select>
        </div>
        <div class="tf-field">
          <label class="tf-label">Material Group (SAP code)</label>
          <input class="tf-input" type="text" id="mgm-material-group" maxlength="9" style="text-transform:uppercase" value="${esc(mapping?.MaterialGroup || '')}" placeholder="e.g. ITLG01A">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Description</label>
          <input class="tf-input" type="text" id="mgm-description" value="${esc(mapping?.Description || '')}" placeholder="e.g. Inbound freight">
        </div>
      </div>
      <div class="toolbar-hint" style="margin:2px 0 10px">Leave Mode of Transport blank to use this code as the default for the GL account regardless of mode. A specific mode always takes priority over the default when both exist.</div>
      <div id="mgm-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="mgm-save-btn">${isEdit ? 'Save Changes' : 'Add Mapping'}</button>
    </div>
  </div>`);

  document.getElementById('mgm-save-btn').addEventListener('click', async () => {
    const body = {
      costElement: document.getElementById('mgm-cost-element').value.trim(),
      modeOfTransport: document.getElementById('mgm-mode').value || null,
      materialGroup: document.getElementById('mgm-material-group').value.trim().toUpperCase(),
      description: document.getElementById('mgm-description').value.trim() || null,
    };
    if (!body.costElement) {
      document.getElementById('mgm-result').innerHTML = '<div class="sap-error">GL Account is required.</div>';
      return;
    }
    if (!body.materialGroup) {
      document.getElementById('mgm-result').innerHTML = '<div class="sap-error">Material Group is required.</div>';
      return;
    }
    const btn = document.getElementById('mgm-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch(isEdit ? `/api/material-groups/${mapping.MappingId}` : '/api/material-groups', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Save failed');
      closePickModal();
      runMaterialGroupMapping();
    } catch (err) {
      document.getElementById('mgm-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = isEdit ? 'Save Changes' : 'Add Mapping';
    }
  });
}

async function mgmDeleteMapping(mappingId, label) {
  if (!confirm(`Delete the mapping for ${label}? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/material-groups/${mappingId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Delete failed');
    runMaterialGroupMapping();
  } catch (err) {
    alert(err.message);
  }
}

// ── Admin: Cost Centres ────────────────────────────────────────────────────────
// Logistics.dbo.CostCenters — centerCode is the SAP cost centre code used
// across booking (private/js/logistics.js's Awaiting Booking modal),
// Manual Inbound Shipment, and MIGO postings (ShipmentCost.costCenter).
// centerID is a legacy identity-style column left to the database on
// create — see routes/costcenters.js.
async function runCostCentres() {
  showResultPanel('Cost Centres', 'Click a row to edit · Add Cost Centre for a new SAP cost centre code');
  try {
    const rows = await fetch('/api/costcenters').then(r => r.json());
    if (!Array.isArray(rows)) throw new Error('Failed to load cost centres');
    ccRenderList(rows);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

function ccRenderList(rows) {
  rows = rows.slice().sort((a, b) => (a.centerDescription || '').localeCompare(b.centerDescription || ''));
  document.getElementById('result-row-badge').textContent = `${rows.length} cost centre${rows.length !== 1 ? 's' : ''}`;
  document.getElementById('result-row-badge').classList.remove('hidden');

  const tableRows = rows.map(r => `
    <tr class="admin-row">
      <td style="font-family:'JetBrains Mono',monospace">${esc(r.centerCode || '')}</td>
      <td>${esc(r.centerDescription || '')}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn-secondary cc-edit" data-id="${esc(String(r.centerID))}" style="padding:3px 10px;font-size:11px">Edit</button>
        <button class="btn-secondary cc-delete" data-id="${esc(String(r.centerID))}" data-label="${esc(r.centerCode || '')} — ${esc(r.centerDescription || '')}" style="padding:3px 10px;font-size:11px;color:var(--error,#DC2626)">Delete</button>
      </td>
    </tr>`).join('');

  document.getElementById('result-body').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button class="btn-submit" id="cc-add-btn">+ Add Cost Centre</button>
    </div>
    ${rows.length ? `
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Cost Centre Code</th><th>Description</th><th></th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>` : '<div class="sap-empty">No cost centres yet — add one to use across booking and manual shipments.</div>'}
  `;

  document.getElementById('cc-add-btn').addEventListener('click', () => ccOpenModal(null));
  document.querySelectorAll('.cc-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = rows.find(x => String(x.centerID) === btn.dataset.id);
      if (r) ccOpenModal(r);
    });
  });
  document.querySelectorAll('.cc-delete').forEach(btn => {
    btn.addEventListener('click', () => ccDeleteRow(btn.dataset.id, btn.dataset.label));
  });
}

function ccOpenModal(row) {
  const isEdit = !!row;
  openModal(`<div class="ps-modal" style="max-width:480px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">${isEdit ? 'Edit Cost Centre' : 'Add Cost Centre'}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Cost Centre Code (SAP)</label>
          <input class="tf-input" type="text" id="cc-code" value="${esc(row?.centerCode || '')}" placeholder="e.g. 0000002004">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Description</label>
          <input class="tf-input" type="text" id="cc-description" value="${esc(row?.centerDescription || '')}" placeholder="e.g. PTFE">
        </div>
      </div>
      <div id="cc-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="cc-save-btn">${isEdit ? 'Save Changes' : 'Add Cost Centre'}</button>
    </div>
  </div>`);

  document.getElementById('cc-save-btn').addEventListener('click', async () => {
    const body = {
      centerCode: document.getElementById('cc-code').value.trim(),
      centerDescription: document.getElementById('cc-description').value.trim(),
    };
    if (!body.centerCode || !body.centerDescription) {
      document.getElementById('cc-result').innerHTML = '<div class="sap-error">Both fields are required.</div>';
      return;
    }
    const btn = document.getElementById('cc-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch(isEdit ? `/api/costcenters/${row.centerID}` : '/api/costcenters', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Save failed');
      closePickModal();
      runCostCentres();
    } catch (err) {
      document.getElementById('cc-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = isEdit ? 'Save Changes' : 'Add Cost Centre';
    }
  });
}

async function ccDeleteRow(centerId, label) {
  if (!confirm(`Delete cost centre ${label}? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/costcenters/${centerId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Delete failed');
    runCostCentres();
  } catch (err) {
    alert(err.message);
  }
}

// ── Admin: GL Accounts ─────────────────────────────────────────────────────────
// Logistics.dbo.CostElements — elementCode is the real SAP GL account short
// code (e.g. '602200'). This is what ShipmentCost.costElement holds and
// what Material Group Mapping's CostElement column is keyed on (see
// mgmCostElementLabel/mgmOpenModal above) — elementID is only a surrogate
// PK, never used as the GL account value anywhere in the app.
async function runGlAccounts() {
  showResultPanel('GL Accounts', 'Click a row to edit · Add GL Account for a new freight cost code — feeds Material Group Mapping\'s GL account list');
  try {
    const rows = await fetch('/api/costelements').then(r => r.json());
    if (!Array.isArray(rows)) throw new Error('Failed to load GL accounts');
    glaRenderList(rows);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

function glaRenderList(rows) {
  rows = rows.slice().sort((a, b) => String(a.elementCode || '').localeCompare(String(b.elementCode || '')));
  document.getElementById('result-row-badge').textContent = `${rows.length} GL account${rows.length !== 1 ? 's' : ''}`;
  document.getElementById('result-row-badge').classList.remove('hidden');

  const tableRows = rows.map(r => `
    <tr class="admin-row">
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700">${esc(r.elementCode || '')}</td>
      <td>${esc(r.elementDescription || '')}</td>
      <td>${esc(r.direction || '—')}</td>
      <td>${esc(r.tier || '—')}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn-secondary gla-edit" data-id="${esc(String(r.elementID))}" style="padding:3px 10px;font-size:11px">Edit</button>
        <button class="btn-secondary gla-delete" data-id="${esc(String(r.elementID))}" data-label="${esc(r.elementCode || '')} — ${esc(r.elementDescription || '')}" style="padding:3px 10px;font-size:11px;color:var(--error,#DC2626)">Delete</button>
      </td>
    </tr>`).join('');

  document.getElementById('result-body').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button class="btn-submit" id="gla-add-btn">+ Add GL Account</button>
    </div>
    ${rows.length ? `
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>GL Account Code</th><th>Description</th><th>Direction</th><th>Tier</th><th></th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>` : '<div class="sap-empty">No GL accounts yet — add one to use for freight cost postings.</div>'}
  `;

  document.getElementById('gla-add-btn').addEventListener('click', () => glaOpenModal(null));
  document.querySelectorAll('.gla-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = rows.find(x => String(x.elementID) === btn.dataset.id);
      if (r) glaOpenModal(r);
    });
  });
  document.querySelectorAll('.gla-delete').forEach(btn => {
    btn.addEventListener('click', () => glaDeleteRow(btn.dataset.id, btn.dataset.label));
  });
}

function glaOpenModal(row) {
  const isEdit = !!row;
  openModal(`<div class="ps-modal" style="max-width:480px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">${isEdit ? 'Edit GL Account' : 'Add GL Account'}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">GL Account Code (SAP)</label>
          <input class="tf-input" type="text" id="gla-code" maxlength="6" value="${esc(row?.elementCode || '')}" placeholder="e.g. 602200">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Description</label>
          <input class="tf-input" type="text" id="gla-description" value="${esc(row?.elementDescription || '')}" placeholder="e.g. Inbound Standard Freight">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Direction</label>
          <select class="tf-input" id="gla-direction">
            <option value="">—</option>
            <option value="inbound" ${row?.direction === 'inbound' ? 'selected' : ''}>Inbound</option>
            <option value="outbound" ${row?.direction === 'outbound' ? 'selected' : ''}>Outbound</option>
          </select>
        </div>
        <div class="tf-field">
          <label class="tf-label">Tier</label>
          <select class="tf-input" id="gla-tier">
            <option value="">—</option>
            <option value="standard" ${row?.tier === 'standard' ? 'selected' : ''}>Standard</option>
            <option value="premium" ${row?.tier === 'premium' ? 'selected' : ''}>Premium</option>
          </select>
        </div>
      </div>
      <div id="gla-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="gla-save-btn">${isEdit ? 'Save Changes' : 'Add GL Account'}</button>
    </div>
  </div>`);

  document.getElementById('gla-save-btn').addEventListener('click', async () => {
    const body = {
      elementCode: document.getElementById('gla-code').value.trim(),
      elementDescription: document.getElementById('gla-description').value.trim(),
      direction: document.getElementById('gla-direction').value || null,
      tier: document.getElementById('gla-tier').value || null,
    };
    if (!body.elementCode || !body.elementDescription) {
      document.getElementById('gla-result').innerHTML = '<div class="sap-error">GL Account Code and Description are required.</div>';
      return;
    }
    const btn = document.getElementById('gla-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch(isEdit ? `/api/costelements/${row.elementID}` : '/api/costelements', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Save failed');
      // Material Group Mapping's GL Account dropdown caches this list
      // (mgmCostElements) — invalidate so a newly added/renamed code shows
      // up there without a hard page refresh.
      mgmCostElements = null;
      closePickModal();
      runGlAccounts();
    } catch (err) {
      document.getElementById('gla-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = isEdit ? 'Save Changes' : 'Add GL Account';
    }
  });
}

async function glaDeleteRow(elementId, label) {
  if (!confirm(`Delete GL account ${label}? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/costelements/${elementId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Delete failed');
    mgmCostElements = null;
    runGlAccounts();
  } catch (err) {
    alert(err.message);
  }
}

// ── Admin: Forwarder Mode Mapping ─────────────────────────────────────────────
// Translates a forwarder's own mode/type (Forwarders.forwarderMode, e.g.
// "Road") into the canonical ModeOfTransport value used on
// ShipmentCost.modeOfTransport and MaterialGroupMapping.ModeOfTransport —
// previously the booked forwarder's mode was never carried through to the
// cost lines at all (routes/shipmentmain.js's mark-booked). See
// sql/migrate_forwarder_mode_mapping.sql for the full writeup.
let fmmForwarderTypes = [];

async function runForwarderModeMapping() {
  showResultPanel('Forwarder Mode Mapping', 'Click a row to edit · Maps a forwarder\'s mode/type to the Mode of Transport stored on cost lines.');
  try {
    const [mappingsJson, typesJson] = await Promise.all([
      fetch('/api/forwarder-mode-mapping').then(r => r.json()),
      fetch('/api/forwarder-mode-mapping/forwarder-types').then(r => r.json()),
    ]);
    if (!mappingsJson.success) throw new Error(mappingsJson.error?.message || 'Failed to load mappings');
    fmmForwarderTypes = typesJson.success ? (typesJson.data || []) : [];
    fmmRenderList(mappingsJson.data || []);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
  }
}

function fmmRenderList(rows) {
  rows = rows.slice().sort((a, b) => String(a.ForwarderMode || '').localeCompare(String(b.ForwarderMode || '')));
  document.getElementById('result-row-badge').textContent = `${rows.length} mapping${rows.length !== 1 ? 's' : ''}`;
  document.getElementById('result-row-badge').classList.remove('hidden');

  const tableRows = rows.map(r => `
    <tr class="admin-row">
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700">${esc(r.ForwarderMode || '')}</td>
      <td>${esc(r.ModeOfTransport || '')}</td>
      <td>${esc(r.Description || '—')}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn-secondary fmm-edit" data-id="${esc(String(r.MappingId))}" style="padding:3px 10px;font-size:11px">Edit</button>
        <button class="btn-secondary fmm-delete" data-id="${esc(String(r.MappingId))}" data-label="${esc(r.ForwarderMode || '')}" style="padding:3px 10px;font-size:11px;color:var(--error,#DC2626)">Delete</button>
      </td>
    </tr>`).join('');

  document.getElementById('result-body').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button class="btn-submit" id="fmm-add-btn">+ Add Mapping</button>
    </div>
    ${rows.length ? `
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Forwarder Type</th><th>Mode of Transport</th><th>Description</th><th></th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>` : '<div class="sap-empty">No mappings yet — a forwarder\'s mode is used as-is on cost lines until one is added here.</div>'}
  `;

  document.getElementById('fmm-add-btn').addEventListener('click', () => fmmOpenModal(null));
  document.querySelectorAll('.fmm-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = rows.find(x => String(x.MappingId) === btn.dataset.id);
      if (r) fmmOpenModal(r);
    });
  });
  document.querySelectorAll('.fmm-delete').forEach(btn => {
    btn.addEventListener('click', () => fmmDeleteRow(btn.dataset.id, btn.dataset.label));
  });
}

function fmmOpenModal(row) {
  const isEdit = !!row;
  openModal(`<div class="ps-modal" style="max-width:480px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">${isEdit ? 'Edit Mapping' : 'Add Mapping'}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Forwarder Type</label>
          <select class="tf-input" id="fmm-forwarder-mode">
            <option value="">— Select forwarder type —</option>
            ${fmmForwarderTypes.map(m => `<option value="${esc(m)}" ${row?.ForwarderMode === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
            ${row?.ForwarderMode && !fmmForwarderTypes.includes(row.ForwarderMode)
              ? `<option value="${esc(row.ForwarderMode)}" selected>${esc(row.ForwarderMode)} (no longer on any forwarder)</option>`
              : ''}
          </select>
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Mode of Transport</label>
          <select class="tf-input" id="fmm-mode-of-transport">
            <option value="">Select mode</option>
            ${OS_TRANSPORT_MODES.map(m => `<option value="${esc(m)}" ${row?.ModeOfTransport === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Description</label>
          <input class="tf-input" type="text" id="fmm-description" value="${esc(row?.Description || '')}" placeholder="Optional">
        </div>
      </div>
      <div id="fmm-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="fmm-save-btn">${isEdit ? 'Save Changes' : 'Add Mapping'}</button>
    </div>
  </div>`);

  document.getElementById('fmm-save-btn').addEventListener('click', async () => {
    const body = {
      forwarderMode: document.getElementById('fmm-forwarder-mode').value.trim(),
      modeOfTransport: document.getElementById('fmm-mode-of-transport').value,
      description: document.getElementById('fmm-description').value.trim() || null,
    };
    if (!body.forwarderMode || !body.modeOfTransport) {
      document.getElementById('fmm-result').innerHTML = '<div class="sap-error">Forwarder Type and Mode of Transport are required.</div>';
      return;
    }
    const btn = document.getElementById('fmm-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch(isEdit ? `/api/forwarder-mode-mapping/${row.MappingId}` : '/api/forwarder-mode-mapping', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Save failed');
      closePickModal();
      runForwarderModeMapping();
    } catch (err) {
      document.getElementById('fmm-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = isEdit ? 'Save Changes' : 'Add Mapping';
    }
  });
}

async function fmmDeleteRow(mappingId, label) {
  if (!confirm(`Delete the mapping for "${label}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/forwarder-mode-mapping/${mappingId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Delete failed');
    runForwarderModeMapping();
  } catch (err) {
    alert(err.message);
  }
}

// ── Shipment Event Log ────────────────────────────────────────────────────────
async function openShipmentEventLog(shipmentId, shipmentRef) {
  openModal(`<div class="ps-modal" style="max-width:700px;width:92vw">
    <div class="ps-modal-header">
      <div>
        <div class="ps-modal-title">Event Log</div>
        <div class="ps-modal-sub">Shipment ${esc(String(shipmentRef))}</div>
      </div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body" id="sd-events-body"
      style="padding:0;max-height:500px;overflow-y:auto">
      <div class="sap-loading"><div class="spinner"></div>Loading events…</div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="openShipmentDetailModal(${Number(shipmentId)})">&larr; Back</button>
      <button class="btn-secondary" onclick="closePickModal()">Close</button>
    </div>
  </div>`);

  const body = document.getElementById('sd-events-body');
  try {
    const res    = await fetch(`/api/shipmentmain/${encodeURIComponent(shipmentId)}/events`);
    const json   = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load events');
    const events = json.data || [];

    if (!events.length) {
      body.innerHTML = `<div class="ps-pcard-empty" style="padding:40px;text-align:center">
        No events recorded for this shipment.</div>`;
      return;
    }

    body.innerHTML = events.map(e => {
      const ts   = new Date(e.timeStamp);
      const date = ts.toLocaleDateString('en-GB');
      const time = ts.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `<div style="display:flex;gap:14px;padding:12px 16px;border-bottom:1px solid var(--border)">
        <div style="flex-shrink:0;text-align:right;min-width:80px;padding-top:1px">
          <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted)">${date}</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-muted)">${time}</div>
        </div>
        <div style="flex-shrink:0;padding-top:2px">
          <span class="ps-pcard-badge" style="${shipmentEventCategoryStyle(e.eventCategory)}">${esc(e.eventCategory)}</span>
        </div>
        <div style="font-size:13px;color:var(--text);line-height:1.5;word-break:break-word">
          ${esc(e.eventDescription)}
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    body.innerHTML = `<div class="sap-error" style="padding:24px">✕ ${esc(err.message)}</div>`;
  }
}

// ── Edit Dates & Status ───────────────────────────────────────────────────────
async function openShipmentStatusEdit(shipmentId, shipmentRef) {
  openModal(`<div class="ps-modal" style="max-width:600px;width:92vw">
    <div class="ps-modal-header">
      <div>
        <div class="ps-modal-title">Edit Dates &amp; Status</div>
        <div class="ps-modal-sub">Shipment ${esc(String(shipmentRef))}</div>
      </div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body" id="sse-body">
      <div class="sap-loading"><div class="spinner"></div>Loading…</div>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-secondary" onclick="openShipmentDetailModal(${Number(shipmentId)})">&larr; Back</button>
      <button class="btn-submit" id="sse-save" disabled>Save Corrections</button>
    </div>
  </div>`);

  try {
    const res  = await fetch(`/api/shipmentmain/${encodeURIComponent(shipmentId)}/details`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Shipment not found');
    const s = json.data.shipment;

    const fmt = d => d ? new Date(d).toISOString().slice(0, 10) : '';

    document.getElementById('sse-body').innerHTML = `
      <form class="transfer-form" style="padding:0">
        <div class="tf-section-label">Booking</div>
        <div class="tf-row">
          <div class="tf-field" style="display:flex;flex-direction:column;justify-content:flex-end;padding-bottom:4px">
            <label class="tf-label">Booking Status</label>
            <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;color:var(--text)">
              <input type="checkbox" id="sse-booking" style="width:16px;height:16px" ${s.bookingStatus ? 'checked' : ''}>
              Booked
            </label>
          </div>
          <div class="tf-field">
            <label class="tf-label">Planned Collection</label>
            <input class="tf-input" id="sse-plan-col" type="date" value="${fmt(s.plannedCollection)}">
          </div>
        </div>

        <div class="tf-section-label">Collection</div>
        <div class="tf-row">
          <div class="tf-field" style="display:flex;flex-direction:column;justify-content:flex-end;padding-bottom:4px">
            <label class="tf-label">Collection Status</label>
            <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;color:var(--text)">
              <input type="checkbox" id="sse-col-status" style="width:16px;height:16px" ${s.collectionStatus ? 'checked' : ''}>
              Collected
            </label>
          </div>
          <div class="tf-field">
            <label class="tf-label">Actual Collection Date</label>
            <input class="tf-input" id="sse-act-col" type="date" value="${fmt(s.actualCollection)}">
          </div>
        </div>

        <div class="tf-section-label">Delivery</div>
        <div class="tf-row">
          <div class="tf-field" style="display:flex;flex-direction:column;justify-content:flex-end;padding-bottom:4px">
            <label class="tf-label">Delivery Status</label>
            <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;color:var(--text)">
              <input type="checkbox" id="sse-del-status" style="width:16px;height:16px" ${s.deliveryStatus ? 'checked' : ''}>
              Delivered
            </label>
          </div>
          <div class="tf-field">
            <label class="tf-label">Planned Delivery</label>
            <input class="tf-input" id="sse-plan-del" type="date" value="${fmt(s.plannedDelivery)}">
          </div>
          <div class="tf-field">
            <label class="tf-label">Actual Delivery Date</label>
            <input class="tf-input" id="sse-act-del" type="date" value="${fmt(s.actualDelivery)}">
          </div>
        </div>

        <div id="sse-result" style="margin-top:10px;font-size:13px"></div>
      </form>`;

    // Auto-fill actual dates when status checkboxes are ticked and date is empty
    document.getElementById('sse-col-status').addEventListener('change', function () {
      const actCol = document.getElementById('sse-act-col');
      if (this.checked && !actCol.value) actCol.value = new Date().toISOString().slice(0, 10);
    });
    document.getElementById('sse-del-status').addEventListener('change', function () {
      const actDel = document.getElementById('sse-act-del');
      if (this.checked && !actDel.value) actDel.value = new Date().toISOString().slice(0, 10);
    });

    const saveBtn = document.getElementById('sse-save');
    saveBtn.disabled = false;
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      const resultEl = document.getElementById('sse-result');
      const val = id => document.getElementById(id)?.value || null;
      const chk = id => document.getElementById(id)?.checked ? 1 : 0;

      try {
        const res2 = await fetch(`/api/shipmentmain/${encodeURIComponent(shipmentId)}/status-dates`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bookingStatus:     chk('sse-booking'),
            plannedCollection: val('sse-plan-col'),
            collectionStatus:  chk('sse-col-status'),
            actualCollection:  val('sse-act-col'),
            plannedDelivery:   val('sse-plan-del'),
            deliveryStatus:    chk('sse-del-status'),
            actualDelivery:    val('sse-act-del'),
          }),
        });
        const json2 = await res2.json();
        if (!json2.success) throw new Error(json2.error || 'Save failed');
        resultEl.style.color = 'var(--success,#059669)';
        resultEl.textContent  = 'Saved. Returning to detail…';
        setTimeout(() => openShipmentDetailModal(shipmentId), 800);
      } catch (err) {
        resultEl.style.color = 'var(--error,#DC2626)';
        resultEl.textContent  = `✕ ${err.message}`;
        saveBtn.disabled = false; saveBtn.textContent = 'Save Corrections';
      }
    });
  } catch (err) {
    document.getElementById('sse-body').innerHTML =
      `<div class="sap-error" style="padding:24px">✕ ${esc(err.message)}</div>`;
  }
}


function shipmentEventCategoryStyle(category) {
  const c = String(category || '').toUpperCase();
  if (c.includes('COLLECT') || c.includes('DISPATCH') || c.includes('CREAT'))
    return 'background:rgba(124,58,237,.1);color:var(--accent);border-color:rgba(124,58,237,.25)';
  if (c.includes('DELIVER') || c.includes('COMPLET') || c.includes('ARRIV'))
    return 'background:rgba(5,150,105,.1);color:#059669;border-color:rgba(5,150,105,.25)';
  if (c.includes('CANCEL') || c.includes('ERROR') || c.includes('FAIL'))
    return 'background:rgba(220,38,38,.1);color:var(--error);border-color:rgba(220,38,38,.25)';
  if (c.includes('CUSTOMS') || c.includes('DOCUMENT') || c.includes('BOOKING'))
    return 'background:rgba(217,119,6,.1);color:#D97706;border-color:rgba(217,119,6,.25)';
  return 'background:var(--surface2);color:var(--text-muted);border-color:var(--border2)';
}

// ── Shipment Search ───────────────────────────────────────────────────────────
function runShipmentSearch() {
  showResultPanel('Search', 'Find outbound and inbound shipments in one place');

  document.getElementById('result-body').innerHTML = `
    <form class="transfer-form" id="ss-form" onsubmit="submitShipmentSearch(event)">

      <div class="tf-section-label">Identifiers</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Shipment Ref</label>
          <input class="tf-input" id="ss-ref" type="text" inputmode="text"
            placeholder="e.g. 00000042 or INB-000123" autocomplete="off">
        </div>
        <div class="tf-field">
          <label class="tf-label">Delivery Number <span class="tf-optional">(outbound only)</span></label>
          <input class="tf-input" id="ss-delivery" type="text" inputmode="numeric"
            placeholder="e.g. 82888798" autocomplete="off">
        </div>
        <div class="tf-field">
          <label class="tf-label">Tracking Number</label>
          <input class="tf-input" id="ss-tracking" type="text"
            placeholder="Partial match" autocomplete="off">
        </div>
      </div>

      <div class="tf-section-label">Parties</div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Customer / Supplier / Destination</label>
          <input class="tf-input" id="ss-customer" type="text"
            placeholder="Partial name match" autocomplete="off">
        </div>
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Forwarder / Haulier</label>
          <input class="tf-input" id="ss-forwarder" type="text"
            placeholder="Partial name match" autocomplete="off">
        </div>
      </div>

      <div class="tf-section-label">Date Range <span class="tf-optional">(optional)</span></div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Date Type</label>
          <select class="tf-input" id="ss-date-field">
            <option value="">— Select date type —</option>
            <option value="plannedCollection">Planned Collection</option>
            <option value="actualCollection">Actual Collection (outbound only)</option>
            <option value="plannedDelivery">Planned Delivery</option>
            <option value="actualDelivery">Actual Delivery</option>
          </select>
        </div>
        <div class="tf-field">
          <label class="tf-label">From</label>
          <input class="tf-input" id="ss-date-from" type="date">
        </div>
        <div class="tf-field">
          <label class="tf-label">To</label>
          <input class="tf-input" id="ss-date-to" type="date">
        </div>
      </div>

      <div class="tf-actions">
        <div id="ss-error" style="font-size:13px;color:var(--error)"></div>
        <button type="submit" class="btn-submit" id="ss-submit">Search →</button>
      </div>
    </form>

    <div id="ss-results" style="margin-top:4px"></div>`;
}

async function submitShipmentSearch(e) {
  e.preventDefault();
  if (!await checkSession()) return;

  const params = new URLSearchParams();
  const ref      = document.getElementById('ss-ref').value.trim();
  const delivery = document.getElementById('ss-delivery').value.trim();
  const tracking = document.getElementById('ss-tracking').value.trim();
  const customer = document.getElementById('ss-customer').value.trim();
  const forwarder= document.getElementById('ss-forwarder').value.trim();
  const dateField= document.getElementById('ss-date-field').value;
  const dateFrom = document.getElementById('ss-date-from').value;
  const dateTo   = document.getElementById('ss-date-to').value;

  if (ref)       params.set('shipmentRef',    ref);
  if (delivery)  params.set('deliveryNumber', delivery);
  if (tracking)  params.set('tracking',       tracking);
  if (customer)  params.set('customer',       customer);
  if (forwarder) params.set('forwarder',      forwarder);
  if (dateField) params.set('dateField',      dateField);
  if (dateFrom)  params.set('dateFrom',       dateFrom);
  if (dateTo)    params.set('dateTo',         dateTo);

  const errorEl  = document.getElementById('ss-error');
  const resultsEl= document.getElementById('ss-results');
  const btn      = document.getElementById('ss-submit');
  errorEl.textContent = '';
  resultsEl.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Searching…</div>';
  btn.disabled = true; btn.textContent = 'Searching…';

  try {
    const res  = await fetch(`/api/shipmentmain/search?${params}`);
    const json = await res.json();

    if (!json.success) {
      errorEl.textContent = json.error || 'Search failed';
      resultsEl.innerHTML = '';
    } else {
      renderShipmentSearchResults(json.data);
      document.getElementById('result-row-badge').textContent = `${json.data.length} result${json.data.length !== 1 ? 's' : ''}`;
      document.getElementById('result-row-badge').classList.remove('hidden');
    }
  } catch (err) {
    errorEl.textContent = `✕ ${err.message}`;
    resultsEl.innerHTML = '';
  } finally {
    btn.disabled = false; btn.textContent = 'Search →';
  }
}

// Combined outbound + inbound search results — routes/shipmentmain.js's
// /search now runs both legs and returns a merged, direction-tagged list
// (r.direction: 'outbound'|'inbound', r.key: 'O:<id>'|'I:<id>') so this one
// tile replaces what used to be two separate search mechanisms (Search
// Shipment for outbound, browsing Inbound Log buckets for inbound). Each row
// still opens the same detail modal it always did per direction.
function renderShipmentSearchResults(rows) {
  const resultsEl = document.getElementById('ss-results');
  if (!rows.length) {
    resultsEl.innerHTML = `<div class="sap-error" style="color:var(--text-muted)">No shipments matched your search.</div>`;
    return;
  }

  function statusBadge(row) {
    if (row.direction === 'inbound') {
      if (row.receivedAtUtc) return `<span class="ps-pcard-badge ps-pcard-badge--done">Received</span>`;
      return `<span class="ps-pcard-badge" style="background:rgba(217,119,6,.1);color:#D97706;border-color:rgba(217,119,6,.25)">Pending</span>`;
    }
    if (row.shipmentCancelled) return `<span class="ps-pcard-badge" style="background:rgba(220,38,38,.1);color:var(--error);border-color:rgba(220,38,38,.25)">Cancelled</span>`;
    if (row.deliveryStatus)    return `<span class="ps-pcard-badge ps-pcard-badge--done">Delivered</span>`;
    if (row.collectionStatus)  return `<span class="ps-pcard-badge ps-pcard-badge--wip">In Transit</span>`;
    if (row.bookingStatus)     return `<span class="ps-pcard-badge" style="background:rgba(124,58,237,.1);color:var(--accent);border-color:rgba(124,58,237,.25)">Awaiting Collection</span>`;
    return `<span class="ps-pcard-badge" style="background:rgba(217,119,6,.1);color:#D97706;border-color:rgba(217,119,6,.25)">Awaiting Booking</span>`;
  }

  function directionBadge(row) {
    return row.direction === 'inbound'
      ? `<span class="ps-pcard-badge" style="background:rgba(37,99,235,.1);color:#2563EB;border-color:rgba(37,99,235,.25)">Inbound</span>`
      : `<span class="ps-pcard-badge" style="background:rgba(5,150,105,.1);color:#059669;border-color:rgba(5,150,105,.25)">Outbound</span>`;
  }

  function fmt(d) { return d ? new Date(d).toLocaleDateString('en-GB') : '—'; }

  const thead = `<tr>
    <th>Dir.</th><th>Ref</th><th>Customer / Supplier</th><th>Forwarder</th>
    <th>Planned Coll.</th><th>Actual Coll.</th><th>Planned Del.</th><th>Actual Del.</th>
    <th>Tracking</th><th>Status</th>
  </tr>`;

  const tbody = rows.map(r => `
    <tr class="ps-row" style="cursor:pointer" data-id="${r.shipmentID}" data-direction="${r.direction}"
      onclick="${r.direction === 'inbound' ? `openInboundShipmentDetail(${r.shipmentID})` : `openShipmentDetailModal(${r.shipmentID})`}">
      <td>${directionBadge(r)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700">
        ${esc(r.refDisplay)}
      </td>
      <td>${esc(r.customer || '—')}</td>
      <td>${esc(r.forwarderName   || '—')}</td>
      <td>${fmt(r.plannedCollection)}</td>
      <td>${fmt(r.actualCollection)}</td>
      <td>${fmt(r.plannedDelivery)}</td>
      <td>${fmt(r.actualDelivery)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11px">${esc(r.trackingNumber || '—')}</td>
      <td>${statusBadge(r)}</td>
    </tr>`).join('');

  resultsEl.innerHTML = `
    <div style="overflow-x:auto;margin-top:8px">
      <table class="pn-batch-table">
        <thead>${thead}</thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}

function renderSimpleTable(rows, cols) {
  if (!rows.length) return '<div class="sap-error">No data.</div>';
  const head = cols.map(c => `<th>${esc(c)}</th>`).join('');
  const body = rows.map(r => `<tr>${cols.map(c => `<td>${esc(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('');
  return `<div style="overflow-x:auto"><table class="pn-batch-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}


// ── Unprocessed Freight Costs ─────────────────────────────────────────────────
async function runUnprocessedCosts() {
  showResultPanel('Unprocessed Freight Costs', 'Cost lines awaiting MIGO posting — tick rows and press Post to SAP');
  const body = document.getElementById('result-body');
  body.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading...</div>';

  try {
    const resp = await fetch('/api/shipmentcost/unprocessed');
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);

    const rows = json.data;
    if (!rows.length) {
      body.innerHTML = '<div class="sap-empty">No unprocessed cost lines found.</div>';
      return;
    }

    document.getElementById('result-row-badge').textContent = `${rows.length} line${rows.length !== 1 ? 's' : ''}`;
    document.getElementById('result-row-badge').classList.remove('hidden');

    const fmt        = d => d ? new Date(d).toLocaleDateString('en-GB') : '—';
    const gbp        = v => v != null ? `£${Number(v).toFixed(2)}` : '—';
    const location   = r => {
      const cc = (r.destinationCountry  || '').slice(0, 2).toUpperCase();
      const pc = (r.destinationPostCode || '').slice(0, 2).toUpperCase();
      return cc && pc ? `${cc} ${pc}` : (cc || pc || '—');
    };
    const TYPE_LABEL = { '1': 'Freight', '2': 'Customs' };

    const thead = `<tr>
      <th style="width:32px"><input type="checkbox" id="migo-check-all" title="Select all"></th>
      <th>Dir.</th>
      <th>Shipment</th>
      <th>Type</th>
      <th>Planned</th>
      <th>Delivered</th>
      <th>Haulier</th>
      <th>Mode</th>
      <th>Cost Centre</th>
      <th>Cost Element</th>
      <th style="text-align:right">Expected</th>
      <th>Location</th>
      <th>Tracking</th>
      <th>Result</th>
    </tr>`;

    // Nothing posts to SAP until the shipment has actually been delivered
    // (outbound: marked delivered from the in-transit section) or received
    // (inbound: Mark Received on the Inbound Log) — stops costs going to
    // SAP before the service is fully tendered, in case a price adjustment
    // is still needed. See POST /post-migo, which enforces this
    // server-side too (this is just so the checkbox doesn't invite a click
    // that'll only bounce).
    const tbody = rows.map(r => {
      const delivered = Boolean(r.deliveredDate);
      return `
      <tr data-cost-id="${r.costID}" class="migo-row" ${delivered ? '' : 'style="opacity:0.6"'}>
        <td><input type="checkbox" class="migo-check" data-cost-id="${r.costID}" ${delivered ? '' : 'disabled title="Not delivered/received yet"'}></td>
        <td>${r.direction === 'inbound' ? '<span style="color:#0369A1">In</span>' : '<span style="color:#B45309">Out</span>'}</td>
        <td>${esc(r.shipmentRef || (r.shipmentID != null ? String(r.shipmentID).padStart(6,'0') : '—'))}</td>
        <td>${esc(TYPE_LABEL[r.costType] || r.costType || '—')}</td>
        <td>${fmt(r.plannedCollection)}</td>
        <td>${fmt(r.deliveredDate)}</td>
        <td>${esc(r.forwarderName || '—')}</td>
        <td>${esc(r.modeOfTransport || '—')}</td>
        <td class="pn-batch-mono">${esc(r.costCenter  || '—')}</td>
        <td class="pn-batch-mono">${esc(r.costElement || '—')}</td>
        <td style="text-align:right">${gbp(r.expectedCost)}</td>
        <td class="pn-batch-mono">${location(r)}</td>
        <td class="pn-batch-mono">${esc(r.trackingNumber || '—')}</td>
        <td class="migo-result-cell">${delivered ? '' : '<span style="color:var(--text-muted);font-size:11px">Awaiting delivery</span>'}</td>
      </tr>`;
    }).join('');

    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0 12px;border-bottom:1px solid var(--border);margin-bottom:12px">
        <span id="migo-sel-count" style="font-size:13px;color:var(--text-dim)">0 selected</span>
        <button id="migo-post-btn" class="btn-export" disabled style="margin-left:auto">Post to SAP</button>
      </div>
      <div style="overflow-x:auto">
        <table class="pn-batch-table">
          <thead>${thead}</thead>
          <tbody id="migo-tbody">${tbody}</tbody>
        </table>
      </div>`;

    // Select-all toggle (skips rows disabled for not being delivered/received yet)
    document.getElementById('migo-check-all').addEventListener('change', function () {
      document.querySelectorAll('.migo-check:not(:disabled)').forEach(cb => { cb.checked = this.checked; });
      updateMigoSelection();
    });

    // Individual checkbox changes
    document.getElementById('migo-tbody').addEventListener('change', e => {
      if (e.target.classList.contains('migo-check')) {
        updateMigoSelection();
        const all = document.querySelectorAll('.migo-check');
        document.getElementById('migo-check-all').checked = [...all].every(cb => cb.checked);
      }
    });

    document.getElementById('migo-post-btn').addEventListener('click', postMigoSelected);

  } catch (err) {
    body.innerHTML = `<div class="sap-error">Error loading unprocessed costs: ${esc(err.message)}</div>`;
  }
}

function updateMigoSelection() {
  const checked = document.querySelectorAll('.migo-check:checked');
  const countEl = document.getElementById('migo-sel-count');
  const btn     = document.getElementById('migo-post-btn');
  if (!countEl || !btn) return;
  countEl.textContent = `${checked.length} selected`;
  btn.disabled = checked.length === 0;
}

async function postMigoSelected() {
  const checked = [...document.querySelectorAll('.migo-check:checked')];
  if (!checked.length) return;

  const costIDs = checked.map(cb => Number(cb.dataset.costId));
  const btn     = document.getElementById('migo-post-btn');
  const countEl = document.getElementById('migo-sel-count');

  btn.disabled    = true;
  btn.textContent = 'Posting…';
  countEl.textContent = 'Sending to SAP…';

  // Clear previous results on selected rows
  checked.forEach(cb => {
    const cell = cb.closest('tr')?.querySelector('.migo-result-cell');
    if (cell) cell.innerHTML = '<span style="color:var(--text-muted);font-size:11px">Pending…</span>';
  });

  try {
    const resp = await fetch('/api/shipmentcost/post-migo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ costIDs }),
    });
    const json = await resp.json();
    if (!json.success && !json.blockedCostIDs) throw new Error(json.error);

    let okCount = 0;
    let failCount = 0;
    let blockedCount = 0;

    for (const costID of (json.blockedCostIDs || [])) {
      const row  = document.querySelector(`tr[data-cost-id="${costID}"]`);
      const cell = row?.querySelector('.migo-result-cell');
      if (!row || !cell) continue;
      cell.innerHTML = `<span style="color:var(--text-muted);font-size:11px">Not delivered yet</span>`;
      blockedCount++;
    }

    // routes/shipmentcost.js's post-migo pushes one result object per
    // costID (result.costID, singular) — not a result-per-group with a
    // costIDs array. Iterating result.costIDs here threw "not iterable" on
    // the very first result, which meant a line that posted successfully
    // in SAP (and was already marked migoStatus=1 server-side) never got
    // its checkmark/material document shown and never got its checkbox
    // disabled — so it looked stuck/unposted even though it had gone
    // through, risking a confused re-post attempt.
    for (const result of (json.results || [])) {
      const costID = result.costID;
      const row  = document.querySelector(`tr[data-cost-id="${costID}"]`);
      const cell = row?.querySelector('.migo-result-cell');
      const cb   = row?.querySelector('.migo-check');
      if (!row || !cell) continue;

      if (result.success) {
        cell.innerHTML = `<span style="background:#D1FAE5;color:#065F46;border:1px solid #6EE7B7;border-radius:4px;padding:2px 7px;font-size:11px;font-family:'JetBrains Mono',monospace;white-space:nowrap">${esc(result.materialDocument)}</span>`;
        row.style.opacity = '0.45';
        if (cb) { cb.checked = false; cb.disabled = true; }
        okCount++;
      } else {
        cell.innerHTML = `<span style="color:var(--error);font-size:11px" title="${esc(result.error || '')}">${esc(result.error || 'Failed')}</span>`;
        failCount++;
      }
    }

    updateMigoSelection();
    btn.textContent = 'Post to SAP';

    const parts = [];
    if (okCount)      parts.push(`${okCount} posted`);
    if (failCount)    parts.push(`${failCount} failed`);
    if (blockedCount) parts.push(`${blockedCount} not delivered yet`);
    countEl.textContent = parts.join(' · ') || 'Done';

  } catch (err) {
    btn.disabled    = false;
    btn.textContent = 'Post to SAP';
    countEl.textContent = `Error: ${err.message}`;
    checked.forEach(cb => {
      const cell = cb.closest('tr')?.querySelector('.migo-result-cell');
      if (cell) cell.innerHTML = '';
    });
  }
}


// ── Freight Spend Analytics ───────────────────────────────────────────────────
function destroyFreightCharts() {
  freightCharts.forEach(c => { try { c.destroy(); } catch (_) {} });
  freightCharts = [];
}

async function runFreightSpend(months) {
  months = months || freightSpendMonths;
  freightSpendMonths = months;
  showResultPanel('Freight Spend Analytics', `Last ${months} months — spend by forwarder, country, month and direction`);
  destroyFreightCharts();

  const body = document.getElementById('result-body');

  try {
    const resp = await fetch(`/api/shipmentcost/analytics?months=${months}`);
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);

    const d = json.data;
    const gbp = v => v != null ? `£${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '£0.00';

    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthLabel  = (yr, mo) => `${MONTH_NAMES[mo - 1]} ${String(yr).slice(-2)}`;

    const CHART_COLOURS = ['#0891B2','#10B981','#F59E0B','#EF4444','#8B5CF6','#F97316','#84CC16','#EC4899','#6366F1','#06B6D4'];

    const periodOptions = [3,6,12,24].map(m =>
      `<option value="${m}"${m === months ? ' selected' : ''}>${m} months</option>`
    ).join('');

    const totals = d.totals || {};
    const kpiHtml = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">
        ${[
          { label: 'Total Expected Spend', value: gbp(totals.totalSpend),        accent: false },
          { label: 'MIGO Processed',       value: gbp(totals.processedSpend),    accent: false },
          { label: 'Awaiting MIGO',        value: gbp(totals.unprocessedSpend),  accent: true  },
          { label: 'Shipments',            value: totals.shipments  ?? '—',      accent: false },
          { label: 'Cost Lines',           value: totals.costRecords ?? '—',     accent: false },
        ].map(k => `
          <div style="background:var(--surface);border:1px solid ${k.accent ? 'var(--accent)' : 'var(--border)'};border-radius:8px;padding:14px 18px;min-width:130px;flex:1">
            <div style="font-size:10px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">${k.label}</div>
            <div style="font-size:22px;font-weight:800;color:${k.accent ? 'var(--accent)' : 'var(--text)'};font-family:'JetBrains Mono',monospace">${k.value}</div>
          </div>`).join('')}
      </div>`;

    const card  = (title, canvasId) => `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px">
        <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em;margin-bottom:14px">${title}</div>
        <canvas id="${canvasId}" style="max-height:240px"></canvas>
      </div>`;

    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <label style="font-size:13px;color:var(--text-dim);font-weight:600">Period:</label>
        <select id="spend-period-sel" style="background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 10px;font-size:13px">
          ${periodOptions}
        </select>
      </div>
      ${kpiHtml}
      <div style="margin-bottom:14px">${card('Monthly Spend', 'chart-monthly')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px">
        ${card('Spend by Forwarder',  'chart-forwarder')}
        ${card('Inbound vs Outbound', 'chart-direction')}
        ${card('Spend by Service',    'chart-service')}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        ${card('Spend by Country',    'chart-country')}
        ${card('Spend by Cost Centre','chart-costcenter')}
      </div>
      <div style="margin-bottom:14px">${card('Spend by Customer', 'chart-customer')}</div>`;

    document.getElementById('spend-period-sel').addEventListener('change', e => {
      runFreightSpend(Number(e.target.value));
    });

    const TICK   = '#8DA3BE';
    const GRID   = 'rgba(0,0,0,0.06)';
    const gbpTip = ctx => ` £${Number(ctx.parsed).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;
    const gbpY   = v   => `£${Number(v).toLocaleString('en-GB')}`;

    const barDefaults = {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: TICK, font: { size: 10 } }, grid: { color: GRID } },
        y: { ticks: { color: TICK, font: { size: 10 }, callback: gbpY }, grid: { color: GRID } },
      },
    };

    const doughnutDefaults = opts => ({
      plugins: {
        legend: { position: 'bottom', labels: { color: '#4D6380', font: { size: 11 }, padding: 12 } },
        tooltip: { callbacks: { label: gbpTip } },
        ...opts,
      },
    });

    if (d.byForwarder.length) {
      freightCharts.push(new Chart(document.getElementById('chart-forwarder'), {
        type: 'doughnut',
        data: { labels: d.byForwarder.map(r => r.forwarderName || 'Unassigned'), datasets: [{ data: d.byForwarder.map(r => Number(r.totalCost)), backgroundColor: CHART_COLOURS, borderWidth: 2, borderColor: '#fff' }] },
        options: doughnutDefaults(),
      }));
    }

    if (d.byCountry.length) {
      freightCharts.push(new Chart(document.getElementById('chart-country'), {
        type: 'bar',
        data: { labels: d.byCountry.map(r => r.country || '?'), datasets: [{ data: d.byCountry.map(r => Number(r.totalCost)), backgroundColor: '#0891B2', borderRadius: 4 }] },
        options: barDefaults,
      }));
    }

    if (d.byMonth.length) {
      freightCharts.push(new Chart(document.getElementById('chart-monthly'), {
        type: 'line',
        data: {
          labels: d.byMonth.map(r => monthLabel(r.yr, r.mo)),
          datasets: [{ label: 'Expected Spend', data: d.byMonth.map(r => Number(r.totalCost)), borderColor: '#0891B2', backgroundColor: 'rgba(8,145,178,0.08)', fill: true, tension: 0.35, pointRadius: 4, pointBackgroundColor: '#0891B2', pointBorderColor: '#fff', pointBorderWidth: 2 }],
        },
        options: {
          plugins: { legend: { display: false } },
          scales: barDefaults.scales,
        },
      }));
    }

    if (d.byDirection.length) {
      freightCharts.push(new Chart(document.getElementById('chart-direction'), {
        type: 'doughnut',
        data: { labels: d.byDirection.map(r => r.direction), datasets: [{ data: d.byDirection.map(r => Number(r.totalCost)), backgroundColor: ['#0891B2','#F59E0B'], borderWidth: 2, borderColor: '#fff' }] },
        options: doughnutDefaults(),
      }));
    }

    if (d.byCostCenter.length) {
      freightCharts.push(new Chart(document.getElementById('chart-costcenter'), {
        type: 'bar',
        data: { labels: d.byCostCenter.map(r => r.costCenter || 'Unassigned'), datasets: [{ data: d.byCostCenter.map(r => Number(r.totalCost)), backgroundColor: '#8B5CF6', borderRadius: 4 }] },
        options: barDefaults,
      }));
    }

    if (d.byCustomer.length) {
      freightCharts.push(new Chart(document.getElementById('chart-customer'), {
        type: 'bar',
        data: {
          labels: d.byCustomer.map(r => r.customer || '?'),
          datasets: [{ data: d.byCustomer.map(r => Number(r.totalCost)), backgroundColor: '#10B981', borderRadius: 4 }],
        },
        options: {
          ...barDefaults,
          indexAxis: 'y',
          scales: {
            x: { ticks: { color: TICK, font: { size: 10 }, callback: gbpY }, grid: { color: GRID } },
            y: { ticks: { color: TICK, font: { size: 10 } }, grid: { color: GRID } },
          },
        },
      }));
    }

    if (d.byService.length) {
      freightCharts.push(new Chart(document.getElementById('chart-service'), {
        type: 'doughnut',
        data: {
          labels: d.byService.map(r => r.service),
          datasets: [{ data: d.byService.map(r => Number(r.totalCost)), backgroundColor: CHART_COLOURS, borderWidth: 2, borderColor: '#fff' }],
        },
        options: doughnutDefaults(),
      }));
    }

  } catch (err) {
    destroyFreightCharts();
    body.innerHTML = `<div class="sap-error">Error loading analytics: ${esc(err.message)}</div>`;
  }
}


// ── Haulier On-Time Performance ───────────────────────────────────────────────
// Reuses freightCharts/destroyFreightCharts — only one of Freight Spend /
// this report is ever open in the result panel at a time, so sharing the
// same chart-instance registry is safe and avoids a second near-identical
// destroy helper.
let otifMonths = 12;

async function runHaulierOtif(months) {
  months = months || otifMonths;
  otifMonths = months;
  showResultPanel('Haulier On-Time Performance', `Last ${months} months — planned vs actual delivery, by haulier, country, destination and month`);
  destroyFreightCharts();

  const body = document.getElementById('result-body');

  try {
    const resp = await fetch(`/api/shipmentmain/otif-report?months=${months}`);
    const json = await resp.json();
    if (!json.success) throw new Error(json.error);

    const d = json.data;
    const pct = (onTime, total) => total > 0 ? (Number(onTime) / Number(total) * 100) : null;
    const pctLabel = v => v == null ? '—' : `${v.toFixed(1)}%`;

    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthLabel  = (yr, mo) => `${MONTH_NAMES[mo - 1]} ${String(yr).slice(-2)}`;

    const periodOptions = [3,6,12,24].map(m =>
      `<option value="${m}"${m === months ? ' selected' : ''}>${m} months</option>`
    ).join('');

    const totals = d.totals || {};
    const overallPct = pct(totals.onTime, totals.total);
    const kpiHtml = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">
        ${[
          { label: 'Overall On-Time',   value: pctLabel(overallPct), accent: overallPct != null && overallPct < 90 },
          { label: 'Total Deliveries',  value: totals.total ?? '—',  accent: false },
          { label: 'On Time',           value: totals.onTime ?? '—', accent: false },
          { label: 'Late',              value: (totals.total ?? 0) - (totals.onTime ?? 0), accent: true },
        ].map(k => `
          <div style="background:var(--surface);border:1px solid ${k.accent ? 'var(--accent)' : 'var(--border)'};border-radius:8px;padding:14px 18px;min-width:130px;flex:1">
            <div style="font-size:10px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">${k.label}</div>
            <div style="font-size:22px;font-weight:800;color:${k.accent ? 'var(--accent)' : 'var(--text)'};font-family:'JetBrains Mono',monospace">${k.value}</div>
          </div>`).join('')}
      </div>`;

    const card  = (title, canvasId) => `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px">
        <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em;margin-bottom:14px">${title}</div>
        <canvas id="${canvasId}" style="max-height:240px"></canvas>
      </div>`;

    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <label style="font-size:13px;color:var(--text-dim);font-weight:600">Period:</label>
        <select id="otif-period-sel" style="background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 10px;font-size:13px">
          ${periodOptions}
        </select>
      </div>
      ${kpiHtml}
      <div style="margin-bottom:14px">${card('On-Time % by Month', 'otif-chart-monthly')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        ${card('On-Time % by Haulier', 'otif-chart-haulier')}
        ${card('On-Time % by Country', 'otif-chart-country')}
      </div>
      <div style="margin-bottom:14px">${card('On-Time % by Destination (top 15 by volume)', 'otif-chart-destination')}</div>`;

    document.getElementById('otif-period-sel').addEventListener('change', e => {
      runHaulierOtif(Number(e.target.value));
    });

    const TICK = '#8DA3BE';
    const GRID = 'rgba(0,0,0,0.06)';
    const pctTip = ctx => ` ${Number(ctx.parsed.y ?? ctx.parsed).toFixed(1)}%`;

    // Colour bars/points red below 85% on-time, amber below 95%, green
    // above — a flat single-colour chart doesn't surface the hauliers
    // actually worth a conversation.
    const otifColour = v => v == null ? '#94A3B8' : v < 85 ? '#DC2626' : v < 95 ? '#D97706' : '#059669';

    const pctBarDefaults = {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: pctTip } } },
      scales: {
        x: { ticks: { color: TICK, font: { size: 10 } }, grid: { color: GRID } },
        y: { min: 0, max: 100, ticks: { color: TICK, font: { size: 10 }, callback: v => `${v}%` }, grid: { color: GRID } },
      },
    };

    if (d.byHaulier.length) {
      const rows = d.byHaulier.map(r => ({ label: r.haulier || 'Unassigned', v: pct(r.onTime, r.total), total: Number(r.total) }));
      freightCharts.push(new Chart(document.getElementById('otif-chart-haulier'), {
        type: 'bar',
        data: { labels: rows.map(r => `${r.label} (${r.total})`), datasets: [{ data: rows.map(r => r.v), backgroundColor: rows.map(r => otifColour(r.v)), borderRadius: 4 }] },
        options: { ...pctBarDefaults, indexAxis: 'y' },
      }));
    }

    if (d.byCountry.length) {
      const rows = d.byCountry.map(r => ({ label: r.country || '?', v: pct(r.onTime, r.total) }));
      freightCharts.push(new Chart(document.getElementById('otif-chart-country'), {
        type: 'bar',
        data: { labels: rows.map(r => r.label), datasets: [{ data: rows.map(r => r.v), backgroundColor: rows.map(r => otifColour(r.v)), borderRadius: 4 }] },
        options: pctBarDefaults,
      }));
    }

    if (d.byDestination.length) {
      const rows = d.byDestination.map(r => ({ label: r.destination || '?', v: pct(r.onTime, r.total), total: Number(r.total) }));
      freightCharts.push(new Chart(document.getElementById('otif-chart-destination'), {
        type: 'bar',
        data: { labels: rows.map(r => `${r.label} (${r.total})`), datasets: [{ data: rows.map(r => r.v), backgroundColor: rows.map(r => otifColour(r.v)), borderRadius: 4 }] },
        options: { ...pctBarDefaults, indexAxis: 'y' },
      }));
    }

    if (d.byMonth.length) {
      const rows = d.byMonth.map(r => ({ label: monthLabel(r.yr, r.mo), v: pct(r.onTime, r.total) }));
      freightCharts.push(new Chart(document.getElementById('otif-chart-monthly'), {
        type: 'line',
        data: {
          labels: rows.map(r => r.label),
          datasets: [{ label: 'On-Time %', data: rows.map(r => r.v), borderColor: '#0891B2', backgroundColor: 'rgba(8,145,178,0.08)', fill: true, tension: 0.35, pointRadius: 4, pointBackgroundColor: rows.map(r => otifColour(r.v)), pointBorderColor: '#fff', pointBorderWidth: 2 }],
        },
        options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: pctTip } } }, scales: pctBarDefaults.scales },
      }));
    }

  } catch (err) {
    destroyFreightCharts();
    body.innerHTML = `<div class="sap-error">Error loading OTIF report: ${esc(err.message)}</div>`;
  }
}


// ── MM Turns / Valuation Class ────────────────────────────────────────────────
function destroyTurnsCharts() {
  turnsCharts.forEach(c => { try { c.destroy(); } catch (_) {} });
  turnsCharts = [];
}

function tvcGbp(v) { return v != null ? `£${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'; }
function tvcNum(v, dp = 1) { return v != null ? Number(v).toLocaleString('en-GB', { maximumFractionDigits: dp }) : '—'; }

async function fetchValClassCatalog() {
  if (valClassCatalogCache) return valClassCatalogCache;
  const resp = await fetch('/api/performance/turns-valclass/valuation-classes');
  const json = await resp.json();
  valClassCatalogCache = json.success ? json.data : [];
  return valClassCatalogCache;
}

// ── Tile 1: full table, filterable ──────────────────────────────────────────
async function runTurnsValClassTable() {
  showResultPanel('Stock Turns & Valuation', 'Full material list — stock, valuation class, turns and days-in-stock');
  const body = document.getElementById('result-body');

  try {
    const resp = await fetch('/api/performance/turns-valclass');
    const json = await resp.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load');

    const rows = json.data;
    if (!rows.length) {
      body.innerHTML = '<div class="sap-empty">No stock turns data available yet — the daily sync runs at 05:45.</div>';
      return;
    }

    document.getElementById('result-row-badge').textContent = `${rows.length} material${rows.length !== 1 ? 's' : ''}`;
    document.getElementById('result-row-badge').classList.remove('hidden');

    const COLS = [
      { key: 'material',         label: 'Material' },
      { key: 'materialText',     label: 'Description' },
      { key: 'plant',            label: 'Plant',      filter: true },
      { key: 'valuationClass',   label: 'Val. Class', filter: true },
      { key: 'mrpController',    label: 'MRP Ctrl',   filter: true },
      { key: 'materialType',     label: 'Type',        filter: true },
      { key: 'stockQty',         label: 'Stock Qty',  render: v => tvcNum(v, 2) },
      { key: 'stockValue',       label: 'Stock Value',render: tvcGbp },
      { key: 'unitPrice',        label: 'Unit Price', render: tvcGbp },
      { key: 'bookValue',        label: 'Book Value', render: tvcGbp },
      { key: 'stockTurns',       label: 'Turns',       render: v => tvcNum(v, 2) },
      { key: 'daysInStock',      label: 'Days in Stock', render: v => tvcNum(v, 0) },
      { key: 'turnoverCategory', label: 'Category',   filter: true },
      { key: 'warning',          label: 'Warning' },
    ];

    const uniqueValues = key => [...new Set(rows.map(r => r[key]).filter(v => v != null && v !== ''))].sort();

    const filterBar = COLS
      .map((c, idx) => ({ ...c, idx }))
      .filter(c => c.filter)
      .map(c => `
        <select class="tf-input tvc-filter" data-col-idx="${c.idx}" style="max-width:150px;display:inline-block;width:auto">
          <option value="">All ${esc(c.label)}</option>
          ${uniqueValues(c.key).map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}
        </select>`)
      .join(' ');

    // Sorted once up front (highest stock value first) — no DataTables dependency;
    // filtering below just toggles row visibility, matching every other filtered
    // list in this app (e.g. Unprocessed Freight Costs, Change Valuation Class search).
    const sorted = [...rows].sort((a, b) => (Number(b.stockValue) || 0) - (Number(a.stockValue) || 0));

    const thead = `<tr>${COLS.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr>`;
    const tbody = sorted.map(r => `<tr>${COLS.map((c, idx) => `<td data-col-idx="${idx}">${c.render ? c.render(r[c.key]) : esc(r[c.key] ?? '—')}</td>`).join('')}</tr>`).join('');

    body.innerHTML = `
      <div style="margin-bottom:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
        <span style="font-size:12px;color:var(--text-muted);font-weight:600">Filter:</span>
        <input class="tf-input tvc-search" id="tvc-search" type="text" placeholder="Search material or description…" style="max-width:220px;display:inline-block;width:auto">
        ${filterBar}
        <span id="tvc-visible-count" style="font-size:12px;color:var(--text-muted);margin-left:auto"></span>
      </div>
      <div style="overflow-x:auto">
        <table id="tvc-table" class="pn-batch-table" style="width:100%">
          <thead>${thead}</thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>`;

    const tbodyEl = document.querySelector('#tvc-table tbody');
    const allTrs  = [...tbodyEl.querySelectorAll('tr')];

    function tvcApplyFilters() {
      const searchVal = document.getElementById('tvc-search').value.trim().toLowerCase();
      const active = [...document.querySelectorAll('.tvc-filter')]
        .map(sel => ({ idx: Number(sel.dataset.colIdx), val: sel.value }))
        .filter(f => f.val);

      let visible = 0;
      allTrs.forEach(tr => {
        const matchesFilters = active.every(f => tr.children[f.idx]?.textContent === f.val);
        const matchesSearch  = !searchVal || tr.textContent.toLowerCase().includes(searchVal);
        const show = matchesFilters && matchesSearch;
        tr.style.display = show ? '' : 'none';
        if (show) visible++;
      });

      document.getElementById('tvc-visible-count').textContent = `${visible} of ${allTrs.length} shown`;
    }

    tvcApplyFilters();

    document.getElementById('tvc-search').addEventListener('input', tvcApplyFilters);
    document.querySelectorAll('.tvc-filter').forEach(sel => sel.addEventListener('change', tvcApplyFilters));

  } catch (err) {
    body.innerHTML = `<div class="sap-error">Error loading stock turns data: ${esc(err.message)}</div>`;
  }
}

// ── Tile 2: aggregate KPIs + breakdown charts ────────────────────────────────
async function runTurnsValClassSummary() {
  showResultPanel('Stock Value Overview', 'Aggregate stock & book value by turnover category, valuation class and material type');
  // Viewing this tile no longer requires LOG_MRP (see
  // sql/migrate_log_reports_permission.sql — it's LOG_ADMIN/LOG_MRP/
  // LOG_REPORTS now), but the manual-refresh action underneath it still
  // does (POST /turns-valclass/refresh pulls live SAP data). A LOG_REPORTS-
  // only viewer would get a 403 clicking this, so it's hidden for them.
  const canRefresh = sessionRole === 'superadmin' || userPermissions.includes('LOG_MRP');
  document.getElementById('btn-refresh-turnsvalclass').classList.toggle('hidden', !canRefresh);
  await loadTurnsValClassSummaryBody();
}

// Split out of runTurnsValClassSummary() so runTurnsValClassManualRefresh()
// can reload just the body after a manual refresh, without wiping the
// toolbar's "Refreshed at ..." status message the way calling
// showResultPanel() again would.
async function loadTurnsValClassSummaryBody() {
  destroyTurnsCharts();
  const body = document.getElementById('result-body');
  loadTurnsValClassRefreshSummary();

  try {
    const resp = await fetch('/api/performance/turns-valclass/aggregates');
    const json = await resp.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load');

    const d = json.data;
    const t = d.totals || {};

    const CHART_COLOURS = ['#0891B2', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#F97316', '#84CC16', '#EC4899', '#6366F1', '#06B6D4'];

    const kpiHtml = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">
        ${[
          { label: 'Materials',        value: t.materialCount ?? '—' },
          { label: 'Total Stock Value',value: tvcGbp(t.totalStockValue) },
          { label: 'Total Book Value', value: tvcGbp(t.totalBookValue) },
          { label: 'With Warnings',    value: t.warningCount ?? '—', accent: (t.warningCount ?? 0) > 0 },
          { label: 'Avg. Turns',       value: tvcNum(t.avgStockTurns, 2) },
          { label: 'Avg. Days in Stock', value: tvcNum(t.avgDaysInStock, 0) },
        ].map(k => `
          <div style="background:var(--surface);border:1px solid ${k.accent ? 'var(--accent)' : 'var(--border)'};border-radius:8px;padding:14px 18px;min-width:130px;flex:1">
            <div style="font-size:10px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">${k.label}</div>
            <div style="font-size:22px;font-weight:800;color:${k.accent ? 'var(--accent)' : 'var(--text)'};font-family:'JetBrains Mono',monospace">${k.value}</div>
          </div>`).join('')}
      </div>`;

    const card = (title, canvasId) => `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px">
        <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em;margin-bottom:14px">${title}</div>
        <canvas id="${canvasId}" style="max-height:260px"></canvas>
      </div>`;

    body.innerHTML = `
      ${kpiHtml}
      <div style="margin-bottom:14px">${card('Stock Value by Turnover Category', 'chart-tvc-category')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        ${card('Stock Value by Valuation Class', 'chart-tvc-valclass')}
        ${card('Stock Value by Material Type', 'chart-tvc-mattype')}
      </div>`;

    const TICK = '#8DA3BE';
    const GRID = 'rgba(0,0,0,0.06)';
    const gbpTip = ctx => ` £${Number(ctx.parsed.y ?? ctx.parsed).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;
    const gbpY   = v => `£${Number(v).toLocaleString('en-GB')}`;

    const barDefaults = {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: gbpTip } } },
      scales: {
        x: { ticks: { color: TICK, font: { size: 10 } }, grid: { color: GRID } },
        y: { ticks: { color: TICK, font: { size: 10 }, callback: gbpY }, grid: { color: GRID } },
      },
    };

    if (d.byTurnoverCategory?.length) {
      turnsCharts.push(new Chart(document.getElementById('chart-tvc-category'), {
        type: 'bar',
        data: {
          labels: d.byTurnoverCategory.map(r => r.category || 'Unclassified'),
          datasets: [{ data: d.byTurnoverCategory.map(r => Number(r.stockValue) || 0), backgroundColor: '#0891B2', borderRadius: 4 }],
        },
        options: barDefaults,
      }));
    }

    if (d.byValuationClass?.length) {
      turnsCharts.push(new Chart(document.getElementById('chart-tvc-valclass'), {
        type: 'doughnut',
        data: {
          labels: d.byValuationClass.map(r => r.valuationClass || 'Unassigned'),
          datasets: [{ data: d.byValuationClass.map(r => Number(r.stockValue) || 0), backgroundColor: CHART_COLOURS, borderWidth: 2, borderColor: '#fff' }],
        },
        options: {
          plugins: {
            legend: { position: 'bottom', labels: { color: '#4D6380', font: { size: 11 }, padding: 10 } },
            tooltip: { callbacks: { label: gbpTip } },
          },
        },
      }));
    }

    if (d.byMaterialType?.length) {
      turnsCharts.push(new Chart(document.getElementById('chart-tvc-mattype'), {
        type: 'bar',
        data: {
          labels: d.byMaterialType.map(r => r.materialType || 'Unassigned'),
          datasets: [{ data: d.byMaterialType.map(r => Number(r.stockValue) || 0), backgroundColor: '#8B5CF6', borderRadius: 4 }],
        },
        options: barDefaults,
      }));
    }

  } catch (err) {
    destroyTurnsCharts();
    body.innerHTML = `<div class="sap-error">Error loading summary: ${esc(err.message)}</div>`;
  }
}

// Persisted "Last Refreshed" indicator, backed by dbo.RefreshLog — same
// table and "no false confidence" pattern as the Management page's refresh
// summary (see renderRefreshSummary/loadRefreshStatus in management.js and
// GET /turns-valclass/refresh-status in routes/performance.js), just scoped
// to the two datasets the daily 05:45 job writes here (TurnsValClass,
// ValuationClasses) and shown as a dd/mm/yyyy date rather than relative
// time. Unlike the ephemeral "Refreshed HH:MM:SS" message below (which only
// exists after a manual click, this browser session), this reflects the
// real state of the scheduled data any time the tile is opened — including
// by someone who never clicked Refresh Now. Deliberately doesn't show a
// date at all if either dataset's most recent run failed; a stale-looking
// success date next to charts that didn't actually update would be worse
// than no date.
async function loadTurnsValClassRefreshSummary() {
  const el = document.getElementById('turnsvalclass-refresh-summary');
  if (!el) return;
  try {
    const resp = await fetch('/api/performance/turns-valclass/refresh-status');
    const json = await resp.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load refresh status');
    renderTurnsValClassRefreshSummary(json.data);
  } catch (err) {
    el.classList.remove('hidden', 'tvc-refresh-status--ok');
    el.classList.add('tvc-refresh-status--warn');
    el.title = '';
    el.textContent = 'Refresh status unavailable';
  }
}

function renderTurnsValClassRefreshSummary(data) {
  const el = document.getElementById('turnsvalclass-refresh-summary');
  if (!el) return;
  el.classList.remove('hidden', 'tvc-refresh-status--ok', 'tvc-refresh-status--warn');

  const failures = data?.failures || [];
  if (failures.length) {
    el.classList.add('tvc-refresh-status--warn');
    el.title = failures
      .map(f => `${f.name}: ${f.status}${f.errorMessage ? ' — ' + f.errorMessage : ''}`)
      .join('\n');
    el.textContent = `⚠ Refresh failed: ${failures.map(f => f.name).join(', ')}`;
    return;
  }

  if (data?.lastRefreshUtc) {
    el.classList.add('tvc-refresh-status--ok');
    el.title = (data.datasets || []).map(d => `${d.name}: ${d.status}`).join('\n');
    el.textContent = `Last Refreshed on ${formatDisplayDate(data.lastRefreshUtc)}`;
    return;
  }

  el.title = '';
  el.textContent = 'Refresh status unavailable';
}

// Manual trigger for the daily turns-valclass SAP pull (server.js's cron
// only runs this at 05:45) — POST /api/performance/turns-valclass/refresh
// already existed for this (see routes/performance.js), just wasn't wired
// up to anything in the UI. Runs both sources (TurnsValClass,
// ValuationClasses) and reports back per-source success/failure exactly
// like the cron's own console log does, then reloads the summary body —
// which re-fetches the persisted refresh-status above — so both the
// ephemeral click feedback and the "Last Refreshed" date reflect what just
// happened.
async function runTurnsValClassManualRefresh() {
  const btn    = document.getElementById('btn-refresh-turnsvalclass');
  const status = document.getElementById('turnsvalclass-refresh-status');

  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  status.classList.remove('hidden', 'tvc-refresh-status--ok', 'tvc-refresh-status--warn');
  status.textContent = '';

  try {
    const resp = await fetch('/api/performance/turns-valclass/refresh', { method: 'POST' });
    const json = await resp.json();
    if (!json.success) throw new Error(json.error?.message || 'Refresh failed');

    const results = json.data || [];
    const failed  = results.filter(r => r.status === 'failed');
    const now     = new Date().toLocaleTimeString('en-GB');

    if (failed.length) {
      status.classList.add('tvc-refresh-status--warn');
      status.title = failed.map(f => `${f.name}: ${f.error}`).join('\n');
      status.textContent = `⚠ Refreshed ${now} — ${failed.map(f => `${f.name} failed`).join(', ')}`;
    } else {
      status.classList.add('tvc-refresh-status--ok');
      status.title = '';
      status.textContent = `✓ Refreshed ${now}`;
    }

    await loadTurnsValClassSummaryBody();
  } catch (err) {
    status.classList.add('tvc-refresh-status--warn');
    status.title = '';
    status.textContent = `✕ Refresh failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh Now';
  }
}

// ── Tile 3: stock value by unit-price band ──────────────────────────────────
async function runStockValueByPrice() {
  showResultPanel('Stock Value by Price', 'Breakdown of stock value across unit-price bands');
  destroyTurnsCharts();
  const body = document.getElementById('result-body');

  try {
    const resp = await fetch('/api/performance/turns-valclass/value-by-price');
    const json = await resp.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load');

    const rows = json.data;
    if (!rows.length) {
      body.innerHTML = '<div class="sap-empty">No stock turns data available yet — the daily sync runs at 05:45.</div>';
      return;
    }

    body.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px">
        <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em;margin-bottom:14px">Stock Value by Unit-Price Band</div>
        <canvas id="chart-price-band" style="max-height:280px"></canvas>
      </div>
      <div style="overflow-x:auto">
        <table class="pn-batch-table">
          <thead><tr><th>Price Band</th><th>Materials</th><th>Total Stock Qty</th><th>Total Stock Value</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td style="font-family:'JetBrains Mono',monospace">${esc(r.priceBand)}</td>
                <td>${tvcNum(r.materialCount, 0)}</td>
                <td>${tvcNum(r.totalStockQty, 2)}</td>
                <td>${tvcGbp(r.totalStockValue)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    turnsCharts.push(new Chart(document.getElementById('chart-price-band'), {
      type: 'bar',
      data: {
        labels: rows.map(r => r.priceBand),
        datasets: [{ label: 'Stock Value', data: rows.map(r => Number(r.totalStockValue) || 0), backgroundColor: '#10B981', borderRadius: 4 }],
      },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` £${Number(ctx.parsed.y).toLocaleString('en-GB', { minimumFractionDigits: 2 })}` } } },
        scales: {
          x: { ticks: { color: '#8DA3BE', font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.06)' } },
          y: { ticks: { color: '#8DA3BE', font: { size: 10 }, callback: v => `£${Number(v).toLocaleString('en-GB')}` }, grid: { color: 'rgba(0,0,0,0.06)' } },
        },
      },
    }));

  } catch (err) {
    destroyTurnsCharts();
    body.innerHTML = `<div class="sap-error">Error loading breakdown: ${esc(err.message)}</div>`;
  }
}

// ── Tile 4: change valuation class ──────────────────────────────────────────
async function runChangeValuationClass() {
  showResultPanel('Change Valuation Class', 'Search materials, choose a new valuation class, then submit — SAP moves stock to the order, changes valuation class, and moves stock back');
  const body = document.getElementById('result-body');

  body.innerHTML = `
    <form class="transfer-form" id="cvc-form" onsubmit="return false">
      <div class="tf-section-label">Transit Order</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">SAP Order <span class="tf-req">*</span></label>
          <input class="tf-input" id="cvc-order" type="text" placeholder="e.g. 000012345678" autocomplete="off">
        </div>
        <div class="tf-field">
          <label class="tf-label">Plant <span class="tf-optional">(optional)</span></label>
          <input class="tf-input" id="cvc-plant" type="text" placeholder="defaults to standard plant" autocomplete="off">
        </div>
      </div>

      <div class="tf-section-label">Find Materials</div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <input class="tf-input" id="cvc-search" type="text" placeholder="Material code or description" autocomplete="off">
        </div>
        <div class="tf-field"><button type="button" class="btn-submit" id="cvc-search-btn">Search</button></div>
      </div>

      <div id="cvc-results" style="margin-top:10px"></div>

      <div class="tf-actions">
        <span id="cvc-sel-count" style="font-size:13px;color:var(--text-dim)">0 selected</span>
        <div id="cvc-error" style="font-size:13px;color:var(--error)"></div>
        <button type="button" class="btn-submit" id="cvc-submit-btn" disabled>Change Valuation Class →</button>
      </div>
    </form>
    <div id="cvc-outcome" style="margin-top:14px"></div>`;

  cvcSelections = new Map();
  await fetchValClassCatalog();

  document.getElementById('cvc-search-btn').addEventListener('click', cvcSearchMaterials);
  document.getElementById('cvc-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); cvcSearchMaterials(); }
  });
  document.getElementById('cvc-submit-btn').addEventListener('click', cvcSubmit);
}

async function cvcSearchMaterials() {
  const q = document.getElementById('cvc-search').value.trim();
  const resultsEl = document.getElementById('cvc-results');
  if (!q) { resultsEl.innerHTML = ''; return; }

  resultsEl.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Searching…</div>';

  try {
    const resp = await fetch(`/api/performance/turns-valclass?search=${encodeURIComponent(q)}`);
    const json = await resp.json();
    if (!json.success) throw new Error(json.error?.message || 'Search failed');

    const rows = json.data.slice(0, 50);
    if (!rows.length) { resultsEl.innerHTML = '<div class="sap-empty">No materials matched.</div>'; return; }

    const catalog = await fetchValClassCatalog();

    const valClassOptions = (materialType, current) => {
      const options = catalog.filter(c => !materialType || c.materialType === materialType);
      return `<option value="">— keep ${esc(current || 'current')} —</option>` +
        options.map(o => `<option value="${esc(o.valuationClass)}">${esc(o.valuationClass)} — ${esc(o.description || '')}</option>`).join('');
    };

    resultsEl.innerHTML = `
      <div style="overflow-x:auto">
        <table class="pn-batch-table">
          <thead><tr>
            <th style="width:32px"></th><th>Material</th><th>Description</th><th>Plant</th>
            <th>Current Val. Class</th><th>Stock Qty</th><th>Stock Value</th><th>New Val. Class</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr data-material="${esc(r.material)}" data-plant="${esc(r.plant)}" data-mattext="${esc(r.materialText || '')}"
                  data-valclass="${esc(r.valuationClass || '')}" data-stockqty="${r.stockQty ?? 0}">
                <td><input type="checkbox" class="cvc-check"></td>
                <td style="font-family:'JetBrains Mono',monospace">${esc(r.material)}</td>
                <td>${esc(r.materialText || '—')}</td>
                <td>${esc(r.plant || '—')}</td>
                <td>${esc(r.valuationClass || '—')}</td>
                <td>${tvcNum(r.stockQty, 2)}</td>
                <td>${tvcGbp(r.stockValue)}</td>
                <td>
                  <select class="tf-input cvc-newvalclass" disabled style="font-size:12px;padding:4px 6px">
                    ${valClassOptions(r.materialType, r.valuationClass)}
                  </select>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    resultsEl.querySelectorAll('tr[data-material]').forEach(row => {
      const check  = row.querySelector('.cvc-check');
      const select = row.querySelector('.cvc-newvalclass');

      check.addEventListener('change', () => {
        select.disabled = !check.checked;
        const material = row.dataset.material;
        if (check.checked) {
          cvcSelections.set(material, {
            material,
            materialText: row.dataset.mattext,
            plant: row.dataset.plant,
            newValuationClass: select.value || null,
          });
        } else {
          cvcSelections.delete(material);
        }
        cvcUpdateSelectionState();
      });

      select.addEventListener('change', () => {
        const entry = cvcSelections.get(row.dataset.material);
        if (entry) entry.newValuationClass = select.value || null;
      });
    });

  } catch (err) {
    resultsEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

function cvcUpdateSelectionState() {
  document.getElementById('cvc-sel-count').textContent = `${cvcSelections.size} selected`;
  const order = document.getElementById('cvc-order').value.trim();
  const ready = order.length > 0 && cvcSelections.size > 0 &&
    [...cvcSelections.values()].every(v => v.newValuationClass);
  document.getElementById('cvc-submit-btn').disabled = !ready;
}

async function cvcSubmit() {
  const errorEl = document.getElementById('cvc-error');
  const btn     = document.getElementById('cvc-submit-btn');
  const order   = document.getElementById('cvc-order').value.trim();
  const plant   = document.getElementById('cvc-plant').value.trim();
  errorEl.textContent = '';

  const changes = [...cvcSelections.values()].map(v => ({ material: v.material, newValuationClass: v.newValuationClass }));

  if (!order || !changes.length) {
    errorEl.textContent = 'An order and at least one material with a new valuation class are required.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Submitting…';
  document.getElementById('cvc-outcome').innerHTML = '<div class="sap-loading"><div class="spinner"></div>Moving stock, changing valuation class, moving stock back…</div>';

  try {
    const resp = await fetch('/api/performance/turns-valclass/change-valuation-class', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order, plant: plant || undefined, changes }),
    });
    const json = await resp.json();

    const data = json.data;
    if (!data) throw new Error(json.error?.message || 'Change valuation class failed.');

    const results = data.results || [];
    const okCount = results.filter(r => r.success).length;

    document.getElementById('cvc-outcome').innerHTML = `
      <div style="font-size:13px;color:var(--text-dim);margin-bottom:8px">
        ${okCount} of ${results.length} succeeded ${data.totalValueChange ? `· Total book value change: ${tvcGbp(data.totalValueChange)}` : ''}
      </div>
      <div style="overflow-x:auto">
        <table class="pn-batch-table">
          <thead><tr><th>Material</th><th>Old Val. Class</th><th>New Val. Class</th><th>Old Book Value</th><th>New Book Value</th><th>Result</th></tr></thead>
          <tbody>
            ${results.map(r => `
              <tr>
                <td style="font-family:'JetBrains Mono',monospace">${esc(r.material)}</td>
                <td>${esc(r.oldValuationClass || '—')}</td>
                <td>${esc(r.newValuationClass || '—')}</td>
                <td>${tvcGbp(r.oldBookValue)}</td>
                <td>${tvcGbp(r.newBookValue)}</td>
                <td>${r.success
                  ? `<span style="background:#D1FAE5;color:#065F46;border:1px solid #6EE7B7;border-radius:4px;padding:2px 7px;font-size:11px">OK</span>`
                  : `<span style="color:var(--error);font-size:11px" title="${esc(r.message || '')}">${esc(r.message || 'Failed')}</span>`}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    if (!json.success && data.errorMessage) errorEl.textContent = data.errorMessage;

    if (json.success) {
      cvcSelections = new Map();
      document.getElementById('cvc-results').innerHTML = '';
      document.getElementById('cvc-sel-count').textContent = '0 selected';
    }

  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Change Valuation Class →';
    cvcUpdateSelectionState();
  }
}

// ── Tile 5: history / forecast, by material or combined ─────────────────────
let shfMrpController = '';
let shfCurrentMaterial = null; // null when the combined/"Show All" view is loaded — quick-add link hides itself in that case

async function runStockHistoryForecast() {
  showResultPanel('Stock History & Forecast', '13-month consumption history vs. demand forecast, plus a weekly expected-stock-level projection — search for a material, or view the combined trend for all materials');
  destroyTurnsCharts();
  shfMrpController = '';
  shfCurrentMaterial = null;
  const body = document.getElementById('result-body');

  body.innerHTML = `
    <div class="tf-row">
      <div class="tf-field tf-field--wide">
        <label class="tf-label">Material search</label>
        <input class="tf-input" id="shf-search" type="text" placeholder="Material code or description" autocomplete="off">
      </div>
      <div class="tf-field">
        <label class="tf-label">MRP Controller</label>
        <select class="tf-input" id="shf-mrp-controller"><option value="">All controllers</option></select>
      </div>
      <div class="tf-field" style="justify-content:flex-end">
        <label class="tf-label">&nbsp;</label>
        <button type="button" class="btn-submit" id="shf-search-btn">Search</button>
      </div>
      <div class="tf-field" style="justify-content:flex-end">
        <label class="tf-label">&nbsp;</label>
        <button type="button" class="btn-export" id="shf-all-btn">Show All (combined)</button>
      </div>
    </div>
    <div id="shf-picker" style="margin:10px 0"></div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-top:10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:14px">
        <div id="shf-chart-title" style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em">Select a material or press &ldquo;Show All&rdquo;</div>
        <a href="javascript:void(0)" id="shf-add-adjustment-link" class="hidden" style="font-size:12px;color:var(--accent);white-space:nowrap">+ Add Demand Adjustment</a>
      </div>
      <canvas id="shf-chart" style="max-height:320px"></canvas>
    </div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-top:14px">
      <div style="font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px">Expected Stock Level (Weekly)</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:14px">Projected forward from current stock using predicted usage, spread across weeks. Confirmed deliveries are not shown yet — the line only goes down.</div>
      <canvas id="shf-stock-chart" style="max-height:280px"></canvas>
    </div>`;

  document.getElementById('shf-search-btn').addEventListener('click', shfSearchMaterials);
  document.getElementById('shf-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); shfSearchMaterials(); }
  });
  document.getElementById('shf-all-btn').addEventListener('click', () => shfLoadChart(null, 'All Materials (combined)'));
  document.getElementById('shf-add-adjustment-link').addEventListener('click', () => {
    if (shfCurrentMaterial) daOpenModal(null, shfCurrentMaterial);
  });
  document.getElementById('shf-mrp-controller').addEventListener('change', e => {
    shfMrpController = e.target.value;
    shfLoadChart(null, shfMrpController ? `All Materials — MRP Controller ${shfMrpController} (combined)` : 'All Materials (combined)');
  });

  shfLoadMrpControllers();
}

async function shfLoadMrpControllers() {
  const sel = document.getElementById('shf-mrp-controller');
  try {
    const resp = await fetch('/api/performance/turns-valclass/mrp-controllers');
    const json = await resp.json();
    if (!json.success) return;
    json.data.forEach(row => {
      const opt = document.createElement('option');
      opt.value = row.controller;
      opt.textContent = `${row.controller} (${row.materialCount})`;
      sel.appendChild(opt);
    });
  } catch (_) { /* dropdown just stays at "All controllers" */ }
}

async function shfSearchMaterials() {
  const q = document.getElementById('shf-search').value.trim();
  const picker = document.getElementById('shf-picker');
  if (!q) { picker.innerHTML = ''; return; }

  picker.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Searching…</div>';

  try {
    const ctrlParam = shfMrpController ? `&mrpController=${encodeURIComponent(shfMrpController)}` : '';
    const resp = await fetch(`/api/performance/turns-valclass?search=${encodeURIComponent(q)}${ctrlParam}`);
    const json = await resp.json();
    if (!json.success) throw new Error(json.error?.message || 'Search failed');

    const rows = json.data.slice(0, 30);
    if (!rows.length) { picker.innerHTML = '<div class="sap-empty">No materials matched.</div>'; return; }

    picker.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">
        ${rows.length} material${rows.length !== 1 ? 's' : ''} found — click a row to load its chart (showing the first below):
      </div>
      <div style="overflow-x:auto">
        <table class="pn-batch-table">
          <thead><tr><th>Material</th><th>Description</th></tr></thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr class="pn-row shf-pick" style="cursor:pointer" data-idx="${i}"
                  data-material="${esc(r.material)}" data-desc="${esc(r.materialText || '')}">
                <td style="font-family:'JetBrains Mono',monospace;font-weight:700">${esc(r.material)}</td>
                <td>${esc(r.materialText || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    const pickRows = picker.querySelectorAll('.shf-pick');
    const setActive = tr => {
      pickRows.forEach(r => { r.style.background = ''; r.style.fontWeight = ''; });
      tr.style.background = 'var(--surface2)';
      tr.style.fontWeight = '600';
    };

    pickRows.forEach(tr => {
      tr.addEventListener('click', () => {
        setActive(tr);
        shfLoadChart(tr.dataset.material, `${tr.dataset.material}${tr.dataset.desc ? ' — ' + tr.dataset.desc : ''}`);
      });
    });

    // Load the first match immediately so a click isn't required for the common case.
    if (pickRows[0]) setActive(pickRows[0]);
    const first = rows[0];
    shfLoadChart(first.material, `${first.material}${first.materialText ? ' — ' + first.materialText : ''}`);

  } catch (err) {
    picker.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function shfLoadChart(material, title) {
  destroyTurnsCharts();
  const titleEl = document.getElementById('shf-chart-title');
  titleEl.textContent = 'Loading…';
  shfCurrentMaterial = material || null;
  const addAdjLink = document.getElementById('shf-add-adjustment-link');
  if (addAdjLink) addAdjLink.classList.toggle('hidden', !shfCurrentMaterial);

  try {
    const ctrlParam = shfMrpController ? `mrpController=${encodeURIComponent(shfMrpController)}` : '';
    const materialParam = material ? `materials=${encodeURIComponent(material)}` : '';
    const qs = [materialParam, ctrlParam].filter(Boolean).join('&');
    const url = `/api/performance/turns-valclass/history${qs ? '?' + qs : ''}`;
    const resp = await fetch(url);
    const json = await resp.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load history');

    let history, forecast, predicted;

    if (material) {
      const row = json.data[0];
      if (!row) throw new Error('No history/forecast data for that material.');
      history   = row.consumptionHistory.map(v => Number(v) || 0);
      forecast  = row.demandForecast.map(v => Number(v) || 0);
      predicted = (row.predictedUsage || []).map(v => Number(v) || 0);
    } else {
      history   = new Array(13).fill(0);
      forecast  = new Array(13).fill(0);
      predicted = new Array(13).fill(0);
      json.data.forEach(r => {
        (r.consumptionHistory || []).forEach((v, i) => { history[i]   += Number(v) || 0; });
        (r.demandForecast     || []).forEach((v, i) => { forecast[i]  += Number(v) || 0; });
        (r.predictedUsage     || []).forEach((v, i) => { predicted[i] += Number(v) || 0; });
      });
    }

    // "Recorded" values come from dbo.ForecastAccuracyLog (see performance.js /turns-valclass/history) —
    // what SAP demand and our prediction WERE for each of the last 12 months, frozen as of right before
    // each month started. Already summed server-side across whichever materials this request covers.
    const accuracy = json.accuracy || {};
    const recordedSapDemand = (accuracy.recordedSapDemand || new Array(13).fill(null)).map(v => v == null ? null : Number(v));
    const recordedPredicted = (accuracy.recordedPredicted || new Array(13).fill(null)).map(v => v == null ? null : Number(v));

    titleEl.textContent = title;

    // MVER (consumption history) is only populated in SAP when a material's
    // "consumption values" indicator is switched on — plenty of materials
    // legitimately have none, even when the forecast (live requirements) does.
    // Flag it explicitly rather than showing a silent flat line at zero.
    const noHistory = history.every(v => !v);
    let noteEl = document.getElementById('shf-history-note');
    if (!noteEl) {
      noteEl = document.createElement('div');
      noteEl.id = 'shf-history-note';
      noteEl.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:8px';
      titleEl.parentElement.appendChild(noteEl);
    }
    noteEl.textContent = noHistory
      ? 'No consumption history recorded in SAP (MVER) for this selection — the material\'s consumption-values indicator may not be maintained, or it genuinely has no consumption yet.'
      : '';

    // history[0..12] runs M-12 -> Current; forecast/predicted[0..12] run Current -> M+12
    // (see BuildConsumptionHistoryRequest/ParseDemandForecastRows in PerformanceHelpers.cs —
    // the arrays share "Current" at opposite ends, not the same position). One continuous
    // 25-point timeline, each series padded with nulls on the side it doesn't cover, so the
    // lines visually join at "Current". recordedSapDemand/recordedPredicted (from
    // dbo.ForecastAccuracyLog) are already 13-wide in the same M-12..Current shape as
    // history, so they get the same right-padding treatment.
    const labels = [
      ...Array.from({ length: 12 }, (_, i) => `M-${12 - i}`),
      'Current',
      ...Array.from({ length: 12 }, (_, i) => `M+${i + 1}`),
    ];
    const historySeries          = [...history, ...Array(12).fill(null)];
    const forecastSeries         = [...Array(12).fill(null), ...forecast];
    const predictedSeries        = [...Array(12).fill(null), ...predicted];
    const recordedSapSeries      = [...recordedSapDemand, ...Array(12).fill(null)];
    const recordedPredictedSeries = [...recordedPredicted, ...Array(12).fill(null)];

    let canvas = document.getElementById('shf-chart');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'shf-chart';
      canvas.style.maxHeight = '320px';
      titleEl.insertAdjacentElement('afterend', canvas);
    }

    turnsCharts.push(new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Consumption History', data: historySeries, borderColor: '#0891B2', backgroundColor: 'rgba(8,145,178,0.08)', fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: '#0891B2', spanGaps: false },
          { label: 'SAP Demand Forecast', data: forecastSeries, borderColor: '#F59E0B', backgroundColor: 'rgba(245,158,11,0.08)', fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: '#F59E0B', borderDash: [5, 4], spanGaps: false },
          { label: 'Predicted Usage', data: predictedSeries, borderColor: '#16A34A', backgroundColor: 'rgba(22,163,74,0.08)', fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: '#16A34A', borderDash: [5, 4], spanGaps: false },
          { label: 'SAP Demand (recorded)', data: recordedSapSeries, borderColor: '#F59E0B', backgroundColor: 'transparent', fill: false, tension: 0.3, pointRadius: 2, pointBackgroundColor: '#F59E0B', borderDash: [1, 3], borderWidth: 1.5, spanGaps: false },
          { label: 'Predicted (recorded)', data: recordedPredictedSeries, borderColor: '#16A34A', backgroundColor: 'transparent', fill: false, tension: 0.3, pointRadius: 2, pointBackgroundColor: '#16A34A', borderDash: [1, 3], borderWidth: 1.5, spanGaps: false },
        ],
      },
      options: {
        plugins: { legend: { position: 'bottom', labels: { color: '#4D6380', font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: '#8DA3BE', font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.06)' } },
          y: { ticks: { color: '#8DA3BE', font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.06)' } },
        },
      },
    }));

    // ── Weekly expected stock level (Phase 1 — see routes/performance.js
    // buildWeeklyStockForecast for the month-to-week spreading method; no
    // confirmed-delivery data exists yet, so this line only ever goes down). ──
    const stockForecast = json.stockForecast;
    const stockCanvas = document.getElementById('shf-stock-chart');
    if (stockForecast && stockCanvas) {
      const stockLabels = [stockForecast.asOfDate, ...stockForecast.weeks.map(w => w.weekEnding)];
      const stockSeries  = [stockForecast.currentStock, ...stockForecast.weeks.map(w => w.expectedStock)];
      const usageSeries   = [null, ...stockForecast.weeks.map(w => w.weeklyUsage)];

      turnsCharts.push(new Chart(stockCanvas, {
        type: 'line',
        data: {
          labels: stockLabels,
          datasets: [
            { label: 'Expected Stock Level', data: stockSeries, borderColor: '#7C3AED', backgroundColor: 'rgba(124,58,237,0.10)', fill: true, tension: 0.2, pointRadius: 2, pointBackgroundColor: '#7C3AED', yAxisID: 'y' },
            { label: 'Weekly Usage', data: usageSeries, borderColor: '#DC2626', backgroundColor: 'transparent', fill: false, borderDash: [3, 3], borderWidth: 1.5, pointRadius: 0, yAxisID: 'y1' },
          ],
        },
        options: {
          plugins: { legend: { position: 'bottom', labels: { color: '#4D6380', font: { size: 11 } } } },
          scales: {
            x: { ticks: { color: '#8DA3BE', font: { size: 10 }, maxRotation: 60, minRotation: 60 }, grid: { color: 'rgba(0,0,0,0.06)' } },
            y:  { position: 'left',  ticks: { color: '#8DA3BE', font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.06)' }, title: { display: true, text: 'Stock', color: '#8DA3BE', font: { size: 10 } } },
            y1: { position: 'right', ticks: { color: '#8DA3BE', font: { size: 10 } }, grid: { display: false }, title: { display: true, text: 'Weekly Usage', color: '#8DA3BE', font: { size: 10 } } },
          },
        },
      }));
    }

  } catch (err) {
    titleEl.textContent = 'Error';
    const canvas = document.getElementById('shf-chart');
    if (canvas) {
      const errDiv = document.createElement('div');
      errDiv.className = 'sap-error';
      errDiv.textContent = err.message;
      canvas.replaceWith(errDiv);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Vendor Master Data (MRP Phase 2) — lead time, Incoterms, MOQ per vendor
// and per vendor+material. Manually maintained (not sourced from SAP — see
// sql/migrate_vendor_master_data.sql). A later phase reads this to drive the
// order-suggestion engine; this tile is just the data entry/management UI.
// ══════════════════════════════════════════════════════════════════════════

async function runVendorMasterData() {
  showResultPanel('Vendor Master Data', "Lead time, Incoterms & minimum order quantities — click a vendor to manage its materials");
  try {
    const vendors = await vmFetchVendors();
    vmRenderVendorList(vendors);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function vmFetchVendors() {
  const res = await fetch('/api/performance/vendors');
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message || 'Failed to load vendors');
  return json.data;
}

function vmRenderVendorList(vendors) {
  document.getElementById('result-row-badge').textContent = `${vendors.length} vendor${vendors.length !== 1 ? 's' : ''}`;
  document.getElementById('result-row-badge').classList.remove('hidden');

  const rows = vendors.map(v => `
    <tr class="admin-row vm-vendor-row" style="cursor:pointer" data-id="${esc(String(v.VendorId))}">
      <td><strong>${esc(v.VendorName)}</strong></td>
      <td>${v.SapVendorNumber ? esc(v.SapVendorNumber) : '<span class="sap-error" title="Needed before Create PO in SAP can be used for this vendor">Not set</span>'}</td>
      <td>${esc(v.Incoterms || '—')}</td>
      <td>${vmOrderQtyLabel(v)}</td>
      <td>${v.DefaultLeadTimeDays != null ? esc(String(v.DefaultLeadTimeDays)) + ' days' : '—'}</td>
      <td>${v.MaterialCount}</td>
      <td onclick="event.stopPropagation()" style="text-align:right;white-space:nowrap">
        <button class="btn-secondary vm-edit-vendor" data-id="${esc(String(v.VendorId))}" style="padding:3px 10px;font-size:11px">Edit</button>
        <button class="btn-secondary vm-delete-vendor" data-id="${esc(String(v.VendorId))}" data-name="${esc(v.VendorName)}" style="padding:3px 10px;font-size:11px;color:var(--error,#DC2626)">Delete</button>
      </td>
    </tr>`).join('');

  document.getElementById('result-body').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button class="btn-submit" id="vm-add-vendor-btn">+ Add Vendor</button>
    </div>
    ${vendors.length ? `
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Vendor</th><th>SAP Vendor No.</th><th>Incoterms</th><th>Order Qty</th><th>Default Lead Time</th><th>Materials</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : '<div class="sap-empty">No vendors yet — add one to get started.</div>'}
  `;

  document.getElementById('vm-add-vendor-btn').addEventListener('click', () => vmOpenVendorModal(null));
  document.querySelectorAll('.vm-vendor-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const v = vendors.find(x => String(x.VendorId) === tr.dataset.id);
      if (v) vmShowVendorMaterials(v);
    });
  });
  document.querySelectorAll('.vm-edit-vendor').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = vendors.find(x => String(x.VendorId) === btn.dataset.id);
      if (v) vmOpenVendorModal(v);
    });
  });
  document.querySelectorAll('.vm-delete-vendor').forEach(btn => {
    btn.addEventListener('click', () => vmDeleteVendor(btn.dataset.id, btn.dataset.name));
  });
}

const VM_INCOTERMS = ['EXW', 'FCA', 'FOB', 'CPT', 'CIP', 'CFR', 'CIF', 'DAP', 'DPU', 'DDP'];

// Order Min/Max collapse to one label: an exact-quantity vendor (min ===
// max, e.g. Raaj Ratna: exactly 20,000kg) reads differently from a plain
// minimum or a min/max range.
function vmOrderQtyLabel(v) {
  const uom = v.OrderMoqUom ? ' ' + esc(v.OrderMoqUom) : '';
  const min = v.OrderMoqQty != null ? Number(v.OrderMoqQty) : null;
  const max = v.OrderMaxQty != null ? Number(v.OrderMaxQty) : null;
  if (min == null && max == null) return '—';
  if (min != null && max != null && min === max) return `Exactly ${min.toLocaleString()}${uom}`;
  if (min != null && max != null) return `${min.toLocaleString()}–${max.toLocaleString()}${uom}`;
  if (min != null) return `Min ${min.toLocaleString()}${uom}`;
  return `Max ${max.toLocaleString()}${uom}`;
}

function vmOpenVendorModal(vendor) {
  const isEdit = !!vendor;
  openModal(`<div class="ps-modal" style="max-width:480px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">${isEdit ? 'Edit Vendor' : 'Add Vendor'}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Vendor Name</label>
          <input class="tf-input" type="text" id="vm-name" value="${esc(vendor?.VendorName || '')}">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">SAP Vendor Number</label>
          <input class="tf-input" type="text" id="vm-sap-vendor-number" maxlength="10" value="${esc(vendor?.SapVendorNumber || '')}" placeholder="e.g. 0000078712">
        </div>
        <div class="tf-field">
          <label class="tf-label">Currency</label>
          <input class="tf-input" type="text" id="vm-currency" maxlength="3" value="${esc(vendor?.Currency || '')}" placeholder="GBP">
        </div>
      </div>
      <div class="toolbar-hint" style="margin:2px 0 10px">Both required before this vendor can be used for "Create PO in SAP" on Tracked Orders — SAP Vendor Number is the real LIFNR from SAP, not any Nexus id.</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Incoterms</label>
          <select class="tf-input" id="vm-incoterms">
            <option value="">—</option>
            ${VM_INCOTERMS.map(t => `<option value="${t}" ${vendor?.Incoterms === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="tf-field">
          <label class="tf-label">Default Lead Time (days)</label>
          <input class="tf-input" type="number" step="0.1" id="vm-lead-time" value="${vendor?.DefaultLeadTimeDays ?? ''}">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Transit Time (days)</label>
          <input class="tf-input" type="number" step="0.1" id="vm-transit-time" value="${vendor?.TransitTimeDays ?? ''}">
        </div>
      </div>
      <div class="toolbar-hint" style="margin:2px 0 10px">Only used for EXW vendors: subtracted from lead time to get the date to actually quote the supplier (ready-to-collect date), since under EXW you arrange collection and transit yourself rather than the vendor. Ignored for any other Incoterm.</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Order Min Qty</label>
          <input class="tf-input" type="number" step="0.001" id="vm-order-moq-qty" value="${vendor?.OrderMoqQty ?? ''}">
        </div>
        <div class="tf-field">
          <label class="tf-label">Order Max Qty</label>
          <input class="tf-input" type="number" step="0.001" id="vm-order-max-qty" value="${vendor?.OrderMaxQty ?? ''}">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Order MOQ UOM</label>
          <input class="tf-input" type="text" id="vm-order-moq-uom" maxlength="3" value="${esc(vendor?.OrderMoqUom || '')}" placeholder="KG">
        </div>
      </div>
      <div class="toolbar-hint" style="margin:2px 0 10px">Combined across any mix of this vendor's materials in one order (e.g. a vendor requiring 20,000kg total). Leave Min blank if there's no combined minimum. Set Max equal to Min for a vendor that requires an EXACT combined quantity, not just a minimum (e.g. Raaj Ratna: exactly 20,000kg, no more, no less) — this is enforced when accepting an order, not just a hint.</div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Notes</label>
          <input class="tf-input" type="text" id="vm-notes" value="${esc(vendor?.Notes || '')}">
        </div>
      </div>
      <div id="vm-vendor-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="vm-vendor-save-btn">${isEdit ? 'Save Changes' : 'Add Vendor'}</button>
    </div>
  </div>`);

  document.getElementById('vm-vendor-save-btn').addEventListener('click', async () => {
    const body = {
      vendorName: document.getElementById('vm-name').value.trim(),
      sapVendorNumber: document.getElementById('vm-sap-vendor-number').value.trim() || null,
      currency: document.getElementById('vm-currency').value.trim().toUpperCase() || null,
      incoterms: document.getElementById('vm-incoterms').value || null,
      defaultLeadTimeDays: vmNumOrNull(document.getElementById('vm-lead-time').value),
      transitTimeDays: vmNumOrNull(document.getElementById('vm-transit-time').value),
      orderMoqQty: vmNumOrNull(document.getElementById('vm-order-moq-qty').value),
      orderMaxQty: vmNumOrNull(document.getElementById('vm-order-max-qty').value),
      orderMoqUom: document.getElementById('vm-order-moq-uom').value.trim() || null,
      notes: document.getElementById('vm-notes').value.trim() || null,
    };
    if (!body.vendorName) {
      document.getElementById('vm-vendor-result').innerHTML = '<div class="sap-error">Vendor name is required.</div>';
      return;
    }
    const btn = document.getElementById('vm-vendor-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch(isEdit ? `/api/performance/vendors/${vendor.VendorId}` : '/api/performance/vendors', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Save failed');
      closePickModal();
      runVendorMasterData();
    } catch (err) {
      document.getElementById('vm-vendor-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = isEdit ? 'Save Changes' : 'Add Vendor';
    }
  });
}

function vmNumOrNull(str) {
  const v = String(str ?? '').trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function vmDeleteVendor(vendorId, vendorName) {
  if (!confirm(`Delete vendor "${vendorName}" and all its material assignments? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/performance/vendors/${vendorId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Delete failed');
    runVendorMasterData();
  } catch (err) {
    alert(err.message);
  }
}

// ── Vendor materials (assign / edit / remove) ───────────────────────────────

async function vmShowVendorMaterials(vendor) {
  showResultPanel(`Vendor Master Data — ${vendor.VendorName}`, 'Click a material to edit its MOQ, lead-time override or schedule agreement');
  try {
    const res = await fetch(`/api/performance/vendors/${vendor.VendorId}/materials`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load materials');
    vmRenderVendorMaterials(vendor, json.data);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

function vmRenderVendorMaterials(vendor, materials) {
  document.getElementById('result-row-badge').textContent = `${materials.length} material${materials.length !== 1 ? 's' : ''}`;
  document.getElementById('result-row-badge').classList.remove('hidden');

  const rows = materials.map(m => `
    <tr class="admin-row vm-material-row" style="cursor:pointer" data-id="${esc(String(m.VendorMaterialId))}">
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700">${esc(m.Material)}</td>
      <td>${esc(m.MaterialText || '—')}</td>
      <td>${esc(m.MrpController || '—')}</td>
      <td>${vmMaterialQtyLabel(m)}</td>
      <td>${vmLeadTimeDisplay(m)}</td>
      <td>${esc(m.ScheduleAgreement || '—')}</td>
      <td onclick="event.stopPropagation()" style="text-align:right;white-space:nowrap">
        <button class="btn-secondary vm-remove-material" data-id="${esc(String(m.VendorMaterialId))}" data-material="${esc(m.Material)}" style="padding:3px 10px;font-size:11px;color:var(--error,#DC2626)">Remove</button>
      </td>
    </tr>`).join('');

  document.getElementById('result-body').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
      <a href="javascript:void(0)" onclick="runVendorMasterData()" style="font-size:12px;color:var(--accent)">&larr; All Vendors</a>
      <button class="btn-submit" id="vm-assign-material-btn">+ Assign Material</button>
    </div>
    ${materials.length ? `
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Material</th><th>Description</th><th>MRP Ctrl</th><th>MOQ / Max</th><th>Lead Time</th><th>Sched. Agmt</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : '<div class="sap-empty">No materials assigned yet.</div>'}
  `;

  document.getElementById('vm-assign-material-btn').addEventListener('click', () => vmOpenAssignMaterialModal(vendor));
  document.querySelectorAll('.vm-material-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const m = materials.find(x => String(x.VendorMaterialId) === tr.dataset.id);
      if (m) vmOpenMaterialEditModal(vendor, m);
    });
  });
  document.querySelectorAll('.vm-remove-material').forEach(btn => {
    btn.addEventListener('click', () => vmRemoveMaterial(vendor, btn.dataset.id, btn.dataset.material));
  });
}

// SapLeadTimeDays comes from TurnsValClassSnapshot.PlannedDeliveryTime (SAP MARC-PLIFZ),
// LEFT JOINed in listVendorMaterials — it's the fallback the order-suggestion engine will
// use whenever LeadTimeDaysOverride is left blank, so it's worth showing here even though
// it isn't stored on VendorMaterial itself.
function vmLeadTimeDisplay(m) {
  if (m.LeadTimeDaysOverride != null) return `${esc(String(m.LeadTimeDaysOverride))} days`;
  if (m.SapLeadTimeDays != null) return `${esc(String(m.SapLeadTimeDays))} days (SAP)`;
  return '—';
}

// Same min/max/exact collapsing as vmOrderQtyLabel, at the per-material level.
function vmMaterialQtyLabel(m) {
  const min = m.MaterialMoqQty != null ? Number(m.MaterialMoqQty) : null;
  const max = m.MaterialMaxQty != null ? Number(m.MaterialMaxQty) : null;
  if (min == null && max == null) return '—';
  if (min != null && max != null && min === max) return `Exactly ${min.toLocaleString()}`;
  if (min != null && max != null) return `${min.toLocaleString()}–${max.toLocaleString()}`;
  if (min != null) return `Lots of ${min.toLocaleString()}`;
  return `Max ${max.toLocaleString()}`;
}

function vmOpenAssignMaterialModal(vendor) {
  openModal(`<div class="ps-modal" style="max-width:560px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Assign Material</div><div class="ps-modal-sub">${esc(vendor.VendorName)}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <input class="tf-input" type="text" id="vm-material-search" placeholder="Search by material number or description…" style="margin-bottom:10px">
      <div id="vm-material-search-results"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
    </div>
  </div>`);

  let searchTimer = null;
  document.getElementById('vm-material-search').addEventListener('input', function () {
    clearTimeout(searchTimer);
    const q = this.value.trim();
    const results = document.getElementById('vm-material-search-results');
    if (!q) { results.innerHTML = ''; return; }
    searchTimer = setTimeout(() => vmSearchMaterials(vendor, q), 250);
  });
}

// Reuses the same turns-valclass search endpoint the Stock History & Forecast
// tile's shfSearchMaterials() already uses — no new backend search route needed.
async function vmSearchMaterials(vendor, q) {
  const results = document.getElementById('vm-material-search-results');
  if (!results) return;
  results.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Searching…</div>';
  try {
    const resp = await fetch(`/api/performance/turns-valclass?search=${encodeURIComponent(q)}`);
    const json = await resp.json();
    if (!json.success) throw new Error(json.error?.message || 'Search failed');
    const rows = json.data.slice(0, 30);
    if (!rows.length) { results.innerHTML = '<div class="sap-empty">No materials matched.</div>'; return; }
    results.innerHTML = `
      <div style="overflow-x:auto;max-height:320px;overflow-y:auto">
        <table class="pn-batch-table">
          <thead><tr><th>Material</th><th>Description</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr class="pn-row vm-material-pick" style="cursor:pointer" data-material="${esc(r.material)}">
                <td style="font-family:'JetBrains Mono',monospace;font-weight:700">${esc(r.material)}</td>
                <td>${esc(r.materialText || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    document.querySelectorAll('.vm-material-pick').forEach(tr => {
      tr.addEventListener('click', () => vmAssignMaterial(vendor, tr.dataset.material));
    });
  } catch (err) {
    results.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function vmAssignMaterial(vendor, material) {
  try {
    const res = await fetch(`/api/performance/vendors/${vendor.VendorId}/materials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ material }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Assign failed');
    closePickModal();
    vmShowVendorMaterials(vendor);
  } catch (err) {
    const results = document.getElementById('vm-material-search-results');
    if (results) results.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    else alert(err.message);
  }
}

function vmOpenMaterialEditModal(vendor, m) {
  openModal(`<div class="ps-modal" style="max-width:480px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">${esc(m.Material)}</div><div class="ps-modal-sub">${esc(m.MaterialText || '')}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Material MOQ (lot size)</label>
          <input class="tf-input" type="number" step="0.001" id="vm-mat-moq" value="${m.MaterialMoqQty ?? ''}">
        </div>
        <div class="tf-field">
          <label class="tf-label">Material Max Qty</label>
          <input class="tf-input" type="number" step="0.001" id="vm-mat-max" value="${m.MaterialMaxQty ?? ''}">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Lead Time Override (days)</label>
          <input class="tf-input" type="number" step="0.1" id="vm-mat-lead" value="${m.LeadTimeDaysOverride ?? ''}" placeholder="${m.SapLeadTimeDays != null ? `SAP: ${m.SapLeadTimeDays}` : ''}">
        </div>
      </div>
      <div class="toolbar-hint" style="margin:2px 0 10px">MOQ is a lot size, not just a floor — order suggestions round up to whole multiples of it, and quantities you enter are snapped to the nearest multiple automatically. Max Qty is a hard cap. Leave either blank if it doesn't apply.</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Min Safety Stock</label>
          <input class="tf-input" type="number" step="0.001" id="vm-mat-safety" value="${m.MinSafetyStockQty ?? ''}" placeholder="${m.SapSafetyStock != null ? `SAP: ${m.SapSafetyStock}` : ''}">
        </div>
      </div>
      <div class="toolbar-hint" style="margin:2px 0 10px">Minimum stock buffer to maintain for this material — order suggestions (Phase 2b) are raised before stock is projected to fall below this floor rather than just-in-time, since supplier dates often slip. Leave blank to fall back to SAP's own safety stock (EISBE) if set, otherwise 0.</div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Schedule Agreement</label>
          <input class="tf-input" type="text" id="vm-mat-sched" value="${esc(m.ScheduleAgreement || '')}">
        </div>
      </div>
      <div class="toolbar-hint" style="margin:2px 0 10px">Leave blank if this material is ordered via spot PO rather than against a scheduling agreement.</div>
      ${m.SourceHint ? `<div class="toolbar-hint">Seeded from MRP2.xlsx as "${esc(m.SourceHint)}" — double-check this is the right SAP material.</div>` : ''}
      <div id="vm-mat-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="vm-mat-save-btn">Save</button>
    </div>
  </div>`);

  document.getElementById('vm-mat-save-btn').addEventListener('click', async () => {
    const body = {
      materialMoqQty: vmNumOrNull(document.getElementById('vm-mat-moq').value),
      materialMaxQty: vmNumOrNull(document.getElementById('vm-mat-max').value),
      leadTimeDaysOverride: vmNumOrNull(document.getElementById('vm-mat-lead').value),
      minSafetyStockQty: vmNumOrNull(document.getElementById('vm-mat-safety').value),
      scheduleAgreement: document.getElementById('vm-mat-sched').value.trim() || null,
    };
    const btn = document.getElementById('vm-mat-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch(`/api/performance/vendors/${vendor.VendorId}/materials/${m.VendorMaterialId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Save failed');
      closePickModal();
      vmShowVendorMaterials(vendor);
    } catch (err) {
      document.getElementById('vm-mat-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Save';
    }
  });
}

async function vmRemoveMaterial(vendor, vendorMaterialId, material) {
  if (!confirm(`Remove ${material} from ${vendor.VendorName}?`)) return;
  try {
    const res = await fetch(`/api/performance/vendors/${vendor.VendorId}/materials/${vendorMaterialId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Remove failed');
    vmShowVendorMaterials(vendor);
  } catch (err) {
    alert(err.message);
  }
}


// ══════════════════════════════════════════════════════════════════════════
// Vendor Consignment Tracker — replaces the manually-maintained per-vendor
// Excel workbooks (Chemours/Fothergill(FCF)/Raaj) with a SQL-backed balance
// dashboard + FEFO/FIFO declaration builder. See sql/migrate_consignment_
// tracker.sql for the full design writeup — "undeclared consumption" is a
// balance (Delivered - live SAP stock - already Declared), not a raw SAP
// consumption pull; MRKO itself stays manual (run in SAP GUI, settlement
// doc number pasted back), gated behind the VENDOR_CONSIGNMENT permission.
// ══════════════════════════════════════════════════════════════════════════

let ctVendors = [];
let ctCurrentVendor = null;

async function runConsignmentTracker() {
  showResultPanel('Vendor Consignment Tracker', 'Delivered / current stock / declared balance per vendor — click a vendor to build a declaration');
  try {
    ctVendors = await ctApi('/vendors');
    ctRenderVendorList();
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function ctApi(path, opts) {
  const res = await fetch(`/api/consignment${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message || 'Request failed');
  return json.data;
}

function ctRenderVendorList() {
  const rows = ctVendors.map(v => `
    <tr class="admin-row ct-vendor-row" style="cursor:pointer" data-id="${esc(String(v.VendorId))}">
      <td><strong>${esc(v.VendorName)}</strong></td>
      <td>${v.SapVendorNumber ? esc(v.SapVendorNumber) : '<span class="sap-error" title="Needed before GR can be synced from SAP">Not set</span>'}</td>
      <td>${v.TrackExpiry ? `Yes (${v.ExpiryWarningDays ?? '—'}d warning)` : 'No'}</td>
      <td>${esc(v.DefaultAllocationMethod)}</td>
      <td onclick="event.stopPropagation()" style="text-align:right;white-space:nowrap">
        <button class="btn-secondary ct-edit-vendor" data-id="${esc(String(v.VendorId))}" style="padding:3px 10px;font-size:11px">Config</button>
      </td>
    </tr>`).join('');

  document.getElementById('result-body').innerHTML = `
    ${ctVendors.length ? `
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Vendor</th><th>SAP Vendor No.</th><th>Expiry Tracking</th><th>Default Method</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : '<div class="sap-empty">No consignment vendors configured yet.</div>'}
  `;

  document.querySelectorAll('.ct-vendor-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const v = ctVendors.find(x => String(x.VendorId) === tr.dataset.id);
      if (v) ctShowVendorDashboard(v);
    });
  });
  document.querySelectorAll('.ct-edit-vendor').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = ctVendors.find(x => String(x.VendorId) === btn.dataset.id);
      if (v) ctOpenConfigModal(v);
    });
  });
}

function ctOpenConfigModal(vendor) {
  openModal(`<div class="ps-modal" style="max-width:440px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">${esc(vendor.VendorName)} — Consignment Config</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label"><input type="checkbox" id="ct-cfg-track-expiry" ${vendor.TrackExpiry ? 'checked' : ''}> Track Expiry</label>
        </div>
        <div class="tf-field">
          <label class="tf-label">Warning Window (days)</label>
          <input class="tf-input" type="number" id="ct-cfg-warning-days" value="${vendor.ExpiryWarningDays ?? ''}">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Default Allocation Method</label>
          <select class="tf-input" id="ct-cfg-method">
            <option value="FEFO" ${vendor.DefaultAllocationMethod === 'FEFO' ? 'selected' : ''}>FEFO (First-Expire-First-Out)</option>
            <option value="FIFO" ${vendor.DefaultAllocationMethod === 'FIFO' ? 'selected' : ''}>FIFO (First-In-First-Out)</option>
            <option value="MANUAL" ${vendor.DefaultAllocationMethod === 'MANUAL' ? 'selected' : ''}>Manual selection only</option>
          </select>
        </div>
      </div>
      <div class="tf-field tf-field--wide">
        <label class="tf-label">Notes</label>
        <textarea class="tf-input" id="ct-cfg-notes" rows="2">${esc(vendor.Notes || '')}</textarea>
      </div>
      <div class="tf-actions">
        <div id="ct-cfg-result"></div>
        <button type="button" class="btn-submit" id="ct-cfg-save-btn">Save</button>
      </div>
    </div>
  </div>`);

  document.getElementById('ct-cfg-save-btn').addEventListener('click', async () => {
    const resultEl = document.getElementById('ct-cfg-result');
    try {
      await ctApi(`/vendors/${vendor.VendorId}/config`, {
        method: 'PUT',
        body: JSON.stringify({
          trackExpiry: document.getElementById('ct-cfg-track-expiry').checked,
          expiryWarningDays: document.getElementById('ct-cfg-warning-days').value || null,
          defaultAllocationMethod: document.getElementById('ct-cfg-method').value,
          notes: document.getElementById('ct-cfg-notes').value,
        }),
      });
      closePickModal();
      runConsignmentTracker();
    } catch (err) {
      resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
    }
  });
}

// ── Vendor dashboard: balance per material + expiry warnings + history ──────

async function ctShowVendorDashboard(vendor) {
  ctCurrentVendor = vendor;
  document.getElementById('result-title').textContent = `Consignment Tracker — ${vendor.VendorName}`;
  document.getElementById('result-hint').textContent = 'Delivered / current SAP stock / declared balance, per material';
  document.getElementById('result-body').innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading balance…</div>';

  try {
    const [balance, declarations] = await Promise.all([
      ctApi(`/vendors/${vendor.VendorId}/balance`),
      ctApi(`/vendors/${vendor.VendorId}/declarations`),
    ]);
    ctRenderVendorDashboard(vendor, balance, declarations);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

function ctRenderVendorDashboard(vendor, balance, declarations) {
  const matRows = balance.materials.map(m => `
    <tr class="admin-row">
      <td><strong>${esc(m.material)}</strong></td>
      <td style="text-align:right">${m.delivered.toLocaleString()}</td>
      <td style="text-align:right">${m.currentStock.toLocaleString()}</td>
      <td style="text-align:right">${m.declared.toLocaleString()}</td>
      <td style="text-align:right"><strong>${m.undeclared.toLocaleString()}</strong></td>
      <td style="text-align:right">
        <button class="btn-secondary ct-propose-btn" data-material="${esc(m.material)}" data-undeclared="${m.undeclared}" style="padding:3px 10px;font-size:11px" ${m.undeclared > 0 ? '' : 'disabled'}>Build Declaration</button>
      </td>
    </tr>`).join('');

  const warningRows = (balance.expiryWarnings || []).map(d => `
    <tr class="admin-row ct-row--negative">
      <td>${esc(d.Material)}</td>
      <td>${esc(d.InvoiceNumber || '—')}</td>
      <td style="text-align:right">${Number(d.RemainingQty).toLocaleString()}</td>
      <td>${d.ExpiryDate ? new Date(d.ExpiryDate).toLocaleDateString('en-GB') : '—'}</td>
    </tr>`).join('');

  const declRows = declarations.map(d => `
    <tr class="admin-row ct-decl-row" style="cursor:pointer" data-id="${d.DeclarationId}">
      <td>#${d.DeclarationId}</td>
      <td>${new Date(d.CreatedAtUtc).toLocaleDateString('en-GB')}</td>
      <td>${esc(d.AllocationMethod)}</td>
      <td style="text-align:right">${Number(d.TotalQty).toLocaleString()}</td>
      <td><span class="tile-badge ${d.Status === 'Confirmed' ? 'tile-badge--live' : ''}">${esc(d.Status)}</span></td>
      <td>${d.SettlementDocumentNumber ? esc(d.SettlementDocumentNumber) : '—'}</td>
    </tr>`).join('');

  document.getElementById('result-body').innerHTML = `
    <div class="tf-actions" style="margin-bottom:14px">
      <button type="button" class="btn-secondary" id="ct-back-btn">&larr; All Vendors</button>
      <button type="button" class="btn-secondary" id="ct-sync-btn">Sync GR from SAP</button>
      <div id="ct-sync-result" style="margin-left:8px"></div>
    </div>

    <div class="ct-panel-title">Material Balance</div>
    <div class="ct-panel-sub">Undeclared = Delivered − current SAP consignment stock − already-Confirmed declarations.</div>
    <div style="overflow-x:auto;margin-bottom:20px">
      <table class="pn-batch-table admin-table">
        <thead><tr><th>Material</th><th>Delivered</th><th>Current Stock</th><th>Declared</th><th>Undeclared</th><th></th></tr></thead>
        <tbody>${matRows || '<tr><td colspan="6" class="sap-empty">No deliveries recorded for this vendor yet.</td></tr>'}</tbody>
      </table>
    </div>

    ${vendor.TrackExpiry ? `
    <div class="ct-panel-title">Expiry Warnings</div>
    <div class="ct-panel-sub">Delivery lines with remaining balance expiring within the configured warning window.</div>
    <div style="overflow-x:auto;margin-bottom:20px">
      <table class="pn-batch-table admin-table">
        <thead><tr><th>Material</th><th>Invoice/Ref</th><th>Remaining Qty</th><th>Expiry</th></tr></thead>
        <tbody>${warningRows || '<tr><td colspan="4" class="sap-empty">Nothing expiring soon.</td></tr>'}</tbody>
      </table>
    </div>` : ''}

    <div class="ct-panel-title">Declaration History</div>
    <div style="overflow-x:auto">
      <table class="pn-batch-table admin-table">
        <thead><tr><th>#</th><th>Created</th><th>Method</th><th>Total Qty</th><th>Status</th><th>Settlement Doc</th></tr></thead>
        <tbody>${declRows || '<tr><td colspan="6" class="sap-empty">No declarations yet.</td></tr>'}</tbody>
      </table>
    </div>
  `;

  document.getElementById('ct-back-btn').addEventListener('click', () => runConsignmentTracker());
  document.getElementById('ct-sync-btn').addEventListener('click', () => ctSyncVendor(vendor));
  document.querySelectorAll('.ct-propose-btn').forEach(btn => {
    btn.addEventListener('click', () => ctOpenProposeModal(vendor, btn.dataset.material, Number(btn.dataset.undeclared)));
  });
  document.querySelectorAll('.ct-decl-row').forEach(tr => {
    tr.addEventListener('click', () => ctShowDeclaration(tr.dataset.id));
  });
}

async function ctSyncVendor(vendor) {
  const btn = document.getElementById('ct-sync-btn');
  const resultEl = document.getElementById('ct-sync-result');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  resultEl.innerHTML = '';
  try {
    const data = await ctApi(`/vendors/${vendor.VendorId}/sync`, { method: 'POST' });
    resultEl.innerHTML = `<span class="toolbar-hint">Pulled ${data.pulled} GR line(s) from SAP, ${data.inserted} new.</span>`;
    ctShowVendorDashboard(vendor);
  } catch (err) {
    resultEl.innerHTML = `<span class="sap-error tf-inline-error">✕ ${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync GR from SAP';
  }
}

// ── Build declaration: propose (FEFO/FIFO/manual) -> edit -> save draft ────

function ctOpenProposeModal(vendor, material, undeclared) {
  const method = vendor.DefaultAllocationMethod || 'FIFO';
  openModal(`<div class="ps-modal" style="max-width:420px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Build Declaration — ${esc(material)}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="toolbar-hint" style="margin-bottom:10px">Undeclared consumption: <strong>${undeclared.toLocaleString()}</strong></div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Quantity to Declare</label>
          <input class="tf-input" type="number" step="any" id="ct-propose-qty" value="${undeclared}">
        </div>
        <div class="tf-field">
          <label class="tf-label">Method</label>
          <select class="tf-input" id="ct-propose-method">
            <option value="FEFO" ${method === 'FEFO' ? 'selected' : ''}>FEFO</option>
            <option value="FIFO" ${method === 'FIFO' ? 'selected' : ''}>FIFO</option>
            <option value="MANUAL" ${method === 'MANUAL' ? 'selected' : ''}>Manual</option>
          </select>
        </div>
      </div>
      <div class="tf-actions">
        <div id="ct-propose-result"></div>
        <button type="button" class="btn-submit" id="ct-propose-btn">Propose Allocation</button>
      </div>
    </div>
  </div>`);

  document.getElementById('ct-propose-btn').addEventListener('click', async () => {
    const resultEl = document.getElementById('ct-propose-result');
    const qty = Number(document.getElementById('ct-propose-qty').value);
    const selMethod = document.getElementById('ct-propose-method').value;
    if (!qty || qty <= 0) { resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Enter a valid quantity.</div>`; return; }
    try {
      const proposal = await ctApi(`/vendors/${vendor.VendorId}/declarations/propose`, {
        method: 'POST',
        body: JSON.stringify({ material, qtyToDeclare: qty, method: selMethod }),
      });
      closePickModal();
      ctShowProposalEditor(vendor, material, selMethod, proposal);
    } catch (err) {
      resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
    }
  });
}

// Editable matrix preview — the FEFO/FIFO proposal (or, for MANUAL, every
// open delivery line unallocated) with per-line qty editable before saving
// as a Draft declaration. Mirrors exactly what Raaj's old Summary tab
// recorded after the fact via MRKO.
let ctEditorLines = [];

function ctShowProposalEditor(vendor, material, method, proposal) {
  ctEditorLines = (proposal.lines && proposal.lines.length ? proposal.lines : proposal.openLines.map(l => ({
    deliveryId: l.DeliveryId, material: l.Material, qtyAllocated: 0,
    invoiceNumber: l.InvoiceNumber, expiryDate: l.ExpiryDate, documentDate: l.DocumentDate,
    remainingBeforeAllocation: Number(l.RemainingQty),
  }))).map(l => ({ ...l }));

  document.getElementById('result-title').textContent = `Declaration Preview — ${material}`;
  document.getElementById('result-hint').textContent = `${method} allocation — adjust quantities before saving as a draft`;
  ctRenderProposalEditor(vendor, method, proposal.unallocatedQty || 0);
}

function ctRenderProposalEditor(vendor, method, unallocatedQty) {
  const rows = ctEditorLines.map((l, i) => `
    <tr class="admin-row">
      <td>${esc(l.invoiceNumber || '—')}</td>
      <td>${l.expiryDate ? new Date(l.expiryDate).toLocaleDateString('en-GB') : '—'}</td>
      <td>${l.documentDate ? new Date(l.documentDate).toLocaleDateString('en-GB') : '—'}</td>
      <td style="text-align:right">${(l.remainingBeforeAllocation ?? '').toLocaleString?.() ?? l.remainingBeforeAllocation}</td>
      <td style="text-align:right"><input class="tf-input ct-line-qty" data-idx="${i}" type="number" step="any" style="width:100px;text-align:right" value="${l.qtyAllocated}"></td>
      <td><button class="btn-secondary ct-line-remove" data-idx="${i}" style="padding:2px 8px;font-size:11px;color:var(--error,#DC2626)">×</button></td>
    </tr>`).join('');

  const total = ctEditorLines.reduce((s, l) => s + Number(l.qtyAllocated || 0), 0);

  document.getElementById('result-body').innerHTML = `
    <div class="tf-actions" style="margin-bottom:14px">
      <button type="button" class="btn-secondary" id="ct-editor-back-btn">&larr; Back to Dashboard</button>
    </div>
    ${unallocatedQty > 0 ? `<div class="ct-disc-warn" style="margin-bottom:12px">${unallocatedQty.toLocaleString()} could not be auto-allocated — not enough open delivery balance found. Add lines manually or reduce the quantity.</div>` : ''}
    <div style="overflow-x:auto">
      <table class="pn-batch-table admin-table">
        <thead><tr><th>Invoice/Ref</th><th>Expiry</th><th>Delivery Date</th><th>Open Balance</th><th>Qty to Declare</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="sap-empty">No lines — nothing to declare.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="tf-actions" style="margin-top:16px">
      <div class="toolbar-hint">Total: <strong>${total.toLocaleString()}</strong></div>
      <div id="ct-editor-result"></div>
      <button type="button" class="btn-submit" id="ct-editor-save-btn">Save as Draft</button>
    </div>
  `;

  document.getElementById('ct-editor-back-btn').addEventListener('click', () => ctShowVendorDashboard(vendor));
  document.querySelectorAll('.ct-line-qty').forEach(input => {
    input.addEventListener('change', () => {
      ctEditorLines[Number(input.dataset.idx)].qtyAllocated = Number(input.value) || 0;
      ctRenderProposalEditor(vendor, method, unallocatedQty);
    });
  });
  document.querySelectorAll('.ct-line-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      ctEditorLines.splice(Number(btn.dataset.idx), 1);
      ctRenderProposalEditor(vendor, method, unallocatedQty);
    });
  });
  document.getElementById('ct-editor-save-btn').addEventListener('click', () => ctSaveDraftDeclaration(vendor, method));
}

async function ctSaveDraftDeclaration(vendor, method) {
  const resultEl = document.getElementById('ct-editor-result');
  const lines = ctEditorLines.filter(l => Number(l.qtyAllocated) > 0)
    .map(l => ({ deliveryId: l.deliveryId, material: l.material, qtyAllocated: l.qtyAllocated }));
  if (!lines.length) { resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Enter a quantity on at least one line.</div>`; return; }

  try {
    const declaration = await ctApi(`/vendors/${vendor.VendorId}/declarations`, {
      method: 'POST',
      body: JSON.stringify({ allocationMethod: method, lines }),
    });
    ctShowDeclaration(declaration.DeclarationId, vendor);
  } catch (err) {
    resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
  }
}

// ── Declaration detail: view, print, confirm (elevated), cancel ─────────────

async function ctShowDeclaration(declarationId, vendor) {
  document.getElementById('result-title').textContent = `Declaration #${declarationId}`;
  document.getElementById('result-hint').textContent = 'Review, print, and confirm once MRKO has been run in SAP';
  document.getElementById('result-body').innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading…</div>';

  try {
    const declaration = await ctApi(`/declarations/${declarationId}`);
    ctRenderDeclaration(declaration, vendor);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

function ctRenderDeclaration(d, vendor) {
  const canConfirm = sessionRole === 'superadmin' || userPermissions.includes('VENDOR_CONSIGNMENT');

  const rows = d.lines.map(l => `
    <tr class="admin-row">
      <td>${esc(l.Material)}</td>
      <td>${esc(l.InvoiceNumber || '—')}</td>
      <td>${esc(l.MaterialDocument || '—')}</td>
      <td>${l.ExpiryDate ? new Date(l.ExpiryDate).toLocaleDateString('en-GB') : '—'}</td>
      <td style="text-align:right">${Number(l.QtyAllocated).toLocaleString()}</td>
    </tr>`).join('');

  document.getElementById('result-body').innerHTML = `
    <div class="tf-actions" style="margin-bottom:14px">
      <button type="button" class="btn-secondary" id="ct-decl-back-btn">&larr; Back</button>
      <button type="button" class="btn-secondary" id="ct-decl-print-btn">Print Declaration (PDF)</button>
      ${d.Status === 'Draft' ? `<button type="button" class="btn-secondary" id="ct-decl-cancel-btn" style="color:var(--error,#DC2626)">Cancel Draft</button>` : ''}
    </div>

    <div class="tf-row" style="margin-bottom:14px">
      <div class="tf-field"><label class="tf-label">Vendor</label><div>${esc(d.VendorName)}</div></div>
      <div class="tf-field"><label class="tf-label">Status</label><div><span class="tile-badge ${d.Status === 'Confirmed' ? 'tile-badge--live' : ''}">${esc(d.Status)}</span></div></div>
      <div class="tf-field"><label class="tf-label">Method</label><div>${esc(d.AllocationMethod)}</div></div>
      <div class="tf-field"><label class="tf-label">Total Qty</label><div>${Number(d.TotalQty).toLocaleString()}</div></div>
    </div>

    <div style="overflow-x:auto;margin-bottom:16px">
      <table class="pn-batch-table admin-table">
        <thead><tr><th>Material</th><th>Invoice/Ref</th><th>GR Doc</th><th>Expiry</th><th>Qty Declared</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    ${d.Status === 'Draft' ? `
      <div class="ct-panel-title">Confirm Declaration</div>
      <div class="ct-panel-sub">Run MRKO in SAP GUI for this quantity first, then paste the resulting settlement document number below.</div>
      ${canConfirm ? `
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Settlement Document Number</label>
            <input class="tf-input" type="text" id="ct-decl-settlement-doc" placeholder="e.g. 1700003535">
          </div>
          <div class="tf-field">
            <label class="tf-label">Reconciled Qty <span class="tf-optional">(optional — what MRKO actually settled)</span></label>
            <input class="tf-input" type="number" step="any" id="ct-decl-reconciled-qty">
          </div>
        </div>
        <div class="tf-actions">
          <div id="ct-decl-confirm-result"></div>
          <button type="button" class="btn-submit" id="ct-decl-confirm-btn">Confirm Declaration</button>
        </div>
      ` : `<div class="toolbar-hint">You don't have permission to confirm a declaration — ask a supervisor with Vendor Consignment Settlement access.</div>`}
    ` : d.SettlementDocumentNumber ? `
      <div class="toolbar-hint">Confirmed ${new Date(d.ConfirmedAtUtc).toLocaleDateString('en-GB')} by ${esc(d.ConfirmedByUsername || '—')} — settlement document ${esc(d.SettlementDocumentNumber)}${d.SettlementReconciledQty != null ? `, reconciled qty ${Number(d.SettlementReconciledQty).toLocaleString()}` : ''}</div>
    ` : ''}
  `;

  document.getElementById('ct-decl-back-btn').addEventListener('click', () => vendor ? ctShowVendorDashboard(vendor) : runConsignmentTracker());
  document.getElementById('ct-decl-print-btn').addEventListener('click', () => window.open(`/api/consignment/declarations/${d.DeclarationId}/pdf`, '_blank'));

  const cancelBtn = document.getElementById('ct-decl-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', async () => {
    if (!confirm('Cancel this draft declaration?')) return;
    try {
      await ctApi(`/declarations/${d.DeclarationId}/cancel`, { method: 'POST' });
      vendor ? ctShowVendorDashboard(vendor) : runConsignmentTracker();
    } catch (err) { alert(err.message); }
  });

  const confirmBtn = document.getElementById('ct-decl-confirm-btn');
  if (confirmBtn) confirmBtn.addEventListener('click', async () => {
    const resultEl = document.getElementById('ct-decl-confirm-result');
    const settlementDocumentNumber = document.getElementById('ct-decl-settlement-doc').value.trim();
    const reconciledQtyVal = document.getElementById('ct-decl-reconciled-qty').value;
    if (!settlementDocumentNumber) { resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ Enter the SAP settlement document number.</div>`; return; }
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Confirming…';
    try {
      await ctApi(`/declarations/${d.DeclarationId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ settlementDocumentNumber, settlementReconciledQty: reconciledQtyVal ? Number(reconciledQtyVal) : null }),
      });
      ctShowDeclaration(d.DeclarationId, vendor);
    } catch (err) {
      resultEl.innerHTML = `<div class="sap-error tf-inline-error">✕ ${esc(err.message)}</div>`;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm Declaration';
    }
  });
}


// ══════════════════════════════════════════════════════════════════════════
// Demand Adjustments (MRP Phase 3) — manual, per-material usage overrides for
// known events a seasonal-index forecast can't see on its own (machine down,
// planned extra production, or a standing correction to a forecast running
// too high/low). See sql/migrate_demand_adjustments.sql and
// routes/performance.js's makeDailyUsageFn for how these feed both the Stock
// History & Forecast graph and the order-suggestion engine.
// ══════════════════════════════════════════════════════════════════════════

async function runDemandAdjustments() {
  showResultPanel('Demand Adjustments', 'Manual usage overrides for known events — machine downtime, extra production, or a standing forecast correction');
  try {
    const adjustments = await daFetchAdjustments();
    daRenderList(adjustments);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function daFetchAdjustments() {
  const res = await fetch('/api/performance/demand-adjustments');
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message || 'Failed to load demand adjustments');
  return json.data;
}

function daRenderList(adjustments) {
  document.getElementById('result-row-badge').textContent = `${adjustments.length} adjustment${adjustments.length !== 1 ? 's' : ''}`;
  document.getElementById('result-row-badge').classList.remove('hidden');

  const rows = adjustments.map(a => `
    <tr class="admin-row">
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700">${esc(a.Material)}</td>
      <td>${esc(a.MaterialText || '—')}</td>
      <td>${daRangeLabel(a)}</td>
      <td>${esc(String(a.UsagePercent))}%</td>
      <td>${esc(a.Reason || '—')}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn-secondary da-edit" data-id="${esc(String(a.AdjustmentId))}" style="padding:3px 10px;font-size:11px">Edit</button>
        <button class="btn-secondary da-delete" data-id="${esc(String(a.AdjustmentId))}" data-material="${esc(a.Material)}" style="padding:3px 10px;font-size:11px;color:var(--error,#DC2626)">Delete</button>
      </td>
    </tr>`).join('');

  document.getElementById('result-body').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button class="btn-submit" id="da-add-btn">+ Add Adjustment</button>
    </div>
    ${adjustments.length ? `
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Material</th><th>Description</th><th>Range</th><th>Usage %</th><th>Reason</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : '<div class="sap-empty">No demand adjustments yet — add one to override predicted usage for a material.</div>'}
  `;

  document.getElementById('da-add-btn').addEventListener('click', () => daOpenModal(null));
  document.querySelectorAll('.da-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = adjustments.find(x => String(x.AdjustmentId) === btn.dataset.id);
      if (a) daOpenModal(a);
    });
  });
  document.querySelectorAll('.da-delete').forEach(btn => {
    btn.addEventListener('click', () => daDeleteAdjustment(btn.dataset.id, btn.dataset.material));
  });
}

// Range reads as "Permanent" only when BOTH bounds are open — a single open
// bound still shows the bound it does have (e.g. "22/07/2026 → indefinitely").
function daRangeLabel(a) {
  if (!a.StartDate && !a.EndDate) return 'Permanent';
  const start = a.StartDate ? formatDisplayDate(a.StartDate) : 'the start';
  const end = a.EndDate ? formatDisplayDate(a.EndDate) : 'indefinitely';
  return `${start} &rarr; ${end}`;
}

function daDateInputValue(value) {
  if (!value) return '';
  return new Date(value).toISOString().slice(0, 10);
}

// prefillMaterial locks the Material field for the quick-add link from Stock
// History & Forecast (a known-valid material already on screen — no need to
// search for it again), without being an edit of an existing adjustment.
function daOpenModal(adjustment, prefillMaterial) {
  const isEdit = !!adjustment;
  const material = adjustment?.Material || prefillMaterial || '';
  const materialLocked = isEdit || !!prefillMaterial;
  openModal(`<div class="ps-modal" style="max-width:520px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">${isEdit ? 'Edit Demand Adjustment' : 'Add Demand Adjustment'}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Material</label>
          <input class="tf-input" type="text" id="da-material" value="${esc(material)}" placeholder="Search by material number or description…" ${materialLocked ? 'readonly' : ''}>
          <input type="hidden" id="da-material-value" value="${esc(material)}">
          <div id="da-material-search-results"></div>
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Start Date</label>
          <input class="tf-input" type="date" id="da-start-date" value="${daDateInputValue(adjustment?.StartDate)}">
        </div>
        <div class="tf-field">
          <label class="tf-label">End Date</label>
          <input class="tf-input" type="date" id="da-end-date" value="${daDateInputValue(adjustment?.EndDate)}">
        </div>
      </div>
      <div class="toolbar-hint" style="margin:2px 0 10px">Leave Start Date blank to apply from today onward. Leave End Date blank to apply indefinitely until you edit or delete this adjustment. Leave both blank for a permanent correction.</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Usage %</label>
          <input class="tf-input" type="number" step="0.1" min="0" id="da-usage-percent" value="${adjustment?.UsagePercent ?? 100}">
        </div>
      </div>
      <div class="toolbar-hint" style="margin:2px 0 10px">Percentage of the normal predicted usage to apply over the range above — 0 = fully stopped (e.g. a machine down), 50 = half rate, 150 = one and a half times (planned extra production).</div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Reason</label>
          <input class="tf-input" type="text" id="da-reason" value="${esc(adjustment?.Reason || '')}" placeholder="e.g. Line 3 down for planned maintenance">
        </div>
      </div>
      <div id="da-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="da-save-btn">${isEdit ? 'Save Changes' : 'Add Adjustment'}</button>
    </div>
  </div>`);

  if (!materialLocked) {
    let searchTimer = null;
    document.getElementById('da-material').addEventListener('input', function () {
      document.getElementById('da-material-value').value = '';
      clearTimeout(searchTimer);
      const q = this.value.trim();
      const results = document.getElementById('da-material-search-results');
      if (!q) { results.innerHTML = ''; return; }
      searchTimer = setTimeout(() => daSearchMaterials(q), 250);
    });
  }

  document.getElementById('da-save-btn').addEventListener('click', async () => {
    const material = isEdit ? adjustment.Material : document.getElementById('da-material-value').value;
    const body = {
      material,
      startDate: document.getElementById('da-start-date').value || null,
      endDate: document.getElementById('da-end-date').value || null,
      usagePercent: vmNumOrNull(document.getElementById('da-usage-percent').value),
      reason: document.getElementById('da-reason').value.trim() || null,
    };
    if (!body.material) {
      document.getElementById('da-result').innerHTML = '<div class="sap-error">Pick a material from the search results.</div>';
      return;
    }
    if (body.usagePercent == null || body.usagePercent < 0) {
      document.getElementById('da-result').innerHTML = '<div class="sap-error">Usage % is required and cannot be negative.</div>';
      return;
    }
    const btn = document.getElementById('da-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch(isEdit ? `/api/performance/demand-adjustments/${adjustment.AdjustmentId}` : '/api/performance/demand-adjustments', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Save failed');
      closePickModal();
      runDemandAdjustments();
    } catch (err) {
      document.getElementById('da-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = isEdit ? 'Save Changes' : 'Add Adjustment';
    }
  });
}

// Reuses the same turns-valclass search endpoint as vmSearchMaterials —
// no new backend search route needed.
async function daSearchMaterials(q) {
  const results = document.getElementById('da-material-search-results');
  if (!results) return;
  results.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Searching…</div>';
  try {
    const resp = await fetch(`/api/performance/turns-valclass?search=${encodeURIComponent(q)}`);
    const json = await resp.json();
    if (!json.success) throw new Error(json.error?.message || 'Search failed');
    const rows = json.data.slice(0, 30);
    if (!rows.length) { results.innerHTML = '<div class="sap-empty">No materials matched.</div>'; return; }
    results.innerHTML = `
      <div style="overflow-x:auto;max-height:240px;overflow-y:auto;margin-top:6px">
        <table class="pn-batch-table">
          <thead><tr><th>Material</th><th>Description</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr class="pn-row da-material-pick" style="cursor:pointer" data-material="${esc(r.material)}">
                <td style="font-family:'JetBrains Mono',monospace;font-weight:700">${esc(r.material)}</td>
                <td>${esc(r.materialText || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    document.querySelectorAll('.da-material-pick').forEach(tr => {
      tr.addEventListener('click', () => {
        document.getElementById('da-material').value = tr.dataset.material;
        document.getElementById('da-material-value').value = tr.dataset.material;
        results.innerHTML = '';
      });
    });
  } catch (err) {
    results.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function daDeleteAdjustment(adjustmentId, material) {
  if (!confirm(`Delete the demand adjustment for ${material}? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/performance/demand-adjustments/${adjustmentId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Delete failed');
    runDemandAdjustments();
  } catch (err) {
    alert(err.message);
  }
}


// ── Order suggestions (MRP Phase 2b) ────────────────────────────────────────
// See sql/migrate_order_suggestions.sql / routes/performance.js's
// computeOrderSuggestions() for the full trigger logic writeup. Two views
// sharing the same result panel, toggled by a button rather than separate
// tiles: the live "needs ordering" list, and a tracker for what's already
// been accepted (so status can be walked forward as it's raised in SAP and
// received) — same pattern as vmShowVendorMaterials's drill-down, just a
// toggle instead of a click-through.

async function runOrderSuggestions() {
  showResultPanel('Order Suggestions', "Materials projected to fall below their safety stock floor before a fresh order could arrive — not just-in-time");
  try {
    const groups = await osFetchSuggestions(); // grouped by vendor — see groupSuggestionsByVendor server-side
    osRenderSuggestionList(groups);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function osFetchSuggestions() {
  const res = await fetch('/api/performance/order-suggestions');
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message || 'Failed to load order suggestions');
  return json.data;
}

async function osFetchTracked() {
  const res = await fetch('/api/performance/order-suggestions/tracked');
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message || 'Failed to load tracked orders');
  return json.data;
}

function osRenderSuggestionList(groups) {
  const totalMaterials = groups.reduce((sum, g) => sum + g.materials.length, 0);
  document.getElementById('result-row-badge').textContent =
    `${totalMaterials} need${totalMaterials === 1 ? 's' : ''} ordering across ${groups.length} vendor${groups.length === 1 ? '' : 's'}`;
  document.getElementById('result-row-badge').classList.remove('hidden');

  if (!groups.length) {
    document.getElementById('result-body').innerHTML = `
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:10px">
        <button class="btn-secondary" id="os-add-manual-btn">+ Add Manual Order</button>
        <button class="btn-secondary" id="os-view-tracked-btn">View Tracked Orders →</button>
      </div>
      <div class="sap-empty">Nothing needs ordering right now.</div>`;
    document.getElementById('os-view-tracked-btn').addEventListener('click', () => runOrderSuggestionsTracked());
    document.getElementById('os-add-manual-btn').addEventListener('click', () => openManualOrderModal());
    return;
  }

  // Vendors with a combined order-level MOQ (dbo.Vendor.OrderMoqQty) are
  // forced through the Build Order modal rather than getting a per-row quick
  // Accept — accepting one material alone would silently leave the order
  // short of the minimum, which defeats the point of tracking it at all.
  const sections = groups.map((g, gi) => {
    // hasMoq covers a plain minimum, a plain maximum, or an exact quantity
    // (min === max) — any of these forces the vendor through Build Order
    // rather than a per-row quick Accept, since a single material alone
    // can't be trusted to satisfy a combined constraint.
    const hasMoq = !!(g.orderMoqQty || g.orderMaxQty);
    let moqLabel = '';
    if (hasMoq) {
      if (g.moqMet) {
        moqLabel = g.isExactQty ? 'Exact qty met' : 'MOQ met';
      } else if (g.isExactQty) {
        moqLabel = g.moqShortfall > 0
          ? `Short ${g.moqShortfall.toLocaleString()} ${esc(g.orderMoqUom || '')} of exact ${Number(g.orderMoqQty).toLocaleString()}`
          : `Over exact ${Number(g.orderMoqQty).toLocaleString()} by ${g.moqOverage.toLocaleString()} ${esc(g.orderMoqUom || '')}`;
      } else if (g.moqOverage > 0) {
        moqLabel = `Over max by ${g.moqOverage.toLocaleString()} ${esc(g.orderMoqUom || '')}`;
      } else {
        moqLabel = `Short ${g.moqShortfall.toLocaleString()} ${esc(g.orderMoqUom || '')} of MOQ`;
      }
    }
    const moqBadge = hasMoq
      ? `<span class="tile-badge" style="background:${g.moqMet ? 'var(--success,#16A34A)' : 'var(--error,#DC2626)'};color:#fff">${moqLabel}</span>`
      : '';

    const rows = g.materials.map((s, mi) => {
      const urgencyBadge = s.urgency === 'Overdue'
        ? `<span class="tile-badge" style="background:var(--error,#DC2626);color:#fff">Overdue</span>`
        : `<span class="tile-badge" style="background:var(--warning,#D97706);color:#fff">Due Soon</span>`;
      const agreementCell = s.isSpotPo
        ? `<span style="color:var(--warning,#D97706)">Spot PO</span>`
        : esc(s.scheduleAgreement || '—');
      const acceptCell = hasMoq
        ? `<span style="font-size:11px;color:var(--text-secondary,#666)">via Build Order</span>`
        : `<button class="btn-submit os-accept-btn" data-gi="${gi}" data-mi="${mi}" style="padding:4px 12px;font-size:11px">Accept</button>`;
      return `
        <tr class="admin-row os-suggestion-row" data-material="${esc(s.material)}" data-material-text="${esc(s.materialText || '')}" style="cursor:context-menu">
          <td><strong>${esc(s.material)}</strong><div style="font-size:11px;color:var(--text-secondary,#666)">${esc(s.materialText || '')}</div></td>
          <td>${urgencyBadge}<div style="font-size:11px;margin-top:2px">Order by ${formatDisplayDate(s.orderByDate)}</div></td>
          <td>${Number(s.currentStock).toLocaleString()} ${esc(s.uom || '')}</td>
          <td>${Number(s.safetyStockQty).toLocaleString()} ${esc(s.uom || '')}</td>
          <td>${formatDisplayDate(s.breachDate)}</td>
          <td>${s.leadTimeDays}${s.transitTimeDays != null ? ` (+${s.transitTimeDays} transit)` : ''}d</td>
          <td><strong>${Number(s.suggestedQty).toLocaleString()}</strong> ${esc(s.uom || '')}${s.materialMoqQty ? `<div style="font-size:11px;color:var(--text-secondary,#666)">MOQ ${Number(s.materialMoqQty).toLocaleString()}</div>` : ''}</td>
          <td>${agreementCell}</td>
          <td style="text-align:right">${acceptCell}</td>
        </tr>`;
    }).join('');

    return `
      <div class="ps-section">
        <div class="ps-section-header" style="display:flex;align-items:center;gap:10px">
          <span class="ps-section-dot ps-section-dot--today"></span>
          <span class="ps-section-title">${esc(g.vendorName)}</span>
          <span class="ps-section-count">${g.materials.length}</span>
          ${moqBadge}
          ${hasMoq ? `<button class="btn-submit os-build-order-btn" data-vendor-id="${g.vendorId}" style="margin-left:auto;padding:4px 12px;font-size:11px">Build Order</button>` : ''}
        </div>
        <div class="ps-section-body">
          <div style="overflow-x:auto">
            <table class="pn-batch-table admin-table">
              <thead><tr>
                <th>Material</th><th>Urgency</th><th>Current Stock</th><th>Safety Floor</th>
                <th>Breach Date</th><th>Lead Time</th><th>Suggested Qty</th><th>Agreement</th><th></th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  }).join('');

  document.getElementById('result-body').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:12px">
      <div class="toolbar-hint" style="margin:0">Triggered off each material's safety stock floor — not just-in-time. Vendors with a combined order MOQ are grouped so you can see whether one order clears it; use Build Order to combine materials and hit the minimum.</div>
      <div style="display:flex;gap:8px;white-space:nowrap">
        <button class="btn-secondary" id="os-add-manual-btn">+ Add Manual Order</button>
        <button class="btn-secondary" id="os-upload-csv-btn">Upload CSV</button>
        <button class="btn-secondary" id="os-view-tracked-btn">View Tracked Orders →</button>
      </div>
    </div>
    ${sections}
  `;

  document.getElementById('os-view-tracked-btn').addEventListener('click', () => runOrderSuggestionsTracked());
  document.getElementById('os-add-manual-btn').addEventListener('click', () => openManualOrderModal());
  document.getElementById('os-upload-csv-btn').addEventListener('click', () => openManualOrderCsvModal());
  document.querySelectorAll('.os-accept-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const g = groups[Number(btn.dataset.gi)];
      osOpenAcceptModal(g.materials[Number(btn.dataset.mi)]);
    });
  });
  document.querySelectorAll('.os-build-order-btn').forEach(btn => {
    btn.addEventListener('click', () => osOpenBuildOrderModal(btn.dataset.vendorId));
  });
  document.querySelectorAll('.ps-section-header').forEach(hdr => {
    hdr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return; // don't collapse when the Build Order button is clicked
      hdr.closest('.ps-section').classList.toggle('ps-section--collapsed');
    });
  });
  document.querySelectorAll('.os-suggestion-row').forEach(row => {
    row.addEventListener('contextmenu', (e) => {
      showOsContextMenu(e, row.dataset.material, row.dataset.materialText);
    });
  });
}

// Small floating menu on right-click of an Order Suggestions row — mirrors
// the pallet builder's .pb-ctx-menu pattern (warehouse.js
// showPackageContextMenu/closePackageContextMenu). Built dynamically rather
// than an inline oncontextmenu attribute, since materialText is free-text
// from SAP and could contain characters that break attribute-string
// escaping.
function closeOsContextMenu() {
  document.getElementById('os-ctx-menu')?.remove();
  document.removeEventListener('click', closeOsContextMenu);
}

function showOsContextMenu(event, material, materialText) {
  event.preventDefault();
  closeOsContextMenu();

  const menu = document.createElement('div');
  menu.id = 'os-ctx-menu';
  menu.className = 'pb-ctx-menu';
  // Fixed positioning is viewport-relative, so use clientX/clientY (not
  // pageX/pageY, which drift once the page has scrolled).
  menu.style.left = `${Math.min(event.clientX, window.innerWidth  - 230)}px`;
  menu.style.top  = `${Math.min(event.clientY, window.innerHeight - 60)}px`;
  menu.innerHTML = `<div class="pb-ctx-item" data-action="forecast">View Consumption / Forecast</div>`;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', closeOsContextMenu), 0);

  menu.querySelector('[data-action="forecast"]').addEventListener('click', () => {
    closeOsContextMenu();
    goToMaterialForecast(material, materialText);
  });
}

// Jumps to the Stock History & Forecast tile pre-filtered to a single
// material — used from the Order Suggestions right-click menu so a buyer
// can sanity-check the consumption trend behind a suggestion without
// leaving to search for the material manually.
function goToMaterialForecast(material, materialText) {
  runStockHistoryForecast();
  const searchInput = document.getElementById('shf-search');
  if (searchInput) searchInput.value = material;
  const title = `${material}${materialText ? ' — ' + materialText : ''}`;
  shfLoadChart(material, title);
}

// Mirrors routes/performance.js's enforceMaterialQty — snaps to the nearest
// whole MaterialMoqQty lot and clamps to MaterialMaxQty. Client-side so a
// lot-size/max violation gets corrected before the request even goes out;
// the server re-derives the constraints fresh from the DB and enforces
// again regardless (defence against a stale page or a direct API call), so
// this is a convenience, not the source of truth. Returns null for a
// non-positive qty (caller should treat that as "missing").
function osEnforceQty(rawQty, materialMoqQty, materialMaxQty) {
  let q = Number(rawQty) || 0;
  if (q <= 0) return null;
  const moq = Number(materialMoqQty) || 0;
  if (moq > 0) {
    q = Math.round(q / moq) * moq;
    if (q <= 0) q = moq;
  }
  const max = Number(materialMaxQty) || 0;
  if (max > 0 && q > max) {
    q = moq > 0 ? Math.floor(max / moq) * moq : max;
    if (q <= 0) q = max;
  }
  return Math.round(q * 1000) / 1000;
}

function osOpenAcceptModal(s) {
  const todayStr = new Date().toISOString().slice(0, 10);
  openModal(`<div class="ps-modal" style="max-width:480px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Accept Order Suggestion</div><div class="ps-modal-sub">${esc(s.material)} — ${esc(s.vendorName)}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Order Qty</label>
          <input class="tf-input" type="number" step="${s.materialMoqQty || 0.001}" id="os-order-qty" value="${s.suggestedQty}">
        </div>
        <div class="tf-field">
          <label class="tf-label">Order Date</label>
          <input class="tf-input" type="date" id="os-order-date" value="${todayStr}">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Delivery Date <span style="font-weight:400;color:var(--text-secondary,#666)">(optional — leave blank to auto-calculate from lead time)</span></label>
          <input class="tf-input" type="date" id="os-delivery-date" value="">
        </div>
      </div>
      ${s.materialMoqQty ? `<div class="toolbar-hint" style="margin:2px 0 10px">This vendor only supplies in ${Number(s.materialMoqQty).toLocaleString()} ${esc(s.uom || '')} lots — order in whole multiples.</div>` : ''}
      ${s.materialMaxQty ? `<div class="toolbar-hint" style="margin:2px 0 10px">Capped at ${Number(s.materialMaxQty).toLocaleString()} ${esc(s.uom || '')} maximum — entered/adjusted quantities above this are clamped down automatically.</div>` : ''}
      ${s.isSpotPo
        ? `<div class="toolbar-hint" style="margin:2px 0 10px">No schedule agreement for this material — this will need a spot PO raised manually in SAP.</div>`
        : `<div class="toolbar-hint" style="margin:2px 0 10px">Schedule agreement ${esc(s.scheduleAgreement || '')} — release against this in SAP once ordered.</div>`}
      ${s.orderMoqQty ? `<div class="toolbar-hint" style="margin:2px 0 10px">${esc(s.vendorName)} has a combined order MOQ of ${Number(s.orderMoqQty).toLocaleString()} ${esc(s.orderMoqUom || '')} across all materials — check what else is due if this order alone won't clear it.</div>` : ''}
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Notes</label>
          <input class="tf-input" type="text" id="os-notes" value="">
        </div>
      </div>
      <div id="os-accept-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="os-accept-save-btn">Accept Order</button>
    </div>
  </div>`);

  // Enforced (not hinted): snap/clamp on blur so the field reflects the
  // real quantity that will be submitted, before the user even hits Save.
  document.getElementById('os-order-qty').addEventListener('blur', function () {
    const enforced = osEnforceQty(this.value, s.materialMoqQty, s.materialMaxQty);
    if (enforced != null) this.value = enforced;
  });

  document.getElementById('os-accept-save-btn').addEventListener('click', async () => {
    // Re-enforce right before submit too — covers Enter-to-submit and any
    // path that skips the blur handler above.
    const enforcedQty = osEnforceQty(document.getElementById('os-order-qty').value, s.materialMoqQty, s.materialMaxQty);
    if (enforcedQty != null) document.getElementById('os-order-qty').value = enforcedQty;
    const body = {
      vendorMaterialId: s.vendorMaterialId,
      vendorId: s.vendorId,
      material: s.material,
      suggestedQty: s.suggestedQty,
      orderQty: enforcedQty,
      orderDate: document.getElementById('os-order-date').value || null,
      deliveryDate: document.getElementById('os-delivery-date').value || null,
      leadTimeDays: s.leadTimeDays,
      transitTimeDays: s.transitTimeDays,
      incoterms: s.incoterms,
      isSpotPo: s.isSpotPo,
      notes: document.getElementById('os-notes').value.trim() || null,
    };
    if (!body.orderQty) {
      document.getElementById('os-accept-result').innerHTML = '<div class="sap-error">Order qty is required.</div>';
      return;
    }
    const btn = document.getElementById('os-accept-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/performance/order-suggestions/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Failed to accept suggestion');
      closePickModal();
      runOrderSuggestions();
    } catch (err) {
      document.getElementById('os-accept-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Accept Order';
    }
  });
}


// Combines several materials from one vendor into a single order — the way
// a combined order-level MOQ (dbo.Vendor.OrderMoqQty) actually gets managed,
// rather than just noted. Lists every material this vendor supplies (not
// only the ones currently due), pre-checks the ones that are, and shows the
// running total against the MOQ live as materials are checked/unchecked or
// quantities adjusted, so a buyer can pull in a not-yet-urgent material to
// close a gap without leaving the page to go check stock levels elsewhere.
async function osOpenBuildOrderModal(vendorId) {
  openModal(`<div class="ps-modal" style="max-width:760px;width:95vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Build Order</div><div class="ps-modal-sub" id="os-build-vendor-name">Loading…</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div id="os-build-body"><div class="sap-loading"><div class="spinner"></div>Loading...</div></div>
    </div>
  </div>`);

  try {
    const res = await fetch(`/api/performance/order-suggestions/vendor/${vendorId}/build`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load vendor materials');
    osRenderBuildOrderForm(json.data);
  } catch (err) {
    document.getElementById('os-build-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

const OS_URGENCY_LABEL = { Overdue: 'Overdue', DueSoon: 'Due Soon', Upcoming: 'Upcoming', NotDue: 'Not due' };

function osRenderBuildOrderForm(build) {
  document.getElementById('os-build-vendor-name').textContent = build.vendorName;
  const todayStr = new Date().toISOString().slice(0, 10);

  const rows = build.materials.map((m, i) => {
    const checked = m.dueNow && m.suggestedQty > 0;
    return `
      <tr class="admin-row">
        <td><input type="checkbox" class="os-build-check" data-i="${i}" ${checked ? 'checked' : ''}></td>
        <td><strong>${esc(m.material)}</strong><div style="font-size:11px;color:var(--text-secondary,#666)">${esc(m.materialText || '')}</div></td>
        <td>${esc(OS_URGENCY_LABEL[m.urgency] || m.urgency)}${m.orderByDate ? `<div style="font-size:11px">by ${formatDisplayDate(m.orderByDate)}</div>` : ''}</td>
        <td>${Number(m.currentStock).toLocaleString()} ${esc(m.uom || '')}</td>
        <td>
          <input class="tf-input os-build-qty" type="number" step="${m.materialMoqQty || 0.001}" data-i="${i}" value="${checked ? m.suggestedQty : ''}" style="width:90px;padding:3px 6px;font-size:12px">
          ${m.materialMoqQty ? `<div style="font-size:10px;color:var(--text-secondary,#666)">lots of ${Number(m.materialMoqQty).toLocaleString()}</div>` : ''}
        </td>
      </tr>`;
  }).join('');

  document.getElementById('os-build-body').innerHTML = `
    <div class="tf-row">
      <div class="tf-field">
        <label class="tf-label">Order Date</label>
        <input class="tf-input" type="date" id="os-build-order-date" value="${todayStr}">
      </div>
    </div>
    <div style="overflow-x:auto;max-height:340px;overflow-y:auto">
      <table class="pn-batch-table admin-table">
        <thead><tr><th></th><th>Material</th><th>Status</th><th>Current Stock</th><th>Order Qty</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div id="os-build-moq-status" style="margin-top:12px;padding:10px;border-radius:6px;font-size:13px"></div>
    <div id="os-build-result"></div>
    <div class="ps-modal-actions" style="margin-top:14px">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="os-build-save-btn">Accept Order</button>
    </div>
  `;

  // Enforced (not hinted): handles plain minimum, plain maximum, a
  // min/max range, and the exact-quantity case (min === max, e.g. Raaj
  // Ratna: exactly 20,000kg). Unlike a single material's lot size, a
  // multi-material combined total can't be auto-corrected — there's no
  // non-arbitrary way to decide which material to bump or trim — so this
  // disables the Accept Order button instead, a hard block rather than a
  // dismissible warning.
  function updateMoqStatus() {
    let total = 0;
    document.querySelectorAll('.os-build-check').forEach(cb => {
      if (cb.checked) {
        const qtyInput = document.querySelector(`.os-build-qty[data-i="${cb.dataset.i}"]`);
        total += Number(qtyInput.value) || 0;
      }
    });
    total = Math.round(total * 1000) / 1000;
    const statusEl = document.getElementById('os-build-moq-status');
    const saveBtn = document.getElementById('os-build-save-btn');
    const min = build.orderMoqQty != null ? Number(build.orderMoqQty) : null;
    const max = build.orderMaxQty != null ? Number(build.orderMaxQty) : null;
    const uom = build.orderMoqUom || '';
    const hasConstraint = !!(min || max);

    let ok = true;
    let msg;
    if (!hasConstraint) {
      msg = `Combined qty: ${total.toLocaleString()} — this vendor has no combined order MOQ.`;
    } else if (min && max && min === max) {
      ok = Math.abs(total - min) <= 0.001;
      msg = ok
        ? `Combined qty: ${total.toLocaleString()} ${uom} — matches the required exact quantity.`
        : `Combined qty: ${total.toLocaleString()} — ${esc(build.vendorName)} requires EXACTLY ${min.toLocaleString()} ${uom}, not just a minimum. ${total < min ? `Add ${(min - total).toLocaleString()} more` : `Remove ${(total - min).toLocaleString()}`} to match.`;
    } else {
      const shortfall = min ? Math.max(0, min - total) : 0;
      const overage = max ? Math.max(0, total - max) : 0;
      ok = shortfall <= 0.001 && overage <= 0.001;
      if (shortfall > 0.001) {
        msg = `Combined qty: ${total.toLocaleString()} / ${min.toLocaleString()} ${uom} MOQ — short by ${shortfall.toLocaleString()}. Check more materials or increase quantities to clear the minimum.`;
      } else if (overage > 0.001) {
        msg = `Combined qty: ${total.toLocaleString()} / ${max.toLocaleString()} ${uom} max — over by ${overage.toLocaleString()}. Uncheck materials or reduce quantities to fit under the cap.`;
      } else {
        msg = `Combined qty: ${total.toLocaleString()}${min ? ` / ${min.toLocaleString()}` : ''}${max ? ` \u2013 ${max.toLocaleString()}` : ''} ${uom} — met.`;
      }
    }

    statusEl.style.background = !hasConstraint ? 'var(--bg-secondary,#F3F4F6)' : (ok ? 'rgba(22,163,74,0.1)' : 'rgba(220,38,38,0.1)');
    statusEl.style.color = !hasConstraint ? '' : (ok ? 'var(--success,#16A34A)' : 'var(--error,#DC2626)');
    statusEl.textContent = msg;
    if (saveBtn) saveBtn.disabled = !ok;
    return total;
  }

  document.querySelectorAll('.os-build-check, .os-build-qty').forEach(el => {
    el.addEventListener('input', updateMoqStatus);
    el.addEventListener('change', updateMoqStatus);
  });

  // Per-material enforcement (not hinted): snap to the nearest MOQ lot and
  // clamp to the material's max on blur, same as the single accept modal.
  document.querySelectorAll('.os-build-qty').forEach(el => {
    el.addEventListener('blur', () => {
      const m = build.materials[Number(el.dataset.i)];
      const enforced = osEnforceQty(el.value, m.materialMoqQty, m.materialMaxQty);
      if (enforced != null) el.value = enforced;
      updateMoqStatus();
    });
  });
  updateMoqStatus();

  document.getElementById('os-build-save-btn').addEventListener('click', async () => {
    const items = [];
    document.querySelectorAll('.os-build-check').forEach(cb => {
      if (!cb.checked) return;
      const m = build.materials[Number(cb.dataset.i)];
      const qtyInput = document.querySelector(`.os-build-qty[data-i="${cb.dataset.i}"]`);
      // Re-enforce right before submit too — covers Enter-to-submit and any
      // row whose blur handler never fired.
      const enforced = osEnforceQty(qtyInput.value, m.materialMoqQty, m.materialMaxQty);
      if (enforced == null) return;
      qtyInput.value = enforced;
      items.push({
        vendorMaterialId: m.vendorMaterialId,
        material: m.material,
        suggestedQty: m.suggestedQty,
        orderQty: enforced,
        leadTimeDays: m.leadTimeDays,
        transitTimeDays: m.transitTimeDays,
        incoterms: m.incoterms,
        isSpotPo: m.isSpotPo,
      });
    });

    if (!items.length) {
      document.getElementById('os-build-result').innerHTML = '<div class="sap-error">Check at least one material with a qty greater than 0.</div>';
      return;
    }

    // Combined min/max/exact is enforced (not hinted) via the disabled
    // Accept Order button, not a dismissible confirm() — this check is a
    // defensive backstop in case the button state is somehow stale.
    updateMoqStatus();
    if (document.getElementById('os-build-save-btn').disabled) {
      document.getElementById('os-build-result').innerHTML = '<div class="sap-error">This combination doesn\u2019t satisfy ' + esc(build.vendorName) + '\u2019s combined order requirement above \u2014 adjust quantities or materials.</div>';
      return;
    }

    const btn = document.getElementById('os-build-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/performance/order-suggestions/accept-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorId: build.vendorId,
          orderDate: document.getElementById('os-build-order-date').value || null,
          items,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Failed to accept order');
      closePickModal();
      runOrderSuggestions();
    } catch (err) {
      document.getElementById('os-build-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Accept Order';
    }
  });
}

// Reads which .ps-section groups are currently expanded (not collapsed) on
// screen, keyed by the stable data-group-key set in osRenderTrackedList —
// called right before a save-triggered re-render wipes result-body, so a
// user's open groups don't collapse back to the default "everything
// closed" state and force them to re-find their place. Must be captured
// before showResultPanel/osRenderTrackedList run, not after.
function osCaptureExpandedGroups() {
  const expanded = new Set();
  document.querySelectorAll('.ps-section[data-group-key]').forEach(sec => {
    if (!sec.classList.contains('ps-section--collapsed')) expanded.add(sec.dataset.groupKey);
  });
  return expanded;
}

function osApplyExpandedGroups(expanded) {
  if (!expanded || !expanded.size) return;
  document.querySelectorAll('.ps-section[data-group-key]').forEach(sec => {
    if (expanded.has(sec.dataset.groupKey)) sec.classList.remove('ps-section--collapsed');
  });
}

// preserveExpanded: pass true when re-running after an in-place save (not a
// fresh visit to the tile) so previously-open groups reopen automatically —
// see osCaptureExpandedGroups/osApplyExpandedGroups above.
async function runOrderSuggestionsTracked(preserveExpanded) {
  const expanded = preserveExpanded ? osCaptureExpandedGroups() : null;
  showResultPanel('Tracked Orders', 'Accepted order suggestions — update status as they’re raised in SAP and received');
  try {
    const tracked = await osFetchTracked();
    osRenderTrackedList(tracked);
    osApplyExpandedGroups(expanded);
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

const OS_STATUS_OPTIONS = ['Accepted', 'Ordered', 'Booked', 'Received', 'Cancelled'];

// Same "which date counts as due" logic as the Due Date column's display
// (renderTrackedRow's dueLabel below) — a spot PO's actionable date is when
// it needs collecting, not the (informational only) full delivery date.
// No date at all sorts to the end.
function osEffectiveDueDate(t) {
  const d = t.IsSpotPo && t.ReadyToCollectDate ? t.ReadyToCollectDate : t.DeliveryDate;
  return d ? new Date(d).getTime() : Infinity;
}

// Live client-side filter — no server round trip, since the full tracked
// list is already in memory. Matches on Material (part number), MaterialText
// (description, so a partial name still finds the right part), or PoNumber.
function osMatchesSearch(t, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return String(t.Material || '').toLowerCase().includes(needle)
    || String(t.MaterialText || '').toLowerCase().includes(needle)
    || String(t.PoNumber || '').toLowerCase().includes(needle);
}

// Re-applies the search box's current value and re-renders. Called on every
// keystroke (oninput) — filtering is over in-memory data so this is cheap,
// but the re-render replaces #result-body's innerHTML wholesale, which would
// normally drop focus out of the search input on every character. Captures
// and restores focus + caret position around the render to keep typing feel
// uninterrupted.
function osApplySearch() {
  const input = document.getElementById('os-search-input');
  trackedSearchQuery = input ? input.value : '';
  const caret = input ? input.selectionStart : null;
  osRenderTrackedList(trackedRows);
  const newInput = document.getElementById('os-search-input');
  if (newInput) {
    newInput.focus();
    if (caret != null) newInput.setSelectionRange(caret, caret);
  }
}

function osRenderTrackedList(tracked) {
  trackedRows = tracked;
  selectedTrackedIds = new Set();

  const query = trackedSearchQuery.trim();
  // Filtering happens over the full set, but trackedRows above always keeps
  // everything — search only changes what's rendered/wired up below, not
  // what's held in memory for save/edit operations on rows still on screen.
  const rows = query ? tracked.filter(t => osMatchesSearch(t, query)) : tracked;

  document.getElementById('result-row-badge').textContent = query
    ? `${rows.length} of ${tracked.length} matching`
    : `${tracked.length} tracked`;
  document.getElementById('result-row-badge').classList.remove('hidden');

  const renderTrackedRow = (t) => {
    // Whichever date is actually actionable/shown gets edited — same
    // ReadyToCollectDate-for-spot-PO-else-DeliveryDate split as
    // osEffectiveDueDate below and the dueLabel this replaced. osSaveOneTracked
    // sends the edited value back under whichever of the two fields it came
    // from, so a spot PO's full DeliveryDate (informational only) is left
    // alone.
    const isSpotDue = t.IsSpotPo && t.ReadyToCollectDate;
    const dueValue  = daDateInputValue(isSpotDue ? t.ReadyToCollectDate : t.DeliveryDate);
    return `
    <tr class="admin-row">
      <td class="lg-check-cell"><input type="checkbox" class="lg-check os-check" data-id="${t.SuggestionId}"></td>
      <td><strong>${esc(t.Material)}</strong><div style="font-size:11px;color:var(--text-secondary,#666)">${esc(t.MaterialText || '')}</div></td>
      <td>${esc(t.VendorName)}</td>
      <td><input class="tf-input os-qty-input" data-id="${t.SuggestionId}" type="number" step="0.001" min="0.001" value="${Number(t.OrderQty)}" style="padding:3px 6px;font-size:12px;width:90px"></td>
      <td>${formatDisplayDate(t.OrderDate)}</td>
      <td>
        <input class="tf-input os-due-date-input" data-id="${t.SuggestionId}" data-spot-due="${isSpotDue ? '1' : ''}" type="date" value="${dueValue}" style="padding:3px 6px;font-size:12px;width:120px">
        ${isSpotDue ? '<div style="font-size:10px;color:var(--text-secondary,#666)">ready to collect</div>' : ''}
      </td>
      <td>
        <select class="tf-input os-status-select" data-id="${t.SuggestionId}" style="padding:3px 6px;font-size:12px">
          ${OS_STATUS_OPTIONS.map(opt => `<option value="${opt}" ${t.Status === opt ? 'selected' : ''}>${opt}</option>`).join('')}
        </select>
      </td>
      <td>
        <input class="tf-input os-po-input" data-id="${t.SuggestionId}" type="text" value="${esc(t.PoNumber || '')}" placeholder="PO number" style="padding:3px 6px;font-size:12px;width:100px">
        ${t.PoItemNumber ? `<div style="font-size:10px;color:var(--text-secondary,#666)">item ${esc(t.PoItemNumber)}</div>` : ''}
      </td>
      <td><input class="tf-input os-supplier-ref-input" data-id="${t.SuggestionId}" type="text" value="${esc(t.SupplierReference || '')}" placeholder="Supplier ref" style="padding:3px 6px;font-size:12px;width:100px"></td>
      <td>
        <button class="btn-secondary os-shipment-btn" data-id="${t.SuggestionId}" style="padding:3px 8px;font-size:11px;white-space:nowrap" title="${t.ShipmentId ? esc([t.Haulier, t.ModeOfTransport, t.ShipmentTrackingNumber].filter(Boolean).join(' · ')) : ''}">
          ${t.ShipmentId ? esc(t.ShipmentReference || t.Haulier || 'Assigned') : '+ Assign'}
        </button>
        ${t.ShipmentId ? `<button class="btn-secondary os-invoice-btn" data-shipment-id="${t.ShipmentId}" data-shipment-ref="${esc(t.ShipmentReference || '')}" style="padding:3px 8px;font-size:11px;white-space:nowrap;margin-left:4px">Invoice</button>` : ''}
      </td>
      <td style="text-align:right">
        <button class="btn-secondary os-save-btn" data-id="${t.SuggestionId}" style="padding:3px 10px;font-size:11px">Save</button>
        <button class="btn-secondary os-delete-btn" data-id="${t.SuggestionId}" style="padding:3px 10px;font-size:11px;margin-left:4px;color:var(--error,#DC2626)">Delete</button>
      </td>
    </tr>`;
  };

  const tableHead = '<thead><tr><th></th><th>Material</th><th>Vendor</th><th>Qty</th><th>Order Date</th><th>Due Date</th><th>Status</th><th>PO Number</th><th>Supplier Ref</th><th>Shipment</th><th></th></tr></thead>';

  // Four-level hierarchy: bucket (Needs Booking / Needs Shipment / Assigned
  // to Shipment / Cancelled) -> supplier -> order rows. Needs Booking comes
  // first and takes priority over everything except Cancelled — an order
  // that's just been accepted (Status still 'Accepted') hasn't actually
  // been sent to the supplier yet, and previously fell straight into Needs
  // Shipment alongside orders that were already placed, making it easy to
  // forget the "tell the supplier" step entirely. It gets the red/priority
  // dot since a forgotten order is the costliest mistake here. Every level
  // starts collapsed — the point is to let the user open exactly one
  // supplier at a time rather than face the whole list, reusing the
  // ps-section pattern from Open Deliveries, nested this time.
  const BUCKET_DEFS = [
    { key: 'needsBooking', label: 'Needs Booking',        dot: 'priority', match: t => t.Status === 'Accepted' },
    { key: 'needs',        label: 'Needs Shipment',       dot: 'backlog',  match: t => t.Status !== 'Cancelled' && t.Status !== 'Accepted' && !t.ShipmentId },
    { key: 'assigned',     label: 'Assigned to Shipment', dot: 'today',    match: t => t.Status !== 'Cancelled' && t.Status !== 'Accepted' && !!t.ShipmentId },
    { key: 'cancelled',    label: 'Cancelled',            dot: 'other',    match: t => t.Status === 'Cancelled' },
  ];

  // data-group-key on both levels lets osCaptureExpandedGroups/
  // osApplyExpandedGroups re-open whatever the user had expanded before a
  // save-triggered re-render — see those functions' comment for why this
  // exists. Keyed on bucket + vendor name rather than array index, since
  // index isn't stable once rows move between buckets after a status change.
  // While a search is active, groups render already expanded (collapsedCls
  // below) — the point of searching is to surface matches immediately, not
  // make the user open every bucket/supplier to find them.
  const collapsedCls = query ? '' : ' ps-section--collapsed';
  const renderSupplierGroup = (bucketKey, name, groupRows) => `<div class="ps-section${collapsedCls} ps-section--nested" data-group-key="${esc(bucketKey)}::${esc(name)}">
    <div class="ps-section-header">
      <span class="ps-section-dot ps-section-dot--other"></span>
      <span class="ps-section-title">${esc(name)}</span>
      <span class="ps-section-count">${groupRows.length}</span>
      <span class="ps-chevron">v</span>
    </div>
    <div class="ps-section-body">
      <div style="overflow-x:auto"><table class="pn-batch-table admin-table">${tableHead}<tbody>${groupRows.map(renderTrackedRow).join('')}</tbody></table></div>
    </div>
  </div>`;

  const bucketSections = BUCKET_DEFS.map(bd => {
    const bucketRows = rows.filter(bd.match);
    if (!bucketRows.length) return '';
    const byVendor = {};
    bucketRows.forEach(t => { const key = t.VendorName || 'Unknown Vendor'; (byVendor[key] = byVendor[key] || []).push(t); });
    // Sort each vendor's orders by the same due date shown in the Due Date
    // column (ready-to-collect date for spot POs, delivery date otherwise) —
    // earliest due first, no-date rows pushed to the end.
    Object.values(byVendor).forEach(groupRows => groupRows.sort((a, b) => osEffectiveDueDate(a) - osEffectiveDueDate(b)));
    const vendorGroups = Object.keys(byVendor).sort((a, b) => a.localeCompare(b))
      .map(name => renderSupplierGroup(bd.key, name, byVendor[name])).join('');
    return `<div class="ps-section${collapsedCls}" data-group-key="${esc(bd.key)}">
      <div class="ps-section-header">
        <span class="ps-section-dot ps-section-dot--${bd.dot}"></span>
        <span class="ps-section-title">${bd.label}</span>
        <span class="ps-section-count">${bucketRows.length}</span>
        <span class="ps-chevron">v</span>
      </div>
      <div class="ps-section-body"><div class="ps-sections ps-sections--nested">${vendorGroups}</div></div>
    </div>`;
  }).join('');

  const emptyMessage = query
    ? `No tracked orders match "${esc(query)}" — try a part number or PO number.`
    : 'No accepted orders yet.';

  document.getElementById('result-body').innerHTML = `
    <div class="lg-actions">
      <div><div class="lg-selection-title">Tracked orders</div><div class="toolbar-hint" id="os-selection-hint">Select order lines to create a shipment, auto-ship, or save edits across several lines at once.</div></div>
      <div class="toolbar-spacer"></div>
      <input class="tf-input" id="os-search-input" type="text" placeholder="Search by part number or PO…" value="${esc(trackedSearchQuery)}" oninput="osApplySearch()" style="max-width:240px">
      <button class="btn-secondary" id="os-add-manual-btn">+ Add Manual Order</button>
      <button class="btn-secondary" id="os-upload-csv-btn">Upload CSV</button>
      <button class="btn-secondary" id="os-view-suggestions-btn">← Back to Suggestions</button>
      <button type="button" class="btn-secondary" id="os-auto-shipment-btn" disabled>Auto-Shipment</button>
      <button type="button" class="btn-secondary" id="os-save-selected-btn" disabled>Save Selected</button>
      <button type="button" class="btn-submit" id="os-create-shipment-btn" disabled>Create Shipment</button>
      <button type="button" class="btn-submit" id="os-create-po-btn" disabled>Create PO in SAP</button>
    </div>
    ${rows.length ? `<div class="ps-sections">${bucketSections}</div>` : `<div class="sap-empty">${emptyMessage}</div>`}
  `;

  document.getElementById('os-view-suggestions-btn').addEventListener('click', () => runOrderSuggestions());
  document.getElementById('os-add-manual-btn').addEventListener('click', () => openManualOrderModal());
  document.getElementById('os-upload-csv-btn').addEventListener('click', () => openManualOrderCsvModal());
  document.getElementById('os-create-shipment-btn').addEventListener('click', () => openCreateShipmentModal());
  document.getElementById('os-auto-shipment-btn').addEventListener('click', () => autoCreateShipments());
  document.getElementById('os-save-selected-btn').addEventListener('click', () => saveSelectedTrackedOrders());
  document.getElementById('os-create-po-btn').addEventListener('click', () => openCreatePoModal());
  document.querySelectorAll('.ps-section-header').forEach(h => h.addEventListener('click', () => h.closest('.ps-section').classList.toggle('ps-section--collapsed')));
  document.querySelectorAll('.os-check').forEach(input => input.addEventListener('change', onTrackedCheckToggle));
  document.querySelectorAll('.os-save-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = rows.find(x => String(x.SuggestionId) === btn.dataset.id);
      if (t) osSaveTrackedStatus(t);
    });
  });
  document.querySelectorAll('.os-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = rows.find(x => String(x.SuggestionId) === btn.dataset.id);
      if (t) osDeleteTracked(t);
    });
  });
  document.querySelectorAll('.os-shipment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = rows.find(x => String(x.SuggestionId) === btn.dataset.id);
      if (t) openAssignShipmentModal(t);
    });
  });
  document.querySelectorAll('.os-invoice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openShipmentInvoiceModal(Number(btn.dataset.shipmentId), btn.dataset.shipmentRef);
    });
  });
}

// Lists and uploads supplier invoices for a shipment, saved server-side into
// LOGISTICS_IMPORT_ROOT\{Year}\{MM}. {MonthName}\{ShipmentReference} -
// {SupplierName}\ (the folder is auto-created on first upload — see
// routes/performance.js's ensureShipmentImportFolder). Opened from the
// Invoice button next to a shipment-assigned tracked-order row, so every
// row on the same shipment lands on the same folder regardless of which
// row's button was clicked.
async function openShipmentInvoiceModal(shipmentId, shipmentReference) {
  openModal(`<div class="ps-modal" style="max-width:560px;width:94vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Supplier Invoices</div><div class="ps-modal-sub">${esc(shipmentReference || `Shipment #${shipmentId}`)}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="toolbar-hint">Uploaded invoices are filed into the shipment's import folder automatically — no need to save them anywhere manually.</div>
      <div id="osi-body"><div class="sap-loading"><div class="spinner"></div>Loading...</div></div>
      <input type="file" id="osi-file-input" accept="application/pdf,image/jpeg,image/png" style="display:none">
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Close</button>
      <button type="button" class="btn-submit" id="osi-upload-btn">Upload Invoice</button>
    </div>
  </div>`);

  document.getElementById('osi-upload-btn').addEventListener('click', () => document.getElementById('osi-file-input').click());
  document.getElementById('osi-file-input').addEventListener('change', async () => {
    const fileInput = document.getElementById('osi-file-input');
    const file = fileInput.files[0];
    if (!file) return;
    const uploadBtn = document.getElementById('osi-upload-btn');
    uploadBtn.disabled = true; uploadBtn.textContent = 'Uploading…';
    try {
      const res = await fetch(`/api/performance/order-suggestions/shipments/${shipmentId}/documents/upload`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/pdf', 'X-File-Name': encodeURIComponent(file.name) },
        body: file,
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Upload failed.');
      await osiLoadFolder(shipmentId);
    } catch (err) {
      const body = document.getElementById('osi-body');
      if (body) body.insertAdjacentHTML('afterbegin', `<div class="sap-error tf-inline-error">${esc(err.message)}</div>`);
    } finally {
      uploadBtn.disabled = false; uploadBtn.textContent = 'Upload Invoice';
      fileInput.value = '';
    }
  });

  await osiLoadFolder(shipmentId);
}

async function osiLoadFolder(shipmentId) {
  const body = document.getElementById('osi-body');
  body.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading...</div>';
  try {
    const res = await fetch(`/api/performance/order-suggestions/shipments/${shipmentId}/documents/folder`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load documents.');
    const files = json.data.files || [];
    body.innerHTML = !files.length
      ? '<div class="sap-empty">No invoices uploaded yet.</div>'
      : `<div style="overflow-x:auto"><table class="pn-batch-table admin-table">
          <thead><tr><th>File</th><th>Size</th><th>Uploaded</th><th></th></tr></thead>
          <tbody>${files.map(f => `<tr class="admin-row">
            <td>${esc(f.fileName)}</td>
            <td>${(Number(f.sizeBytes || 0) / 1024).toFixed(1)} KB</td>
            <td>${formatDisplayDate(f.modifiedAtUtc)}</td>
            <td style="text-align:right"><a href="${esc(f.downloadUrl)}" target="_blank" rel="noopener">View</a></td>
          </tr>`).join('')}</tbody>
        </table></div>`;
  } catch (err) {
    body.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

function onTrackedCheckToggle(e) {
  const id = Number(e.target.dataset.id);
  if (e.target.checked) selectedTrackedIds.add(id); else selectedTrackedIds.delete(id);
  const hint = document.getElementById('os-selection-hint');
  if (hint) hint.textContent = selectedTrackedIds.size
    ? `${selectedTrackedIds.size} order line${selectedTrackedIds.size === 1 ? '' : 's'} selected`
    : 'Select order lines to create a shipment, auto-ship, or save edits across several lines at once.';
  const btn = document.getElementById('os-create-shipment-btn');
  if (btn) btn.disabled = selectedTrackedIds.size === 0;
  const autoBtn = document.getElementById('os-auto-shipment-btn');
  if (autoBtn) autoBtn.disabled = selectedTrackedIds.size === 0;
  const saveSelBtn = document.getElementById('os-save-selected-btn');
  if (saveSelBtn) saveSelBtn.disabled = selectedTrackedIds.size === 0;
  const poBtn = document.getElementById('os-create-po-btn');
  if (poBtn) poBtn.disabled = !osCreatePoSelectionValid();
}

// One PO per vendor, and only for lines that genuinely haven't been ordered
// yet — the same rules the create-po route re-checks server-side (fresh from
// the DB, not trusted from this in-memory copy), but validated here too so
// the button doesn't invite a click that's just going to bounce with an
// error.
function osCreatePoSelectionValid() {
  if (!selectedTrackedIds.size) return false;
  const rows = trackedRows.filter(t => selectedTrackedIds.has(Number(t.SuggestionId)));
  if (rows.some(t => t.Status !== 'Accepted' || t.PoNumber)) return false;
  const vendorIds = new Set(rows.map(t => t.VendorId));
  return vendorIds.size === 1;
}

// Reads the on-screen inputs for one tracked row and PUTs them — shared by
// the per-row Save button and the multi-select "Save Selected" bulk action,
// so editing several lines (qty, status, PO, supplier ref) and saving them
// together doesn't require clicking Save once per row. Returns a result
// object rather than throwing/alerting itself, so the bulk caller can
// collect per-row failures instead of the first one stopping the batch.
async function osSaveOneTracked(t) {
  const statusSelect = document.querySelector(`.os-status-select[data-id="${t.SuggestionId}"]`);
  const poInput = document.querySelector(`.os-po-input[data-id="${t.SuggestionId}"]`);
  const supplierRefInput = document.querySelector(`.os-supplier-ref-input[data-id="${t.SuggestionId}"]`);
  const qtyInput = document.querySelector(`.os-qty-input[data-id="${t.SuggestionId}"]`);
  const dueDateInput = document.querySelector(`.os-due-date-input[data-id="${t.SuggestionId}"]`);
  if (!statusSelect || !poInput || !supplierRefInput || !qtyInput || !dueDateInput) {
    return { success: false, error: 'Row is not on screen (try expanding its group).' };
  }
  const qtyValue = Number(qtyInput.value);
  if (!qtyValue || qtyValue <= 0) {
    return { success: false, error: 'Quantity must be greater than 0.' };
  }
  const body = {
    status: statusSelect.value,
    poNumber: poInput.value.trim() || null,
    supplierReference: supplierRefInput.value.trim() || null,
    notes: t.Notes || null,
    orderQty: qtyValue,
  };
  // Whichever of the two due-date columns this row was actually rendered
  // against (see renderTrackedRow's isSpotDue) is the one that gets updated —
  // data-spot-due carries that choice through since t itself doesn't change
  // between render and save.
  if (dueDateInput.value) {
    if (dueDateInput.dataset.spotDue) body.readyToCollectDate = dueDateInput.value;
    else body.deliveryDate = dueDateInput.value;
  }
  try {
    const res = await fetch(`/api/performance/order-suggestions/${t.SuggestionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to update order');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Full-row update, matching the backend's convention (see
// updateOrderSuggestionStatus's comment in performancesql.js) — Notes isn't
// editable from this table yet, so the existing value is carried through
// rather than overwritten with null on every save.
async function osSaveTrackedStatus(t) {
  const btn = document.querySelector(`.os-save-btn[data-id="${t.SuggestionId}"]`);
  btn.disabled = true; btn.textContent = 'Saving…';
  const result = await osSaveOneTracked(t);
  if (!result.success) {
    alert(result.error);
    btn.disabled = false; btn.textContent = 'Save';
    return;
  }
  runOrderSuggestionsTracked(true);
}

// Hard-deletes a tracked order outright — distinct from setting Status to
// Cancelled (which just hides it from this list for audit purposes, see
// db.deleteOrderSuggestion's comment). For genuine mistakes: a duplicate
// manual entry, wrong material picked, etc. No status/shipment restriction
// client-side — the server allows it at any stage — but this is
// destructive and unrecoverable, so it gets an explicit confirm().
async function osDeleteTracked(t) {
  if (!confirm(`Delete this tracked order for ${t.Material} — ${t.VendorName}? This permanently removes it, it won't just be marked Cancelled. This cannot be undone.`)) return;
  const btn = document.querySelector(`.os-delete-btn[data-id="${t.SuggestionId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  try {
    const res = await fetch(`/api/performance/order-suggestions/${t.SuggestionId}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to delete order');
    runOrderSuggestionsTracked(true);
  } catch (err) {
    alert(err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
  }
}

// Bulk save — for editing several rows (any mix of qty/status/PO/supplier
// ref, across different suppliers/buckets) then ticking their checkboxes
// and saving in one go, instead of hitting each row's own Save button.
// Reuses the same .os-check selection already used for Create
// Shipment/Auto-Shipment, since "tick the lines you're working on" is the
// same gesture for all three actions.
async function saveSelectedTrackedOrders() {
  const btn = document.getElementById('os-save-selected-btn');
  if (!btn || selectedTrackedIds.size === 0) return;
  const ids = [...selectedTrackedIds];
  const rows = trackedRows.filter(t => ids.includes(Number(t.SuggestionId)));
  btn.disabled = true; btn.textContent = 'Saving…';

  const results = [];
  for (const t of rows) {
    const r = await osSaveOneTracked(t);
    results.push({ material: t.Material, ...r });
  }

  const failed = results.filter(r => !r.success);
  if (failed.length) {
    alert(`Saved ${results.length - failed.length} of ${results.length} line(s).\n\nFailed:\n` + failed.map(f => `${f.material}: ${f.error}`).join('\n'));
  }
  runOrderSuggestionsTracked(true);
}

const OS_TRANSPORT_MODES = ['Road', 'Sea', 'Air', 'Rail', 'Courier', 'Other'];

// Populates a <select id="selectId"> with approved forwarders (forwarderID
// as the value — it doubles as the SAP vendor code, see routes/forwarders.js
// — forwarderName as the label). Used everywhere Haulier used to be free
// text: Create Shipment, the Inbound Log detail form, and Manual Inbound
// Shipment creation.
//
// Uses the existing loadApprovedForwarders()/dedupeForwardersByName() pair
// (see above) rather than fetching /api/forwarders/approved directly — a
// forwarder can have multiple rows sharing the same name, one per service/
// rate category (e.g. Road vs Sea vs Air for the same haulier), and this
// dropdown needs exactly one option per name, same as the booking modal.
async function loadForwarderOptionsInto(selectId, selectedForwarderId) {
  const el = document.getElementById(selectId);
  if (!el) return;
  try {
    const forwarders = await loadApprovedForwarders();
    const sel = selectedForwarderId != null ? String(selectedForwarderId) : '';
    el.innerHTML = `<option value="">— Select haulier —</option>${forwarders.map(f =>
      `<option value="${esc(String(f.forwarderID))}" ${String(f.forwarderID) === sel ? 'selected' : ''}>${esc(f.forwarderName)}</option>`
    ).join('')}`;
  } catch (err) {
    el.innerHTML = '<option value="">Failed to load forwarders</option>';
  }
}

// Manual Inbound Shipment: mode of transport is chosen first, and the
// haulier list is filtered to only forwarders approved for that mode —
// uses loadAllForwarders() (undeduped, has forwarderMode per row) rather
// than loadApprovedForwarders() since dedupe-by-name has to happen AFTER
// the mode filter here, not before (a forwarder can have separate rows for
// Road vs Sea vs Air under the same name — see dedupeForwardersByName's
// comment).
async function loadForwarderOptionsByMode(selectId, mode, selectedForwarderId) {
  const el = document.getElementById(selectId);
  if (!el) return;
  if (!mode) {
    el.innerHTML = '<option value="">Select mode of transport first</option>';
    el.disabled = true;
    return;
  }
  el.disabled = false;
  el.innerHTML = '<option value="">Loading…</option>';
  try {
    const all = await loadAllForwarders();
    const matching = all.filter(f => f.forwarderApproval &&
      String(f.forwarderMode || '').trim().toLowerCase() === mode.trim().toLowerCase());
    const filtered = dedupeForwardersByName(matching);
    if (!filtered.length) {
      el.innerHTML = '<option value="">No approved hauliers for this mode</option>';
      return;
    }
    const sel = selectedForwarderId != null ? String(selectedForwarderId) : '';
    el.innerHTML = `<option value="">— Select haulier —</option>${filtered.map(f =>
      `<option value="${esc(String(f.forwarderID))}" ${String(f.forwarderID) === sel ? 'selected' : ''}>${esc(f.forwarderName)}</option>`
    ).join('')}`;
  } catch (err) {
    el.innerHTML = '<option value="">Failed to load forwarders</option>';
  }
}

// Links (or unlinks) a single tracked order to an already-created shipment
// — for adding a stray order to a load after the fact. Shipment CREATION
// itself now happens in bulk from the Tracked Orders selection (see
// openCreateShipmentModal below), mirroring Open Deliveries — so this modal
// only picks from existing shipments, it doesn't build new ones.
async function openAssignShipmentModal(t) {
  const hasShipment = Boolean(t.ShipmentId);
  openModal(`<div class="ps-modal" style="max-width:440px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Assign Shipment</div><div class="ps-modal-sub">${esc(t.Material)} — ${esc(t.VendorName)}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-field">
        <label class="tf-label">Shipment</label>
        <select class="tf-input" id="as-existing"><option value="">Loading…</option></select>
      </div>
      <div class="toolbar-hint" style="margin:2px 0 10px">Only existing shipments are listed here — create a new one from the Tracked Orders selection instead.</div>
      <div id="as-result"></div>
    </div>
    <div class="ps-modal-actions">
      ${hasShipment ? '<button type="button" class="btn-secondary" id="as-unassign-btn">Unassign</button>' : ''}
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="as-save-btn">Save</button>
    </div>
  </div>`);

  const existingSelect = document.getElementById('as-existing');

  try {
    const res  = await fetch('/api/performance/order-suggestions/shipments');
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load shipments');
    // Cancelled shipments can't accept orders (enforced server-side too, in
    // assignOrderShipment) — leaving them out of the picker avoids a
    // pointless round trip to discover that.
    const optionsHtml = json.data.filter(s => !s.CancelledAtUtc).map(s =>
      `<option value="${s.ShipmentId}" ${hasShipment && Number(t.ShipmentId) === s.ShipmentId ? 'selected' : ''}>${esc(s.ShipmentReference || `Shipment #${s.ShipmentId}`)} — ${esc(s.Haulier || 'no haulier set')} (${s.OrderCount} order${s.OrderCount === 1 ? '' : 's'})</option>`
    ).join('');
    existingSelect.innerHTML = `<option value="">— None —</option>${optionsHtml}`;
  } catch (err) {
    existingSelect.innerHTML = '<option value="">Failed to load shipments</option>';
  }

  if (document.getElementById('as-unassign-btn')) {
    document.getElementById('as-unassign-btn').addEventListener('click', async () => {
      const btn = document.getElementById('as-unassign-btn');
      btn.disabled = true; btn.textContent = 'Removing…';
      try {
        const res = await fetch(`/api/performance/order-suggestions/${t.SuggestionId}/shipment`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shipmentId: null }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error?.message || 'Failed to unassign shipment');
        closePickModal();
        runOrderSuggestionsTracked();
      } catch (err) {
        document.getElementById('as-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = 'Unassign';
      }
    });
  }

  document.getElementById('as-save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('as-save-btn');
    const result = document.getElementById('as-result');
    result.innerHTML = '';
    btn.disabled = true; btn.textContent = 'Saving…';

    try {
      const shipmentId = existingSelect.value ? Number(existingSelect.value) : null;
      const assignRes = await fetch(`/api/performance/order-suggestions/${t.SuggestionId}/shipment`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shipmentId }),
      });
      const assignJson = await assignRes.json();
      if (!assignJson.success) throw new Error(assignJson.error?.message || 'Failed to assign shipment');

      closePickModal();
      runOrderSuggestionsTracked();
    } catch (err) {
      result.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Save';
    }
  });
}

// Bulk "select lines, Create Shipment" flow — mirrors openShipmentModal for
// outbound Open Deliveries, but for inbound purchase orders. The reference
// is generated server-side (createOrderShipment), so there's no field for
// it here.
async function openCreateShipmentModal() {
  const ids = [...selectedTrackedIds];
  if (!ids.length) return;
  const rows = trackedRows.filter(t => ids.includes(Number(t.SuggestionId)));

  openModal(`<div class="ps-modal lg-modal" style="max-width:560px;width:94vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Create Shipment</div><div class="ps-modal-sub">${rows.length} order line${rows.length === 1 ? '' : 's'} selected</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Dispatch Date</label>
          <input class="tf-input" type="date" id="cs-dispatch">
        </div>
        <div class="tf-field">
          <label class="tf-label">Expected ETA</label>
          <input class="tf-input" type="date" id="cs-eta">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Haulier</label>
          <select class="tf-input" id="cs-haulier"><option value="">Loading…</option></select>
        </div>
        <div class="tf-field">
          <label class="tf-label">Mode of Transport</label>
          <select class="tf-input" id="cs-mode">
            <option value="">—</option>
            ${OS_TRANSPORT_MODES.map(m => `<option value="${m}">${m}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Tracking Number</label>
          <input class="tf-input" type="text" id="cs-tracking">
        </div>
        <div class="tf-field">
          <label class="tf-label">Container Number</label>
          <input class="tf-input" type="text" id="cs-container">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">B/L Number</label>
          <input class="tf-input" type="text" id="cs-bl">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Notes</label>
          <input class="tf-input" type="text" id="cs-notes">
        </div>
      </div>
      <div id="cs-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="cs-save-btn">Create Shipment</button>
    </div>
  </div>`);

  loadForwarderOptionsInto('cs-haulier');

  document.getElementById('cs-save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('cs-save-btn');
    const result = document.getElementById('cs-result');
    result.innerHTML = '';
    btn.disabled = true; btn.textContent = 'Creating…';

    const body = {
      dispatchDate: document.getElementById('cs-dispatch').value || null,
      expectedEta: document.getElementById('cs-eta').value || null,
      forwarderID: document.getElementById('cs-haulier').value || null,
      modeOfTransport: document.getElementById('cs-mode').value || null,
      trackingNumber: document.getElementById('cs-tracking').value.trim() || null,
      containerNumber: document.getElementById('cs-container').value.trim() || null,
      billOfLading: document.getElementById('cs-bl').value.trim() || null,
      notes: document.getElementById('cs-notes').value.trim() || null,
      suggestionIds: ids,
    };

    try {
      const res = await fetch('/api/performance/order-suggestions/shipments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Failed to create shipment');
      closePickModal();
      selectedTrackedIds = new Set();
      showCreateShipmentSuccess(json.data);
    } catch (err) {
      result.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Create Shipment';
    }
  });
}

function showCreateShipmentSuccess(data) {
  openModal(`<div class="ps-modal lg-modal">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">${esc(data.shipmentReference)}</div><div class="ps-modal-sub">Shipment created — ${data.orderCount} order${data.orderCount === 1 ? '' : 's'} linked</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="toolbar-hint">Manage dispatch/ETA, add Bill of Lading or container details, and mark it received once it arrives from the Inbound Log tile.</div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Close</button>
      <button type="button" class="btn-submit" id="cs-view-inbound-btn">Open Inbound Log</button>
    </div>
  </div>`);
  document.getElementById('cs-view-inbound-btn').addEventListener('click', () => { closePickModal(); runInboundLog(); });
  runOrderSuggestionsTracked();
}

// Same due date shown in the table's Due Date column — the raw value, not
// the formatted label — used as the auto-shipment's Expected ETA below.
function getOrderDueDateIso(t) {
  const raw = (t.IsSpotPo && t.ReadyToCollectDate) ? t.ReadyToCollectDate : t.DeliveryDate;
  return raw ? String(raw).slice(0, 10) : null;
}

// "Auto-Shipment" — for vendors who are always delivered on the day
// they're ordered, so there's nothing to fill in: no modal, one shipment
// per selected order line (not one combined shipment, since each order can
// have its own due date), haulier fixed to 'Supplier Transport', Expected
// ETA taken straight from the order's own due date, tracking/dispatch left
// blank to be filled in later from the Inbound Log if it turns out to
// matter for that delivery.
async function autoCreateShipments() {
  const ids = [...selectedTrackedIds];
  if (!ids.length) return;
  const rows = trackedRows.filter(t => ids.includes(Number(t.SuggestionId)));

  const btn = document.getElementById('os-auto-shipment-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

  const results = [];
  for (const t of rows) {
    try {
      const res = await fetch('/api/performance/order-suggestions/shipments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          haulier: 'Supplier Transport',
          modeOfTransport: 'Road',
          expectedEta: getOrderDueDateIso(t),
          suggestionIds: [t.SuggestionId],
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Failed to create shipment');
      results.push({ material: t.Material, success: true, reference: json.data.shipmentReference });
    } catch (err) {
      results.push({ material: t.Material, success: false, error: err.message });
    }
  }

  selectedTrackedIds = new Set();
  if (btn) { btn.disabled = false; btn.textContent = 'Auto-Shipment'; }
  showAutoShipmentSummary(results);
  runOrderSuggestionsTracked();
}

function showAutoShipmentSummary(results) {
  const succeeded = results.filter(r => r.success).length;
  openModal(`<div class="ps-modal lg-modal">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Auto-Shipment</div><div class="ps-modal-sub">${succeeded} of ${results.length} shipment${results.length === 1 ? '' : 's'} created</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <ul style="margin:0;padding-left:18px;font-size:12px">
        ${results.map(r => r.success
          ? `<li>${esc(r.material)} → <strong>${esc(r.reference)}</strong></li>`
          : `<li style="list-style:none;margin-left:-18px" class="sap-error">${esc(r.material)}: ${esc(r.error)}</li>`
        ).join('')}
      </ul>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Close</button>
      <button type="button" class="btn-submit" id="asm-view-inbound-btn">Open Inbound Log</button>
    </div>
  </div>`);
  document.getElementById('asm-view-inbound-btn').addEventListener('click', () => { closePickModal(); runInboundLog(); });
}

// "Create PO in SAP" — takes the current tracked-order selection (already
// gated same-vendor/Accepted-only by osCreatePoSelectionValid, re-checked
// again server-side since this posts a real document) and shows a review
// step before actually raising the SAP purchase order: vendor, currency
// (prefilled from the vendor's own Currency field, editable), and each
// line's material/qty/unit/delivery date plus an optional price override.
// Price is left blank by default on purpose — SAP fills it in itself from
// the purchasing info record/condition records (ME12) when nothing is sent,
// since nothing in Nexus's vendor/material master data stores a price (see
// the create-po route's own comment in routes/performance.js).
function openCreatePoModal() {
  if (!osCreatePoSelectionValid()) return;
  const ids = [...selectedTrackedIds];
  const rows = trackedRows.filter(t => ids.includes(Number(t.SuggestionId)));
  const vendorName = rows[0].VendorName;
  const vendorCurrency = rows[0].Currency || '';

  const linesHtml = rows.map(t => `
    <tr data-id="${esc(String(t.SuggestionId))}">
      <td>${esc(t.Material)}</td>
      <td>${esc(t.MaterialText || '—')}</td>
      <td>${esc(String(t.OrderQty))} ${esc(t.Uom || '')}</td>
      <td>${formatDisplayDate(getOrderDueDateIso(t)) || '—'}</td>
      <td><input class="tf-input cpo-price-input" type="number" step="0.01" min="0" placeholder="Auto (SAP)" data-id="${esc(String(t.SuggestionId))}" style="width:110px"></td>
    </tr>`).join('');

  openModal(`<div class="ps-modal lg-modal">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Create PO in SAP</div><div class="ps-modal-sub">${esc(vendorName)} · ${rows.length} line${rows.length === 1 ? '' : 's'}</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="toolbar-hint">This creates a real purchase order in SAP under your own SAP login (My Account → SAP Credentials). Leave Price blank to let SAP price each line itself from the purchasing info record — only fill it in to override that.</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Currency</label>
          <input class="tf-input" type="text" id="cpo-currency" maxlength="3" value="${esc(vendorCurrency)}" style="width:80px">
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Material</th><th>Description</th><th>Qty</th><th>Delivery Date</th><th>Price (optional)</th></tr></thead>
          <tbody>${linesHtml}</tbody>
        </table>
      </div>
      <div id="cpo-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="cpo-confirm-btn">Create PO</button>
    </div>
  </div>`);

  document.getElementById('cpo-confirm-btn').addEventListener('click', () => submitCreatePo(rows));
}

async function submitCreatePo(rows) {
  const btn = document.getElementById('cpo-confirm-btn');
  const resultEl = document.getElementById('cpo-result');
  const currency = document.getElementById('cpo-currency').value.trim().toUpperCase();
  if (!currency) {
    resultEl.innerHTML = '<div class="sap-error">Currency is required.</div>';
    return;
  }
  if (!confirm(`Post a real purchase order to SAP for ${rows.length} line(s) from ${rows[0].VendorName}? This cannot be undone from here.`)) return;

  const priceOverrides = rows.map(t => {
    const input = document.querySelector(`.cpo-price-input[data-id="${CSS.escape(String(t.SuggestionId))}"]`);
    const val = input?.value?.trim();
    return val ? { suggestionId: t.SuggestionId, netPrice: Number(val) } : null;
  }).filter(Boolean);

  btn.disabled = true; btn.textContent = 'Creating…';
  resultEl.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Creating PO in SAP…</div>';

  try {
    const res = await fetch('/api/performance/order-suggestions/create-po', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        suggestionIds: rows.map(t => t.SuggestionId),
        currency,
        priceOverrides,
      }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to create PO');

    selectedTrackedIds = new Set();
    resultEl.innerHTML = `<div style="color:var(--success,#16A34A);font-weight:600">Purchase Order <strong>${esc(json.data.purchaseOrder)}</strong> created and saved against ${json.data.suggestionIds.length} line(s).</div>`;
    btn.textContent = 'Done';
    setTimeout(() => { closePickModal(); runOrderSuggestionsTracked(); }, 1500);
  } catch (err) {
    resultEl.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    btn.disabled = false; btn.textContent = 'Create PO';
  }
}

// Records an order that already exists outside the suggestion engine — the
// user already has a lot in the pipeline, ordered before this feature
// existed (or simply ahead of what the engine has flagged). Vendor and
// material must already be configured together (Vendor Master Data) since
// PurchaseOrderSuggestion.VendorMaterialId is a required FK; this modal
// doesn't create new vendor/material rows, only orders against existing
// ones.
const MANUAL_ORDER_STATUS_OPTIONS = ['Accepted', 'Ordered', 'Received'];

async function openManualOrderModal() {
  const todayStr = new Date().toISOString().slice(0, 10);
  openModal(`<div class="ps-modal" style="max-width:480px;width:92vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Add Manual Order</div><div class="ps-modal-sub">Record an order already placed outside the suggestion engine</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Vendor</label>
          <select class="tf-input" id="mo-vendor"><option value="">Loading…</option></select>
        </div>
        <div class="tf-field">
          <label class="tf-label">Material</label>
          <select class="tf-input" id="mo-material" disabled><option value="">Select vendor first</option></select>
        </div>
      </div>
      <div class="toolbar-hint" style="margin:2px 0 10px" id="mo-material-hint"></div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Order Qty</label>
          <input class="tf-input" type="number" step="0.001" id="mo-qty">
        </div>
        <div class="tf-field">
          <label class="tf-label">Order Date</label>
          <input class="tf-input" type="date" id="mo-order-date" value="${todayStr}">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Delivery Date (optional)</label>
          <input class="tf-input" type="date" id="mo-delivery-date">
        </div>
        <div class="tf-field">
          <label class="tf-label">Status</label>
          <select class="tf-input" id="mo-status">
            ${MANUAL_ORDER_STATUS_OPTIONS.map(s => `<option value="${s}" ${s === 'Ordered' ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="toolbar-hint" style="margin:2px 0 10px">Leave Delivery Date blank to calculate it automatically from the vendor/material's lead time — set it if you already know the confirmed date.</div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">PO Number</label>
          <input class="tf-input" type="text" id="mo-po">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Notes</label>
          <input class="tf-input" type="text" id="mo-notes">
        </div>
      </div>
      <div id="mo-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="mo-save-btn">Add Order</button>
    </div>
  </div>`);

  const vendorSelect   = document.getElementById('mo-vendor');
  const materialSelect = document.getElementById('mo-material');
  const materialHint   = document.getElementById('mo-material-hint');

  try {
    const res  = await fetch('/api/performance/vendors');
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load vendors');
    const vendors = json.data;
    vendorSelect.innerHTML = `<option value="">Select vendor</option>${vendors.map(v => `<option value="${esc(String(v.VendorId))}">${esc(v.VendorName)}</option>`).join('')}`;
  } catch (err) {
    vendorSelect.innerHTML = '<option value="">Failed to load vendors</option>';
  }

  vendorSelect.addEventListener('change', async () => {
    const vendorId = vendorSelect.value;
    materialHint.textContent = '';
    materialSelect.disabled = true;
    if (!vendorId) { materialSelect.innerHTML = '<option value="">Select vendor first</option>'; return; }
    materialSelect.innerHTML = '<option value="">Loading…</option>';
    try {
      const res  = await fetch(`/api/performance/vendors/${encodeURIComponent(vendorId)}/materials`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Failed to load materials');
      const materials = json.data;
      if (!materials.length) {
        materialSelect.innerHTML = '<option value="">No materials configured for this vendor</option>';
        materialHint.textContent = 'This vendor has no materials assigned yet — add one via Vendor Master Data first.';
        return;
      }
      materialSelect.innerHTML = `<option value="">Select material</option>${materials.map(m => `<option value="${esc(String(m.VendorMaterialId))}">${esc(m.Material)}${m.MaterialText ? ' — ' + esc(m.MaterialText) : ''}</option>`).join('')}`;
      materialSelect.disabled = false;
    } catch (err) {
      materialSelect.innerHTML = '<option value="">Failed to load materials</option>';
    }
  });

  document.getElementById('mo-save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('mo-save-btn');
    const result = document.getElementById('mo-result');
    result.innerHTML = '';

    const vendorMaterialId = materialSelect.value;
    const orderQty = document.getElementById('mo-qty').value;
    if (!vendorMaterialId) { result.innerHTML = '<div class="sap-error">Select a vendor and material.</div>'; return; }
    if (!orderQty || Number(orderQty) <= 0) { result.innerHTML = '<div class="sap-error">Order qty must be greater than 0.</div>'; return; }

    const body = {
      vendorMaterialId,
      orderQty: Number(orderQty),
      orderDate: document.getElementById('mo-order-date').value || null,
      deliveryDate: document.getElementById('mo-delivery-date').value || null,
      status: document.getElementById('mo-status').value,
      poNumber: document.getElementById('mo-po').value.trim() || null,
      notes: document.getElementById('mo-notes').value.trim() || null,
    };

    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/performance/order-suggestions/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Failed to add order');
      closePickModal();
      runOrderSuggestionsTracked();
    } catch (err) {
      result.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Add Order';
    }
  });
}


// ── Inbound Log — lists PurchaseOrderShipment records created from Tracked
// Orders' bulk selection, and lets an operator mark one received. Mirrors
// the outbound Completed Shipments / Search tiles' list style.
async function runInboundLog() {
  if (!await checkSession()) return;
  showResultPanel('Inbound Log', 'Inbound shipments created from tracked orders');
  try {
    const res = await fetch('/api/performance/order-suggestions/shipments');
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load shipments');
    inboundShipmentRows = json.data || [];
    const badge = document.getElementById('result-row-badge');
    badge.textContent = `${inboundShipmentRows.length} shipments`;
    badge.classList.remove('hidden');
    renderInboundLog();
  } catch (err) {
    document.getElementById('result-body').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

// Delivery-date bucket for one shipment — ExpectedEta vs today, same
// backlog/today/week dot colours as everywhere else in the app (see
// getDateBucket). No ETA set yet isn't "late" (there's no date to be late
// against), so it falls into Upcoming until one is entered. Cancelled
// shipments are pulled out of the ETA-based buckets entirely and into
// their own bucket — a cancelled shipment's ETA is no longer meaningful,
// and mixing it into Late/Today/Upcoming just adds noise to the buckets
// operators actually need to action.
function ilBucketFor(s) {
  if (s.CancelledAtUtc) return 'cancelled';
  // A received shipment stays out of the ETA-based buckets entirely —
  // previously a shipment received after its ETA had passed kept showing
  // up in Late indefinitely, since ilBucketFor never looked at
  // ReceivedAtUtc at all. Checked before the ETA comparisons below so a
  // late-but-now-received shipment lands here instead of Late.
  if (s.ReceivedAtUtc) return 'completed';
  if (!s.ExpectedEta) return 'upcoming';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const eta = new Date(s.ExpectedEta); eta.setHours(0, 0, 0, 0);
  if (eta.getTime() < today.getTime()) return 'late';
  if (eta.getTime() === today.getTime()) return 'today';
  return 'upcoming';
}

const IL_BUCKET_DEFS = [
  { key: 'late',      label: 'Late',      dot: 'backlog', defaultOpen: true },
  { key: 'today',     label: 'Today',     dot: 'today',   defaultOpen: true },
  { key: 'upcoming',  label: 'Upcoming',  dot: 'week',    defaultOpen: true },
  { key: 'completed', label: 'Completed', dot: 'month',   defaultOpen: false },
  { key: 'cancelled', label: 'Cancelled', dot: 'other',   defaultOpen: false },
];

// No-ETA rows sort last within whichever bucket they land in (Upcoming).
function ilSortByEta(rows) {
  return [...rows].sort((a, b) => {
    const ta = a.ExpectedEta ? new Date(a.ExpectedEta).getTime() : Infinity;
    const tb = b.ExpectedEta ? new Date(b.ExpectedEta).getTime() : Infinity;
    return ta - tb;
  });
}

// Cancelled bucket sorts by most-recently-cancelled first — ETA isn't a
// useful ordering once a shipment's been pulled from the active flow.
function ilSortByCancelled(rows) {
  return [...rows].sort((a, b) => new Date(b.CancelledAtUtc).getTime() - new Date(a.CancelledAtUtc).getTime());
}

// Completed bucket sorts by most-recently-received first, same rationale
// as ilSortByCancelled.
function ilSortByReceived(rows) {
  return [...rows].sort((a, b) => new Date(b.ReceivedAtUtc).getTime() - new Date(a.ReceivedAtUtc).getTime());
}

function renderInboundLog() {
  const addBtnHtml = `<div style="display:flex;justify-content:flex-end;margin-bottom:10px">
    <button type="button" class="btn-secondary" id="il-manual-btn">+ Manual Shipment</button>
  </div>`;

  if (!inboundShipmentRows.length) {
    document.getElementById('result-body').innerHTML = addBtnHtml +
      '<div class="sap-empty">No inbound shipments yet — create one from Tracked Orders by selecting order lines, or add a Manual Shipment above.</div>';
    document.getElementById('il-manual-btn').addEventListener('click', openManualInboundShipmentModal);
    return;
  }

  const renderRow = s => `
    <tr class="admin-row lg-row" data-id="${s.ShipmentId}">
      <td><strong>${esc(s.ShipmentReference || `#${s.ShipmentId}`)}</strong></td>
      <td>${s.IsManual ? `<span style="color:var(--text-secondary,#666)">Manual — ${esc(s.OriginName || 'no origin')}</span>` : esc(s.Suppliers || '-')}</td>
      <td>${esc(s.Haulier || '-')}</td>
      <td>${esc(s.ModeOfTransport || '-')}</td>
      <td>${formatDisplayDate(s.DispatchDate)}</td>
      <td>${formatDisplayDate(s.ExpectedEta)}</td>
      <td>${esc(s.TrackingNumber || '-')}</td>
      <td>${s.OrderCount}</td>
      <td>${s.CancelledAtUtc
        ? `<span style="color:var(--text-secondary,#666)">Cancelled ${formatDisplayDate(s.CancelledAtUtc)}</span>`
        : (s.ReceivedAtUtc ? `Received ${formatDisplayDate(s.ReceivedAtUtc)}` : '<span style="color:var(--text-secondary,#666)">Pending</span>')}</td>
    </tr>`;

  const tableHead = '<thead><tr><th>Reference</th><th>Supplier</th><th>Haulier</th><th>Mode</th><th>Dispatch</th><th>ETA</th><th>Tracking</th><th>Orders</th><th>Status</th></tr></thead>';

  const sections = IL_BUCKET_DEFS.map(bd => {
    const rawRows = inboundShipmentRows.filter(s => ilBucketFor(s) === bd.key);
    const bucketRows = bd.key === 'cancelled' ? ilSortByCancelled(rawRows)
      : bd.key === 'completed' ? ilSortByReceived(rawRows)
      : ilSortByEta(rawRows);
    if (!bucketRows.length) return '';
    const collapsed = bd.defaultOpen ? '' : ' ps-section--collapsed';
    return `<div class="ps-section${collapsed}" data-group-key="${bd.key}">
      <div class="ps-section-header">
        <span class="ps-section-dot ps-section-dot--${bd.dot}"></span>
        <span class="ps-section-title">${bd.label}</span>
        <span class="ps-section-count">${bucketRows.length}</span>
        <span class="ps-chevron">v</span>
      </div>
      <div class="ps-section-body">
        <div style="overflow-x:auto"><table class="pn-batch-table admin-table">${tableHead}<tbody>${bucketRows.map(renderRow).join('')}</tbody></table></div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('result-body').innerHTML = addBtnHtml + `<div class="ps-sections">${sections}</div>`;

  document.getElementById('il-manual-btn').addEventListener('click', openManualInboundShipmentModal);
  document.querySelectorAll('.ps-section-header').forEach(h => h.addEventListener('click', () => h.closest('.ps-section').classList.toggle('ps-section--collapsed')));
  document.querySelectorAll('.lg-row').forEach(row => {
    row.addEventListener('click', () => openInboundShipmentDetail(Number(row.dataset.id)));
  });
}

// ── Manual Inbound Shipment — not derived from any tracked order (e.g. a
// customer return). Origin is picked from Destinations, haulier from
// Forwarders (same dropdown as everywhere else in the Inbound Log), and an
// optional price auto-creates one Associated Costs line via the same
// insertInboundCostLine helper the shipment detail's "+ Add Cost" uses —
// see routes/performance.js's /order-suggestions/shipments/manual route.
async function openManualInboundShipmentModal() {
  openModal(`<div class="ps-modal lg-modal" style="max-width:560px;width:94vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Manual Inbound Shipment</div><div class="ps-modal-sub">Not linked to a tracked order — e.g. a customer return</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="tf-row">
        <div class="tf-field tf-field--wide" style="position:relative">
          <label class="tf-label">Origin</label>
          <input class="tf-input" type="text" id="mi-origin-search" placeholder="Start typing a destination name…" autocomplete="off">
          <input type="hidden" id="mi-origin-id">
          <div id="mi-origin-results" class="hidden" style="position:absolute;top:100%;left:0;right:0;z-index:20;
            background:var(--surface,#fff);border:1px solid var(--border);border-radius:0 0 8px 8px;
            max-height:220px;overflow-y:auto;box-shadow:0 8px 20px rgba(0,0,0,0.12)"></div>
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Mode of Transport</label>
          <select class="tf-input" id="mi-mode">
            <option value="">— Select mode —</option>
            ${OS_TRANSPORT_MODES.map(m => `<option value="${m}">${m}</option>`).join('')}
          </select>
        </div>
        <div class="tf-field">
          <label class="tf-label">Haulier</label>
          <select class="tf-input" id="mi-haulier" disabled><option value="">Select mode of transport first</option></select>
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Dispatch Date</label>
          <input class="tf-input" type="date" id="mi-dispatch">
        </div>
        <div class="tf-field">
          <label class="tf-label">Expected ETA</label>
          <input class="tf-input" type="date" id="mi-eta">
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Tracking Number</label>
          <input class="tf-input" type="text" id="mi-tracking">
        </div>
      </div>
      <div class="tf-section-label">Cost (optional)</div>
      <div class="tf-row">
        <div class="tf-field">
          <label class="tf-label">Price (£)</label>
          <input class="tf-input" type="number" step="0.01" id="mi-price">
        </div>
        <div class="tf-field">
          <label class="tf-label">Cost Centre</label>
          <select class="tf-input" id="mi-costcentre"><option value="">Loading…</option></select>
        </div>
        <div class="tf-field">
          <label class="tf-label">GL Tier</label>
          <select class="tf-input" id="mi-tier">
            <option value="standard">Standard (602200)</option>
            <option value="premium">Premium (602100)</option>
          </select>
        </div>
      </div>
      <div class="tf-row">
        <div class="tf-field tf-field--wide">
          <label class="tf-label">Notes</label>
          <input class="tf-input" type="text" id="mi-notes">
        </div>
      </div>
      <div id="mi-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="mi-save-btn">Create Shipment</button>
    </div>
  </div>`);

  // Origin — search-as-you-type against Logistics.dbo.Destinations, same
  // pattern as the Mass Packaging Update material lookup (debounced,
  // server-filtered, TOP 200) rather than a single big <select> of every
  // destination.
  const originInput   = document.getElementById('mi-origin-search');
  const originIdInput = document.getElementById('mi-origin-id');
  const originResults = document.getElementById('mi-origin-results');
  let originDebounce = null;

  function renderOriginResults(rows) {
    if (!rows.length) {
      originResults.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:var(--text-secondary,#666)">No matches</div>';
    } else {
      originResults.innerHTML = rows.map(d =>
        `<div class="mi-origin-row" data-id="${esc(String(d.destinationID))}" data-name="${esc(d.destinationName)}"
           style="padding:7px 10px;font-size:13px;cursor:pointer">${esc(d.destinationName)}${d.destinationCountry ? ` — ${esc(d.destinationCountry)}` : ''}</div>`
      ).join('');
      originResults.querySelectorAll('.mi-origin-row').forEach(row => {
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--surface2,#f3f4f6)'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });
        // mousedown (not click) so this fires before the input's blur handler hides the list
        row.addEventListener('mousedown', e => {
          e.preventDefault();
          originIdInput.value = row.dataset.id;
          originInput.value = row.dataset.name;
          originResults.classList.add('hidden');
        });
      });
    }
    originResults.classList.remove('hidden');
  }

  originInput.addEventListener('input', () => {
    originIdInput.value = ''; // typing invalidates whatever was previously selected
    clearTimeout(originDebounce);
    const q = originInput.value.trim();
    if (!q) { originResults.classList.add('hidden'); return; }
    originDebounce = setTimeout(async () => {
      try {
        const res = await fetch(`/api/destinations?search=${encodeURIComponent(q)}`);
        const rows = await res.json();
        renderOriginResults(Array.isArray(rows) ? rows : []);
      } catch (err) {
        originResults.innerHTML = '<div style="padding:8px 10px;font-size:12px" class="sap-error">Search failed</div>';
        originResults.classList.remove('hidden');
      }
    }, 250);
  });
  originInput.addEventListener('focus', () => {
    if (originInput.value.trim() && originResults.innerHTML) originResults.classList.remove('hidden');
  });
  originInput.addEventListener('blur', () => {
    setTimeout(() => originResults.classList.add('hidden'), 150);
  });

  // Mode of Transport chosen first, then Haulier is filtered to only
  // forwarders approved for that mode.
  document.getElementById('mi-mode').addEventListener('change', () => {
    loadForwarderOptionsByMode('mi-haulier', document.getElementById('mi-mode').value);
  });

  const costCentreSelect = document.getElementById('mi-costcentre');
  fetch('/api/costcenters').then(r => r.json()).then(rows => {
    if (!Array.isArray(rows)) throw new Error('bad response');
    costCentreSelect.innerHTML = `<option value="">— Select cost centre —</option>${rows.map(c =>
      `<option value="${esc(c.centerCode)}" ${c.centerCode === '0000002012' ? 'selected' : ''}>${esc(c.centerDescription)} (${esc(c.centerCode)})</option>`
    ).join('')}`;
  }).catch(() => { costCentreSelect.innerHTML = '<option value="">Failed to load cost centres</option>'; });

  document.getElementById('mi-save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('mi-save-btn');
    const result = document.getElementById('mi-result');
    result.innerHTML = '';
    btn.disabled = true; btn.textContent = 'Creating…';

    if (originInput.value.trim() && !originIdInput.value) {
      result.innerHTML = '<div class="sap-error">Select an origin from the dropdown list.</div>';
      btn.disabled = false; btn.textContent = 'Create Shipment';
      return;
    }

    const price = document.getElementById('mi-price').value;
    const body = {
      originDestinationID: originIdInput.value || null,
      forwarderID: document.getElementById('mi-haulier').value || null,
      modeOfTransport: document.getElementById('mi-mode').value || null,
      dispatchDate: document.getElementById('mi-dispatch').value || null,
      expectedEta: document.getElementById('mi-eta').value || null,
      trackingNumber: document.getElementById('mi-tracking').value.trim() || null,
      notes: document.getElementById('mi-notes').value.trim() || null,
      price: price ? Number(price) : null,
      costCentre: costCentreSelect.value || null,
      tier: document.getElementById('mi-tier').value,
    };

    try {
      const res = await fetch('/api/performance/order-suggestions/shipments/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Failed to create shipment');
      closePickModal();
      runInboundLog();
    } catch (err) {
      result.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Create Shipment';
    }
  });
}

// Detail/edit view for one inbound shipment — header fields (editable via
// PUT), linked order lines (read-only), and Mark Received when not yet
// received. Mark Received bulk-flips every linked order to 'Booked' server
// side (markShipmentReceived) and calls the SAP goods-receipt placeholder —
// see that function's comment in performancesql.js.
async function openInboundShipmentDetail(shipmentId) {
  openModal(`<div class="ps-modal lg-modal" style="max-width:640px;width:94vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Shipment</div><div class="ps-modal-sub">Loading…</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body" id="isd-body"><div class="sap-loading"><div class="spinner"></div>Loading...</div></div>
    <div class="ps-modal-actions" id="isd-actions"></div>
  </div>`);
  await refreshInboundShipmentDetail(shipmentId);
}

async function refreshInboundShipmentDetail(shipmentId) {
  const body = document.getElementById('isd-body');
  const actions = document.getElementById('isd-actions');
  if (!body) return;
  try {
    const res = await fetch(`/api/performance/order-suggestions/shipments/${shipmentId}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load shipment');
    const s = json.data;

    document.querySelector('.ps-modal-title').textContent = s.ShipmentReference || `Shipment #${s.ShipmentId}`;
    document.querySelector('.ps-modal-sub').textContent = s.CancelledAtUtc
      ? `Cancelled ${formatDisplayDate(s.CancelledAtUtc)}${s.CancelledBy ? ' by ' + s.CancelledBy : ''} — orders unlinked`
      : (s.ReceivedAtUtc
        ? `Received ${formatDisplayDate(s.ReceivedAtUtc)}${s.ReceivedBy ? ' by ' + s.ReceivedBy : ''}`
        : `${s.orders.length} order line${s.orders.length === 1 ? '' : 's'} — not yet received`);

    const ordersRows = s.orders.map(o => `
      <tr class="admin-row">
        <td><strong>${esc(o.Material)}</strong><div style="font-size:11px;color:var(--text-secondary,#666)">${esc(o.MaterialText || '')}</div></td>
        <td>${esc(o.VendorName)}</td>
        <td>${Number(o.OrderQty).toLocaleString()}</td>
        <td>${esc(o.Status)}</td>
        <td>${esc(o.PoNumber || '-')}</td>
        <td>${esc(o.SupplierReference || '-')}</td>
      </tr>`).join('');

    body.innerHTML = `
      ${s.IsManual ? `<div class="toolbar-hint" style="margin-bottom:10px">Manual shipment — not linked to any tracked order. Origin: <strong>${esc(s.OriginName || '—')}</strong></div>` : ''}
      <form id="isd-form" class="transfer-form">
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Dispatch Date</label>
            <input class="tf-input" type="date" id="isd-dispatch" value="${s.DispatchDate ? String(s.DispatchDate).slice(0, 10) : ''}">
          </div>
          <div class="tf-field">
            <label class="tf-label">Expected ETA</label>
            <input class="tf-input" type="date" id="isd-eta" value="${s.ExpectedEta ? String(s.ExpectedEta).slice(0, 10) : ''}">
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Haulier</label>
            <select class="tf-input" id="isd-haulier"><option value="">Loading…</option></select>
          </div>
          <div class="tf-field">
            <label class="tf-label">Mode of Transport</label>
            <select class="tf-input" id="isd-mode">
              <option value="">—</option>
              ${OS_TRANSPORT_MODES.map(m => `<option value="${m}" ${s.ModeOfTransport === m ? 'selected' : ''}>${m}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field">
            <label class="tf-label">Tracking Number</label>
            <input class="tf-input" type="text" id="isd-tracking" value="${esc(s.TrackingNumber || '')}">
          </div>
          <div class="tf-field">
            <label class="tf-label">Container Number</label>
            <input class="tf-input" type="text" id="isd-container" value="${esc(s.ContainerNumber || '')}">
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">B/L Number</label>
            <input class="tf-input" type="text" id="isd-bl" value="${esc(s.BillOfLading || '')}">
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-field tf-field--wide">
            <label class="tf-label">Notes</label>
            <input class="tf-input" type="text" id="isd-notes" value="${esc(s.Notes || '')}">
          </div>
        </div>
        <div id="isd-result"></div>
      </form>
      ${s.orders.length ? `
      <div class="tf-section-label">Order Lines</div>
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>Material</th><th>Vendor</th><th>Qty</th><th>Status</th><th>PO Number</th><th>Supplier Ref</th></tr></thead>
          <tbody>${ordersRows}</tbody>
        </table>
      </div>` : ''}
      <div class="tf-section-label">Documents</div>
      <div class="toolbar-hint">Purchase orders assigned to this shipment are filed here automatically. Upload shipping documents or the supplier invoice too — everything lands in the same folder.</div>
      <div id="isd-documents"><div class="sap-loading"><div class="spinner"></div>Loading…</div></div>
      <input type="file" id="isd-doc-file-input" accept="application/pdf,image/jpeg,image/png" style="display:none">
      <div class="tf-row" style="margin-top:8px">
        <button type="button" class="btn-secondary" id="isd-doc-upload-btn">Upload Document</button>
      </div>
      <div class="tf-section-label">Associated Costs</div>
      <div id="isd-costs"><div class="sap-loading"><div class="spinner"></div>Loading…</div></div>`;

    loadForwarderOptionsInto('isd-haulier', s.ForwarderID);
    renderAssociatedCosts(shipmentId, s);
    renderShipmentDocuments(shipmentId);

    document.getElementById('isd-doc-upload-btn').addEventListener('click', () => document.getElementById('isd-doc-file-input').click());
    document.getElementById('isd-doc-file-input').addEventListener('change', async () => {
      const fileInput = document.getElementById('isd-doc-file-input');
      const file = fileInput.files[0];
      if (!file) return;
      const uploadBtn = document.getElementById('isd-doc-upload-btn');
      uploadBtn.disabled = true; uploadBtn.textContent = 'Uploading…';
      try {
        const res2 = await fetch(`/api/performance/order-suggestions/shipments/${shipmentId}/documents/upload`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/pdf', 'X-File-Name': encodeURIComponent(file.name) },
          body: file,
        });
        const json2 = await res2.json();
        if (!json2.success) throw new Error(json2.error?.message || 'Upload failed.');
        await renderShipmentDocuments(shipmentId);
      } catch (err) {
        const docBody = document.getElementById('isd-documents');
        if (docBody) docBody.insertAdjacentHTML('afterbegin', `<div class="sap-error tf-inline-error">${esc(err.message)}</div>`);
      } finally {
        uploadBtn.disabled = false; uploadBtn.textContent = 'Upload Document';
        fileInput.value = '';
      }
    });

    // Cancelling is allowed any time up until the shipment is itself
    // cancelled — including after it's been marked received (see
    // cancelOrderShipment's comment in performancesql.js for why). Marking
    // received is the narrower action: only makes sense once, on a shipment
    // that isn't already cancelled or received.
    const canCancel = !s.CancelledAtUtc;
    const canReceive = !s.CancelledAtUtc && !s.ReceivedAtUtc;
    actions.innerHTML = `
      <button type="button" class="btn-secondary" onclick="closePickModal()">Close</button>
      ${canCancel ? '<button type="button" class="btn-secondary" id="isd-cancel-btn">Cancel Shipment</button>' : ''}
      <button type="button" class="btn-secondary" id="isd-save-btn">Save Details</button>
      ${canReceive ? '<button type="button" class="btn-submit" id="isd-receive-btn">Mark Received</button>' : ''}
    `;

    document.getElementById('isd-save-btn').addEventListener('click', () => saveInboundShipmentDetail(shipmentId));
    if (canReceive) {
      document.getElementById('isd-receive-btn').addEventListener('click', () => markInboundShipmentReceived(shipmentId, s));
    }
    if (canCancel) {
      document.getElementById('isd-cancel-btn').addEventListener('click', () => cancelInboundShipment(shipmentId, s));
    }
  } catch (err) {
    body.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

// ── Documents (Inbound Log detail) ──────────────────────────────────────────
// Same folder/upload endpoints the Tracked Orders "Invoice" button already
// used (openShipmentInvoiceModal/osiLoadFolder) — surfaced here too, inline
// on the Inbound Log shipment detail rather than only reachable via a
// per-row button that only appears once a tracked order has a ShipmentId,
// which is easy to never notice if you work from the Inbound Log rather
// than Tracked Orders. Auto-generated PO PDFs (see
// autoFileShipmentPoDocuments in performance.js) show up in this same list
// with no extra step — they're just files that were already sitting in the
// folder before the modal ever loaded.
async function renderShipmentDocuments(shipmentId) {
  const container = document.getElementById('isd-documents');
  if (!container) return;
  container.innerHTML = '<div class="sap-loading"><div class="spinner"></div>Loading…</div>';
  try {
    const res = await fetch(`/api/performance/order-suggestions/shipments/${shipmentId}/documents/folder`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load documents.');
    const files = json.data.files || [];
    container.innerHTML = !files.length
      ? '<div class="sap-empty">No documents yet.</div>'
      : `<div style="overflow-x:auto"><table class="pn-batch-table admin-table">
          <thead><tr><th>File</th><th>Size</th><th>Uploaded</th><th></th></tr></thead>
          <tbody>${files.map(f => `<tr class="admin-row">
            <td>${esc(f.fileName)}</td>
            <td>${(Number(f.sizeBytes || 0) / 1024).toFixed(1)} KB</td>
            <td>${formatDisplayDate(f.modifiedAtUtc)}</td>
            <td style="text-align:right"><a href="${esc(f.downloadUrl)}" target="_blank" rel="noopener">View</a></td>
          </tr>`).join('')}</tbody>
        </table></div>`;
  } catch (err) {
    container.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

// ── Associated Costs (Inbound Log detail) ───────────────────────────────────
// Cost centre is always the fixed inbound default (2012) here, per the
// user's spec — only the GL tier (standard/premium -> 602200/602100) is
// chosen per line. See routes/inboundcosts.js for the posting mechanics.
async function renderAssociatedCosts(shipmentId, shipment) {
  const container = document.getElementById('isd-costs');
  if (!container) return;
  try {
    const res = await fetch(`/api/inboundcosts/shipment/${shipmentId}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to load costs');
    const lines = json.data || [];
    const unprocessed = lines.filter(l => !l.migoStatus);

    const rows = lines.map(l => `
      <tr class="admin-row">
        <td>${esc(l.elementDescription || l.costElement)}</td>
        <td>£${Number(l.expectedCost).toFixed(2)}</td>
        <td>${l.migoStatus ? `<span style="color:var(--success,#059669)">Posted — ${esc(l.materialDocument || '')}</span>` : '<span style="color:var(--text-secondary,#666)">Pending</span>'}</td>
        <td>${l.migoStatus
          ? `<button type="button" class="btn-secondary isd-cost-reverse" data-cost-id="${l.costID}" style="padding:2px 8px;font-size:11px">Reverse</button>`
          : `<button type="button" class="btn-secondary isd-cost-delete" data-cost-id="${l.costID}" style="padding:2px 8px;font-size:11px">Remove</button>`}</td>
      </tr>`).join('');

    container.innerHTML = `
      <div style="overflow-x:auto">
        <table class="pn-batch-table admin-table">
          <thead><tr><th>GL Element</th><th>Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows.length ? rows : '<tr><td colspan="4" style="color:var(--text-secondary,#666)">No cost lines yet</td></tr>'}</tbody>
        </table>
      </div>
      <div class="tf-row" style="margin-top:10px;align-items:flex-end">
        <div class="tf-field">
          <label class="tf-label">Tier</label>
          <select class="tf-input" id="isd-cost-tier">
            <option value="standard">Standard (602200)</option>
            <option value="premium">Premium (602100)</option>
          </select>
        </div>
        <div class="tf-field">
          <label class="tf-label">Amount (£)</label>
          <input class="tf-input" type="number" step="0.01" id="isd-cost-amount">
        </div>
        <div class="tf-field">
          <button type="button" class="btn-secondary" id="isd-cost-add-btn">+ Add Cost</button>
        </div>
      </div>
      ${!shipment.ForwarderID ? '<div class="toolbar-hint" style="color:var(--error,#DC2626)">Select a haulier and save before posting costs to SAP — the haulier is used as the vendor.</div>' : ''}
      ${unprocessed.length ? `<div class="toolbar-hint" style="margin-top:8px">${unprocessed.length} line${unprocessed.length === 1 ? '' : 's'} awaiting SAP posting — post from Admin &rarr; Unprocessed Costs, alongside outbound freight.</div>` : ''}
      <div id="isd-cost-result" style="margin-top:8px"></div>`;

    document.getElementById('isd-cost-add-btn').addEventListener('click', async () => {
      const btn = document.getElementById('isd-cost-add-btn');
      const result = document.getElementById('isd-cost-result');
      const amount = document.getElementById('isd-cost-amount').value;
      const tier = document.getElementById('isd-cost-tier').value;
      if (!amount || Number(amount) <= 0) { result.innerHTML = '<div class="sap-error">Enter an amount greater than 0.</div>'; return; }
      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        const res2 = await fetch('/api/inboundcosts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ poShipmentID: shipmentId, tier, amount: Number(amount) }),
        });
        const json2 = await res2.json();
        if (!json2.success) throw new Error(json2.error?.message || 'Failed to add cost');
        renderAssociatedCosts(shipmentId, shipment);
      } catch (err) {
        result.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = '+ Add Cost';
      }
    });

    document.querySelectorAll('.isd-cost-delete').forEach(b => {
      b.addEventListener('click', async () => {
        try {
          const res2 = await fetch(`/api/inboundcosts/${b.dataset.costId}`, { method: 'DELETE' });
          const json2 = await res2.json();
          if (!json2.success) throw new Error(json2.error?.message || 'Failed to remove cost');
          renderAssociatedCosts(shipmentId, shipment);
        } catch (err) {
          document.getElementById('isd-cost-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
        }
      });
    });

    document.querySelectorAll('.isd-cost-reverse').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('Reverse this posting in SAP? This creates a reversing material document — the line will drop back into Unprocessed Costs afterwards.')) return;
        b.disabled = true; b.textContent = 'Reversing…';
        try {
          const res2 = await fetch(`/api/shipmentcost/${b.dataset.costId}/reverse`, { method: 'POST' });
          const json2 = await res2.json();
          if (!json2.success) throw new Error(json2.error || json2.message || 'Reversal failed');
          renderAssociatedCosts(shipmentId, shipment);
        } catch (err) {
          document.getElementById('isd-cost-result').innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
          b.disabled = false; b.textContent = 'Reverse';
        }
      });
    });

  } catch (err) {
    container.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
  }
}

async function saveInboundShipmentDetail(shipmentId) {
  const btn = document.getElementById('isd-save-btn');
  const result = document.getElementById('isd-result');
  btn.disabled = true; btn.textContent = 'Saving…';
  const body = {
    dispatchDate: document.getElementById('isd-dispatch').value || null,
    expectedEta: document.getElementById('isd-eta').value || null,
    forwarderID: document.getElementById('isd-haulier').value || null,
    modeOfTransport: document.getElementById('isd-mode').value || null,
    trackingNumber: document.getElementById('isd-tracking').value.trim() || null,
    containerNumber: document.getElementById('isd-container').value.trim() || null,
    billOfLading: document.getElementById('isd-bl').value.trim() || null,
    notes: document.getElementById('isd-notes').value.trim() || null,
  };
  try {
    const res = await fetch(`/api/performance/order-suggestions/shipments/${shipmentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to save shipment');
    runInboundLog();
    await refreshInboundShipmentDetail(shipmentId);
  } catch (err) {
    if (result) result.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    btn.disabled = false; btn.textContent = 'Save Details';
  }
}

// Bulk-flips every linked order to 'Booked' server-side — a significant,
// hard-to-reverse action affecting every order on the shipment, so this
// gets an explicit confirm() rather than firing straight away.
async function markInboundShipmentReceived(shipmentId, shipment) {
  const orderCount = shipment.orders?.length || 0;
  if (!confirm(`Mark ${shipment.ShipmentReference || 'this shipment'} received? ${orderCount} order line${orderCount === 1 ? '' : 's'} will be flipped to Booked.`)) return;
  const btn = document.getElementById('isd-receive-btn');
  const result = document.getElementById('isd-result');
  if (btn) { btn.disabled = true; btn.textContent = 'Marking…'; }
  try {
    const res = await fetch(`/api/performance/order-suggestions/shipments/${shipmentId}/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to mark shipment received');
    runInboundLog();
    await refreshInboundShipmentDetail(shipmentId);
  } catch (err) {
    if (result) result.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    if (btn) { btn.disabled = false; btn.textContent = 'Mark Received'; }
  }
}

// Unlinks every order on the shipment (their Status is left untouched —
// they're just freed up to go on a different shipment later) and marks the
// shipment cancelled. Allowed even after Mark Received (see
// cancelOrderShipment's comment) — in that case the orders stay Booked, so
// the confirm makes that explicit rather than implying a full undo. A
// destructive, hard-to-reverse action affecting every order on the
// shipment, so this gets an explicit confirm() too.
async function cancelInboundShipment(shipmentId, shipment) {
  const orderCount = shipment.orders?.length || 0;
  const receivedNote = shipment.ReceivedAtUtc
    ? ` This shipment was already marked received — its orders will stay Booked, just unlinked from this shipment.`
    : '';
  if (!confirm(`Cancel ${shipment.ShipmentReference || 'this shipment'}? ${orderCount} order line${orderCount === 1 ? '' : 's'} will be unlinked and free to add to a different shipment.${receivedNote}`)) return;
  const btn = document.getElementById('isd-cancel-btn');
  const result = document.getElementById('isd-result');
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
  try {
    const res = await fetch(`/api/performance/order-suggestions/shipments/${shipmentId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || 'Failed to cancel shipment');
    // Not refreshing Tracked Orders here — it isn't necessarily the
    // underlying view (Inbound Log is), and it fetches fresh on its own
    // next visit anyway, same as after Mark Received above.
    runInboundLog();
    await refreshInboundShipmentDetail(shipmentId);
  } catch (err) {
    if (result) result.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    if (btn) { btn.disabled = false; btn.textContent = 'Cancel Shipment'; }
  }
}


// ── Bulk CSV upload for manual orders — same fields as openManualOrderModal,
// but for pasting in a whole pipeline's worth of orders at once instead of
// one at a time. Parsed entirely client-side (no CSV library bundled for
// this app; the format is simple enough to hand-roll correctly, including
// quoted fields with embedded delimiters) and posted as JSON rows to
// /order-suggestions/manual/bulk, which resolves Vendor/Material by name.
//
// Delimiter is ';' rather than ',' — every PC on the network is set to a
// locale (UK/EU) where Excel's default list separator is ';' (since ','
// doubles as the decimal separator there), so a ',' delimiter would silently
// mis-split a CSV exported/opened on any of those machines. Order Qty is
// normalised for the same reason: those locales also use ',' as the decimal
// point, so "5000,5" is accepted as 5000.5, not misread as two fields.
const CSV_DELIMITER = ';';

const MANUAL_ORDER_CSV_HEADERS = {
  'vendor': 'vendor', 'vendor name': 'vendor',
  'material': 'material', 'material code': 'material', 'material number': 'material',
  'qty': 'orderQty', 'order qty': 'orderQty', 'order quantity': 'orderQty', 'orderqty': 'orderQty',
  'order date': 'orderDate', 'orderdate': 'orderDate',
  'delivery date': 'deliveryDate', 'deliverydate': 'deliveryDate',
  'status': 'status',
  'po': 'poNumber', 'po number': 'poNumber', 'ponumber': 'poNumber',
  'supplier ref': 'supplierReference', 'supplier reference': 'supplierReference', 'supplierreference': 'supplierReference',
  'notes': 'notes',
};

// Minimal RFC4180-style parser: handles quoted fields (embedded delimiters,
// embedded newlines, "" for an escaped quote) and both CRLF and LF row
// endings, since a spreadsheet export could produce either.
function parseCsvText(text, delimiter = CSV_DELIMITER) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } }
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c === '\r') {
      // skip — the following \n (or EOF) ends the row
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) pushRow();
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

// A comma-decimal qty ("5000,5") is only ambiguous with the ',' delimiter,
// which this app no longer uses — safe to always normalise comma to dot.
function normaliseCsvQty(value) {
  const v = String(value || '').trim();
  return /^-?\d+,\d+$/.test(v) ? v.replace(',', '.') : v;
}

// JS's Date constructor only reliably understands ISO (YYYY-MM-DD); the
// network's locale writes dates as DD.MM.YY(YY) or DD/MM/YY(YY) (e.g.
// "21.07.26"), which Date() silently turns into an Invalid Date — that then
// fails server-side with "Validation failed for parameter 'orderDate'.
// Invalid date." Converts the locale format to ISO before sending; already-
// ISO values and anything unrecognised pass through unchanged so the server
// still surfaces its own error for genuinely bad input.
function normaliseCsvDate(value) {
  const v = String(value || '').trim();
  if (!v || /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2}|\d{4})$/);
  if (!m) return v;
  const [, dd, mm, yy] = m;
  const year = yy.length === 2 ? (Number(yy) < 50 ? `20${yy}` : `19${yy}`) : yy;
  return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function parseManualOrderCsv(text) {
  const rows = parseCsvText(text);
  if (!rows.length) return [];
  const headerKeys = rows[0].map(h => MANUAL_ORDER_CSV_HEADERS[h.trim().toLowerCase()] || null);
  if (!headerKeys.some(Boolean)) throw new Error('No recognised columns in the header row — see the template for expected column names.');
  return rows.slice(1).map(cols => {
    const obj = {};
    headerKeys.forEach((key, i) => { if (key) obj[key] = (cols[i] || '').trim(); });
    if (obj.orderQty) obj.orderQty = normaliseCsvQty(obj.orderQty);
    if (obj.orderDate) obj.orderDate = normaliseCsvDate(obj.orderDate);
    if (obj.deliveryDate) obj.deliveryDate = normaliseCsvDate(obj.deliveryDate);
    return obj;
  }).filter(obj => obj.vendor || obj.material);
}

function downloadManualOrderCsvTemplate() {
  const header  = ['Vendor', 'Material', 'Order Qty', 'Order Date', 'Delivery Date', 'Status', 'PO Number', 'Supplier Reference', 'Notes'].join(CSV_DELIMITER);
  const example = ['Example Vendor Ltd', '100123', '5000', '2026-07-16', '', 'Ordered', 'PO-12345', 'SUP-REF-001', ''].join(CSV_DELIMITER);
  const blob = new Blob([`${header}\r\n${example}\r\n`], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'manual-orders-template.csv'; a.click();
  URL.revokeObjectURL(url);
}

async function openManualOrderCsvModal() {
  openModal(`<div class="ps-modal" style="max-width:560px;width:94vw">
    <div class="ps-modal-header">
      <div><div class="ps-modal-title">Upload Orders CSV</div><div class="ps-modal-sub">Bulk-add manual orders instead of one at a time</div></div>
      <button class="ps-modal-close" onclick="closePickModal()">×</button>
    </div>
    <div class="ps-modal-body">
      <div class="toolbar-hint">Columns: Vendor, Material, Order Qty, Order Date, Delivery Date (optional), Status (optional — Accepted/Ordered/Booked/Received), PO Number (optional), Supplier Reference (optional), Notes (optional). Vendor and Material must already be configured together in Vendor Master Data. Uses <strong>;</strong> as the column delimiter, matching Excel's UK/EU default — just save/export as CSV as normal.</div>
      <div style="margin:10px 0"><button type="button" class="btn-secondary" id="mc-template-btn">Download Template</button></div>
      <input type="file" id="mc-file-input" accept=".csv,text/csv" style="margin-bottom:10px">
      <div id="mc-preview"></div>
      <div id="mc-result"></div>
    </div>
    <div class="ps-modal-actions">
      <button type="button" class="btn-secondary" onclick="closePickModal()">Cancel</button>
      <button type="button" class="btn-submit" id="mc-upload-btn" disabled>Upload</button>
    </div>
  </div>`);

  let parsedRows = [];

  document.getElementById('mc-template-btn').addEventListener('click', downloadManualOrderCsvTemplate);

  document.getElementById('mc-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const preview = document.getElementById('mc-preview');
    const uploadBtn = document.getElementById('mc-upload-btn');
    parsedRows = [];
    preview.innerHTML = '';
    uploadBtn.disabled = true;
    if (!file) return;
    try {
      const text = await file.text();
      parsedRows = parseManualOrderCsv(text);
      if (!parsedRows.length) throw new Error('No data rows found in that file.');
      preview.innerHTML = `<div class="toolbar-hint">${parsedRows.length} row${parsedRows.length === 1 ? '' : 's'} ready to upload.</div>`;
      uploadBtn.disabled = false;
    } catch (err) {
      parsedRows = [];
      preview.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    }
  });

  document.getElementById('mc-upload-btn').addEventListener('click', async () => {
    if (!parsedRows.length) return;
    const btn = document.getElementById('mc-upload-btn');
    const result = document.getElementById('mc-result');
    result.innerHTML = '';
    btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      const res = await fetch('/api/performance/order-suggestions/manual/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: parsedRows }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Upload failed');
      const { succeeded, failed, results } = json.data;
      const failures = results.filter(r => !r.success);
      result.innerHTML = `
        <div class="${failed ? 'sap-error' : 'toolbar-hint'}">${succeeded} of ${results.length} row${results.length === 1 ? '' : 's'} added${failed ? `, ${failed} failed` : ''}.</div>
        ${failures.length ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:12px">${failures.map(f => `<li>Row ${f.row}: ${esc(f.error)}</li>`).join('')}</ul>` : ''}
      `;
      if (succeeded) runOrderSuggestionsTracked();
    } catch (err) {
      result.innerHTML = `<div class="sap-error">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = 'Upload';
    }
  });
}
