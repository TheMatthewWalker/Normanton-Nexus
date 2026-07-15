'use strict';

// ── Nexus table paginator ─────────────────────────────────────────────────────
// Auto-paginates every table on the page at 20 rows/page and compacts row
// styling, to keep large tables cheap to render.
//
// - Watches the DOM, so tables rendered later (innerHTML) are picked up
//   automatically — no per-render wiring needed.
// - Rows outside the current page are hidden (display:none), NOT removed, so
//   existing querySelectorAll-based logic (select-all checkboxes, bulk actions,
//   CSV readers, group toggles) keeps seeing every row.
// - Rows carrying [data-parent] (collapsible groups, e.g. the management order
//   book) always stay on the same page as their parent row.
// - Skipped: DataTables-managed tables (they paginate themselves) and any
//   table marked <table data-no-paginate>.
//
// - FILTER-AWARE: application code elsewhere (search boxes, column filter
//   dropdowns — e.g. the Stock Turns tile in logistics.js) hides non-matching
//   rows itself by setting `tr.style.display = 'none'` directly, rather than
//   re-rendering the table. Originally this paginator had no idea that had
//   happened: it assigned rows to pages purely by their original DOM order and
//   count, so "page 2" always meant physical rows 21-40 of the FULL unfiltered
//   list — if a filter hid all of those, page 2 rendered completely empty even
//   though matches existed elsewhere, and the page count never shrank to match
//   the filtered result. Fixed by excluding any row the app has already hidden
//   via inline style (isAppHidden below) from pagination entirely — such rows
//   are left exactly as the app set them, and only the REMAINING (matching)
//   rows get split into pages. Also now watches style/class attribute changes,
//   not just DOM structure changes, so a filter running after the table is
//   already paginated triggers a re-page immediately.
(function () {
  const PAGE_SIZE = 20;
  const HIDE_CLS  = 'nx-pg-hidden';

  // ── styles: compact rows + pager bar ──────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    table td, table th {
      padding: 3px 8px !important;
      font-size: 12px !important;
      line-height: 1.35 !important;
    }
    tr.${HIDE_CLS} { display: none !important; }
    .nx-pager {
      display: flex; align-items: center; gap: 10px;
      margin: 6px 0 10px; font-size: 12px;
      color: var(--text-muted, #64748B);
      user-select: none;
    }
    .nx-pager button {
      padding: 2px 10px; font-size: 12px; line-height: 1.4;
      border: 1px solid var(--border, #CBD5E1); border-radius: 5px;
      background: transparent; color: inherit; cursor: pointer;
    }
    .nx-pager button:disabled { opacity: .35; cursor: default; }
    .nx-pager .nx-pager-info { font-variant-numeric: tabular-nums; }
  `;
  document.head.appendChild(style);

  // ── pagination core ───────────────────────────────────────────────────────

  // A row the APPLICATION has filtered out — inline display:none, set by
  // filter code elsewhere, as opposed to HIDE_CLS below which is how this
  // paginator hides rows that are simply on a different page. Kept as a
  // distinct, simple heuristic (inline style vs. a CSS class) so the two
  // mechanisms never need to know about each other's internal state.
  function isAppHidden(row) {
    return row.style.display === 'none';
  }

  // Group ELIGIBLE (not app-hidden) tbody rows into blocks: a row with
  // [data-parent] belongs to the block of the nearest preceding eligible row
  // without one, so groups never split across pages. App-hidden rows are
  // skipped entirely — they're never assigned to a page and never touched by
  // showPage(), left exactly as the app's own filter set them.
  function buildBlocks(tbody) {
    const blocks = [];
    for (const row of tbody.rows) {
      if (isAppHidden(row)) continue;
      if (row.hasAttribute('data-parent') && blocks.length) blocks[blocks.length - 1].push(row);
      else blocks.push([row]);
    }
    return blocks;
  }

  // Split blocks into pages of ~PAGE_SIZE rows (a page can exceed it only when
  // a single block is larger than the page size).
  function buildPages(blocks) {
    const pages = [];
    let current = [], count = 0;
    for (const block of blocks) {
      if (count >= PAGE_SIZE && current.length) { pages.push(current); current = []; count = 0; }
      current.push(block);
      count += block.length;
    }
    if (current.length) pages.push(current);
    return pages;
  }

  function showPage(table) {
    const st = table._nxPg;
    st.page = Math.max(0, Math.min(st.page, st.pages.length - 1));

    const onThisPage = new Set();
    const activePage = st.pages[st.page];
    if (activePage) for (const block of activePage) for (const row of block) onThisPage.add(row);

    for (const row of table.tBodies[0].rows) {
      if (isAppHidden(row)) {
        // Not this paginator's row to manage — make sure we're not still
        // holding it hidden via our own class from a previous, wider page.
        row.classList.remove(HIDE_CLS);
        continue;
      }
      row.classList.toggle(HIDE_CLS, !onThisPage.has(row));
    }

    const totalRows = st.pages.reduce((s, p) => s + p.reduce((x, b) => x + b.length, 0), 0);
    if (!totalRows) {
      st.info.textContent = '0 of 0';
      st.prev.disabled = true;
      st.next.disabled = true;
      return;
    }
    const first = st.pages.slice(0, st.page).reduce((s, p) => s + p.reduce((x, b) => x + b.length, 0), 0) + 1;
    const last  = first - 1 + (activePage ? activePage.reduce((x, b) => x + b.length, 0) : 0);
    st.info.textContent = `${first}–${last} of ${totalRows}`;
    st.prev.disabled = st.page === 0;
    st.next.disabled = st.page === st.pages.length - 1;
  }

  function makePager(table) {
    const pager = document.createElement('div');
    pager.className = 'nx-pager';
    const prev = document.createElement('button');
    const next = document.createElement('button');
    const info = document.createElement('span');
    prev.type = next.type = 'button';
    prev.textContent = '‹ Prev';
    next.textContent = 'Next ›';
    info.className = 'nx-pager-info';
    pager.append(prev, info, next);
    pager._nxTable = table;
    prev.addEventListener('click', () => { table._nxPg.page--; showPage(table); });
    next.addEventListener('click', () => { table._nxPg.page++; showPage(table); });
    // If the table sits in an overflow wrapper, place the pager after it so it
    // doesn't scroll horizontally with the table.
    const anchor = table.parentElement && /auto|scroll/.test(getComputedStyle(table.parentElement).overflowX)
      ? table.parentElement : table;
    anchor.after(pager);
    return { pager, prev, next, info };
  }

  // Count of rows the app currently considers "in play" (not filtered out) —
  // used to detect "the filter changed" even when the total row count in the
  // DOM hasn't (filtering hides rows, it doesn't remove them).
  function countEligible(tbody) {
    let n = 0;
    for (const row of tbody.rows) if (!isAppHidden(row)) n++;
    return n;
  }

  function paginate(table) {
    const tbody = table.tBodies[0];
    if (!tbody) return;

    const blocks = buildBlocks(tbody);
    const pages  = buildPages(blocks);

    if (!table._nxPg) {
      const { pager, prev, next, info } = makePager(table);
      table._nxPg = { page: 0, pages, pager, prev, next, info, rowCount: tbody.rows.length, eligibleCount: countEligible(tbody) };
    } else {
      table._nxPg.pages = pages;
      table._nxPg.rowCount = tbody.rows.length;
      table._nxPg.eligibleCount = countEligible(tbody);
    }
    showPage(table);
  }

  // ── scanning ──────────────────────────────────────────────────────────────

  function scan() {
    // Drop pagers whose table was re-rendered away
    document.querySelectorAll('.nx-pager').forEach(p => {
      if (!p._nxTable || !p._nxTable.isConnected) p.remove();
    });

    document.querySelectorAll('table').forEach(table => {
      if (table.classList.contains('dataTable')) return;   // DataTables paginates itself
      if (table.hasAttribute('data-no-paginate')) return;
      const tbody = table.tBodies[0];
      if (!tbody) return;

      if (table._nxPg) {
        const eligibleNow = countEligible(tbody);
        if (!table._nxPg.pager.isConnected && tbody.rows.length > PAGE_SIZE) {
          delete table._nxPg;                               // table node reused after re-render
          paginate(table);
        } else if (tbody.rows.length !== table._nxPg.rowCount
                   || eligibleNow !== table._nxPg.eligibleCount
                   || !table._nxPg.pages[0]?.[0]?.[0]?.isConnected) {
          table._nxPg.page = 0;                             // content or filter changed — restart at page 1
          paginate(table);
        }
        return;
      }
      if (tbody.rows.length > PAGE_SIZE) paginate(table);
    });
  }

  let pending = null;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; scan(); }, 120);
  });

  function start() {
    observer.observe(document.body, {
      childList: true, subtree: true,
      // Needed to notice app-level filter code toggling tr.style.display —
      // that's an attribute change, not a childList change, so without this
      // a filter running after the table is already paginated would never
      // trigger a re-page (see the file-level comment above).
      attributes: true, attributeFilter: ['style'],
    });
    scan();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
