// GL Account Groups tile — pure CRUD over /api/finance/gl-groups. Node's
// original (private/js/finance.js's showGlGroupConfig()/openGlGroupModal())
// used a floating modal with chip-style account tags; this now opens via
// the shared AdminEditModal (same generic "edit a flat record" convention
// already used by Logistics's reference-data tiles), accounts entered
// one-per-line rather than dynamic add/remove input rows — same behavior,
// less markup than reproducing Node's chip UI. Every dynamic value in the
// list itself is still built via textContent/DOM APIs, never innerHTML.
(function () {
  const listEl = document.getElementById("gg-list");
  const msgEl = document.getElementById("gg-msg");

  let groups = [];

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
    if (!(await NexusModal.confirm(`Delete GL group "${group.label}"?`, { danger: true, confirmLabel: "Delete" }))) return;
    try {
      await api(`/gl-groups/${group.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      msgEl.textContent = err.message;
    }
  }

  const FIELDS = [
    { key: "label", label: "Label" },
    { key: "accounts", label: "GL Accounts (one per line)", multiline: true, wide: true },
  ];

  function openForm(existing) {
    const record = existing
      ? { label: existing.label, accounts: existing.accounts.join("\n") }
      : { label: "", accounts: "" };

    AdminEditModal.open(existing ? "Edit Group" : "Add Group", "", FIELDS, record, async (values) => {
      const label = values.label.trim();
      const accounts = values.accounts.split("\n").map((s) => s.trim()).filter(Boolean);
      if (!label) throw new Error("Label is required.");

      if (existing) {
        await api(`/gl-groups/${existing.id}`, {
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
      await load();
    });
  }

  document.getElementById("gg-add-btn").addEventListener("click", () => openForm(null));

  load();
})();
