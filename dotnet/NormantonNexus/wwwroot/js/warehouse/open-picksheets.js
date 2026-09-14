// Open Picksheets tile — port of runOpenPicksheets()/renderPicksheets()
// (priority/date-bucketed sections) from private/js/warehouse.js. Row click
// opens the shared Picked Pallets modal (picked-pallets-modal.js) — see
// that file's own header for what it covers (the delivery-picker restore
// this pass was specifically about, pallet summary list, Complete Delivery)
// and what's deliberately still deferred (the full Pallet Builder wizard).
(function () {
  const esc = NexusApi.esc;
  const api = NexusApi.make("/api/deliverymain");
  const bodyEl = document.getElementById("op-body");

  async function load() {
    bodyEl.innerHTML = `<div class="sap-loading"><div class="spinner"></div>Loading open deliveries…</div>`;
    try {
      const { data } = await api("/open-picksheets");
      render(data || []);
    } catch (err) {
      bodyEl.innerHTML = `<div class="sap-error">✕ ${esc(err.message)}</div>`;
    }
  }

  const BUCKETS = [
    { key: "priority", label: "Priority", dot: "priority" },
    { key: "backlog", label: "Backlog", dot: "backlog" },
    { key: "today", label: "Today", dot: "today" },
    { key: "this-week", label: "This Week", dot: "week" },
    { key: "this-month", label: "This Month", dot: "month" },
    { key: "other", label: "Everything Else", dot: "other" },
  ];

  function getDateBucket(dueDate) {
    if (!dueDate) return "other";
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const due = new Date(dueDate);
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());

    if (dueDay < today) return "backlog";
    if (dueDay.getTime() === today.getTime()) return "today";

    const dow = today.getDay() || 7;
    const monday = new Date(today); monday.setDate(today.getDate() - dow + 1);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);

    if (dueDay <= sunday) return "this-week";
    if (due.getFullYear() === now.getFullYear() && due.getMonth() === now.getMonth()) return "this-month";
    return "other";
  }

  function render(rows) {
    if (!rows.length) {
      bodyEl.innerHTML = `<div class="sap-error">No open picksheets found.</div>`;
      return;
    }

    const bucketMap = {};
    BUCKETS.forEach((b) => { bucketMap[b.key] = []; });
    rows.forEach((r) => {
      const key = r.deliveryPriority === 1 ? "priority" : getDateBucket(r.dispatchDate);
      bucketMap[key].push(r);
    });

    const html = BUCKETS.filter((b) => bucketMap[b.key].length > 0).map((b, i) => {
      const collapsed = i < 4 ? "" : " ps-section--collapsed";
      const thead = `<tr><th>Delivery ID</th><th>Destination</th><th>Due Date</th><th>Service</th><th>Comment</th></tr>`;
      const tbody = bucketMap[b.key].map((r) => {
        const due = r.dispatchDate ? new Date(r.dispatchDate).toLocaleDateString("en-GB") : "—";
        const flag = b.key === "priority" ? '<span class="ps-priority-flag"></span>' : "";
        return `<tr class="ps-row" data-id="${esc(String(r.deliveryId))}" data-dest="${esc(r.destinationName ?? "")}">
          <td>${flag}${esc(String(r.deliveryId))}</td>
          <td>${esc(r.destinationName ?? "—")}</td>
          <td>${esc(due)}</td>
          <td>${esc(r.deliveryService ?? "")}</td>
          <td>${esc(r.picksheetComment ?? "")}</td>
        </tr>`;
      }).join("");
      return `<div class="ps-section${collapsed}">
        <div class="ps-section-header">
          <span class="ps-section-dot ps-section-dot--${b.dot}"></span>
          <span class="ps-section-title">${b.label}</span>
          <span class="ps-section-count">${bucketMap[b.key].length}</span>
          <span class="ps-chevron">▼</span>
        </div>
        <div class="ps-section-body">
          <table class="ps-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
        </div>
      </div>`;
    }).join("");

    bodyEl.innerHTML = `<div class="ps-sections">${html}</div>`;

    bodyEl.querySelectorAll(".ps-section-header").forEach((h) => {
      h.addEventListener("click", () => h.closest(".ps-section").classList.toggle("ps-section--collapsed"));
    });
    bodyEl.querySelectorAll(".ps-row").forEach((tr) => {
      tr.addEventListener("click", () => PickedPalletsModal.show(tr.dataset.id, tr.dataset.dest, false, load));
    });
  }

  document.getElementById("op-refresh").addEventListener("click", load);
  load();
})();
