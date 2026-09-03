// The shared metre-process (EX/CO/BR/CL/TW) Data tile — filterable
// historical record listing. Port of runMeterProcessData in
// production-nexus.js. The row-click detail modal in Node (SAP postings +
// scrap entries + reprint-label button) is simplified here to an inline
// expand — no shared modal component exists (same precedent as
// posted-scrap.js's drilldown) — but both halves of Node's reprint button
// are real: "Print Label" opens the browser-preview page in a new tab,
// and "Send to Printer…" picks a configured network printer and posts to
// LabelsController's server-side PDF/raw-TCP print route.
(function () {
  const container = document.querySelector("[data-process-code]");
  const processCode = container.dataset.processCode;
  const resultsEl = document.getElementById("mpd-results");

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

  document.getElementById("mpd-search").addEventListener("click", async () => {
    const material = document.getElementById("mpd-material").value.trim();
    const from = document.getElementById("mpd-from").value;
    const to = document.getElementById("mpd-to").value;

    const params = new URLSearchParams();
    if (material) params.set("material", material);
    if (from) params.set("dateFrom", from);
    if (to) params.set("dateTo", to);

    resultsEl.textContent = "Loading…";
    try {
      const { data } = await api(`/process/${processCode}/data?${params}`);
      lastRows = data;
      if (!data.length) { resultsEl.textContent = "No records match the selected filters."; return; }
      renderResults();
    } catch (err) {
      resultsEl.textContent = err.message;
    }
  });

  function renderResults() {
    resultsEl.innerHTML = "";

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "secondary";
    exportBtn.textContent = "Export CSV";
    exportBtn.style.marginBottom = "0.5rem";
    exportBtn.addEventListener("click", () => downloadCsv(lastRows, `${processCode.toLowerCase()}-data.csv`));
    resultsEl.appendChild(exportBtn);

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Ref", "Material", "Length (M)", "Machine", "Shift", "Status", "Started", "Completed", "Created By"]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    for (const row of lastRows) {
      tbody.append(buildRow(row), buildDetailRow(row));
    }
    table.append(thead, tbody);
    resultsEl.appendChild(table);
  }

  function buildRow(row) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";

    const refTd = document.createElement("td");
    refTd.textContent = row.batchRef;
    const matTd = document.createElement("td");
    matTd.textContent = row.material;
    const lenTd = document.createElement("td");
    lenTd.style.textAlign = "right";
    lenTd.textContent = Number(row.lengthMetres).toFixed(3);
    const machineTd = document.createElement("td");
    machineTd.textContent = row.machineName || row.machineCode || "—";
    const shiftTd = document.createElement("td");
    shiftTd.textContent = row.shiftName || "—";
    const statusTd = document.createElement("td");
    statusTd.textContent = row.isReversed ? "Reversed" : (row.statusName || row.status);
    const startedTd = document.createElement("td");
    startedTd.textContent = fmtDate(row.startedAt);
    const completedTd = document.createElement("td");
    completedTd.textContent = fmtDate(row.completedAt);
    const byTd = document.createElement("td");
    byTd.textContent = row.createdBy || "—";

    tr.append(refTd, matTd, lenTd, machineTd, shiftTd, statusTd, startedTd, completedTd, byTd);
    tr.addEventListener("click", () => toggleDetail(row.recordId));
    return tr;
  }

  function buildDetailRow(row) {
    const tr = document.createElement("tr");
    tr.id = `mpd-detail-${row.recordId}`;
    tr.hidden = true;
    const td = document.createElement("td");
    td.colSpan = 9;
    tr.appendChild(td);
    return tr;
  }

  async function toggleDetail(recordId) {
    const tr = document.getElementById(`mpd-detail-${recordId}`);
    if (!tr) return;
    tr.hidden = !tr.hidden;
    if (tr.hidden || tr.dataset.loaded) return;
    tr.dataset.loaded = "1";

    const td = tr.firstElementChild;
    td.textContent = "Loading…";
    try {
      const [postingsRes, scrapRes] = await Promise.all([
        api(`/reversal/by-batch/${encodeURIComponent(processCode)}/${recordId}`),
        api(`/scrap/entries?processCode=${encodeURIComponent(processCode)}&processRecordId=${recordId}`),
      ]);
      td.innerHTML = "";

      const printLink = document.createElement("a");
      printLink.href = `/api/labels/process/${encodeURIComponent(processCode)}/${recordId}`;
      printLink.target = "_blank";
      printLink.rel = "noopener";
      printLink.textContent = "🖨 Print Label";
      printLink.style.cssText = "display:inline-block;margin-bottom:0.5rem;margin-right:0.75rem;";
      td.appendChild(printLink);

      td.appendChild(buildSendToPrinterControl(recordId));

      td.appendChild(buildSubTable("SAP Postings", postingsRes.data, ["postingType", "materialDocumentSap", "quantity", "unitOfMeasure", "isReversed"]));
      td.appendChild(buildSubTable("Scrap Entries", scrapRes.data, ["reasonDescription", "quantity", "unitOfMeasure", "isApproved", "sapPosted"]));
    } catch (err) {
      td.textContent = err.message;
    }
  }

  // Server-side print to a configured network printer — port of the
  // printer-select + POST .../print half of Node's reprint button. Lazily
  // loads the printer list on first use (most records are only ever
  // previewed, not sent to a physical printer, so no need to fetch it
  // unconditionally for every row).
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
            const res = await labelsApi(`/process/${encodeURIComponent(processCode)}/${recordId}/print`, {
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
