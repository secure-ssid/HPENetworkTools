#!/bin/bash
# Double-clickable dev launcher (macOS): builds/watches the web application and
# starts one Express server for the UI, API and terminal bridge on port 5173.
# Stop with Ctrl+C in the Terminal window this opens.
cd "$(dirname "$0")"

# Open the app once the API answers (background watcher, gives up after ~30s).
(
  for _ in $(seq 1 30); do
    sleep 1
    if curl -s -o /dev/null http://localhost:5173/api/health; then
      open http://localhost:5173
      exit 0
    fi
  done
) &

npm run dev
