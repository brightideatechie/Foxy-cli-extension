#!/usr/bin/env python3
"""Foxy CLI native messaging host.

Speaks the Firefox native-messaging protocol on stdio (4-byte little-endian
length-prefixed JSON) and executes commands in a REAL shell:

  POSIX  : a persistent non-interactive bash/zsh process (cwd, env vars and
           shell functions survive across commands). Output is streamed.
  Windows: each command runs via cmd.exe with cwd tracking.

Message protocol (extension -> host):
  {"cmd": "ping"}                       -> {"type": "exit", "code": 0}
  {"cmd": "run", "command": "..."}      -> {"type": "output", "data": "..."}*
                                           {"type": "exit", "code": N}
  {"cmd": "run_script", "snippet": "..."} -> same as run, via temp file
  {"cmd": "interrupt"}                  -> SIGINT the current command
  {"cmd": "exit"}                       -> terminate host
"""

import codecs
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import threading

DONE_RE = re.compile(r"__FOXY_DONE_(-?\d+)__")
HOLD_BACK = 32  # marker can be at most ~26 chars; never emit this tail early

_send_lock = threading.Lock()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if not raw or len(raw) < 4:
        return None
    length = int.from_bytes(raw, "little")
    data = b""
    while len(data) < length:
        chunk = sys.stdin.buffer.read(length - len(data))
        if not chunk:
            return None
        data += chunk
    try:
        return json.loads(data.decode("utf-8"))
    except ValueError:
        return None


def send_message(msg):
    try:
        data = json.dumps(msg).encode("utf-8")
        with _send_lock:
            sys.stdout.buffer.write(len(data).to_bytes(4, "little"))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    except OSError:
        sys.exit(0)


def emit(text):
    if text:
        send_message({"type": "output", "data": text})


def detect_interpreter(snippet):
    first = snippet.lstrip().split("\n", 1)[0]
    if first.startswith("#!"):
        s = first[2:].lower()
        if "python" in s:
            return [sys.executable or "python3"]
        if "node" in s:
            return ["node"]
        if "bash" in s:
            return ["bash"]
        if "sh" in s:
            return ["sh"]
    if re.search(r"^\s*(import|from)\s+\w+", snippet, re.M) or re.search(r"\bdef\s+\w+\(", snippet):
        return [sys.executable or "python3"]
    low = snippet.lower()
    if re.search(r"\b(const\s|let\s|var\s|require\(|console\.log)", low):
        return ["node"]
    return ["bash"]


def quote_args(parts):
    if os.name == "nt":
        return " ".join('"' + p + '"' for p in parts)
    return " ".join(shlex.quote(p) for p in parts)


class PosixSession:
    """Persistent non-interactive shell; state survives across commands."""

    def __init__(self, shell=None):
        self.exe = self._find_shell(shell)
        self.proc = None
        self._start()

    @staticmethod
    def _find_shell(shell):
        from shutil import which
        for cand in (shell, "bash", "sh"):
            if cand:
                path = which(cand)
                if path:
                    return path
        return "/bin/sh"

    def _start(self):
        base = os.path.basename(self.exe)
        flags = []
        if base == "bash":
            flags = ["--noprofile", "--norc"]
        elif base == "zsh":
            flags = ["-f"]
        self.proc = subprocess.Popen(
            [self.exe] + flags,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
        )

    def _read_chunk(self, timeout=0.5):
        import select
        fd = self.proc.stdout.fileno()
        r, _, _ = select.select([fd], [], [], timeout)
        if not r:
            return b""
        try:
            return os.read(fd, 65536)
        except OSError:
            return b""

    def run(self, command):
        if self.proc.poll() is not None:
            self._start()  # shell died (e.g. 'exit'); respawn
        wrapped = command.rstrip() + "\nFOXY_RC=$?\nprintf '__FOXY_DONE_%s__' \"$FOXY_RC\"\n"
        try:
            self.proc.stdin.write(wrapped.encode("utf-8"))
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            send_message({"type": "exit", "code": -1})
            return
        dec = codecs.getincrementaldecoder("utf-8")("replace")
        buf = ""
        sent = 0
        while True:
            data = self._read_chunk()
            if data:
                buf += dec.decode(data)
            m = DONE_RE.search(buf)
            if m:
                emit(buf[sent:m.start()])
                send_message({"type": "exit", "code": int(m.group(1))})
                return
            if not data and self.proc.poll() is not None:
                emit(buf[sent:])
                code = self.proc.returncode
                send_message({"type": "exit", "code": code if code is not None else -1})
                return
            safe = max(sent, len(buf) - HOLD_BACK)
            if safe > sent:
                emit(buf[sent:safe])
                sent = safe

    def interrupt(self):
        try:
            import signal
            os.killpg(os.getpgid(self.proc.pid), signal.SIGINT)
        except Exception:
            pass

    def close(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
            except Exception:
                pass


class WindowsSession:
    """Per-command cmd.exe execution with cwd tracking."""

    def __init__(self, shell=None):
        self.cwd = os.path.expanduser("~")
        self.current = None

    def run(self, command):
        try:
            p = subprocess.Popen(
                command, shell=True, cwd=self.cwd,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            self.current = p
            out, err = p.communicate()
            self.current = None
            code = p.returncode
            text = out.decode("utf-8", errors="replace")
            err_text = err.decode("utf-8", errors="replace")
            if err_text:
                text = text + (("\n" if text else "") + err_text)
            emit(text)
        except Exception as e:  # noqa: BLE001
            emit(str(e))
            code = 1
        m = re.match(r"\s*(?:cd|chdir)(?:\s+/d)?\s+(.+?)\s*$", command, re.IGNORECASE)
        if m:
            self._update_cwd(m.group(1).strip('"'))
        send_message({"type": "exit", "code": code})

    def _update_cwd(self, target):
        try:
            cand = os.path.abspath(os.path.join(self.cwd, target))
            if os.path.isdir(cand):
                self.cwd = cand
        except Exception:
            pass

    def interrupt(self):
        if self.current:
            try:
                self.current.terminate()
            except Exception:
                pass

    def close(self):
        pass


def run_script(session, snippet):
    interp = detect_interpreter(snippet)
    lowered = [i.lower() for i in interp]
    if any("python" in i for i in lowered):
        suffix = ".py"
    elif any("node" in i for i in lowered):
        suffix = ".js"
    else:
        suffix = ".sh"
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "w") as f:
        f.write(snippet)
    try:
        session.run(quote_args(interp) + " " + quote_args([path]))
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def make_session(shell):
    return (WindowsSession if os.name == "nt" else PosixSession)(shell)


def main():
    import queue

    q = queue.Queue()
    state = {"session": None, "busy": False}

    def get_session(shell):
        if state["session"] is None:
            state["session"] = make_session(shell)
        return state["session"]

    def reader():
        """Reads stdin on a thread so interrupts arrive while a command runs."""
        while True:
            msg = read_message()
            if msg is None:
                q.put(None)
                return
            cmd = msg.get("cmd")
            if cmd == "ping":
                send_message({"type": "exit", "code": 0})
            elif cmd == "interrupt":
                if state["busy"] and state["session"]:
                    state["session"].interrupt()
            elif cmd == "exit":
                q.put(None)
                return
            else:
                q.put(msg)

    threading.Thread(target=reader, daemon=True).start()

    while True:
        msg = q.get()
        if msg is None:
            break
        cmd = msg.get("cmd")
        state["busy"] = True
        try:
            session = get_session(msg.get("shell"))
            if cmd == "run":
                session.run(msg.get("command", ""))
            elif cmd == "run_script":
                run_script(session, msg.get("snippet", ""))
        except Exception as e:  # noqa: BLE001
            send_message({"type": "output", "data": "foxy host error: " + str(e)})
            send_message({"type": "exit", "code": 1})
        state["busy"] = False

    if state["session"]:
        state["session"].close()


if __name__ == "__main__":
    main()