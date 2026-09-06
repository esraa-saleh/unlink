
const params = new URLSearchParams(location.search);
const token = params.get("token");

async function load() {
  if (!token) {
    document.getElementById("copy").textContent = "Missing routing token.";
    return;
  }

  const d = await browser.runtime.sendMessage({
    type:"GET_PENDING_CHOICE",
    token
  });

  if (!d?.ok) {
    document.getElementById("copy").textContent = d?.error || "Choice expired.";
    return;
  }

  document.getElementById("copy").textContent =
    `${d.cluster.name} has multiple isolated sessions. Choose which state this navigation should join.`;

  const choices = document.getElementById("choices");

  choices.innerHTML =
    d.instances.map(i => `
      <button class="choice" data-store="${i.cookieStoreId}">
        <div>
          <strong>${d.cluster.name} #${i.instanceIndex}</strong>
          <span>Existing isolated state</span>
        </div>
        <div>USE</div>
      </button>
    `).join("") +
    `
      <button class="choice new" id="newInstance">
        <div>
          <strong>New ${d.cluster.name} instance</strong>
          <span>Start with a fresh cookie/storage identity</span>
        </div>
        <div>NEW</div>
      </button>
    `;

  for (const btn of document.querySelectorAll("[data-store]")) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const r = await browser.runtime.sendMessage({
        type:"RESOLVE_PENDING_CHOICE",
        token,
        cookieStoreId:btn.dataset.store
      });
      if (!r?.ok) {
        alert(r?.error || "Could not route.");
        btn.disabled = false;
      } else {
        window.close();
      }
    });
  }

  document.getElementById("newInstance").addEventListener("click", async e => {
    e.currentTarget.disabled = true;
    const r = await browser.runtime.sendMessage({
      type:"RESOLVE_PENDING_CHOICE",
      token,
      createNew:true
    });
    if (!r?.ok) {
      alert(r?.error || "Could not create identity.");
      e.currentTarget.disabled = false;
    } else {
      window.close();
    }
  });
}

load();
