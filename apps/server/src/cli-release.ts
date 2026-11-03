export const CLI_RELEASE_BASE = 'https://github.com/Dodecahedr0x/idlehand/releases/latest/download';

export const CLI_TARGETS = [
  { id: 'darwin-arm64', label: 'macOS (Apple Silicon)' },
  { id: 'darwin-x64', label: 'macOS (Intel)' },
  { id: 'linux-x64', label: 'Linux (x64)' },
  { id: 'linux-arm64', label: 'Linux (ARM64)' },
] as const;

export function archiveName(id: string): string {
  return `idlehand-${id}.tar.gz`;
}

export function loginCommand(baseUrl: string): string {
  return `idlehand login --server ${baseUrl}`;
}

/** Download, checksum, and install the published Bun binary. Login is a separate command so this stays non-interactive. */
export function installCommands(): string {
  return `OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
case "$OS" in
  darwin|linux) ;;
  *) echo "unsupported OS: $OS" >&2; exit 1 ;;
esac
ARCHIVE="idlehand-$OS-$ARCH.tar.gz"
BASE="${CLI_RELEASE_BASE}"
TMP=$(mktemp -d)
curl -fsSL -o "$TMP/$ARCHIVE" "$BASE/$ARCHIVE"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS"
EXPECT=$(awk -v f="$ARCHIVE" '$2 == f { print $1 }' "$TMP/SHA256SUMS")
if [ -z "$EXPECT" ]; then echo "no checksum for $ARCHIVE" >&2; exit 1; fi
if command -v sha256sum >/dev/null 2>&1; then
  GOT=$(sha256sum "$TMP/$ARCHIVE" | awk '{ print $1 }')
else
  GOT=$(shasum -a 256 "$TMP/$ARCHIVE" | awk '{ print $1 }')
fi
if [ "$EXPECT" != "$GOT" ]; then echo "checksum mismatch for $ARCHIVE" >&2; exit 1; fi
mkdir -p "$HOME/.local/bin"
tar -xzf "$TMP/$ARCHIVE" -C "$TMP"
cp "$TMP/idlehand" "$HOME/.local/bin/idlehand"
chmod +x "$HOME/.local/bin/idlehand"
rm -rf "$TMP"
export PATH="$HOME/.local/bin:$PATH"`;
}
