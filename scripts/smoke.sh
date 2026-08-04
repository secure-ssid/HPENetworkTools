#!/usr/bin/env bash
# scripts/smoke.sh — hit every API route and the SPA shell; fail on any non-200.
# Usage: bash scripts/smoke.sh [base-url]   (default http://localhost:5173)
# Set SMOKE_TOKEN to send an Authorization: Bearer header with every request —
# a server with auth enabled answers 401 to everything otherwise.
set -u
BASE="${1:-http://localhost:5173}"
fail=0

CURL=(curl -s)
if [ -n "${SMOKE_TOKEN:-}" ]; then
  CURL+=(-H "Authorization: Bearer $SMOKE_TOKEN")
fi

check() { # method path [expected]
  local method="$1" path="$2" expected="${3:-200}"
  local code
  code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path")
  if [ "$code" = "$expected" ]; then
    printf 'ok    %-6s %-32s %s\n' "$method" "$path" "$code"
  else
    printf 'FAIL  %-6s %-32s %s (wanted %s)\n' "$method" "$path" "$code" "$expected"
    fail=1
  fi
}

# Payload fetch with the HTTP status appended as a final line, so a 401 can be
# told apart from an empty list (which used to report "no devices in payload").
fetch() { # path
  "${CURL[@]}" -w '\n%{http_code}' "$BASE$1"
}

echo "== API =="
check GET /api/health
for r in overview alerts tickets clients auth-events sites devices \
         licenses configure compliance systems systems/state \
         search-index settings chat/status configure/queue configure/history \
         inventory/tree config-backups mist central topology; do
  check GET "/api/$r"
done
# Device detail: drill into the FIRST device the inventory actually serves —
# in demo+blend mode that's a live row, and fixture names 404 by design.
resp=$(fetch /api/devices)
if [ "${resp##*$'\n'}" = 401 ]; then
  printf 'FAIL  %-6s %-32s %s\n' GET /api/devices "401 auth required (set SMOKE_TOKEN)"
  fail=1
else
  first_device=$(printf '%s' "${resp%$'\n'*}" | grep -o '"name":"[^"]*"' | head -n 1 | cut -d'"' -f4)
  if [ -n "$first_device" ]; then
    # Device names may contain spaces etc. ("HQ Switch 1") — percent-encode
    # before embedding one in the URL, or the request line is malformed.
    encoded_device=$(printf '%s' "$first_device" | sed -e 's/%/%25/g' -e 's/ /%20/g' -e 's/#/%23/g' -e 's/?/%3F/g' -e 's/&/%26/g' -e 's/+/%2B/g')
    check GET "/api/devices/$encoded_device"
  else
    printf 'FAIL  %-6s %-32s %s\n' GET /api/devices "no devices in payload"
    fail=1
  fi
fi
# Site detail: same rule — the first site id the (possibly blended) list serves.
resp=$(fetch /api/sites)
if [ "${resp##*$'\n'}" = 401 ]; then
  printf 'FAIL  %-6s %-32s %s\n' GET /api/sites "401 auth required (set SMOKE_TOKEN)"
  fail=1
else
  first_site=$(printf '%s' "${resp%$'\n'*}" | grep -o '"id":"[^"]*"' | head -n 1 | cut -d'"' -f4)
  if [ -n "$first_site" ]; then
    check GET "/api/sites/$first_site"
  else
    printf 'FAIL  %-6s %-32s %s\n' GET /api/sites "no sites in payload"
    fail=1
  fi
fi
check POST /api/configure/render 400                       # no body → validation
check GET /api/visual-references
check GET /api/recommendations
check GET /api/taxonomy/summary
check GET /api/openapi.json
check GET /api/taxonomy/summary
# Malformed upload: path-like title + plain text must be refused (no product credentials needed).
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/visual-assets" \
  -H "Content-Type: text/plain" \
  -H "Origin: $BASE" \
  -H "X-Visual-Target-Kind: device" \
  -H "X-Visual-Target-Id: sw-01" \
  -H "X-Visual-Kind: document" \
  -H "X-Visual-Title: ../secrets" \
  --data 'x')
if [ "$code" = "400" ]; then
  printf 'ok    %-6s %-32s %s\n' POST /api/visual-assets "$code"
else
  printf 'FAIL  %-6s %-32s %s (wanted 400)\n' POST /api/visual-assets "$code"
  fail=1
fi
check GET /api/does-not-exist 404

echo "== SPA =="
for r in / /overview /alerts /tickets /clients /auth-events /clearpass \
         /sites /sites/campus-01 /devices /devices/sw-core-a /licenses \
         /greenlake /inventory /configure /compliance /systems /uxi /mist \
         /central /topology /ds; do
  check GET "$r"
done

if [ "$fail" = 0 ]; then echo "smoke: all green"; else echo "smoke: FAILURES above"; exit 1; fi
