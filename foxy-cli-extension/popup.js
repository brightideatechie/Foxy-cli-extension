/* Foxy CLI - popup logic: reads/writes settings and counts snippets on the active tab. */

const DEFAULTS = { autoRun: false, autoCopy: true, shell: "bash", active: true };

async function getSettings() {
  try {
    const res = await browser.storage.local.get("settings");
    return Object.assign({}, DEFAULTS, res.settings || {});
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}
async function setSettings(s) {
  await browser.storage.local.set({ settings: s });
  try {
    await browser.runtime.sendMessage({ type: "foxy-settings-updated", settings: s });
  } catch (e) {}
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab) await browser.tabs.sendMessage(tab.id, { type: "foxy-settings-updated", settings: s }).catch(() => {});
  } catch (e) {}
}

document.addEventListener("DOMContentLoaded", async () => {
  const s = await getSettings();
  document.getElementById("activeToggle").checked = s.active !== false;
  document.getElementById("autoRun").checked = !!s.autoRun;
  document.getElementById("autoCopy").checked = s.autoCopy !== false;
  document.getElementById("shellSelect").value = s.shell || "bash";

  ["activeToggle", "autoRun", "autoCopy"].forEach((id) => {
    document.getElementById(id).addEventListener("change", update);
  });
  document.getElementById("shellSelect").addEventListener("change", update);

  // count snippets on the active tab
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      const res = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.querySelectorAll("pre code").length
      });
      if (res && res[0] && typeof res[0].result === "number") {
        document.getElementById("snippetCount").textContent = res[0].result;
      }
    }
  } catch (e) {
    document.getElementById("snippetCount").textContent = "—";
  }
});

async function update() {
  const s = {
    active: document.getElementById("activeToggle").checked,
    autoRun: document.getElementById("autoRun").checked,
    autoCopy: document.getElementById("autoCopy").checked,
    shell: document.getElementById("shellSelect").value
  };
  await setSettings(s);
}