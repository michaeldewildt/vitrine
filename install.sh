#!/bin/sh
# vitrine install — idempotent.
#
# What it does:
#   1. `pi install <repo>` — registers the extension package in place (the repo
#      tree is used directly; a git pull updates the live extension).
#   2. Writes ~/.local/bin/vitrine-run and ~/.local/bin/vitrine as `#!/bin/sh`
#      exec-wrappers around the repo's entry points, with a pinned absolute
#      bun path.
#
# Why a pinned bun path: the tile spawn runs in the compositor's environment
# (Hyprland -> hl.dsp.exec_cmd -> sh -c), which is NOT a login shell — a bare
# `bun` (mise shim discovery via shell-init PATH) may not resolve there.
#
# Which path is pinned: the REAL bun binary, resolved via `mise where bun`
# (a version-pinned install dir; `.../bin/bun` is the standalone binary). NOT
# the mise shim — the shim dispatches on the calling directory's tool
# versions and is not a stable target (and `readlink -f` on it would resolve
# to the mise CLI, which treats the script path as a subcommand). A guard
# proves the pinned path actually runs bun before the wrappers are written.
#
# Note: a bun upgrade that removes the old install (or a mise reinstall)
# orphans the pinned path — re-run this script; the guard fails loudly
# otherwise.

set -eu

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

# --- 0. the bun pin (validated before anything is installed) -----------------
BUN=""
if command -v mise >/dev/null 2>&1; then
	WHERE="$(mise where bun 2>/dev/null || true)"
	if [ -n "$WHERE" ] && [ -x "$WHERE/bin/bun" ]; then
		BUN="$WHERE/bin/bun"
	fi
fi
if [ -z "$BUN" ]; then
	BUN="$(command -v bun || true)"
fi
if [ -z "$BUN" ]; then
	echo "vitrine: install: no bun found (mise or PATH) — cannot pin the interpreter" >&2
	exit 1
fi
# Guard: the pin must run as bun. `bun -e` prints the interpreter's own path
# (containing "bun"); the mise CLI has no `-e` flag (exits 2); the shim errors
# without a resolvable version (exits 1, no output). The output must be a bun
# path — an exit-status check alone cannot tell these apart.
EXECPATH="$("$BUN" -e 'console.log(process.execPath)' 2>/dev/null || true)"
case "$EXECPATH" in
	*bun*) ;;
	*)
		echo "vitrine: install: refusing to pin '$BUN' — it does not run as bun (execPath: '${EXECPATH:-<none>}')" >&2
		exit 1
		;;
esac

# --- 1. the pi extension package ---------------------------------------------
pi install "$REPO_ROOT"

# --- 2. the ~/.local/bin exec-wrappers ---------------------------------------
mkdir -p "$HOME/.local/bin"

for name in vitrine-run vitrine; do
	case "$name" in
		vitrine-run) entry="src/vitrine-run.ts" ;;
		vitrine)     entry="src/cli.ts" ;;
	esac
	tmp="$HOME/.local/bin/.${name}.tmp"
	cat > "$tmp" <<EOF
#!/bin/sh
# vitrine exec-wrapper (written by install.sh; re-run it after a bun upgrade)
exec "$BUN" "$REPO_ROOT/$entry" "\$@"
EOF
	chmod 0755 "$tmp"
	# atomic swap (tmp+mv, house style): a concurrent tile spawn never sees a
	# truncated wrapper
	mv "$tmp" "$HOME/.local/bin/$name"
done

echo "vitrine: installed"
echo "  extension: pi package in place (repo: $REPO_ROOT)"
echo "  bun:       $BUN (real binary; re-run install.sh after a bun upgrade)"
echo "  bin:       ~/.local/bin/vitrine-run, ~/.local/bin/vitrine"
echo "  config:    ~/.vitrine/config.json (auto-created on first use)"
