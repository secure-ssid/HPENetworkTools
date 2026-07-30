# HPE Network Tools

HPE Network Tools is a multi-plane network operations portal for inventory,
clients, topology, configuration, diagnostics, and connected-system management.
It combines HPE Aruba Networking Central, Central Classic, GreenLake, ClearPass,
UXI, local switches, and HPE Aruba Networking SSE in one interface.

![Operations overview](docs/images/overview.png)

## Highlights

- Unified devices, sites, clients, alerts, licences, and topology.
- Lazy Inventory Explorer for systems, sites, devices, and SSE objects.
- Responsive desktop navigation and a focus-managed mobile drawer.
- Collapsed switch groups that keep large port inventories out of the initial DOM.
- Exact device targeting by management plane and serial number.
- Reviewed New Central SSID creation, editing, and scope assignment.
- AP and AOS-CX traceroute diagnostics with bounded background polling.
- HPE Aruba Networking SSE inventory and reviewed CRUD with Commit handling.
- Central webhook management with one-time HMAC-key handoff.
- Recorded, allow-listed SSH terminal sessions for locally managed devices.
- Demo, live, blended, and per-screen data-source controls.

## Quick start

Requirements: Node.js 20 or 22 and npm.

```bash
git clone https://github.com/secure-ssid/HPENetworkTools.git
cd HPENetworkTools
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The default configuration
uses demo data and does not require network-system credentials.

The normal development command also uses one HTTP listener: Vite rebuilds
assets in watch mode without opening a second web port, and Express serves the
UI, API, and terminal WebSocket together on `5173`.

For a production build:

```bash
npm run build
npm start --workspace server
```

Open [http://localhost:5173](http://localhost:5173).

## Documentation

| Guide | Purpose |
|---|---|
| [Installation](docs/installation.md) | Install, run, update, and configure runtime paths |
| [Configuration](docs/configuration.md) | Data modes, connected systems, credentials, and scopes |
| [User guide](docs/user-guide.md) | Daily navigation, SSIDs, diagnostics, SSE, and webhooks |
| [Security](docs/security.md) | Secret handling, reviews, recovery, and operational safeguards |
| [Design reference](docs/design-reference.md) | Archived interface specification and design notes |

## Screenshots

### Connected systems

![Connected systems](docs/images/connected-systems.png)

### Configuration

![Configuration](docs/images/configure.png)

### Device inventory

![Device inventory](docs/images/devices.png)

### Inventory explorer

![Inventory explorer](docs/images/inventory.png)

## Project layout

```text
HPENetworkTools/
├── docs/                 Installation, configuration, usage, and screenshots
├── server/               Express API, adapters, services, routes, and tests
├── shared/               Shared contracts, fixtures, and domain logic
├── web/                  React application, components, screens, and tests
├── data/                 Local runtime state and credentials (git-ignored)
├── package.json          npm workspace scripts
└── README.md             Project entry point
```

## Validation

```bash
npm run typecheck
npm test
npm run build
bash scripts/smoke.sh
```

Never commit `data/settings.json`, API tokens, client secrets, private keys, or
one-time webhook HMAC keys.
