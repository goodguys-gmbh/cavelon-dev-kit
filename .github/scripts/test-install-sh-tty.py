#!/usr/bin/env python3
"""Exercise piped installer questions with a native executable and a real PTY.

The answers configure only a fresh synthetic profile, never an instance or a
guarded operation. macOS must use the terminal device: Bun hangs on /dev/tty.
"""

import argparse
import errno
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base", help="release folder or loopback URL")
    parser.add_argument("--installer", type=Path, default=Path(__file__).resolve().parents[2] / "install.sh")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cavelon-installer-tty-") as temporary:
        home = Path(temporary)
        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(home),
            "SHELL": "/bin/sh",
            "TERM": "dumb",
            "CAVELON_DOWNLOAD_URL": args.base,
            "CAVELON_CONFIG_DIR": str(home / "config"),
            "CAVELON_CACHE_DIR": str(home / "cache"),
            "CAVELON_NO_UPDATE_CHECK": "1",
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_CACHE_HOME": str(home / ".cache"),
        }
        # The installer's stdin is a pipe; only its controlling terminal can
        # answer. pty.fork gives the shell an actual controlling terminal.
        pid, terminal = pty.fork()
        if pid == 0:
            os.chdir(home)
            os.execve("/bin/sh", ["sh", "-c", f"cat {shlex.quote(str(args.installer.resolve()))} | sh -s -- --no-modify-path"], env)
        output = bytearray()
        questions = [(b"[Y/n]", b"n\n"), (b"[Enter] keep current: ", b"y\n")]
        answered = 0
        status = None
        reading = True
        deadline = time.monotonic() + 45
        try:
            while time.monotonic() < deadline:
                if select.select([terminal] if reading else [], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(terminal, 65536)
                    except OSError as exc:
                        if exc.errno != errno.EIO:
                            raise
                        chunk = b""
                    if not chunk:
                        reading = False
                    else:
                        output.extend(chunk)
                        if answered < len(questions) and questions[answered][0] in output:
                            os.write(terminal, questions[answered][1])
                            answered += 1
                child, child_status = os.waitpid(pid, os.WNOHANG)
                if child:
                    status = child_status
                    break
            if status is None:
                child, child_status = os.waitpid(pid, os.WNOHANG)
                if child:
                    status = child_status
            if status is None:
                raise AssertionError("installer did not finish within 45 seconds")
            assert os.waitstatus_to_exitcode(status) == 0, "installer failed"
            assert answered == 2, "installer did not ask both questions"
            assert json.loads((home / "config" / "automation.json").read_text(encoding="utf-8"))["mcp_mode"] == "yolo"
            print("Piped installer: both PTY answers read; synthetic profile saved YOLO.")
        finally:
            if status is None:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
            os.close(terminal)
            print(output.decode("utf-8", errors="replace"))


if __name__ == "__main__":
    main()
