// GL Account Groups tile — pure CRUD over /api/finance/gl-groups. Node's
// original (private/js/finance.js's showGlGroupConfig()/openGlGroupModal())
// used a floating modal with chip-style account tags; simplified here to an
// in-page form (same pattern as Sales's Customer Standard Instructions
// page) with accounts entered one-per-line rather than dynamic add/remove
// input rows — same behavior, less markup. Every dynamic value is built
// via textContent/DOM APIs, never innerHTML.
(function () {
  const listEl = document.getElementById("gg-list");
  const msgEl = document.getElementById("gg-msg");

  const formEl = document.getElementById("gg-form");
  const formTitleEl = document.getElementById("gg-form-title");
  const labelInput = document.getElementById("gg-label");
  const accountsInput = document.getElementById("gg-accounts");
  const formMsgEl = document.getElementById("gg-form-msg");

  let groups = [];
  let editingId = null;

  async function api(path, opts) {
    const r = await fetch("/api/finance" + path, opts);
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

  async function load() {
    msgEl.textContent = "";
    listEl.textContent = "Loading…";
    try {
      const { data } = await api("/gl-groups");
      groups = data;
      renderList();
    } catch (err) {
      listEl.textContent = "";
      msgEl.textContent = err.message;
    }
  }

  function renderList() {
    listEl.innerHTML = "";
    if (groups.length === 0) {
      listEl.textContent = "No GL account groups defined yet.";
      return;
    }

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Label", "Accounts", "Actions"]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const tbody = document.createElement("tbody");
    for (const g of groups) {
      const tr = document.createElement("tr");
      const labelTd = document.createElement("td");
      labelTd.textContent = g.label;
      const accountsTd = document.createElement("td");
      accountsTd.textContent = g.accounts.join(", ");

      const actionsTd = document.createElement("td");
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "secondary";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => openForm(g));
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "secondary";
      delBtn.style.marginLeft = "0.4rem";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteGroup(g));
      actionsTd.append(editBtn, delBtn);

      tr.append(labelTd, accountsTd, actionsTd);
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    listEl.appendChild(table);
  }

  async function deleteGroup(group) {
    if (!confirm(`Delete GL group "${group.label}"?`)) return;
    try {
      await api(`/gl-groups/${group.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      msgEl.textContent = err.message;
    }
  }

  function openForm(existing) {
    editingId = existing ? existing.id : null;
    formTitleEl.textContent = existing ? "Edit Group" : "Add Group";
    labelInput.value = existing ? existing.label : "";
    accountsInput.value = existing ? existing.accounts.join("\n") : "";
    formMsgEl.textContent = "";
    formEl.style.display = "";
  }

  document.getElementById("gg-add-btn").addEventListener("click", () => openForm(null));
  document.getElementById("gg-cancel-btn").addEventListener("click", () => {
    formEl.style.display = "none";
  });

  document.getElementById("gg-save-btn").addEventListener("click", async () => {
    const label = labelInput.value.trim();
    const accounts = accountsInput.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!label) {
      formMsgEl.textContent = "Label is required.";
      return;
    }
    try {
      if (editingId) {
        await api(`/gl-groups/${editingId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label, accounts }),
        });
      } else {
        await api("/gl-groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label, accounts }),
        });
      }
      formEl.style.display = "none";
      await load();
    } catch (err) {
      formMsgEl.textContent = err.message;
    }
  });

  load();
})();
