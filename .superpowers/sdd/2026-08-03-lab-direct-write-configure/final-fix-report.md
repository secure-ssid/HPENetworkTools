# Final Fix Report — Lab Direct Write Rollout

Date: 2026-08-03

Reviewed findings: `final-review-findings.md`

## Outcome

All twelve rollout findings were corrected. Live write affordances and server mutation edges now derive from the same exact connector admission facts: operation-owned plane, enabled connector, linked runtime, required stored scope, and adapter capability. Lab mode still removes workflow friction, but it does not bypass ownership, write grants, validation, synchronization, reconciliation, auditing, or secret-handling boundaries.

## Finding-by-finding corrections

1. **Canonical write admission**
   - Added one server predicate in `server/src/services/writeAdmission.ts` for brokered Central writes and direct Central, Mist, SSID, and ClearPass writes.
   - Applied it at the broker, SSID, ClearPass, Central webhook, and Mist webhook mutation edges, including admission rechecks immediately before queued pushes.
   - Exposed `canWrite`, `canBrokerWrite`, and `canDirectWrite` from that same truth and made ClearPass, Central webhooks, Mist, and Configure hide or disable mutation controls when denied.

2. **Exact Central ownership for generic broker writes**
   - Port writes retain resolved inventory ownership and reject non-Central targets.
   - VLAN writes require proven Central provenance; missing, mixed, Mist, Local, and AOS-8 ownership fail closed.

3. **Unknown Central PUT outcomes**
   - A thrown PUT is represented as `outcomeUnknown`, never `applied: false`.
   - Queued changes remain durably `applying` for reconciliation instead of becoming retryable.
   - Direct, queued, and bulk UI results warn that reconciliation is required and block blind repeat Apply.

4. **Shared exact-target synchronization**
   - Direct and queued Central writes share the same target-scoped lock, including different change IDs addressing the same object.

5. **Atomic Mist topic validation**
   - Mixed valid/invalid topic arrays are rejected in full; the route no longer strips unknown values before service validation.

6. **Truthful Central webhook audit evidence**
   - Lab direct writes record `none — lab direct apply`; `review-confirmed` remains limited to the hardened reviewed path.

7. **ClearPass request ordering**
   - Endpoint page loads use a monotonically increasing request sequence and mounted guard, so stale pages cannot overwrite a later filter/reset result.

8. **Complete port/VLAN forms before Apply**
   - Apply is disabled until required identifiers, exact Central ownership, and values are present. Live ports also require the exact Central serial identity.
   - Live lab generic editors are opened only from owned inventory rows; unowned fixture defaults and unsupported new port/VLAN affordances cannot leak into live writes.

9. **ClearPass 401 token invalidation**
   - A rejected minted token is invalidated after the one allowed vendor page request. A later explicit action remints; the failed action is never automatically replayed.

10. **Truthful ClearPass paging copy**
    - Loaded-row copy uses the actual page row count, and an empty page reports a proven repository total when ClearPass supplied one.

11. **Lab Configure wording**
    - Immediate lab forms, previews, headers, results, and empty states no longer promise tickets, queueing, leases, review, or dry runs. Hardened mode retains broker/review language.
    - Preview/result copy distinguishes applied, accepted-but-unconfirmed, outcome-unknown, and refresh-failed evidence.

12. **Stale comments and recovery labels**
    - Server route/service comments now describe conditional lab versus hardened gates.
    - Central webhook lab recovery labels use apply/check wording instead of review claims.

## Additional final-review hardening

- Repeat generic Apply is blocked after applied, accepted, or outcome-unknown results until the form changes.
- Mist status refreshes have sequence and unmount guards, preventing a stale writable response from re-exposing controls.
- A ClearPass write drawer is removed immediately if refreshed connector state revokes `canWrite`.
- Capability display facts no longer synthesize writeability from connection mode.

## Commits

- `a9586e4` — `fix(server): enforce exact write admission and reconciliation`
- `6d58c97` — `fix(server): keep reconciliation path lint-clean`
- `875e72e` — `fix(web): enforce live write admission`

## Verification

- Full server suite: **86 files, 2,576 tests passed**.
- Focused broker suite: **52 tests passed**.
- Canonical admission suite: **14 tests passed**.
- Focused affected UI suites (facts, Systems, ClearPass, Configure, ConfigureBulk, Mist, Central webhooks): **230 tests passed**.
- Server TypeScript: `npm run typecheck -w server` passed.
- Web TypeScript: `npm run typecheck -w web` passed.
- Production web build: `npm run build -w web` passed; Vite transformed 171 modules.
- Patch hygiene: `git diff --check` passed.

## Repository-wide verification exceptions

- Full web suite: **1,366 of 1,368 tests passed**. The two failures are the pre-existing `src/screens/siteDetail/RogueAps.test.tsx` harness cases that render a React Router `Link` without router context (`basename` is read from a null context). Neither the component nor its tests are touched by these commits.
- Root lint remains red on the reviewed repository baseline: **13 errors and 3 warnings**. The errors are existing unused imports/helpers and two existing regular-expression escape findings outside this rollout. The three warnings are existing hook warnings; comparison with `3f6248c` confirms the flagged ClearPass endpoint expression and Configure deep-link effect predate these corrections. The new write-broker lint finding discovered during this pass was fixed in `6d58c97`.

## Residual concerns

No remaining correctness concern was found in the corrected write-admission rollout. The portal process still needs to be restarted from this committed tree before visual proof can represent these changes; that runtime restart and Topology/ClearPass visual verification are the next operational step.
