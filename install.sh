#!/bin/sh
# Install cavelon, the Cavelon dev-kit's CLI and MCP server, on macOS or Linux:
#
#   curl -fsSL https://github.com/goodguys-gmbh/cavelon-dev-kit/releases/latest/download/install.sh | sh
#
# It downloads the standalone executable for this system from the GitHub
# release, checks it against the release's checksums.txt, and puts it into
# ~/.local/bin (no root, no Node.js). If that folder is not on your PATH, it
# adds it once to your shell's startup file and says which. Running it again
# updates cavelon, then offers plugin/skill updates and a personal MCP YOLO mode.
#
# Options (after `sh -s --` when piped):
#   --version X.Y.Z    a given release instead of the latest   (CAVELON_VERSION)
#   --dir DIR          install into DIR instead of ~/.local/bin (CAVELON_INSTALL_DIR)
#   --no-modify-path   never change a shell startup file       (CAVELON_NO_MODIFY_PATH=1)
#   --update-agents / --skip-agent-update  refresh or keep plugins and skills (CAVELON_UPDATE_AGENTS=1/0)
#   --yolo / --no-yolo  enable or disable YOLO for new MCP sessions (CAVELON_MCP_MODE=yolo/standard)
#   --non-interactive  skip questions, keep unspecified choices (CAVELON_NON_INTERACTIVE=1)
# CAVELON_DOWNLOAD_URL names a folder that holds the release's files instead of
# the GitHub release: a mirror's URL, or a local folder such as the bin folder
# of the offline bundle.
set -eu

REPOSITORY="goodguys-gmbh/cavelon-dev-kit"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'cavelon install: %s\n' "$*" >&2
  exit 1
}

version="${CAVELON_VERSION:-}"
dir="${CAVELON_INSTALL_DIR:-}"
modify_path=1
update_agents="${CAVELON_UPDATE_AGENTS:-}"
mcp_mode="${CAVELON_MCP_MODE:-}"
non_interactive="${CAVELON_NON_INTERACTIVE:-0}"
case "${CAVELON_NO_MODIFY_PATH:-}" in
  1 | true | yes) modify_path=0 ;;
  *) ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || fail "--version needs a version, such as 0.1.2."
      version="$2"
      shift 2
      ;;
    --version=*) version="${1#--version=}"; shift ;;
    --dir)
      [ $# -ge 2 ] || fail "--dir needs a folder."
      dir="$2"
      shift 2
      ;;
    --dir=*) dir="${1#--dir=}"; shift ;;
    --no-modify-path) modify_path=0; shift ;;
    --update-agents) update_agents=1; shift ;;
    --skip-agent-update) update_agents=0; shift ;;
    --yolo) mcp_mode=yolo; shift ;;
    --no-yolo) mcp_mode=standard; shift ;;
    --non-interactive) non_interactive=1; shift ;;
    -h | --help)
      sed -n '2,21p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
      exit 0
      ;;
    *) fail "unknown option $1 (run install.sh --help)." ;;
  esac
done
case "$update_agents" in "" | 0 | 1) ;; *) fail "CAVELON_UPDATE_AGENTS must be 1 or 0." ;; esac
case "$mcp_mode" in "" | standard | yolo) ;; *) fail "CAVELON_MCP_MODE must be standard or yolo." ;; esac
case "$non_interactive" in 0 | 1) ;; *) fail "CAVELON_NON_INTERACTIVE must be 1 or 0." ;; esac

[ -n "${HOME:-}" ] || fail "HOME is not set."
[ -n "$dir" ] || dir="$HOME/.local/bin"
version="${version#v}"
case "$version" in
  "" | [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "\"$version\" is not a version; write it like 0.1.2." ;;
esac

# --- the system ---------------------------------------------------------------

os="$(uname -s)"
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*)
    fail "on Windows, install with PowerShell: irm https://github.com/$REPOSITORY/releases/latest/download/install.ps1 | iex"
    ;;
  *) fail "there is no cavelon executable for $os; run it through Node.js instead: npx -y @cavelon/cli --version" ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "there is no cavelon executable for $os on $arch; run it through Node.js instead: npx -y @cavelon/cli --version" ;;
esac
# A shell running under Rosetta reports x86_64 on an Apple silicon Mac.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
if [ "$os" = linux ]; then
  # The executables need glibc; Alpine and other musl systems use npx.
  if [ -e /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
    fail "this Linux uses musl, and the cavelon executable needs glibc; run it through Node.js instead: npx -y @cavelon/cli --version"
  fi
fi

asset="cavelon-$os-$arch"

# --- where from ---------------------------------------------------------------

if [ -n "${CAVELON_DOWNLOAD_URL:-}" ]; then
  base="${CAVELON_DOWNLOAD_URL%/}"
elif [ -n "$version" ]; then
  base="https://github.com/$REPOSITORY/releases/download/v$version"
else
  base="https://github.com/$REPOSITORY/releases/latest/download"
fi

download() { # url file
  case "$1" in
    https://*) https_only=1 ;;
    *://*) https_only=0 ;;
    # A local folder, such as the offline bundle's bin. Only the content is
    # copied: macOS's cp would carry over a quarantine flag.
    *) cat "$1" >"$2"; return ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    if [ "$https_only" = 1 ]; then
      curl --fail --location --silent --show-error --retry 3 --proto '=https' --tlsv1.2 --output "$2" "$1"
    else
      curl --fail --location --silent --show-error --retry 3 --output "$2" "$1"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [ "$https_only" = 1 ]; then
      wget --quiet --https-only --tries=3 --output-document="$2" "$1"
    else
      wget --quiet --tries=3 --output-document="$2" "$1"
    fi
  else
    fail "neither curl nor wget is installed; install one of them and run this again."
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | sed 's/^.*= //'
  else
    fail "found no SHA-256 tool (sha256sum, shasum or openssl) to check the download with."
  fi
}

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t cavelon)"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

say "Downloading $asset${version:+ $version} from $base ..."
download "$base/checksums.txt" "$tmp/checksums.txt" || fail "could not download $base/checksums.txt${version:+ (is $version a released version?)}."
download "$base/$asset" "$tmp/$asset" || fail "could not download $base/$asset."

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp/checksums.txt")"
[ -n "$expected" ] || fail "checksums.txt lists no $asset."
actual="$(sha256 "$tmp/$asset")"
[ "$expected" = "$actual" ] || fail "the download's SHA-256 checksum does not match checksums.txt (expected $expected, got $actual); nothing was installed."
chmod 755 "$tmp/$asset"
if ! ran="$("$tmp/$asset" --version 2>&1)"; then
  fail "the downloaded cavelon does not run on this system: $ran"
fi
# The first line is the version; later releases add how cavelon was installed.
new_version="$(printf '%s\n' "$ran" | head -n 1)"

# --- install ------------------------------------------------------------------

target="$dir/cavelon"
old_version=""
if [ -x "$target" ]; then old_version="$({ "$target" --version 2>/dev/null || true; } | head -n 1)"; fi
mkdir -p "$dir" || fail "could not create $dir."
# Copy next to the target, then rename over it: a running cavelon keeps its file.
cp "$tmp/$asset" "$dir/.cavelon.$$" || fail "could not write to $dir."
chmod 755 "$dir/.cavelon.$$"
mv -f "$dir/.cavelon.$$" "$target" || {
  rm -f "$dir/.cavelon.$$"
  fail "could not replace $target."
}

if [ -z "$old_version" ]; then
  say "Installed cavelon $new_version to $target."
elif [ "$old_version" = "$new_version" ]; then
  say "cavelon $new_version is installed in $target and up to date."
else
  say "Updated cavelon $old_version to $new_version in $target."
fi

# --- PATH ---------------------------------------------------------------------

on_path=0
case ":${PATH:-}:" in *":$dir:"*) on_path=1 ;; esac

# The line written to a startup file names the folder through $HOME where it can.
case "$dir" in
  "$HOME"/*) shown_dir="\$HOME/${dir#"$HOME"/}" ;;
  *) shown_dir="$dir" ;;
esac
marker="# Added by the cavelon installer"

add_line() { # file line
  if [ -f "$1" ] && grep -qxF "$2" "$1"; then return 1; fi
  mkdir -p "$(dirname "$1")"
  printf '\n%s\n%s\n' "$marker" "$2" >>"$1"
}

if [ "$on_path" = 0 ]; then
  rc=""
  line="export PATH=\"$shown_dir:\$PATH\""
  case "$(basename "${SHELL:-sh}")" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      rc="$HOME/.bashrc"
      # Terminal windows on macOS start login shells, which read the first of
      # these that exists; creating .bash_profile would hide an existing .profile.
      if [ "$os" = darwin ]; then
        rc="$HOME/.profile"
        [ -f "$HOME/.bash_login" ] && rc="$HOME/.bash_login"
        [ -f "$HOME/.bash_profile" ] && rc="$HOME/.bash_profile"
      fi
      ;;
    fish)
      rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/cavelon.fish"
      line="fish_add_path \"$dir\""
      ;;
    *) rc="$HOME/.profile" ;;
  esac
  # shellcheck disable=SC2088 # a tilde to read, not to expand
  case "$rc" in "$HOME"/*) shown_rc="~/${rc#"$HOME"/}" ;; *) shown_rc="$rc" ;; esac
  if [ "$modify_path" = 0 ]; then
    say ""
    say "$dir is not on your PATH. Add it in your shell's startup file:"
    say "  $line"
  elif add_line "$rc" "$line"; then
    say ""
    say "Added $shown_dir to your PATH in $shown_rc. Open a new terminal, or run this in this one:"
    say "  export PATH=\"$shown_dir:\$PATH\""
  else
    say ""
    say "$shown_rc already puts $shown_dir on your PATH. Open a new terminal, or run this in this one:"
    say "  export PATH=\"$shown_dir:\$PATH\""
  fi
else
  found="$(command -v cavelon 2>/dev/null || true)"
  if [ -n "$found" ] && [ "$found" != "$target" ]; then
    say ""
    say "Another cavelon comes first on your PATH: $found. Remove it (npm uninstall -g @cavelon/cli if npm installed it), or run $target."
  fi
fi

# --- next ---------------------------------------------------------------------

say ""
if "$target" setup --help 2>/dev/null | grep -q -- '--installer'; then
  set -- setup --installer
  case "$update_agents" in 1) set -- "$@" --update ;; 0) set -- "$@" --skip-update ;; esac
  [ -z "$mcp_mode" ] || set -- "$@" --mcp-mode "$mcp_mode"
  # curl | sh uses stdin for the script. Questions must read the controlling
  # terminal; CI and unattended installs never consume or wait on that pipe.
  if [ "$non_interactive" = 0 ] && [ -t 2 ] && ( : </dev/tty ) 2>/dev/null; then
    terminal=/dev/tty
    if [ "$os" = darwin ]; then
      # Bun cannot poll macOS's /dev/tty alias. The real device works; `tty`
      # on the alias just returns /dev/tty again, so ask ps for this shell's.
      terminal=""
      terminal_name="$(ps -o tty= -p "$$" 2>/dev/null | tr -d '[:space:]')"
      case "$terminal_name" in
        "" | *[!a-zA-Z0-9/_-]*) ;;
        *) [ ! -c "/dev/$terminal_name" ] || terminal="/dev/$terminal_name" ;;
      esac
    fi
    if [ -n "$terminal" ] && ( : <"$terminal" ) 2>/dev/null; then
      "$target" "$@" <"$terminal" || fail "CLI installed successfully, but agent setup was incomplete. Retry with $target setup --installer."
    else
      say "Could not find a usable terminal device. Keeping unspecified setup choices; run $target setup --installer in your terminal to choose them."
      "$target" "$@" --non-interactive || fail "CLI installed successfully, but agent setup was incomplete. Retry with $target setup --installer."
    fi
  else
    "$target" "$@" --non-interactive || fail "CLI installed successfully, but agent setup was incomplete. Retry with $target setup --installer."
  fi
elif [ -n "$update_agents$mcp_mode" ]; then
  fail "CLI installed successfully, but this older release does not support installer agent updates or the saved MCP mode. Run cavelon setup manually."
elif "$target" commands --json 2>/dev/null | grep -q '"command":"setup"'; then
  say "Next: cavelon setup"
else
  say "Next: log in to your Cavelon instance, with its address:"
  say "  cavelon login --instance https://cavelon.example.com"
fi
