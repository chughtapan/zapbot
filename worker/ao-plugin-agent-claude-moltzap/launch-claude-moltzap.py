#!/usr/bin/env python3

import os
import pty
import re
import select
import signal
import sys
import termios
import time
import tty

PROMPT_MARKERS = (
    "i am using this for local development",
    "loading development channels",
    "--dangerously-load-development-channels is for local channel development",
)
PROMPT_KEYWORDS = ("loading", "development", "channels", "confirm")
ANSI_ESCAPE_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\\\))")


def main() -> int:
    if len(sys.argv) != 2:
        print(
            "usage: launch-claude-moltzap.py '<claude command>'",
            file=sys.stderr,
        )
        return 2

    command = sys.argv[1]
    child_pid, child_fd = pty.fork()
    if child_pid == 0:
        os.environ.pop("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", None)
        os.execlp("bash", "bash", "-lc", command)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    stdin_is_tty = os.isatty(stdin_fd)
    original_termios = None
    if stdin_is_tty:
        original_termios = termios.tcgetattr(stdin_fd)
        tty.setraw(stdin_fd)

    confirmed = False
    seen = ""
    startup_poke_index = 0
    start_time = time.monotonic()
    startup_poke_schedule = (0.1, 0.35, 0.8)

    def forward_signal(signum: int, _frame: object) -> None:
        try:
            os.kill(child_pid, signum)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGINT, forward_signal)
    signal.signal(signal.SIGTERM, forward_signal)

    try:
        while True:
            if (
                not confirmed
                and startup_poke_index < len(startup_poke_schedule)
                and (time.monotonic() - start_time) >= startup_poke_schedule[startup_poke_index]
            ):
                os.write(child_fd, b"\r")
                startup_poke_index += 1

            read_fds = [child_fd]
            if stdin_is_tty:
                read_fds.append(stdin_fd)
            ready, _, _ = select.select(read_fds, [], [])

            if child_fd in ready:
                try:
                    chunk = os.read(child_fd, 4096)
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                os.write(stdout_fd, chunk)
                if not confirmed:
                    seen = (seen + chunk.decode("utf-8", errors="ignore"))[-16384:]
                    if should_confirm_prompt(seen):
                        os.write(child_fd, b"\r")
                        confirmed = True

            if stdin_is_tty and stdin_fd in ready:
                try:
                    user_input = os.read(stdin_fd, 4096)
                except OSError:
                    user_input = b""
                if not user_input:
                    continue
                os.write(child_fd, user_input)
    finally:
        if stdin_is_tty and original_termios is not None:
            termios.tcsetattr(stdin_fd, termios.TCSADRAIN, original_termios)

    _, status = os.waitpid(child_pid, 0)
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


def normalize_terminal_text(raw: str) -> str:
    without_ansi = ANSI_ESCAPE_RE.sub(" ", raw)
    collapsed = re.sub(r"\s+", " ", without_ansi)
    return collapsed.strip().lower()


def should_confirm_prompt(raw: str) -> bool:
    normalized = normalize_terminal_text(raw)
    if any(marker in normalized for marker in PROMPT_MARKERS):
        return True
    lowered = raw.lower()
    return all(keyword in lowered for keyword in PROMPT_KEYWORDS)


if __name__ == "__main__":
    raise SystemExit(main())
