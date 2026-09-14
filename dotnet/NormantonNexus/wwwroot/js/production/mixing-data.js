// Mixing Data — filterable historical record listing. Port of
// runMixingData in production-nexus.js. Node's own row-click detail shows
// a per-tub breakdown via GET /mixing/:id/tubs, a route this migration
// never ported anywhere; rather than add a new route just for this
// drilldown, the row-detail expand reuses the same generic SAP-postings +
// scrap-entries view metre-data.js/drumming-data.js already establish
// (processCode="MX", recordId=MixingID) — a real, documented simplification
// (per-tub weight/material-document detail isn't shown), not a functional
// loss for the record-level search this tile is actually for.
(function () {
  const resultsEl = document.getElementById("mxd-results");
  const { api, downloadCsv } = window.ProductionReports;

  async function labelsApi(path, opts) {
    const r = await fetch("/api/labels" + path, opts);
    let json = null;
    try {
      json = await r.json();
    } catch {
      /* non-JSON body */
    }
    if (json?.success === false || !r.ok) {
      throw new Error(json?.error?.message || `Request failed (HTTP ${r.status})`);
    }
    return json;
  }

  function fmtDate(dt) {
    return dt ? new Date(dt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  }

  let lastRows = [];

  document.getElementById("mxd-search").addEventListener("click", async () => {
    const material = document.getElementById("mxd-material").value.trim();
    const supplierBatchNo = document.getElementById("mxd-sbn").value.trim();
    const from = document.getElementById("mxd-from").value;
    const to = document.getElementById("mxd-to").value;

    const params = new URLSearchParams();
    if (material) params.set("material", material);
    if (supplierBatchNo) params.set("supplierBatchNo", supplierBatchNo);
    if (from) params.set("dateFrom", from);
    if (to) params.set("dateTo", to);

    resultsEl.innerHTML = `<div class="nx-empty">Loading…</div>`;
    try {
      const { data } = await api(`/mixing/data?${params}`);
      lastRows = data;
      if (!data.length) { resultsEl.innerHTML = `<div class="nx-empty">No records match the selected filters.</div>`; return; }
      renderResults();
    } catch (err) {
      resultsEl.innerHTML = `<div class="nx-empty">Error: ${NexusApi.esc(err.message)}</div>`;
    }
  });

  function renderResults() {
    resultsEl.innerHTML = "";

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "secondary";
    exportBtn.textContent = "Export CSV";
    exportBtn.style.marginBottom = "0.5rem";
    exportBtn.addEventListener("click", () => downloadCsv(lastRows, "mixing-data.csv"));
    resultsEl.appendChild(exportBtn);

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Ref", "Material", "Mix Code", "Weight (KG)", "Supplier Batch", "Supplier Tub", "Shift", "Status", "Started", "Completed", "Created By"]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    table.append(thead, tbody);
    resultsEl.appendChild(table);

    const pagerEl = document.createElement("div");
    pagerEl.className = "nx-pager";
    resultsEl.appendChild(pagerEl);

    NexusTable.paginate({
      container: tbody,
      pagerContainer: pagerEl,
      pageSize: 25,
      renderRows: (pageRows, tbodyEl) => {
        tbodyEl.innerHTML = "";
        for (const row of pageRows) tbodyEl.append(buildRow(row), buildDetailRow(row));
      },
    }).setRows(lastRows);
  }

  function buildRow(row) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";

    const cells = [
      row.mixRef,
      row.material,
      row.mixCode,
      Number(row.totalWeightKg).toFixed(3),
      row.supplierBatchNo || "—",
      row.supplierTubNo || "—",
      row.shiftName || "—",
      row.isReversed ? "Reversed" : (row.statusName || row.status),
      fmtDate(row.startedAt),
      fmtDate(row.completedAt),
      row.createdBy || "—",
    ];
    for (const val of cells) {
      const td = document.createElement("td");
      td.textContent = val;
      tr.appendChild(td);
    }
    tr.addEventListener("click", () => toggleDetail(row.mixingId));
    return tr;
  }

  function buildDetailRow(row) {
    const tr = document.createElement("tr");
    tr.id = `mxd-detail-${row.mixingId}`;
    tr.hidden = true;
    const td = document.createElement("td");
    td.colSpan = 11;
    tr.appendChild(td);
    return tr;
  }

  async function toggleDetail(mixingId) {
    const tr = document.getElementById(`mxd-detail-${mixingId}`);
    if (!tr) return;
    tr.hidden = !tr.hidden;
    if (tr.hidden || tr.dataset.loaded) return;
    tr.dataset.loaded = "1";

    const td = tr.firstElementChild;
    td.textContent = "Loading…";
    try {
      const [postingsRes, scrapRes] = await Promise.all([
        api(`/reversal/by-batch/MX/${mixingId}`),
        api(`/scrap/entries?processCode=MX&processRecordId=${mixingId}`),
      ]);
      td.innerHTML = "";

      const printLink = document.createElement("a");
      printLink.href = `/api/labels/process/MX/${mixingId}`;
      printLink.target = "_blank";
      printLink.rel = "noopener";
      printLink.textContent = "🖨 Print Label(s)";
      printLink.style.cssText = "display:inline-block;margin-bottom:0.5rem;margin-right:0.75rem;";
      td.appendChild(printLink);

      td.appendChild(buildSendToPrinterControl(mixingId));

      td.appendChild(buildSubTable("SAP Postings (per tub)", postingsRes.data, ["postingType", "materialDocumentSap", "quantity", "unitOfMeasure", "isReversed"]));
      td.appendChild(buildSubTable("Scrap Entries", scrapRes.data, ["reasonDescription", "quantity", "unitOfMeasure", "isApproved", "sapPosted"]));
    } catch (err) {
      td.textContent = err.message;
    }
  }

  function buildSendToPrinterControl(recordId) {
    const wrap = document.createElement("span");
    wrap.style.display = "inline-block";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary";
    btn.textContent = "🖨 Send to Printer…";
    wrap.appendChild(btn);

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const { data } = await labelsApi("/printers");
        if (!data.printers.length) {
          alert("No printers configured. Add a \"Printers\" array under LabelPrinters in appsettings.json.");
          return;
        }

        const select = document.createElement("select");
        for (const p of data.printers) {
          const opt = document.createElement("option");
          opt.value = p.id;
          opt.textContent = p.name;
          if (p.id === data.userDefault) opt.selected = true;
          select.appendChild(opt);
        }
        const sendBtn = document.createElement("button");
        sendBtn.type = "button";
        sendBtn.textContent = "Send";
        const msg = document.createElement("span");
        msg.style.marginLeft = "0.5rem";

        wrap.innerHTML = "";
        wrap.append(select, sendBtn, msg);

        sendBtn.addEventListener("click", async () => {
          sendBtn.disabled = true;
          msg.style.color = "#6b7280";
          msg.textContent = "Sending…";
          try {
            const res = await labelsApi(`/process/MX/${recordId}/print`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ printerId: select.value }),
            });
            msg.style.color = "#059669";
            msg.textContent = `✓ ${res.data.message}`;
          } catch (err) {
            msg.style.color = "#b91c1c";
            msg.textContent = err.message;
          } finally {
            sendBtn.disabled = false;
          }
        });
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
      }
    });

    return wrap;
  }

  function buildSubTable(title, rows, columns) {
    const wrap = document.createElement("div");
    wrap.style.marginBottom = "0.5rem";
    const heading = document.createElement("strong");
    heading.textContent = title;
    wrap.appendChild(heading);

    if (!rows || !rows.length) {
      const empty = document.createElement("p");
      empty.style.color = "#6b7280";
      empty.textContent = "None.";
      wrap.appendChild(empty);
      return wrap;
    }

    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const col of columns) {
        const td = document.createElement("td");
        td.textContent = String(row[col] ?? "—");
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }
})();
