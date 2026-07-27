# Research notes — continuous-improvement loop

Findings from loop research fires, newest first. Each entry: what was learned,
the source, and the follow-up it banks (if any). Keep entries to 2–4 lines.

## 2026-07-26 — CLI parsing, centralmcp, AOS-10 sourcing

- **ntc-templates** ([networktocode/ntc-templates](https://github.com/networktocode/ntc-templates)):
  TextFSM templates incl. `aruba_os` (AOS-8) and `aruba_aoscx` (CX) for most
  `show` commands. Python-only — no dependency for this TS app, but the regex
  state machines are the reference when a parser is needed (topology, live
  compliance). Banked: port single-purpose parsers only as a consumer appears.
- **centralmcp v0.7.0** ([secure-ssid/centralmcp](https://github.com/secure-ssid/centralmcp)):
  6,699 tools, FastMCP + httpx. Confirms our patterns: troubleshooting API
  pinned `v1` **with v1alpha1 fallback** (our reboot/disconnect paths already
  v1); GLP token URL derived from base + workspace (matches our greenlake
  fix); read/write tool split mirrors our broker (their `invoke_read_tool` vs
  destructive `invoke_tool`). New-Central OpenAPI specs are ingested from
  devhub page `oasPublicUrl` + ReadMe API registry (post July-2026 portal
  migration) — the source to mine if the adapter grows new-API surface.
  Chat panel already speaks their streamable-HTTP router — no work banked.
- **AOS-10 sourcing — resolved, no SSH adapter**: AOS-10 gateways are
  Central-managed; the sanctioned automation surface is Central's APIs
  (centralmcp `ops.py` runs ping/traceroute/show/reboot/PoE/cable-test
  THROUGH Central's troubleshooting API, not direct SSH). Direct-SSH scraping
  is undocumented and fragile. Decision: AOS-10 coverage comes from the
  Central adapter (gateway section + troubleshooting ops); the AOS-10 plane
  stays honest "via Central" — do NOT build the SSH-sourced adapter the old
  backlog suggested.
