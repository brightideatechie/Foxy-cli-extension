# Foxy CLI — Firefox Extension

Recognizes code snippets (`<pre><code>`) on any web page and injects a **collapsible, fully functional terminal emulator** directly below the snippet box. The snippet is copied into the terminal prompt; pressing **Enter** executes it in a **real shell** (via the native host), and on completion a **screenshot of the entire terminal is copied to the clipboard**.

## Install

### 1. Load the extension

1. Open Firefox → `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → select `foxy-cli-extension/manifest.json`.

### 2. Install the native host (required for real command execution)

The terminal runs real commands through a native messaging host written in Python 3.

**macOS / Linux**

```bash
cd foxy-cli-extension/native-host
chmod +x install.sh
./install.sh
```

**Windows** (double-click or run in cmd)

```bat
foxy-cli-extension\native-host\install-windows.bat
```

Then **restart Firefox** and reload the extension. The status dot in each terminal's header reads **"Live Shell"** when the host is connected; if the host is missing it reads **"Simulated"** and falls back to a built-in simulated shell.

To package for distribution: zip the contents of `foxy-cli-extension/` and submit to [addons.mozilla.org](https://addons.mozilla.org) (the `browser_specific_settings.gecko.id` is already set).

## How it works

- **Snippet detection** — scans every `<pre><code>` block (and watches the DOM for new ones) and anchors a terminal drawer beneath it.
- **Real shell** — each terminal session gets its own native host connection. On macOS/Linux the host keeps a persistent `bash`/`zsh` process, so `cd`, exported variables and shell functions persist between commands; output is streamed live and the exit code is reported. On Windows, commands run via `cmd.exe` with working-directory tracking.
- **Snippet execution** — a single-line snippet is prefilled at the prompt verbatim. A multi-line snippet is prefilled as `foxy run --snippet`; pressing Enter writes the snippet to a temp file and runs it with the right interpreter (detected from the shebang or content: Python, Node, or shell).
- **Keyboard** — `Enter` run, `Esc` detach, `↑`/`↓` history, `Ctrl+L` clear, `Ctrl+C` interrupt the running command.
- **Auto-clipboard screenshot** — on command completion the terminal is rasterized to a PNG and copied to the clipboard with a green border-ripple flash. Toggle it in the header, or use the **Copy Screenshot** button.
- **Popup** — 360px config panel: active toggle, detected-snippet counter, Auto-Run on Focus, Screenshot to Clipboard, Shell Target (bash/zsh), quick-shortcut reference.

## Architecture

```
content.js  ──foxy-run──▶  background.js  ──connectNative──▶  foxy_host.py  ──▶  real shell
     ▲                            │                                                   │
     └──────foxy-output (streamed chunks + exit code)────────────────────────────────┘
```

One native connection per terminal drawer (`tabId:sessionId`), one host process per connection.

## Design tokens

| Token | Value |
|---|---|
| Surface | `#0D1117` |
| Subsurface | `#161B22` |
| Border | `#30363D` |
| Accent (Firefox Orange) | `#FF7118` |
| Terminal Green | `#00FF66` |
| Text Main | `#F0F6FC` |
| Text Muted | `#8B949E` |
| Code font | Fira Code 400/600 |
| Body font | Inter 400/500 |

Signature moves: glowing 1px top border on focus (`#FF7118`), auto-clipboard screenshot flash (`#00FF66` border ripple) on command completion.

## Security note

The host executes whatever command is at the prompt in your user shell — same as running it in a terminal yourself. It only accepts connections from the Foxy CLI extension ID (`allowed_extensions`), and Firefox requires the host to be explicitly installed by you.