"""The cavelon CLI and MCP server for building Cavelon solutions with a coding agent.

This package carries the standalone `cavelon` executable as its script, so
`pip`, `pipx` and `uv` put the same `cavelon` on the PATH as the install
scripts do. Python only finds it for `python -m cavelon`.
"""

from __future__ import annotations

import os
import sys
import sysconfig

__all__ = ["find_cavelon_bin"]


def find_cavelon_bin() -> str:
    """The path of the `cavelon` executable this package installed."""
    name = "cavelon.exe" if sys.platform == "win32" else "cavelon"
    folders = [sysconfig.get_path("scripts")]
    # A user install (pip install --user) puts the scripts in the user scheme.
    get_preferred = getattr(sysconfig, "get_preferred_scheme", None)
    user_scheme = get_preferred("user") if get_preferred else ("nt_user" if os.name == "nt" else "posix_user")
    try:
        folders.append(sysconfig.get_path("scripts", scheme=user_scheme))
    except KeyError:
        pass
    for folder in folders:
        candidate = os.path.join(folder, name)
        if os.path.isfile(candidate):
            return candidate
    raise FileNotFoundError(f"The cavelon executable is not in {' or '.join(folders)}; reinstall the cavelon package.")
