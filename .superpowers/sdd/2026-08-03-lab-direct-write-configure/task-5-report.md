# Task 5 report — product direct-write panels

## Delivered

- Added `useLabConfigMode`, which starts in hardened mode and adopts lab mode only after `getPortalSettings()` succeeds with `configMode !== false`. Loading, unavailable, HTTP-error, malformed, and rejected settings reads retain the hardened fallback.
- Threaded that mode through ClearPass, SSE inventory, GreenLake, Central webhooks, and Mist webhook registration. Lab mode removes the direct-write review confirmation UI and omits `reviewConfirmed`; hardened mode retains the checkbox and passes `true`.
- Made the ClearPass, SSE, GreenLake, and Central webhook client flags optional while preserving an explicit `false` refusal for the existing recovery and one-time-secret safety paths.
- Preserved SSE tenant-wide Commit warnings, journal/unknown-outcome recovery, and manual-reconciliation attestation; Central one-time HMAC acknowledgement, tenant binding, generation, and unknown-outcome reconciliation; ClearPass validation/read-back/password handling; GreenLake write-scope/outcome handling; and Mist status/secret handling.
- In lab Central derives the required tenant binding from the current listing before create/rotation, rather than relying on the hardened review interaction to populate it.

## Verification

From `web/`:

```text
npm test -- --run src/api/client.test.ts src/hooks/useLabConfigMode.test.tsx src/api/clearpass.test.ts src/screens/ClearPass.test.tsx src/screens/SseInventoryPanel.test.tsx src/screens/GreenLake.test.tsx src/screens/CentralWebhooksPanel.test.tsx src/screens/systems/MistSection.test.tsx
8 files passed; 232 tests passed

npm run typecheck
tsc --noEmit passed

npm run build
vite production build passed
```

## Scope

Only Task 5 direct-write panels, clients, hook, and focused tests changed. Configure, clickthrough, server code, and the pre-existing untracked plan were left outside this slice.
