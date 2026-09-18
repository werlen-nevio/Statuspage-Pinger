#!/usr/bin/env bash
# Installs the two non-npm dependencies: asterisk (the PBX that places the call)
# and piper (the offline TTS that speaks the alert).
#
# Asterisk is installed but deliberately NOT started: the stock configuration
# opens chan_sip on 0.0.0.0:5060 and chan_iax2 on 4569 with an anonymous [guest]
# and a reachable demo dialplan. Configure it first (see README.md, "Asterisk"),
# then start it.
set -euo pipefail

PIPER_DIR="${PIPER_DIR:-/opt/piper}"
VOICE="${VOICE:-de_DE-thorsten-medium}"
VOICE_URL_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/medium"

echo "==> Installing asterisk and ffmpeg"
if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    # policy-rc.d makes the package manager skip the service start, so there is
    # no window in which an unconfigured Asterisk is listening.
    printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
    chmod +x /usr/sbin/policy-rc.d
    trap 'rm -f /usr/sbin/policy-rc.d' EXIT
    DEBIAN_FRONTEND=noninteractive apt-get install -y asterisk ffmpeg
    rm -f /usr/sbin/policy-rc.d
    trap - EXIT
else
    echo "Not a Debian/Ubuntu system — install 'asterisk' and 'ffmpeg' yourself, then re-run."
    exit 1
fi

echo "==> Installing piper to $PIPER_DIR"
mkdir -p "$PIPER_DIR"
if [ ! -x "$PIPER_DIR/piper" ]; then
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/piper.tar.gz" \
        "https://github.com/rhasspy/piper/releases/latest/download/piper_linux_x86_64.tar.gz"
    tar xzf "$tmp/piper.tar.gz" -C "$tmp"
    cp -a "$tmp/piper/." "$PIPER_DIR/"
    rm -rf "$tmp"
else
    echo "    already present, skipping"
fi

echo "==> Downloading voice $VOICE"
mkdir -p "$PIPER_DIR/voices"
for suffix in onnx onnx.json; do
    target="$PIPER_DIR/voices/$VOICE.$suffix"
    [ -s "$target" ] && { echo "    $VOICE.$suffix already present"; continue; }
    curl -fsSL -o "$target" "$VOICE_URL_BASE/$VOICE.$suffix"
done

echo "==> Verifying"
echo "Setup erfolgreich abgeschlossen." | \
    LD_LIBRARY_PATH="$PIPER_DIR" "$PIPER_DIR/piper" \
    --model "$PIPER_DIR/voices/$VOICE.onnx" --output_file /tmp/piper-selftest.wav 2>/dev/null
ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/piper-selftest.wav >/dev/null
rm -f /tmp/piper-selftest.wav
asterisk -V

echo
echo "Done. asterisk: $(command -v asterisk), piper: $PIPER_DIR/piper"
echo
echo "Asterisk is installed but NOT running yet. Next steps:"
echo "  1. Configure /etc/asterisk — see README.md, section \"Asterisk\""
echo "  2. sudo systemctl start asterisk"
echo "  3. Set SIP_URI and CALL_TARGET in .env, the SIP password in pjsip.conf, then: npm run test-call"
