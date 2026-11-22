#!/usr/bin/env bash
set -euo pipefail

# Headless Firefox still needs a running Linux audio backend for AudioContext.
# This provides a real, clocked software output sink for the injected PCM tests;
# it does not change browser autoplay policy or replace any Web Audio API.
if [[ "${GITHUB_ACTIONS:-}" != "true" || "$(uname -s)" != "Linux" ]]; then
  echo "The voice test audio service is only for Linux GitHub Actions runners." >&2
  exit 1
fi

command -v pulseaudio >/dev/null
command -v pactl >/dev/null
if ! pactl info >/dev/null 2>&1; then
  pulseaudio --start --exit-idle-time=-1
fi

voice_ci_ready=false
for voice_ci_attempt in {1..20}; do
  if pactl info >/dev/null 2>&1; then
    voice_ci_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$voice_ci_ready" != "true" ]]; then
  echo "PulseAudio did not become ready; browser PCM qualification cannot run." >&2
  exit 1
fi

voice_ci_sink=tendriller-ci
if ! pactl list short sinks | awk -v sink="$voice_ci_sink" '$2 == sink { found = 1 } END { exit !found }'; then
  pactl load-module module-null-sink sink_name="$voice_ci_sink" rate=48000 channels=2
fi
pactl set-default-sink "$voice_ci_sink"
if [[ "$(pactl get-default-sink)" != "$voice_ci_sink" ]]; then
  echo "The browser PCM output sink could not be selected." >&2
  exit 1
fi
pactl info
pactl list short sinks
