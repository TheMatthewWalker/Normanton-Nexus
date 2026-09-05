// Stock Adjustments tile — Finance's approval console over the shared
// Stock Count feature. Port of private/js/finance.js's
// runStockAdjustments()/scfRenderPendingCounts()/scfRenderCountDetail()/
// scfApprove()/scfReject()/scfRenderHistoryReport(). Field names here match
// this app's own camelCase API responses (StockCountDocumentRow/
// CountReportRow/FinanceReportResult), not Node's original mixed
// PascalCase-from-SQL/camelCase-from-SAP casing.
(function () {
  const bodyEl = document.getElementById("scf-body");

  async function api(path, opts) {
    const r = await fetch("/api/stockcount" + path, opts);
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

  function scfMoney(value) {
    const n = Number(value) || 0;
    const sign = n >= 0 ? "+" : "";
    return `${sign}£${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }

  function scfColor(value) {
    return Number(value) >= 0 ? "#059669" : "#dc2626";
  }

  function scfFormatDate(value) {
    return value ? new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  }

  // ── Pending Approval list ────────────────────────────────────────────
  async function renderPendingCounts() {
    bodyEl.textContent = "Loading…";
    try {
      const { data: counts } = await api("/counts?status=PendingApproval");

      if (counts.length === 0) {
        bodyEl.textContent = "No stock counts are currently pending approval.";
        return;
      }

      const reports = await Promise.all(
        counts.map((c) =>
          api(`/counts/${c.countId}/report`)
            .then((r) => r.data)
            .catch(() => [])
        )
      );

      let totalGain = 0;
      let totalLoss = 0;
      for (const rows of reports) {
        for (const r of rows) {
          const v = Number(r.varianceValue) || 0;
          if (v > 0) totalGain += v;
          else totalLoss += Math.abs(v);
        }
      }

      bodyEl.innerHTML = "";

      const summary = document.createElement("p");
      const gainSpan = document.createElement("span");
      gainSpan.style.color = "#059669";
      gainSpan.style.fontWeight = "700";
      gainSpan.textContent = `Total Gains: +£${totalGain.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
      const lossSpan = document.createElement("span");
      lossSpan.style.color = "#dc2626";
      lossSpan.style.fontWeight = "700";
      lossSpan.style.marginLeft = "1rem";
      lossSpan.textContent = `Total Losses: -£${totalLoss.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
      const countSpan = document.createElement("span");
      countSpan.style.marginLeft = "1rem";
      countSpan.textContent = `Pending Counts: ${counts.length}`;
      summary.append(gainSpan, lossSpan, countSpan);
      bodyEl.appendChild(summary);

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of ["Count", "Type", "Location", "Submitted By", "Net Value"]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = document.createElement("tbody");

      counts.forEach((c, i) => {
        const netValue = (reports[i] || []).reduce((sum, r) => sum + (Number(r.varianceValue) || 0), 0);
        const location = c.storageLocation || (c.weekStartDate ? `PTFE (week of ${new Date(c.weekStartDate).toLocaleDateString("en-GB")})` : "—");

        const tr = document.createElement("tr");
        tr.style.cursor = "pointer";
        const idTd = document.createElement("td");
        idTd.textContent = `#${c.countId}`;
        const typeTd = document.createElement("td");
        typeTd.textContent = c.countType.replace("_", " ");
        const locationTd = document.createElement("td");
        locationTd.textContent = location;
        const submittedTd = document.createElement("td");
        submittedTd.textContent = c.submittedBy || "—";
        const netTd = document.createElement("td");
        netTd.style.color = scfColor(netValue);
        netTd.style.fontWeight = "700";
        netTd.textContent = scfMoney(netValue);
        tr.append(idTd, typeTd, locationTd, submittedTd, netTd);
        tr.addEventListener("click", () => renderCountDetail(c.countId));
        tbody.appendChild(tr);
      });
      table.append(thead, tbody);
      bodyEl.appendChild(table);

      const detailEl = document.createElement("div");
      detailEl.id = "scf-detail";
      bodyEl.appendChild(detailEl);
    } catch (err) {
      bodyEl.textContent = err.message;
    }
  }

  // ── Count detail — grouped-by-material report + Approve/Reject ──────
  async function renderCountDetail(countId) {
    const container = document.getElementById("scf-detail");
    if (!container) return;
    container.textContent = "Loading…";
    try {
      const { data: report } = await api(`/counts/${countId}/report`);

      container.innerHTML = "";
      const heading = document.createElement("h3");
      heading.textContent = `Count #${countId} — Grouped by Material`;
      container.appendChild(heading);

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of ["Material", "Counted", "SAP Qty", "Value"]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = document.createElement("tbody");
      if (report.length === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 4;
        td.textContent = "No variance lines on this count.";
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        for (const r of report) {
          const tr = document.createElement("tr");
          const matTd = document.createElement("td");
          matTd.textContent = r.material;
          if (r.materialText) {
            const sub = document.createElement("div");
            sub.style.fontSize = "0.75rem";
            sub.style.color = "#6b7280";
            sub.textContent = r.materialText;
            matTd.appendChild(sub);
          }
          const countedTd = document.createElement("td");
          countedTd.textContent = `${Number(r.countedQty).toLocaleString()} ${r.uom || ""}`;
          const sapTd = document.createElement("td");
          sapTd.textContent = r.sapQty != null ? Number(r.sapQty).toLocaleString() : "—";
          const valueTd = document.createElement("td");
          valueTd.style.color = scfColor(r.varianceValue);
          valueTd.style.fontWeight = "700";
          valueTd.textContent = scfMoney(r.varianceValue);
          tr.append(matTd, countedTd, sapTd, valueTd);
          tbody.appendChild(tr);
        }
      }
      table.append(thead, tbody);
      container.appendChild(table);

      const approveBtn = document.createElement("button");
      approveBtn.type = "button";
      approveBtn.textContent = "Approve";
      approveBtn.addEventListener("click", () => approve(countId));
      const rejectBtn = document.createElement("button");
      rejectBtn.type = "button";
      rejectBtn.className = "secondary";
      rejectBtn.style.marginLeft = "0.5rem";
      rejectBtn.textContent = "Reject";
      rejectBtn.addEventListener("click", () => reject(countId));
      const actionResult = document.createElement("div");
      actionResult.id = "scf-action-result";
      actionResult.style.marginTop = "0.5rem";

      container.append(approveBtn, rejectBtn, actionResult);
    } catch (err) {
      container.textContent = err.message;
    }
  }

  async function approve(countId) {
    if (!confirm("Approve this count? This posts the resulting 711/712 SAP goods movements immediately.")) return;
    const resultEl = document.getElementById("scf-action-result");
    try {
      const { data } = await api(`/counts/${countId}/approve`, { method: "POST" });
      const { allSucceeded, results, postedLineCount } = data;
      if (allSucceeded) {
        alert(`Approved — ${postedLineCount} adjustment${postedLineCount === 1 ? "" : "s"} posted to SAP.`);
        await renderPendingCounts();
      } else {
        const failed = results.filter((r) => !r.success);
        if (resultEl) {
          resultEl.textContent = "";
          resultEl.style.color = "#b91c1c";
          resultEl.textContent = `Approved, but ${failed.length} of ${results.length} SAP postings failed: ${failed.map((f) => `${f.material} (${f.error})`).join("; ")}. The count remains Approved (not fully Posted) — check with IT/SAP support before retrying.`;
        }
      }
    } catch (err) {
      if (resultEl) {
        resultEl.style.color = "#b91c1c";
        resultEl.textContent = err.message;
      }
    }
  }

  async function reject(countId) {
    const reason = prompt("Reason for rejecting this count (sent to the warehouse supervisors):");
    if (!reason || !reason.trim()) return;
    const resultEl = document.getElementById("scf-action-result");
    try {
      await api(`/counts/${countId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      await renderPendingCounts();
    } catch (err) {
      if (resultEl) {
        resultEl.style.color = "#b91c1c";
        resultEl.textContent = err.message;
      }
    }
  }

  // ── Gains/Losses history report ──────────────────────────────────────
  async function renderHistoryReport() {
    bodyEl.textContent = "Loading…";
    try {
      const { data } = await api("/reports/finance");
      renderHistoryReportView(data);
    } catch (err) {
      bodyEl.textContent = err.message;
    }
  }

  function renderHistoryReportView(data) {
    const { totalGains, totalLosses, net, byMaterial, byBin, counts } = data;

    bodyEl.innerHTML = "";

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "secondary";
    backBtn.textContent = "← Back to Pending Approval";
    backBtn.addEventListener("click", renderPendingCounts);
    bodyEl.appendChild(backBtn);

    const summary = document.createElement("p");
    const gainSpan = document.createElement("span");
    gainSpan.style.color = "#059669";
    gainSpan.style.fontWeight = "700";
    gainSpan.textContent = `Total Gains: ${scfMoney(totalGains)}`;
    const lossSpan = document.createElement("span");
    lossSpan.style.color = "#dc2626";
    lossSpan.style.fontWeight = "700";
    lossSpan.style.marginLeft = "1rem";
    lossSpan.textContent = `Total Losses: ${scfMoney(totalLosses)}`;
    const netSpan = document.createElement("span");
    netSpan.style.color = scfColor(net);
    netSpan.style.fontWeight = "700";
    netSpan.style.marginLeft = "1rem";
    netSpan.textContent = `Net: ${scfMoney(net)}`;
    summary.append(gainSpan, lossSpan, netSpan);
    bodyEl.appendChild(summary);

    function offenderTable(title, rows, keyLabel) {
      const heading = document.createElement("h3");
      heading.textContent = title;
      bodyEl.appendChild(heading);

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of [keyLabel, "Net Value"]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = document.createElement("tbody");
      if (rows.length === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 2;
        td.textContent = "No data yet.";
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        for (const r of rows.slice(0, 20)) {
          const tr = document.createElement("tr");
          const keyTd = document.createElement("td");
          keyTd.textContent = r.key;
          const valTd = document.createElement("td");
          valTd.style.color = scfColor(r.netValue);
          valTd.style.fontWeight = "700";
          valTd.textContent = scfMoney(r.netValue);
          tr.append(keyTd, valTd);
          tbody.appendChild(tr);
        }
      }
      table.append(thead, tbody);
      bodyEl.appendChild(table);
    }

    offenderTable("Worst Offenders — Material", byMaterial, "Material");
    offenderTable("Worst Offenders — Bin", byBin, "Bin");

    const historyHeading = document.createElement("h3");
    historyHeading.textContent = "Count History";
    bodyEl.appendChild(historyHeading);

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Count", "Type", "Location", "Status", "Decided", "Net Value"]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    if (counts.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.textContent = "No completed counts yet.";
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const c of counts) {
        const tr = document.createElement("tr");
        const idTd = document.createElement("td");
        idTd.textContent = `#${c.countId}`;
        const typeTd = document.createElement("td");
        typeTd.textContent = c.countType.replace("_", " ");
        const locTd = document.createElement("td");
        locTd.textContent = c.storageLocation || "—";
        const statusTd = document.createElement("td");
        statusTd.textContent = c.status;
        const decidedTd = document.createElement("td");
        decidedTd.textContent = scfFormatDate(c.decidedAtUtc);
        const netTd = document.createElement("td");
        netTd.style.color = scfColor(c.netValue);
        netTd.style.fontWeight = "700";
        netTd.textContent = scfMoney(c.netValue);
        tr.append(idTd, typeTd, locTd, statusTd, decidedTd, netTd);
        tbody.appendChild(tr);
      }
    }
    table.append(thead, tbody);
    bodyEl.appendChild(table);
  }

  document.getElementById("scf-reports-btn").addEventListener("click", renderHistoryReport);

  renderPendingCounts();
})();
