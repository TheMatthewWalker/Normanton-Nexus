// Shared client-side table pagination — introduced because no page in this
// app pages long tables at all (every table is a hand-rolled template-literal
// innerHTML render — see api-helpers.js's own comment on why there's no
// shared rendering framework here). This is deliberately NOT a table
// component: it doesn't render rows itself, since every page's row markup is
// too different to generalize usefully. It only handles the two genuinely
// repeated concerns — slicing a row array into pages, and rendering the
// pager control — so a page keeps its own row-rendering function and just
// wraps it with this.
//
// Usage (see any page adopting this for the concrete pattern):
//   const pager = NexusTable.paginate({
//     container: document.getElementById('my-table-body'),
//     pagerContainer: document.getElementById('my-pager'),
//     pageSize: 25,
//     renderRows: (pageRows) => pageRows.map(r => `<tr>...</tr>`).join(''),
//   });
//   pager.setRows(allRows); // call this whenever the underlying data changes
window.NexusTable = {
  paginate({ container, pagerContainer, renderRows, pageSize = 25 }) {
    let rows = [];
    let page = 1;

    function totalPages() {
      return Math.max(1, Math.ceil(rows.length / pageSize));
    }

    function renderPager() {
      const pages = totalPages();
      if (pages <= 1) {
        pagerContainer.innerHTML = '';
        pagerContainer.classList.add('hidden');
        return;
      }
      pagerContainer.classList.remove('hidden');

      const from = rows.length === 0 ? 0 : (page - 1) * pageSize + 1;
      const to = Math.min(page * pageSize, rows.length);

      pagerContainer.innerHTML = `
        <span class="nx-pager-summary">${from}–${to} of ${rows.length}</span>
        <div class="nx-pager-controls">
          <button type="button" class="nx-pager-btn" data-page="prev" ${page <= 1 ? 'disabled' : ''}>&larr; Prev</button>
          <span class="nx-pager-current">Page ${page} of ${pages}</span>
          <button type="button" class="nx-pager-btn" data-page="next" ${page >= pages ? 'disabled' : ''}>Next &rarr;</button>
        </div>`;

      pagerContainer.querySelector('[data-page="prev"]').addEventListener('click', () => goTo(page - 1));
      pagerContainer.querySelector('[data-page="next"]').addEventListener('click', () => goTo(page + 1));
    }

    function renderPage() {
      const start = (page - 1) * pageSize;
      const pageRows = rows.slice(start, start + pageSize);
      container.innerHTML = renderRows(pageRows);
      renderPager();
    }

    function goTo(newPage) {
      page = Math.min(Math.max(1, newPage), totalPages());
      renderPage();
    }

    return {
      // Call whenever the underlying row array changes (a fresh fetch, a filter change).
      // Resets to page 1 so a filter change never leaves the view on a now-invalid page.
      setRows(newRows) {
        rows = newRows || [];
        page = 1;
        renderPage();
      },
      goTo,
      get currentPage() { return page; },
    };
  },
};
