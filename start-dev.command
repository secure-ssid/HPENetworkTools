#!/bin/bash
# Double-clickable dev launcher (macOS): starts the API (:8177) and the Vite
# dev server (:5173) together, then opens the app in the default browser.
# Stop with Ctrl+C in the Terminal window this opens.
cd "$(dirname "$0")"

# Open the app once the API answers (background watcher, gives up after ~30s).
(
  for _ in $(seq 1 30); do
    sleep 1
    if curl -s -o /dev/null http://localhost:8177/api/health; then
      open http://localhost:5173
      exit 0
    fi
  done
) &

npm run dev
