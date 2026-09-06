
document.getElementById("openDashboard").addEventListener("click", async () => {
  await browser.tabs.create({
    url:browser.runtime.getURL("dashboard.html"),
    active:true
  });
  window.close();
});

document.getElementById("freshTab").addEventListener("click", async () => {
  await browser.runtime.sendMessage({type:"NEW_FRESH_TAB"});
  window.close();
});

document.getElementById("openOptions").addEventListener("click", async () => {
  await browser.runtime.openOptionsPage();
  window.close();
});
