# Task 7 report: truthful bounded ClearPass endpoint paging

## Delivered

- Added the read-only `GET /api/clearpass/endpoints?offset=&limit=` screen route.
- Validates `offset` as an integer at least zero (default `0`) and `limit` from 1 through 100 (default `50`).
- Added the dedicated adapter operation `endpointPage(offset, limit)`. It makes the bounded ClearPass request `GET /api/endpoint?offset=&limit=&calculate_count=true`; it does not use HAL walking, the poller cache, or a full endpoint repository read.
- Returns a closed, mapped response containing only endpoint rows plus effective pagination data: `offset`, `limit`, `total`, `nextOffset`, and `more`.
- Distinguishes unavailable, failed, and empty endpoint-page reads. Live failures never fall back to demo data.
- Demo mode slices the endpoint fixture at the requested offset and limit.

## Pagination truthfulness

- `total` and `nextOffset` are supplied only when the vendor count is provably an overall count.
- A short page proves that no further page exists; a full page without a proven count returns `more: "unknown"` instead of guessing.
- The ClearPass screen now has a separately loaded, 50-row endpoint page. It no longer mounts the main screen's endpoint snapshot as the table data source.
- Table filters apply only to the loaded page and reset pagination. Loading, unavailable, failed, empty, previous-page, and next-page states are explicit.
- Existing overview statistics use a known page total when available, otherwise the compact summary's endpoint count, and mark page-only values accordingly.

## Tests and verification

- Adapter coverage: query bounds, exactly one normal vendor request, mapped-data-only response, no secret leakage, exact count, unknown count, empty, and failed results.
- Route coverage: validation, demo slicing, unavailable/live failure/empty/unknown states, and the closed page contract.
- Web coverage: exact page client request, no demo fallback after live failure, 50-row page presentation, page-only filtering, pagination reset, and load-error handling.

Commands completed successfully:

```text
npm run test -w server -- clearpass.test.ts routes.test.ts   # 331 tests
npm run test -w web -- src/api/clearpass.test.ts src/screens/ClearPass.test.tsx   # 32 tests
npm run typecheck -w server
npm run typecheck -w web
npm run build -w web
```

## Scope

This task intentionally does not change ClearPass write operations or add service-detail/license views; those remain separate work.
