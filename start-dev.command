#!/bin/bash
# Double-clickable dev launcher (macOS): builds/watches the web application and
# starts one Express server for the UI, API and terminal bridge on port 5173.
# Stop with Ctrl+C in the Terminal window this opens.
cd "$(dirname "$0")"

# Lab default: 24h sign-in sessions (overridable — set HPE_SESSION_TTL_MS in
# the environment first to use a different lifetime). Sessions are in memory,
# so any restart still signs everyone out.
export HPE_SESSION_TTL_MS="${HPE_SESSION_TTL_MS:-86400000}"

# Pre-flight: refuse to start a second copy — the server would otherwise die
# with EADDRINUSE as soon as it tried to bind 5173.
if pid=$(lsof -ti :5173); then
  echo "start-dev: port 5173 is already in use (PID $pid)."
  echo "start-dev: the dev server looks already running — use that window, or stop it first."
  exit 1
fi

# Open the app once the API answers with HTTP 200 (background watcher, gives up
# after ~30s and says so).
(
  for _ in $(seq 1 30); do
    sleep 1
    if curl -sf -o /dev/null http://localhost:5173/api/health; then
      open http://localhost:5173
      exit 0
    fi
  done
  echo "start-dev: server did not answer with HTTP 200 within ~30s — not opening the browser."
) &

npm run dev
