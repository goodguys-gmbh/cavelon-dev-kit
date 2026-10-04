#!/usr/bin/env bash
# Test install.sh against a release folder served on 127.0.0.1 (serve.mjs): a
# fresh install through `curl | sh`, the PATH line in the shell's startup file,
# a re-run, a checksum that does not match, and --dir with --no-modify-path.
#
#   .github/scripts/test-install-sh.sh <base-url> <expected-version>
set -euo pipefail

base="$1"
version="$2"
repo="$(cd "$(dirname "$0")/../.." && pwd)"

home="$(mktemp -d)"
trap 'rm -rf "$home"' EXIT
# A clean account: no ~/.local/bin on the PATH, the system's default shell.
export HOME="$home"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
if [ "$(uname -s)" = Darwin ]; then
  export SHELL=/bin/zsh
  rc="$home/.zshrc"
else
  export SHELL=/bin/bash
  rc="$home/.bashrc"
fi
export CAVELON_DOWNLOAD_URL="$base"
bin="$home/.local/bin/cavelon"

check() {
  printf '  ok: %s\n' "$1"
}

echo "== curl | sh, with $SHELL"
out="$(curl -fsSL "$base/install.sh" | sh)"
printf '%s\n' "$out"
test "$("$bin" --version)" = "$version"
grep -q "Installed cavelon $version" <<<"$out"
grep -q "Next: " <<<"$out"
test "$(grep -c 'Added by the cavelon installer' "$rc")" = 1
# shellcheck disable=SC2016 # the line as written, unexpanded
grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "$rc"
check "installed $version, added the PATH line to $rc"

# A new interactive shell reads the startup file and finds cavelon.
found="$(env -i HOME="$home" PATH="/usr/bin:/bin" TERM=dumb "$SHELL" -i -c 'command -v cavelon' 2>/dev/null | tail -n 1)"
test "$found" = "$bin"
check "a new $SHELL finds $found"

set +e
"$bin" whoami --json </dev/null >/dev/null 2>&1
code=$?
set -e
test "$code" = 2
check "the installed cavelon runs (whoami without an instance: exit 2)"

echo "== run again: an update, nothing added twice"
out="$(sh "$repo/install.sh")"
printf '%s\n' "$out"
grep -q "up to date" <<<"$out"
test "$(grep -c 'Added by the cavelon installer' "$rc")" = 1
check "re-run changed nothing"

echo "== a checksum that does not match"
before="$(cksum <"$bin")"
set +e
out="$(CAVELON_DOWNLOAD_URL="$base/tampered" sh "$repo/install.sh" 2>&1)"
code=$?
set -e
printf '%s\n' "$out"
test "$code" = 1
grep -q "does not match" <<<"$out"
test "$(cksum <"$bin")" = "$before"
check "refused, the installed cavelon is unchanged"

echo "== --dir and --no-modify-path"
cp "$rc" "$home/rc.before"
out="$(sh "$repo/install.sh" --dir "$home/tools" --no-modify-path)"
printf '%s\n' "$out"
test "$("$home/tools/cavelon" --version)" = "$version"
cmp -s "$rc" "$home/rc.before"
grep -q "is not on your PATH" <<<"$out"
check "installed into --dir, no startup file changed"

echo "== a version that is not one"
set +e
out="$(sh "$repo/install.sh" --version latest 2>&1)"
code=$?
set -e
test "$code" = 1
grep -q "is not a version" <<<"$out"
check "refused"

echo "install.sh: all checks passed"
