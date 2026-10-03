/* Foxy CLI - background script.
   Bridges each injected terminal to the native shell host ("foxy_cli") via
   native messaging. One persistent host connection per terminal session. */

const NATIVE_APP = "foxy_cli";
const sessions = new Map(); // key -> { port, tabId, sessionId, disconnected, onExit }

function getSession(key, tabId, sessionId) {
  let s = sessions.get(key);
  if (s && !s.disconnected) return s;

  const port = browser.runtime.connectNative(NATIVE_APP);
  s = { port, tabId, sessionId, disconnected: false, onExit: null };

  port.onMessage.addListener((m) => {
    if (!m) return;
    if (m.type === "output") {
      browser.tabs.sendMessage(s.tabId, {
        type: "foxy-output",
        sessionId: s.sessionId,
        data: m.data
      }).catch(() => {});
    } else if (m.type === "exit") {
      const cb = s.onExit;
      s.onExit = null;
      if (cb) cb({ code: m.code });
    }
  });

  port.onDisconnect.addListener(() => {
    s.disconnected = true;
    sessions.delete(key);
    const cb = s.onExit;
    s.onExit = null;
    if (cb) cb({ code: -1 });
  });

  sessions.set(key, s);
  return s;
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("foxy-")) return;
  const tabId = sender.tab && sender.tab.id;
  if (tabId === undefined) return;

  if (msg.type === "foxy-ping") {
    return browser.runtime.sendNativeMessage(NATIVE_APP, { cmd: "ping" })
      .then(() => ({ ok: true }))
      .catch(() => ({ ok: false }));
  }

  if (msg.type === "foxy-interrupt") {
    const s = sessions.get(tabId + ":" + (msg.sessionId || "s"));
    if (s && !s.disconnected) {
      try { s.port.postMessage({ cmd: "interrupt" }); } catch (e) {}
    }
    return;
  }

  if (msg.type !== "foxy-run" && msg.type !== "foxy-run-script") return;

  const sessionId = msg.sessionId || "s";
  const s = getSession(tabId + ":" + sessionId, tabId, sessionId);

  return new Promise((resolve) => {
    s.onExit = resolve;
    try {
      if (msg.type === "foxy-run") {
        s.port.postMessage({ cmd: "run", command: msg.command });
      } else {
        s.port.postMessage({ cmd: "run_script", snippet: msg.snippet, shell: msg.shell });
      }
    } catch (e) {
      s.onExit = null;
      resolve({ code: -1 });
    }
  });
});