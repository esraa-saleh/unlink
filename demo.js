
function stat(label, value) {
  return `<div class="stat"><strong>${Number(value || 0).toLocaleString()}</strong><span>${label}</span></div>`;
}

async function openExternal(url) {
  // Open from this extension page into a normal browser tab.
  // The background router then applies the real Unlink policy.
  await browser.tabs.create({url, active:true});
}

document.querySelectorAll("[data-url]").forEach(btn => {
  btn.addEventListener("click", () => openExternal(btn.dataset.url));
});

document.getElementById("openSearch").addEventListener("click", () => {
  openExternal("https://www.google.com/search?q=unlink+privacy+demo");
});

document.getElementById("newGoogle").addEventListener("click", async () => {
  await browser.runtime.sendMessage({
    type:"CREATE_CLUSTER_INSTANCE",
    clusterId:"google-productivity",
    openUrl:"https://mail.google.com/"
  });
});

document.getElementById("refresh").addEventListener("click", refresh);

async function refresh() {
  const d = await browser.runtime.sendMessage({type:"GET_DASHBOARD"});
  if (!d?.ok) return;

  const s = d.state.stats;
  const google = d.clusters.find(c => c.id === "google-productivity");

  document.getElementById("statusGrid").innerHTML = [
    stat("GOOGLE CLUSTER INSTANCES", google?.instances?.length || 0),
    stat("EPHEMERAL IDENTITIES", s.freshEphemeralCreated),
    stat("CLUSTER REUSES", s.clusterReuses),
    stat("CROSS-DOMAIN SPLITS", s.crossDomainSplits)
  ].join("");

  const x = d.state.lastDecision;
  let text = "No routing decision yet.";
  if (x) {
    const target = x.clusterName ? ` · ${x.clusterName}` : "";
    text = `${x.action}${target} — ${x.reason || ""}`;
  }
  document.getElementById("lastDecision").textContent = text;
}

refresh();
setInterval(refresh, 2000);
