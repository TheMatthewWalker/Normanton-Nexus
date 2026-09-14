// Drumming Data — filterable historical record listing. Port of
// runDrummingData in production-nexus.js. Same row-detail-expand
// simplification (SAP postings + scrap entries + print/send-to-printer)
// as metre-data.js's own row-click detail, reusing the identical shared
// endpoints (reversal/by-batch, scrap/entries, labels) with processCode="DR".
(function () {
  const resultsEl = document.getElementById("dd-results");
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

  document.getElementById("dd-search").addEventListener("click", async () => {
    const material = document.getElementById("dd-material").value.trim();
    const customerId = document.getElementById("dd-customer").value.trim();
    const salesOrderSap = document.getElementById("dd-order").value.trim();
    const from = document.getElementById("dd-from").value;
    const to = document.getElementById("dd-to").value;

    const params = new URLSearchParams();
    if (material) params.set("material", material);
    if (customerId) params.set("customerId", customerId);
    if (salesOrderSap) params.set("salesOrderSap", salesOrderSap);
    if (from) params.set("dateFrom", from);
    if (to) params.set("dateTo", to);

    resultsEl.innerHTML = `<div class="nx-empty">Loading…</div>`;
    try {
      const { data } = await api(`/drumming/data?${params}`);
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
    exportBtn.addEventListener("click", () => downloadCsv(lastRows, "drumming-data.csv"));
    resultsEl.appendChild(exportBtn);

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Ref", "Material", "Length (M)", "Packaging", "Sales Order", "Customer", "Shift", "Status", "Started", "Completed", "Created By"]) {
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
      row.drumRef,
      row.material,
      Number(row.lengthMetres).toFixed(3),
      row.packagingType || "—",
      row.salesOrderSap || "—",
      row.customerId || "—",
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
    tr.addEventListener("click", () => toggleDetail(row.drummingId));
    return tr;
  }

  function buildDetailRow(row) {
    const tr = document.createElement("tr");
    tr.id = `dd-detail-${row.drummingId}`;
    tr.hidden = true;
    const td = document.createElement("td");
    td.colSpan = 11;
    tr.appendChild(td);
    return tr;
  }

  async function toggleDetail(drummingId) {
    const tr = document.getElementById(`dd-detail-${drummingId}`);
    if (!tr) return;
    tr.hidden = !tr.hidden;
    if (tr.hidden || tr.dataset.loaded) return;
    tr.dataset.loaded = "1";

    const td = tr.firstElementChild;
    td.textContent = "Loading…";
    try {
      const [postingsRes, scrapRes] = await Promise.all([
        api(`/reversal/by-batch/DR/${drummingId}`),
        api(`/scrap/entries?processCode=DR&processRecordId=${drummingId}`),
      ]);
      td.innerHTML = "";

      const printLink = document.createElement("a");
      printLink.href = `/api/labels/process/DR/${drummingId}`;
      printLink.target = "_blank";
      printLink.rel = "noopener";
      printLink.textContent = "🖨 Print Label";
      printLink.style.cssText = "display:inline-block;margin-bottom:0.5rem;margin-right:0.75rem;";
      td.appendChild(printLink);

      td.appendChild(buildSendToPrinterControl(drummingId));

      td.appendChild(buildSubTable("SAP Postings", postingsRes.data, ["postingType", "materialDocumentSap", "quantity", "unitOfMeasure", "isReversed"]));
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
            const res = await labelsApi(`/process/DR/${recordId}/print`, {
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
