#!/usr/bin/env python3
"""B16: exercise the real Ink TUI through a Linux pseudo-terminal."""

from __future__ import annotations

import fcntl
import hashlib
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WIDE = (140, 42)
NARROW = (80, 24)
TIMEOUT_SECONDS = 20.0
CSI_RE = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
CREDENTIAL_RE = re.compile(r"(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE)", re.I)


class BenchmarkFailure(RuntimeError):
    pass


def plain(raw: bytes) -> str:
    """Remove ANSI/CSI controls while retaining the exact printable paint."""
    return CSI_RE.sub(b"", raw).replace(b"\r", b"").decode("utf-8", "replace")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise BenchmarkFailure(message)


def set_size(fd: int, width: int, height: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))


def isolated_env(workspace: str) -> dict[str, str]:
    env = os.environ.copy()
    # The benchmark is intentionally keyless even when invoked from a shell
    # that has provider, search, GitHub, or browser credentials configured.
    for key in list(env):
        if CREDENTIAL_RE.search(key) or key in {"HERMES_HOME", "OLLAMA_HOST"}:
            env[key] = ""
    for key in (
        "JOBOS_LLM_PROVIDER", "JOBOS_LLM_MODEL", "JOBOS_LLM_API_KEY",
        "JOBOS_RESEARCH_SCORE_PROVIDER", "JOBOS_RESEARCH_SCORE_MODEL",
        "JOBOS_RESEARCH_TAILOR_PROVIDER", "JOBOS_RESEARCH_TAILOR_MODEL",
        "JOBOS_SEARCH_PROVIDERS", "JOBOS_XAI_ENABLED",
        "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY",
        "GOOGLE_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "OLLAMA_API_KEY",
        "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "CEREBRAS_API_KEY", "GROQ_API_KEY",
        "EXA_API_KEY", "JOBOS_EXA_API_KEY", "TAVILY_API_KEY", "JOBOS_TAVILY_API_KEY",
        "PERPLEXITY_API_KEY", "JOBOS_PERPLEXITY_API_KEY", "BRAVE_SEARCH_API_KEY",
        "JOBOS_BRAVE_API_KEY", "GITHUB_TOKEN",
    ):
        env[key] = ""
    env.update({
        "JOBOS_HOME": workspace,
        "JOBOS_WORKSPACE": "",
        "JOBOS_SEARCH_PROVIDER": "none",
        "JOBOS_ACP_COMMAND": "__jobos_b16_agent_must_not_start__",
        "TERM": "xterm-256color",
    })
    return env


def spawn_tui(workspace: str) -> tuple[subprocess.Popen[bytes], int]:
    master, slave = pty.openpty()
    set_size(slave, *WIDE)

    def child_setup() -> None:
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    try:
        process = subprocess.Popen(
            ["node", "src/cli.js", "tui", "--agent", "off"],
            cwd=ROOT,
            env=isolated_env(workspace),
            stdin=slave,
            stdout=slave,
            stderr=slave,
            preexec_fn=child_setup,
            close_fds=True,
        )
    except Exception:
        os.close(master)
        raise
    finally:
        os.close(slave)
    return process, master


def read_available(fd: int, wait: float = 0.15) -> bytes:
    chunks: list[bytes] = []
    while True:
        ready, _, _ = select.select([fd], [], [], wait)
        if not ready:
            return b"".join(chunks)
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            # Linux PTY masters report EIO after the slave closes.
            if error.errno == 5:
                return b"".join(chunks)
            raise
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)
        wait = 0.02


def wait_for(fd: int, deadline: float, description: str, predicate) -> bytes:
    captured = bytearray()
    while time.monotonic() < deadline:
        captured.extend(read_available(fd))
        if predicate(bytes(captured)):
            return bytes(captured)
        time.sleep(0.02)
    excerpt = plain(bytes(captured))[-800:]
    raise BenchmarkFailure(f"timeout waiting for {description}; paint tail={excerpt!r}")


def send(fd: int, payload: bytes) -> None:
    written = os.write(fd, payload)
    assert_true(written == len(payload), f"short PTY write: {written}/{len(payload)}")


def assert_welcome_covers_board(raw: bytes) -> None:
    text = plain(raw)
    assert_true("WELCOME TO JOBOS" in text.upper(), "real PTY first paint did not show welcome")
    lines = text.splitlines()
    rail = next((line for line in lines if re.search(r"\bNew\b.*\bJobs\b", line)), None)
    panes = next((line for line in lines
                  if re.search(r"\bJob\b.*\bPeople\b.*\bChat\b", line)
                  and "/ in Chat" not in line and "Tab" not in line), None)
    rail_copy = next((line for line in lines if "No jobs yet" in line or "Add to Jobs from New" in line), None)
    assert_true(rail is None, f"welcome live paint exposed New | Jobs rail: {rail!r}")
    assert_true(panes is None, f"welcome live paint exposed pane tabs: {panes!r}")
    assert_true(rail_copy is None, f"welcome live paint exposed rail body: {rail_copy!r}")


def assert_clean_composer(raw: bytes, payload: bytes, size: str) -> None:
    text = plain(raw)
    protocol = payload.decode("ascii").removeprefix("\x1b")
    workspace_visible = "Workspace — the whole search" in text or re.search(r"(?m)^ Workspace\s*$", text)
    assert_true(bool(workspace_visible), f"{size} mouse action did not route to Workspace")
    assert_true("Ask about the search" in text, f"{size} Workspace composer was not painted")
    assert_true(protocol not in text, f"{size} mouse protocol appeared as composer text: {protocol!r}")
    assert_true("[<0;" not in text, f"{size} paint leaked SGR mouse protocol into visible text")


def terminate_fail_closed(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=1.0)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            pass


def main() -> int:
    if not sys.platform.startswith("linux"):
        raise BenchmarkFailure(f"B16 requires Linux PTY semantics, got {sys.platform}")
    workspace = tempfile.mkdtemp(prefix="jobos-b16-pty-", dir="/tmp")
    assert_true(os.path.realpath(workspace).startswith("/tmp/"), "JOBOS_HOME escaped /tmp")
    process: subprocess.Popen[bytes] | None = None
    master: int | None = None
    raw_all = bytearray()
    deadline = time.monotonic() + TIMEOUT_SECONDS
    try:
        process, master = spawn_tui(workspace)

        welcome = wait_for(
            master, deadline, "140x42 welcome paint",
            lambda data: b"\x1b[?1000h" in data and "WELCOME TO JOBOS" in plain(data).upper(),
        )
        raw_all.extend(welcome)
        assert_true(b"\x1b[?1000h" in welcome, "missing SGR 1000 enable bytes")
        assert_true(b"\x1b[?1006h" in welcome, "missing SGR 1006 enable bytes")
        assert_true(b"\x1b[?2026h" in welcome, "PTY did not mount the interactive Ink paint path")
        assert_welcome_covers_board(welcome)

        # Dismiss first-run welcome with a real terminal Escape key.
        send(master, b"\x1b")
        board = wait_for(master, deadline, "dismissed 140x42 board", lambda data: "No jobs yet" in plain(data))
        raw_all.extend(board)

        # Route an actual terminal SGR press at 140x42 from Jobs to Workspace.
        wide_mouse = b"\x1b[<0;124;1M"
        send(master, wide_mouse)
        wide_paint = wait_for(master, deadline, "140x42 Workspace mouse action",
                              lambda data: "Ask about the search" in plain(data))
        raw_all.extend(wide_paint)
        assert_clean_composer(wide_paint, wide_mouse, "140x42")

        # Send a visible local message by clicking the live composer. If Ink's
        # parser leaked the SGR bytes, they would appear beside this sentinel in
        # the chat log or composer repaint.
        sentinel = b"B16 protocol quarantine"
        send(master, sentinel)
        typed = wait_for(master, deadline, "140x42 typed composer sentinel",
                         lambda data: sentinel.decode() in plain(data))
        raw_all.extend(typed)
        composer_mouse = b"\x1b[<0;135;40M"
        send(master, composer_mouse)
        wide_composer = wait_for(master, deadline, "140x42 mouse composer submit",
                                 lambda data: "YOU" in plain(data)
                                 and sentinel.decode() in plain(data))
        raw_all.extend(wide_composer)
        visible = plain(wide_composer)
        assert_true("[<0;" not in visible, "140x42 composer submit leaked SGR protocol as text")
        assert_true(composer_mouse.decode("ascii").removeprefix("\x1b") not in visible,
                    "140x42 composer submit painted its mouse payload")

        # Resize the same mounted process, then leave Workspace with Esc so a
        # size-specific SGR coordinate must route back into it.
        set_size(master, *NARROW)
        os.killpg(process.pid, signal.SIGWINCH)
        resized = wait_for(master, deadline, "80x24 resize paint",
                           lambda data: "Ask about the search" in plain(data) and "JobOS" in plain(data))
        raw_all.extend(resized)
        send(master, b"\x1b")
        narrow_board = wait_for(master, deadline, "80x24 board", lambda data: "No jobs yet" in plain(data))
        raw_all.extend(narrow_board)
        # Drain any trailing Ink diff from the board transition so it cannot be
        # mistaken for evidence from the following mouse action.
        raw_all.extend(read_available(master, wait=0.2))

        narrow_mouse = b"\x1b[<0;64;1M"
        send(master, narrow_mouse)
        narrow_paint = wait_for(master, deadline, "80x24 Workspace mouse action",
                                lambda data: "Ask about the search" in plain(data)
                                and sentinel.decode() in plain(data))
        raw_all.extend(narrow_paint)
        assert_clean_composer(narrow_paint, narrow_mouse, "80x24")

        # Clean Ctrl-C must unmount Ink and restore both terminal modes.
        before_exit = bytes(raw_all)
        for mode in (b"1000", b"1006"):
            enable = b"\x1b[?" + mode + b"h"
            disable = b"\x1b[?" + mode + b"l"
            assert_true(disable not in before_exit[before_exit.find(enable) + len(enable):],
                        f"SGR {mode.decode()} disabled before interactions completed")
        exit_offset = len(raw_all)
        send(master, b"\x03")
        while process.poll() is None and time.monotonic() < deadline:
            raw_all.extend(read_available(master))
            time.sleep(0.02)
        assert_true(process.poll() is not None, "timeout waiting for clean TUI exit")
        raw_all.extend(read_available(master))
        assert_true(process.returncode == 0, f"real TUI exited {process.returncode}: {plain(bytes(raw_all))[-800:]!r}")
        raw = bytes(raw_all)
        exit_tail = raw[exit_offset:]
        assert_true(b"\x1b[?1000l" in exit_tail, "missing SGR 1000 disable bytes after clean-exit signal")
        assert_true(b"\x1b[?1006l" in exit_tail, "missing SGR 1006 disable bytes after clean-exit signal")
        assert_true(b"Hermes ACP guest session started" not in raw and b"acp_spawn_failed" not in raw,
                    "--agent off unexpectedly started or attempted an ACP guest")


        digest = hashlib.sha256(raw).hexdigest()
        print(
            f"B16 PASS: real Ink PTY captured {len(raw)} raw bytes (sha256 {digest}); "
            "140x42 -> 80x24 SGR actions routed, welcome covered navigation, "
            "composer stayed protocol-clean, and 1000/1006 modes were restored."
        )
        return 0
    finally:
        cleanup_errors: list[str] = []
        if process is not None:
            terminate_fail_closed(process)
            if process.poll() is None:
                cleanup_errors.append("PTY child process group survived SIGTERM/SIGKILL cleanup")
        if master is not None:
            try:
                os.close(master)
            except OSError as error:
                cleanup_errors.append(f"could not close PTY master: {error}")
        try:
            shutil.rmtree(workspace)
        except OSError as error:
            cleanup_errors.append(f"could not remove isolated JOBOS_HOME: {error}")
        if os.path.exists(workspace):
            cleanup_errors.append(f"isolated JOBOS_HOME still exists: {workspace}")
        if cleanup_errors:
            raise BenchmarkFailure("cleanup failed closed: " + "; ".join(cleanup_errors))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BenchmarkFailure as error:
        print(f"B16 FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
