#!/usr/bin/env bash
# Foxy CLI native host installer (macOS / Linux).
# Copies the host to ~/.local/share/foxy-cli and registers it with Firefox.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required (sudo apt install python3 / brew install python3)." >&2
  exit 1
fi

HOST_DIR="$HOME/.local/share/foxy-cli"
mkdir -p "$HOST_DIR"
cp "$DIR/foxy_host.py" "$HOST_DIR/foxy_host.py"

cat > "$HOST_DIR/foxy_host" <<EOF
#!/bin/sh
exec python3 "$HOST_DIR/foxy_host.py" "\$@"
EOF
chmod +x "$HOST_DIR/foxy_host"

case "$(uname)" in
  Darwin) TARGET="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
  *)      TARGET="$HOME/.mozilla/native-messaging-hosts" ;;
esac
mkdir -p "$TARGET"

cat > "$TARGET/foxy_cli.json" <<EOF
{
  "name": "foxy_cli",
  "description": "Foxy CLI native shell host",
  "path": "$HOST_DIR/foxy_host",
  "type": "stdio",
  "allowed_extensions": ["foxy-cli@foxy.cli"]
}
EOF

echo "Foxy CLI native host installed."
echo "  Host:         $HOST_DIR/foxy_host.py"
echo "  Registration: $TARGET/foxy_cli.json"
echo "Restart Firefox, then reload the Foxy CLI extension."