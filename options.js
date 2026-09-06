
const editor = document.getElementById("editor");
const status = document.getElementById("status");

async function load() {
  const d = await browser.runtime.sendMessage({type:"GET_POLICIES"});
  editor.value = JSON.stringify(d.policies, null, 2);
}

document.getElementById("save").addEventListener("click", async () => {
  try {
    const policies = JSON.parse(editor.value);
    const r = await browser.runtime.sendMessage({
      type:"SAVE_POLICIES",
      policies
    });
    if (!r?.ok) throw new Error(r?.error || "Could not save.");
    status.textContent = "Saved.";
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
  }
});

document.getElementById("reset").addEventListener("click", async () => {
  const r = await browser.runtime.sendMessage({type:"RESET_POLICIES"});
  if (r?.ok) {
    editor.value = JSON.stringify(r.policies, null, 2);
    status.textContent = "Built-in rules restored.";
  }
});

load();
