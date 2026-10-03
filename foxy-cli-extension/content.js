/* Foxy CLI - content script
   Detects <pre><code> snippet blocks and injects a collapsible terminal
   emulator directly below each one. The snippet text is copied into the
   terminal prompt; pressing Enter (after focusing the terminal) executes it.

   Commands run in a REAL shell through the Foxy CLI native messaging host
   (see native-host/). If the host is not installed, the terminal falls back
   to a built-in simulated shell so it stays usable. */

(function () {
  "use strict";

  const COLORS = {
    surface: "#0D1117",
    subsurface: "#161B22",
    border: "#30363D",
    accent: "#FF7118",
    green: "#00FF66",
    text: "#F0F6FC",
    muted: "#8B949E",
    err: "#FF6B6B"
  };

  const SETTINGS_KEY = "foxy-cli-settings";
  let settings = { autoRun: false, autoCopy: true, shell: "bash" };
  const terminals = new Map(); // sessionId -> FoxyTerminal
  let sessionIdCounter = 0;

  const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  function cleanOutput(text) {
    return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(ANSI_RE, "");
  }

  function loadSettings(cb) {
    try {
      browser.storage.local.get("settings").then((res) => {
        if (res && res.settings) settings = Object.assign({}, settings, res.settings);
        cb();
      }).catch(() => cb());
    } catch (e) {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) settings = Object.assign({}, settings, JSON.parse(raw));
      } catch (e2) {}
      cb();
    }
  }
  function saveSettingsLocal() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  /* ---- message routing: streamed output + live settings updates ---- */
  try {
    browser.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === "foxy-output") {
        const t = terminals.get(msg.sessionId);
        if (t) t.appendOutput(msg.data);
      } else if (msg.type === "foxy-settings-updated" && msg.settings) {
        settings = Object.assign({}, settings, msg.settings);
        saveSettingsLocal();
        document.querySelectorAll(".foxy-cli-autocopy").forEach((c) => { c.checked = !!settings.autoCopy; });
        document.querySelectorAll(".foxy-cli-shell-label").forEach((l) => { l.textContent = settings.shell || "bash"; });
      }
    });
  } catch (e) {}

  /* ---------- Terminal emulator ---------- */
  class FoxyTerminal {
    constructor(drawer, snippetText) {
      this.drawer = drawer;
      this.sessionId = "s" + (++sessionIdCounter);
      terminals.set(this.sessionId, this);
      this.snippet = (snippetText || "").replace(/\s+$/, "");
      this.realShell = false;
      this.busy = false;
      this.entries = []; // { kind: 'prompt'|'out'|'sim', text?, html? }
      this.history = [];
      this.histIndex = -1;
      this.cwd = "~";
      this.fs = {
        "~": {
          "README.md": "# Foxy CLI - injected terminal",
          "main.py": 'print("hello from foxy")',
          "src": { "index.js": "console.log('foxy')" },
          "package.json": '{ "name": "snippet-demo" }'
        }
      };
      this.terminalEl = drawer.querySelector(".foxy-cli-terminal");
      this.inputEl = drawer.querySelector(".foxy-cli-input");
      this.timerEl = drawer.querySelector(".foxy-cli-timer");
      this.currentInput = "";
      this.cursorPos = 0;
      this.startTime = null;
      this.timerHandle = null;
      this.collapsed = false;

      this.prefillSnippet();
      this.bindEvents();
      this.render();
      this.detectShell();
    }

    promptText() {
      return this.realShell ? "$" : "$ " + this.cwd;
    }

    detectShell() {
      browser.runtime.sendMessage({ type: "foxy-ping", sessionId: this.sessionId })
        .then((res) => { this.realShell = !!(res && res.ok); })
        .catch(() => { this.realShell = false; })
        .finally(() => {
          const label = this.drawer.querySelector(".foxy-cli-status-label");
          if (label) label.textContent = this.realShell ? "Live Shell" : "Simulated";
          this.render();
        });
    }

    prefillSnippet() {
      // Copy the snippet into the command line. Single line -> run it raw.
      // Multi-line -> the foxy wrapper, which executes the whole snippet.
      const lines = this.snippet.split("\n").filter((l) => l.trim() !== "");
      this.currentInput = lines.length <= 1 ? (lines[0] || "") : "foxy run --snippet";
      this.cursorPos = this.currentInput.length;
    }

    bindEvents() {
      const input = this.inputEl;
      this.terminalEl.addEventListener("click", () => { input.focus(); this.drawer.classList.add("foxy-focused"); });
      input.addEventListener("blur", () => this.drawer.classList.remove("foxy-focused"));
      input.addEventListener("keydown", (e) => this.onKey(e));

      this.drawer.querySelector(".foxy-cli-collapse").addEventListener("click", () => this.toggleCollapse());
      this.drawer.querySelector(".foxy-cli-copy-btn").addEventListener("click", () => this.screenshot(true));
      this.drawer.querySelector(".foxy-cli-autocopy").addEventListener("change", (e) => {
        settings.autoCopy = e.target.checked;
        saveSettingsLocal();
      });
      this.drawer.querySelector(".foxy-cli-shell").addEventListener("click", () => {
        settings.shell = (settings.shell === "bash") ? "zsh" : "bash";
        saveSettingsLocal();
        this.drawer.querySelector(".foxy-cli-shell-label").textContent = settings.shell;
      });
    }

    toggleCollapse() {
      this.collapsed = !this.collapsed;
      this.terminalEl.classList.toggle("foxy-collapsed", this.collapsed);
      this.drawer.querySelector(".foxy-cli-collapse").textContent = this.collapsed ? "+" : "–";
    }

    onKey(e) {
      const k = e.key;
      if (k === "Escape") {
        e.preventDefault();
        this.inputEl.blur();
        this.drawer.classList.remove("foxy-focused");
        return;
      }
      if (k === "c" && e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (this.busy && this.realShell) {
          browser.runtime.sendMessage({ type: "foxy-interrupt", sessionId: this.sessionId }).catch(() => {});
        }
        return;
      }
      if (this.busy) { e.preventDefault(); return; }
      if (k === "Enter") {
        e.preventDefault();
        this.runCommand(this.currentInput);
        this.currentInput = "";
        this.cursorPos = 0;
        this.render();
      } else if (k === "Backspace") {
        e.preventDefault();
        if (this.cursorPos > 0) {
          this.currentInput = this.currentInput.slice(0, this.cursorPos - 1) + this.currentInput.slice(this.cursorPos);
          this.cursorPos--;
        }
        this.render();
      } else if (k === "ArrowUp") {
        e.preventDefault();
        if (this.history.length) {
          this.histIndex = Math.min(this.histIndex + 1, this.history.length - 1);
          this.currentInput = this.history[this.history.length - 1 - this.histIndex];
          this.cursorPos = this.currentInput.length;
          this.render();
        }
      } else if (k === "ArrowDown") {
        e.preventDefault();
        if (this.histIndex > 0) {
          this.histIndex--;
          this.currentInput = this.history[this.history.length - 1 - this.histIndex];
        } else {
          this.histIndex = -1;
          this.currentInput = "";
        }
        this.cursorPos = this.currentInput.length;
        this.render();
      } else if (k === "ArrowLeft") {
        e.preventDefault();
        this.cursorPos = Math.max(0, this.cursorPos - 1);
        this.render();
      } else if (k === "ArrowRight") {
        e.preventDefault();
        this.cursorPos = Math.min(this.currentInput.length, this.cursorPos + 1);
        this.render();
      } else if (k === "l" && e.ctrlKey) {
        e.preventDefault();
        this.entries = [];
        this.render();
      } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.currentInput = this.currentInput.slice(0, this.cursorPos) + k + this.currentInput.slice(this.cursorPos);
        this.cursorPos++;
        this.render();
      }
    }

    startTimer() {
      this.startTime = performance.now();
      this.timerHandle = setInterval(() => {
        if (this.timerEl) this.timerEl.textContent = ((performance.now() - this.startTime) / 1000).toFixed(2) + "s";
      }, 50);
    }
    stopTimer() {
      if (this.timerHandle) clearInterval(this.timerHandle);
      this.timerHandle = null;
      if (this.timerEl && this.startTime) {
        this.timerEl.textContent = ((performance.now() - this.startTime) / 1000).toFixed(2) + "s";
      }
    }

    async runCommand(raw) {
      const cmd = raw.trim();
      if (!cmd) { this.entries.push({ kind: "prompt", text: "" }); this.render(); return; }
      if (cmd === "clear") { this.entries = []; this.render(); return; }

      this.busy = true;
      this.history.push(cmd);
      this.histIndex = -1;
      this.entries.push({ kind: "prompt", text: cmd });
      this.render();
      this.startTimer();
      this.terminalEl.scrollTop = this.terminalEl.scrollHeight;

      if (cmd === "foxy run --snippet" || cmd.indexOf("foxy run --snippet") === 0) {
        if (this.realShell) {
          await this.runViaBackground({ type: "foxy-run-script", snippet: this.snippet, shell: settings.shell });
        } else {
          this.appendSim(this.simulateSnippet(this.snippet));
        }
      } else if (this.realShell) {
        await this.runViaBackground({ type: "foxy-run", command: cmd });
      } else {
        this.appendSim(this.simulateCommand(cmd));
      }

      this.stopTimer();
      this.entries.push({ kind: "prompt", text: "" });
      this.busy = false;
      this.render();
      this.terminalEl.scrollTop = this.terminalEl.scrollHeight;
      if (settings.autoCopy) this.screenshot(false);
    }

    async runViaBackground(msg) {
      msg.sessionId = this.sessionId;
      try {
        const res = await browser.runtime.sendMessage(msg);
        if (res && res.code === -1) {
          this.appendOutput("foxy: native host disconnected\n");
        }
      } catch (e) {
        this.appendOutput("foxy: native host error: " + (e && e.message ? e.message : e) + "\n");
      }
    }

    appendOutput(data) {
      const text = cleanOutput(data);
      if (!text) return;
      const last = this.entries[this.entries.length - 1];
      if (last && last.kind === "out") {
        last.text += text;
      } else {
        this.entries.push({ kind: "out", text });
      }
      this.render();
      this.terminalEl.scrollTop = this.terminalEl.scrollHeight;
    }

    appendSim(lines) {
      for (const l of lines) this.entries.push({ kind: "sim", html: l.html, text: l.text });
      this.render();
    }

    /* ---- simulated shell (fallback when the native host is absent) ---- */
    simulateCommand(cmd) {
      const out = [];
      const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      const bin = parts[0];
      const args = parts.slice(1).map((a) => a.replace(/^"|"$/g, ""));
      switch (bin) {
        case "echo": out.push(sim(args.join(" "), "out")); break;
        case "pwd": out.push(sim("/home/foxy" + (this.cwd === "~" ? "" : "/" + this.cwd), "out")); break;
        case "whoami": out.push(sim("foxy", "out")); break;
        case "date": out.push(sim(new Date().toString(), "out")); break;
        case "ls": out.push(...this.simLs(args[0])); break;
        case "cd": this.simCd(args[0]); break;
        case "cat": out.push(...this.simCat(args[0])); break;
        case "help": case "?":
          out.push(sim("Foxy CLI (simulated shell - install the native host for a real shell)", "muted"));
          out.push(sim("  foxy run --snippet   Execute the detected code snippet", "out"));
          out.push(sim("  echo | pwd | ls | cd | cat | date | whoami | clear", "out"));
          break;
        case "foxy": out.push(sim("Foxy CLI v1.0.0 - type 'help'", "accent")); break;
        default:
          out.push(sim("foxy: command not found: " + bin, "err"));
      }
      return out;
    }

    simulateSnippet(snip) {
      const out = [];
      out.push(sim("▶ executing snippet (" + snip.length + " chars)…", "accent"));
      const low = snip.toLowerCase();
      if (/print\s*\(|console\.log/.test(low)) {
        const m = snip.match(/(?:print|console\.log)\s*\(\s*["'`]([^"'`]*)["'`]/);
        out.push(sim(m ? m[1] : "hello from foxy", "out"));
      } else if (/npm\s+install|yarn\s+add|pip\s+install/.test(low)) {
        out.push(sim("added 42 packages in 1.8s", "muted"));
      } else if (/curl\s+|wget\s+/.test(low)) {
        out.push(sim("100  1234  100  1234    0     0   8421      0 --:--:--", "muted"));
      } else {
        snip.split("\n").slice(0, 6).forEach((l) => out.push(sim(l || " ", "muted")));
      }
      out.push(sim("✓ snippet exited with code 0", "muted"));
      return out;
    }

    simLs() {
      const dir = this.fs[this.cwd] || {};
      const names = Object.keys(dir);
      if (!names.length) return [sim("(empty)", "muted")];
      const html = names.map((n) =>
        typeof dir[n] === "object"
          ? '<span style="color:' + COLORS.accent + '">' + this.escape(n) + '/</span>'
          : '<span style="color:' + COLORS.text + '">' + this.escape(n) + "</span>"
      ).join("   ");
      return [{ html: html, text: names.join("  ") }];
    }
    simCd(path) {
      if (!path || path === "~") { this.cwd = "~"; return; }
      const dir = this.fs[this.cwd] || {};
      if (dir[path] && typeof dir[path] === "object") this.cwd = path;
    }
    simCat(file) {
      const dir = this.fs[this.cwd] || {};
      if (file && dir[file] && typeof dir[file] === "string") {
        return dir[file].split("\n").map((l) => sim(l, "out"));
      }
      return [sim("cat: " + (file || "") + ": No such file", "err")];
    }

    render() {
      const t = this.terminalEl;
      let html = "";
      for (const e of this.entries) {
        if (e.kind === "prompt") {
          html += '<div class="foxy-cli-line"><span class="foxy-cli-prompt">' + this.escape(this.promptText()) +
            '</span> <span class="foxy-cli-cmd">' + this.escape(e.text) + "</span></div>";
        } else if (e.kind === "out") {
          html += '<div class="foxy-cli-line"><span class="foxy-cli-out">' + this.escape(e.text) + "</span></div>";
        } else if (e.kind === "sim") {
          html += '<div class="foxy-cli-line">' + e.html + "</div>";
        }
      }
      const before = this.escape(this.currentInput.slice(0, this.cursorPos));
      const after = this.escape(this.currentInput.slice(this.cursorPos));
      html += '<div class="foxy-cli-line"><span class="foxy-cli-prompt">' + this.escape(this.promptText()) +
        '</span> <span class="foxy-cli-cmd">' + before + '</span><span class="foxy-cli-cursor"></span><span class="foxy-cli-cmd">' + after + "</span></div>";
      t.innerHTML = html;
    }

    screenshotTextLines() {
      const out = [];
      for (const e of this.entries) {
        if (e.kind === "prompt") {
          out.push(this.promptText() + (e.text ? " " + e.text : ""));
        } else if (e.text != null) {
          for (const l of String(e.text).split("\n")) out.push(l);
        }
      }
      out.push(this.promptText() + (this.currentInput ? " " + this.currentInput : ""));
      return out;
    }

    /* Screenshot: rasterize terminal text to a canvas, copy PNG to clipboard */
    screenshot(manual) {
      const charWidth = 7.8;
      const lineHeight = 19;
      const padX = 16, padY = 14;
      const allLines = this.screenshotTextLines();
      const maxChars = Math.max(40, ...allLines.map((l) => l.length));
      const width = Math.ceil(padX * 2 + maxChars * charWidth);
      const height = padY * 2 + Math.max(1, allLines.length) * lineHeight + 6;
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = COLORS.surface;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = COLORS.green;
      ctx.fillRect(0, 0, width, 2);
      ctx.font = '13px "Fira Code", "Cascadia Code", Consolas, monospace';
      ctx.textBaseline = "top";
      allLines.forEach((l, i) => {
        ctx.fillStyle = COLORS.text;
        ctx.fillText(l, padX, padY + i * lineHeight);
      });
      const blobToClipboard = (blob) => {
        try {
          navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
            .then(() => this.flash(manual))
            .catch(() => this.flash(manual));
        } catch (e) { this.flash(manual); }
      };
      try {
        canvas.toBlob((blob) => { if (blob) blobToClipboard(blob); else this.flash(manual); }, "image/png");
      } catch (e) { this.flash(manual); }
    }

    flash(manual) {
      this.drawer.classList.remove("foxy-flash");
      void this.drawer.offsetWidth;
      this.drawer.classList.add("foxy-flash");
      if (manual) showToast("Screenshot copied to clipboard");
    }

    escape(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
  }

  function sim(text, kind) {
    const cls = kind === "muted" ? "foxy-cli-muted" : kind === "accent" ? "foxy-cli-accent" : kind === "err" ? "foxy-cli-err" : "foxy-cli-out";
    const safe = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return { html: '<span class="' + cls + '">' + safe + "</span>", text: String(text) };
  }

  function showToast(msg) {
    let el = document.getElementById("foxy-cli-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "foxy-cli-toast";
      el.style.cssText = "position:fixed;bottom:18px;right:18px;z-index:2147483647;background:#0D1117;color:#00FF66;border:1px solid #00FF66;border-radius:6px;padding:8px 12px;font-family:Inter,system-ui,sans-serif;font-size:12px;box-shadow:0 6px 18px rgba(0,0,0,.4);opacity:0;transition:opacity .2s;";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = "1";
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = "0"; }, 1800);
  }

  /* ---------- Drawer injection ---------- */
  function buildDrawer() {
    const wrap = document.createElement("div");
    wrap.className = "foxy-cli-drawer";
    wrap.setAttribute("data-foxy-cli", "1");
    wrap.innerHTML = `
      <div class="foxy-cli-header">
        <div class="foxy-cli-header-left">
          <span class="foxy-cli-brand">🦊 Foxy CLI</span>
          <span class="foxy-cli-shell" title="Click to toggle shell">
            <span class="foxy-cli-shell-label">${settings.shell || "bash"}</span> ▾
          </span>
          <span class="foxy-cli-snippet-trigger" title="Snippet preview">ⓘ</span>
        </div>
        <div class="foxy-cli-header-right">
          <span class="foxy-cli-status"><span class="foxy-cli-dot"></span> <span class="foxy-cli-status-label">Ready</span></span>
          <label class="foxy-cli-toggle" title="Auto-copy screenshot on finish">
            <input type="checkbox" class="foxy-cli-autocopy" ${settings.autoCopy ? "checked" : ""}> Auto-Copy on Finish
          </label>
          <button class="foxy-cli-collapse" title="Collapse/Expand">–</button>
        </div>
      </div>
      <div class="foxy-cli-terminal" tabindex="0"></div>
      <input class="foxy-cli-input" type="text" autocomplete="off" spellcheck="false">
      <div class="foxy-cli-footer">
        <span class="foxy-cli-timer">0.00s</span>
        <span class="foxy-cli-footer-center"><kbd>Enter</kbd> Run &nbsp; <kbd>Esc</kbd> Detach</span>
        <button class="foxy-cli-copy-btn" title="Copy screenshot now">⧉ Copy Screenshot</button>
      </div>
    `;
    return wrap;
  }

  function injectFor(codeEl) {
    const pre = codeEl.closest("pre");
    if (!pre) return;
    if (pre.getAttribute("data-foxy-injected")) return;
    pre.setAttribute("data-foxy-injected", "1");
    const snippetText = codeEl.textContent || "";
    const drawer = buildDrawer();
    pre.parentNode.insertBefore(drawer, pre.nextSibling);
    new FoxyTerminal(drawer, snippetText);

    // snippet preview tooltip
    const trigger = drawer.querySelector(".foxy-cli-snippet-trigger");
    let preview = null;
    trigger.addEventListener("mouseenter", () => {
      preview = document.createElement("div");
      preview.className = "foxy-cli-snippet-preview";
      preview.textContent = snippetText.length > 240 ? snippetText.slice(0, 240) + "…" : snippetText;
      const r = trigger.getBoundingClientRect();
      preview.style.left = r.left + "px";
      preview.style.top = (r.bottom + 6) + "px";
      document.body.appendChild(preview);
    });
    trigger.addEventListener("mouseleave", () => { if (preview) { preview.remove(); preview = null; } });
  }

  function scan() {
    document.querySelectorAll("pre code").forEach(injectFor);
  }

  function init() {
    loadSettings(() => {
      scan();
      const obs = new MutationObserver(() => scan());
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();