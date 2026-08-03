# Visual Drill-Downs and Configuration Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make sites, devices, clients, alerts, SSIDs, connectors, and changes clickable into source-aware visual context and enable only product-supported, reviewed configuration pushes.

**Architecture:** A local visual-reference service stores operator-supplied URL or uploaded assets separately from telemetry. A reusable browser panel augments the existing topology, ports, trends, floorplans, and product links on current detail screens; a separate capability panel hands users into existing preview/dry-run/review/push workflows rather than creating generic unsupported writes.

**Tech Stack:** TypeScript 5.7, Node 20/22, Express 4, React 18, Vitest, owner-only filesystem storage.

## Global Constraints

- Preserve all tracked, staged, and untracked work. Do not reset, clean, or discard drawer-check.yml without an explicit user decision.
- Visual assets are references, not telemetry. Show source, owner/attribution, updated time, and unavailable/error state.
- Uploaded assets permit only images, PDFs, and text/documents; enforce MIME allowlist, size limit, generated storage identifier, no user-controlled path, and owner-only permissions.
- External references require HTTPS except loopback HTTP in the lab. Rendering them must not forward application API credentials.
- Detail surfaces show source provenance and never imply a push to one product changed another product.
- Only current catalog capabilities may expose a configuration action. Existing preview, dry-run, review/ticket, push, audit, and uncertain-outcome handling remain required.
- Every behavior change follows a red, green, refactor test cycle.

---

## File Structure

| File | Responsibility |
| --- | --- |
| shared/visualReferences.ts | Target, reference, asset, and action-capability contracts. |
| server/src/services/visualReferences.ts | Owner-only metadata and asset storage. |
| server/src/routes/visualReferences.ts | Listing, linking, upload, remove, and safe asset-stream API. |
| web/src/api/visualReferences.ts | Typed browser calls. |
| web/src/components/VisualReferencePanel.tsx | Reference gallery, attribution, upload/link, native-link, and empty/error states. |
| web/src/components/ConfigActionPanel.tsx | Capability-gated preview/review/push workflow. |
| web/src/screens/DeviceDetail.tsx | Device topology, ports, trends, config history, and references. |
| web/src/screens/SiteDetail.tsx | Site map/floorplan, topology, device context, and references. |
| web/src/screens/Clients.tsx | Client path, source observations, and references. |

### Task 1: Define Visual Reference and Action Contracts

**Files:**
- Create: shared/visualReferences.ts
- Create: shared/visualReferences.test.ts
- Modify: shared/index.ts

**Interfaces:**
- Consumes: PlaneKey and Tone.
- Produces: VisualTarget, VisualReference, VisualReferenceDraft, and ConfigActionCapability.

- [ ] **Step 1: Write failing shared contract tests**

~~~ts
expect(parseVisualReferenceDraft({
  target: { kind: 'site', id: 'northgate', plane: 'mist' },
  kind: 'floorplan', source: 'upload', title: 'Northgate layout',
})).toMatchObject({ target: { kind: 'site', plane: 'mist' }, kind: 'floorplan' });

expect(() => parseVisualReferenceDraft({
  target: { kind: 'client', id: 'aa:bb' },
  kind: 'image', source: 'url', url: 'http://example.com/x.png', title: 'x',
})).toThrow(/https/);
~~~

- [ ] **Step 2: Run the shared test to verify red**

Run: npm run test -w shared -- visualReferences.test.ts

Expected: FAIL because the contracts do not exist.

- [ ] **Step 3: Implement closed contracts**

Define target kinds site, device, client, alert, ssid, connector, and change. Define visual kinds topology, port-map, trend, floorplan, map, image, document, and native-link. Each reference has identifier, target, kind, title, source, owner, update time, URL, MIME type, and attribution.

Define ConfigActionCapability with plane, target kind, action, dry-run support, review requirement, and Configure handoff path. The parser rejects unknown target/kind/source fields and unsafe external URLs.

- [ ] **Step 4: Run shared verification and commit**

Run: npm run typecheck -w shared && npm run test -w shared -- visualReferences.test.ts

~~~bash
git add shared/visualReferences.ts shared/visualReferences.test.ts shared/index.ts
git commit --only -m "feat: define visual reference contracts" -- shared/visualReferences.ts shared/visualReferences.test.ts shared/index.ts
~~~

### Task 2: Add Safe Reference Storage and HTTP API

**Files:**
- Create: server/src/services/visualReferences.ts
- Create: server/src/routes/visualReferences.ts
- Create: server/tests/visualReferences.test.ts
- Modify: server/src/index.ts

**Interfaces:**
- Consumes: HPE_DATA_DIR, VisualReferenceDraft, Express request streams, and currentActor().
- Produces: VisualReferenceStore plus list/create/delete/upload/asset-stream endpoints.

- [ ] **Step 1: Write failing route/store tests**

~~~ts
const created = await postJson('/api/visual-references', urlDraft);
expect(created.status).toBe(201);
expect(created.body.reference.owner).toBe('local operator');
expect((await postBinary('/api/visual-assets', 'text/plain', '../secrets')).status).toBe(400);
expect((await get('/api/visual-references?kind=device&id=sw-01')).body.references).toHaveLength(1);
~~~

Cover URL link, upload, unknown MIME, body over limit, path-traversal name, unauthorized delete, missing asset stream, and attribution.

- [ ] **Step 2: Run targeted server test and verify red**

Run: npm run test -w server -- tests/visualReferences.test.ts

Expected: FAIL with missing API routes.

- [ ] **Step 3: Implement owner-only metadata and assets**

Store JSON at HPE_DATA_DIR/visual-references.json and payloads in HPE_DATA_DIR/visual-assets. Use crypto.randomUUID() for identifiers, 0700 directories, 0600 metadata/assets, a 10 MiB maximum, and MIME allowlist image/png, image/jpeg, image/webp, application/pdf, text/plain, and text/markdown. Store no supplied filesystem path.

- [ ] **Step 4: Implement and mount safe routes**

Use JSON routes for URL/product references and a raw binary upload route with typed target/title/attribution headers. Stream the stored asset using its persisted MIME and inline content disposition. Reject unknown fields, never reveal disk paths, and mount the router in server/src/index.ts beside existing API routers.

- [ ] **Step 5: Run verification and commit**

Run: npm run typecheck -w server && npm run test -w server -- tests/visualReferences.test.ts

~~~bash
git add server/src/services/visualReferences.ts server/src/routes/visualReferences.ts server/src/index.ts server/tests/visualReferences.test.ts
git commit --only -m "feat: store source-aware visual references" -- server/src/services/visualReferences.ts server/src/routes/visualReferences.ts server/src/index.ts server/tests/visualReferences.test.ts
~~~

### Task 3: Render Reference Panels Alongside Live Visual Context

**Files:**
- Create: web/src/api/visualReferences.ts
- Create: web/src/components/VisualReferencePanel.tsx
- Create: web/src/components/VisualReferencePanel.test.tsx
- Modify: web/src/screens/DeviceDetail.tsx
- Modify: web/src/screens/SiteDetail.tsx
- Modify: web/src/screens/Clients.tsx
- Modify: web/src/app/app.css

**Interfaces:**
- Consumes: VisualTarget, VisualReference, existing topology/floorplan/port/trend components, and native console URLs.
- Produces: lazy source-aware reference panels on clicked objects.

- [ ] **Step 1: Write failing panel tests**

~~~tsx
render(<VisualReferencePanel
  target={{ kind: 'site', id: 'northgate', plane: 'mist' }}
  references={[floorplan]}
  editable
/>);
expect(screen.getByRole('img', { name: /northgate layout/i })).toBeTruthy();
expect(screen.getByText(/uploaded by local operator/i)).toBeTruthy();
expect(screen.getByRole('button', { name: /add visual reference/i })).toBeTruthy();
~~~

Also cover empty, unavailable asset, fetch failure, document link, URL attribution, native link, and non-editable view.

- [ ] **Step 2: Verify the missing panel**

Run: npm run test -w web -- src/components/VisualReferencePanel.test.tsx

Expected: FAIL because no browser API or panel exists.

- [ ] **Step 3: Implement browser API and panel**

Load references only after the detail view mounts. Use descriptive image alt text; render documents and native links as labelled links; render an explicit card for unavailable assets. Show source, owner, attribution, and updated time. Expose add-link/upload/remove controls only on editable surfaces and refresh only the selected target after mutation.

- [ ] **Step 4: Integrate existing visual truth before stored assets**

Add the panel to DeviceDetail, SiteDetail, and expanded Clients detail. Keep live visuals first-class and labelled: SiteDetail topology plus SiteFloorPlan, DeviceDetail ports/radios/trends/config history, and Client 360 path/topology. The asset panel augments missing or extra operator context; it never treats an image as telemetry.

- [ ] **Step 5: Run detail regression tests and commit**

Run: npm run test -w web -- src/components/VisualReferencePanel.test.tsx src/screens/DeviceDetail.test.tsx src/screens/SiteDetail.test.tsx src/screens/Clients.test.tsx

~~~bash
git add web/src/api/visualReferences.ts web/src/components/VisualReferencePanel.tsx web/src/components/VisualReferencePanel.test.tsx web/src/screens/DeviceDetail.tsx web/src/screens/SiteDetail.tsx web/src/screens/Clients.tsx web/src/app/app.css
git commit --only -m "feat: show visual references in object details" -- web/src/api/visualReferences.ts web/src/components/VisualReferencePanel.tsx web/src/components/VisualReferencePanel.test.tsx web/src/screens/DeviceDetail.tsx web/src/screens/SiteDetail.tsx web/src/screens/Clients.tsx web/src/app/app.css
~~~

### Task 4: Add Capability-Gated Configuration Actions

**Files:**
- Create: web/src/components/ConfigActionPanel.tsx
- Create: web/src/components/ConfigActionPanel.test.tsx
- Modify: shared/connectors.ts
- Modify: web/src/api/configure.ts
- Modify: web/src/screens/Configure.tsx
- Modify: web/src/screens/DeviceDetail.tsx
- Modify: web/src/screens/SiteDetail.tsx
- Modify: web/src/screens/Systems.tsx

**Interfaces:**
- Consumes: ConfigActionCapability, existing Configure preview/dry-run/queue/push clients, and existing direct-write APIs.
- Produces: detail-origin actions that use the existing safe write workflow.

- [ ] **Step 1: Write failing action-safety tests**

~~~tsx
render(<ConfigActionPanel capability={centralSsidCapability} target={target} />);
expect(screen.getByRole('button', { name: /preview change/i })).toBeTruthy();
expect(screen.queryByRole('button', { name: /^push$/i })).toBeNull();
await user.click(screen.getByRole('button', { name: /preview change/i }));
expect(await screen.findByText(/review required/i)).toBeTruthy();
~~~

Add an OpsRamp case that exposes an explicit read-only explanation and sends no configuration API request. Add an uncertain push response that preserves recovery/audit content.

- [ ] **Step 2: Verify red**

Run: npm run test -w web -- src/components/ConfigActionPanel.test.tsx

Expected: FAIL because no capability panel exists.

- [ ] **Step 3: Declare only real capabilities**

Add descriptors for existing supported actions: Central brokered port/VLAN and reviewed SSID operations, Mist reviewed SSID operations, ClearPass endpoint/local-user writes, and SSE reviewed object CRUD/Commit. Classic, AOS-8, Central-derived AOS-10, Local AOS-CX, EdgeConnect, OpsRamp, GreenLake, and UXI produce product-specific read-only copy instead of disabled fantasy controls.

- [ ] **Step 4: Implement staged panel and handoff**

Require target selection, preview, optional dry-run, review/ticket confirmation, push availability, response/audit, then affected-plane refresh. Pass exact plane/target context into Configure through query parameters and delegate mutation to the existing API clients. Do not make a second write backend.

- [ ] **Step 5: Integrate and test**

Render in Systems connector detail, DeviceDetail configuration, and SiteDetail only when capability and source match.

Run: npm run test -w web -- src/components/ConfigActionPanel.test.tsx src/screens/Configure.test.tsx src/screens/DeviceDetail.test.tsx src/screens/SiteDetail.test.tsx src/screens/Systems.test.tsx

Expected: no supported write bypasses preview/review; unsupported products do not expose Push.

- [ ] **Step 6: Commit detail actions**

~~~bash
git add shared/connectors.ts web/src/api/configure.ts web/src/components/ConfigActionPanel.tsx web/src/components/ConfigActionPanel.test.tsx web/src/screens/Configure.tsx web/src/screens/DeviceDetail.tsx web/src/screens/SiteDetail.tsx web/src/screens/Systems.tsx
git commit --only -m "feat: add reviewed configuration actions to details" -- shared/connectors.ts web/src/api/configure.ts web/src/components/ConfigActionPanel.tsx web/src/components/ConfigActionPanel.test.tsx web/src/screens/Configure.tsx web/src/screens/DeviceDetail.tsx web/src/screens/SiteDetail.tsx web/src/screens/Systems.tsx
~~~

### Task 5: Document and Verify the Experience

**Files:**
- Modify: docs/configuration.md
- Modify: docs/user-guide.md
- Modify: docs/security.md
- Modify: scripts/smoke.sh

- [ ] **Step 1: Add smoke coverage**

Smoke the empty visual-reference list, malformed upload rejection, and absence of actions for a read-only product without providing external product credentials.

- [ ] **Step 2: Update operator/security documentation**

Document visual asset kinds, owner/attribution, storage/size limits, safe URL policy, unavailable states, source provenance, and preview/dry-run/review/push/audit workflow. List intentionally read-only products.

- [ ] **Step 3: Run full fresh evidence**

Run: npm run typecheck && npm run lint && npm test && npm run build && bash scripts/smoke.sh

Expected: all commands exit 0. Run genuine product probes separately with disposable lab credentials and report each product/dataset result.

- [ ] **Step 4: Commit docs and smoke changes**

~~~bash
git add docs/configuration.md docs/user-guide.md docs/security.md scripts/smoke.sh
git commit --only -m "docs: explain visual references and config pushes" -- docs/configuration.md docs/user-guide.md docs/security.md scripts/smoke.sh
~~~

