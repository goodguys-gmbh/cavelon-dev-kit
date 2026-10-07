"""Build the `cavelon` wheels for PyPI from a release's standalone executables.

    python3 -I packaging/pypi/build_wheels.py <release folder> <version> <out folder> [asset ...]

One wheel per executable the release folder holds (or per asset named), each
tagged for the platform the executable runs on and carrying it as the script
`cavelon`, as ruff and uv ship theirs: pip, pipx and uv put it on the PATH, and
Python is not needed to run it. The wheel holds no Python package, only the
script and a marker in the environment's data folder from which `cavelon`
tells that a wheel installed it (cli/src/install.ts).

The folders it reads and writes must lie inside the folder it runs in (the
repository's checkout in CI), and the version must be a release version.

Standard library only, and deterministic: the same executables and version give
the same bytes.
"""

from __future__ import annotations

import base64
import hashlib
import re
import sys
import zipfile
from pathlib import Path

NAME = "cavelon"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

# The platform tag of each release executable. The minimums are the
# executables' own, as Bun builds them (cli/scripts/build-executable.mjs):
# both Linux builds link against glibc symbols up to 2.17, and both macOS
# builds name 13.0 as their minimum (LC_BUILD_VERSION). No musl build exists,
# so Alpine gets no wheel rather than one that fails to start.
PLATFORM_TAGS = {
    "cavelon-linux-x64": "manylinux_2_17_x86_64.manylinux2014_x86_64",
    "cavelon-linux-arm64": "manylinux_2_17_aarch64.manylinux2014_aarch64",
    "cavelon-darwin-arm64": "macosx_13_0_arm64",
    "cavelon-darwin-x64": "macosx_13_0_x86_64",
    "cavelon-windows-x64.exe": "win_amd64",
}

SUMMARY = "The Cavelon dev-kit CLI and MCP server for building Cavelon solutions with a coding agent."
PROJECT_URLS = {
    "Homepage": "https://github.com/goodguys-gmbh/cavelon-dev-kit",
    "Documentation": "https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/docs/installation.md",
    "Changelog": "https://github.com/goodguys-gmbh/cavelon-dev-kit/blob/main/CHANGELOG.md",
    "Issues": "https://github.com/goodguys-gmbh/cavelon-dev-kit/issues",
}

# Zip entries carry a fixed time, so a rebuild gives the same wheel.
FIXED_TIME = (1980, 1, 1, 0, 0, 0)
MARKER_TEXT = "Installed by the cavelon wheel from PyPI; cavelon reads it to name the command that updates it.\n"

SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$")
PRE = {"alpha": "a", "beta": "b", "rc": "rc"}


def pep440(version: str) -> str:
    """The release's version (cli/package.json, the tag without v) as PyPI spells it: 1.2.0-rc.1 is 1.2.0rc1."""
    match = SEMVER.match(version)
    if not match:
        raise SystemExit(f"{version!r} is not a version this script maps to PEP 440 (X.Y.Z or X.Y.Z-alpha|beta|rc.N).")
    major, minor, patch, pre, number = match.groups()
    return f"{int(major)}.{int(minor)}.{int(patch)}" + (f"{PRE[pre]}{int(number)}" if pre else "")


def metadata(version: str) -> str:
    lines = [
        "Metadata-Version: 2.4",
        f"Name: {NAME}",
        f"Version: {version}",
        f"Summary: {SUMMARY}",
        "License-Expression: Apache-2.0",
        "License-File: LICENSE",
        "Requires-Python: >=3.8",
        "Keywords: cavelon,cli,mcp,coding-agent,claude-code,codex",
        "Classifier: Development Status :: 4 - Beta",
        "Classifier: Environment :: Console",
        "Classifier: Intended Audience :: Developers",
        "Classifier: Operating System :: MacOS",
        "Classifier: Operating System :: Microsoft :: Windows",
        "Classifier: Operating System :: POSIX :: Linux",
        "Classifier: Topic :: Software Development :: Build Tools",
        *(f"Project-URL: {label}, {url}" for label, url in PROJECT_URLS.items()),
        "Description-Content-Type: text/markdown",
    ]
    return "\n".join(lines) + "\n\n" + (HERE / "README.md").read_text(encoding="utf-8")


def wheel_file(tag: str) -> str:
    tags = [f"py3-none-{platform}" for platform in tag.split(".")]
    return "\n".join(["Wheel-Version: 1.0", "Generator: cavelon build_wheels.py", "Root-Is-Purelib: false", *(f"Tag: {t}" for t in tags)]) + "\n"


def record_hash(data: bytes) -> str:
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode("ascii")


def build(executable: Path, version: str, out: Path) -> Path:
    asset = executable.name
    tag = PLATFORM_TAGS[asset]
    script = f"{NAME}.exe" if asset.endswith(".exe") else NAME
    data_dir = f"{NAME}-{version}.data"
    dist_info = f"{NAME}-{version}.dist-info"
    files: list[tuple[str, bytes, int]] = [
        (f"{data_dir}/scripts/{script}", executable.read_bytes(), 0o755),
        (f"{data_dir}/data/share/{NAME}/pypi", MARKER_TEXT.encode("utf-8"), 0o644),
        (f"{dist_info}/METADATA", metadata(version).encode("utf-8"), 0o644),
        (f"{dist_info}/WHEEL", wheel_file(tag).encode("utf-8"), 0o644),
        (f"{dist_info}/licenses/LICENSE", (ROOT / "LICENSE").read_bytes(), 0o644),
    ]
    record = "".join(f"{name},{record_hash(data)},{len(data)}\n" for name, data, _ in files) + f"{dist_info}/RECORD,,\n"
    files.append((f"{dist_info}/RECORD", record.encode("utf-8"), 0o644))
    target = out / f"{NAME}-{version}-py3-none-{tag}.whl"
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as wheel:
        for name, data, mode in files:
            info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            info.external_attr = (0o100000 | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            wheel.writestr(info, data)
    return target


def inside_cwd(given: str, what: str) -> Path:
    """`given` resolved, refused unless it lies inside the folder the script runs in."""
    base = Path.cwd().resolve()
    path = (base / given).resolve()
    if path != base and base not in path.parents:
        raise SystemExit(f"The {what} {given!r} is outside {base}; name a folder inside it.")
    return path


def main(argv: list[str]) -> None:
    if len(argv) < 3:
        raise SystemExit(__doc__)
    release, version, out = inside_cwd(argv[0], "release folder"), pep440(argv[1].removeprefix("v")), inside_cwd(argv[2], "out folder")
    named = argv[3:]
    unknown = [asset for asset in named if asset not in PLATFORM_TAGS]
    if unknown:
        raise SystemExit(f"No platform tag for {', '.join(unknown)}; known: {', '.join(PLATFORM_TAGS)}.")
    assets = named or [asset for asset in PLATFORM_TAGS if (release / asset).is_file()]
    missing = [asset for asset in assets if not (release / asset).is_file()]
    if missing or not assets:
        raise SystemExit(f"{release} holds no {', '.join(missing or PLATFORM_TAGS)}.")
    out.mkdir(parents=True, exist_ok=True)
    for asset in assets:
        print(build(release / asset, version, out))


if __name__ == "__main__":
    main(sys.argv[1:])
