#!/usr/bin/env bash
# scripts/smoke.sh — hit every API route and the SPA shell; fail on any non-200.
# Usage: bash scripts/smoke.sh [base-url]   (default http://localhost:8177)
set -u
BASE="${1:-http://localhost:8177}"
fail=0

check() { # method path [expected]
  local method="$1" path="$2" expected="${3:-200}"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path")
  if [ "$code" = "$expected" ]; then
    printf 'ok    %-6s %-32s %s\n' "$method" "$path" "$code"
  else
    printf 'FAIL  %-6s %-32s %s (wanted %s)\n' "$method" "$path" "$code" "$expected"
    fail=1
  fi
}

echo "== API =="
check GET /api/health
for r in overview alerts tickets clients auth-events sites devices \
         licenses configure compliance systems systems/state \
         search-index settings chat/status configure/queue configure/history; do
  check GET "/api/$r"
done
# Device detail: drill into the FIRST device the inventory actually serves —
# in demo+blend mode that's a live row, and fixture names 404 by design.
first_device=$(curl -s "$BASE/api/devices" | grep -o '"name":"[^"]*"' | head -n 1 | cut -d'"' -f4)
if [ -n "$first_device" ]; then
  check GET "/api/devices/$first_device"
else
  printf 'FAIL  %-6s %-32s %s\n' GET /api/devices "no devices in payload"
  fail=1
fi
# Site detail: same rule — the first site id the (possibly blended) list serves.
first_site=$(curl -s "$BASE/api/sites" | grep -o '"id":"[^"]*"' | head -n 1 | cut -d'"' -f4)
if [ -n "$first_site" ]; then
  check GET "/api/sites/$first_site"
else
  printf 'FAIL  %-6s %-32s %s\n' GET /api/sites "no sites in payload"
  fail=1
fi
check POST /api/configure/render 400                       # no body → validation
check GET /api/does-not-exist 404

echo "== SPA =="
for r in / /overview /alerts /tickets /clients /auth-events /sites \
         /sites/campus-01 /devices /devices/sw-core-a /licenses \
         /configure /compliance /systems /ds; do
  check GET "$r"
done

if [ "$fail" = 0 ]; then echo "smoke: all green"; else echo "smoke: FAILURES above"; exit 1; fi
