"""`python -m cavelon`: runs the executable the package installed, with the same arguments."""

from __future__ import annotations

import os
import sys

from cavelon import find_cavelon_bin


def main() -> None:
    executable = find_cavelon_bin()
    if sys.platform == "win32":
        # Windows has no exec that replaces the process; wait for it and pass its exit code on.
        import subprocess

        sys.exit(subprocess.call([executable, *sys.argv[1:]]))
    os.execv(executable, [executable, *sys.argv[1:]])


if __name__ == "__main__":
    main()
