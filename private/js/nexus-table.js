'use strict';

// ── Nexus shared table library ──────────────────────────────────────────────
// Two jobs:
//
// 1. AUTO-WRAP (runs automatically, no per-page wiring needed beyond loading
//    this file): watches the DOM the same way table-paginate.js does, and
//    wraps every plain <table> that isn't already inside a horizontally
//    scrollable ancestor in a `.nx-table-wrap` div. This is the fix for the
//    recurring "table with too many columns pushes the whole page off-screen
//    instead of scrolling" bug — it was previously only fixed page-by-page
//    (admin.css .table-wrap, .dbx-preview-wrap) and inconsistently in
//    hand-built tables across logistics.js/warehouse.js/production-nexus.js.
//    Wrapping is non-destructive: the <table> node itself is untouched
//    (same attributes, same event listeners via closest()-based delegation,
//    same id), it's just given a new parent div. table-paginate.js already
//    anticipates this exact wrapper pattern (see its `anchor` logic in
//    makePager) so pagers still land in the right place once a table gets
//    auto-wrapped.
//
//    Skipped: DataTables-managed tables (they have their own scrollX
//    wrapper), tables already inside a scrollable ancestor (so this never
//    double-wraps, and never gets between a sticky <thead th> and the
//    ancestor it's meant to stick to — see .dbx-preview-wrap in admin.css
//    for exactly that case), and any table marked
//    <table data-no-nx-wrap>.
//
// 2. nxTable(rows, columns, opts) — an OPTIONAL builder for new code to use
//    instead of hand-assembling table HTML strings. Not required (auto-wrap
//    above fixes overflow either way), but gives new render functions a
//    consistent header style, empty state and escaping for free. See the
//    usage comment on nxTable() below.
(function () {

  // ── auto-wrap ──────────────────────────────────────────────────────────
  function hasScrollableAncestor(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
      node = node.parentElement;
    }
    return false;
  }

  function wrapTable(table) {
    const wrap = document.createElement('div');
    wrap.className = 'nx-table-wrap';
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  }

  function scanForWrap() {
    document.querySelectorAll('table').forEach(table => {
      if (table.classList.contains('dataTable')) return;   // DataTables manages its own scroll wrapper
      if (table.hasAttribute('data-no-nx-wrap')) return;
      if (table.closest('.nx-table-wrap')) return;          // already wrapped
      if (hasScrollableAncestor(table)) return;              // some ancestor already scrolls
      wrapTable(table);
    });
  }

  let pending = null;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; scanForWrap(); }, 120);
  });

  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    scanForWrap();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // ── nxTable() builder ─────────────────────────────────────────────────
  // Usage:
  //   container.innerHTML = nxTable(rows, [
  //     { key: 'material',   label: 'Material' },
  //     { key: 'orderQty',   label: 'Order Qty', align: 'right', format: v => Number(v || 0).toLocaleString() },
  //     { key: r => r.status, label: 'Status', format: v => `<span class="badge">${nxEscHtml(v)}</span>` },
  //   ], { emptyText: 'No rows found.' });
  //
  // - `key` can be a field name (string) or a function(row) => raw value.
  // - `format(rawValue, row)` is optional and, if given, its RETURN VALUE IS
  //   TRUSTED HTML (not escaped) — build any badges/links/buttons there, but
  //   escape any untrusted string yourself with nxEscHtml() first. Plain
  //   values with no `format` are escaped automatically.
  // - `align`: 'left' (default) | 'right' | 'center'.
  // - Already wraps its own output in .nx-table-wrap, so no extra markup is
  //   needed at the call site (the auto-wrap above will also just skip it,
  //   since it's already inside a scrollable ancestor).
  function nxEscHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function nxTable(rows, columns, opts) {
    opts = opts || {};
    const emptyText = opts.emptyText || 'No data.';
    const rowClass  = opts.rowClass  || null;
    const rowAttrs  = opts.rowAttrs  || null;

    if (!rows || !rows.length) {
      return `<div class="nx-table-empty">${nxEscHtml(emptyText)}</div>`;
    }

    const alignStyle = a => (a && a !== 'left') ? ` style="text-align:${a}"` : '';

    const thead = `<thead><tr>${columns.map(c =>
      `<th${alignStyle(c.align)}>${nxEscHtml(c.label)}</th>`
    ).join('')}</tr></thead>`;

    const tbody = `<tbody>${rows.map(row => {
      const cls   = rowClass ? ` class="${nxEscHtml(rowClass(row))}"` : '';
      const attrs = rowAttrs ? ' ' + rowAttrs(row) : '';
      const cells = columns.map(c => {
        const raw = typeof c.key === 'function' ? c.key(row) : row[c.key];
        const val = c.format ? c.format(raw, row) : nxEscHtml(raw);
        return `<td${alignStyle(c.align)}>${val}</td>`;
      }).join('');
      return `<tr${cls}${attrs}>${cells}</tr>`;
    }).join('')}</tbody>`;

    return `<div class="nx-table-wrap"><table>${thead}${tbody}</table></div>`;
  }

  window.nxTable    = nxTable;
  window.nxEscHtml  = nxEscHtml;
})();
