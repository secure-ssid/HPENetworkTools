# Installation

## Requirements

- macOS or Linux
- Node.js 20 or 22
- npm
- Git

Optional integrations may require network access to the relevant HPE APIs and
SSH access to locally managed switches.

## Clone and install

```bash
git clone https://github.com/secure-ssid/HPENetworkTools.git
cd HPENetworkTools
npm install
```

`npm install` installs the root, `server`, and `web` workspaces.

## Development mode

```bash
npm run dev
```

This builds the React application in watch mode and starts one Express
listener at `http://localhost:5173`. The same listener serves the UI, `/api`,
and terminal WebSockets. Press `Ctrl+C` in the terminal that started the
command to stop the build watcher and server.

On macOS, `start-dev.command` provides the same development startup flow.

## Production mode

Build the web application:

```bash
npm run build
```

Start the API and static web server:

```bash
npm start --workspace server
```

Open `http://localhost:5173`.

## Runtime environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5173` | UI, API, and terminal WebSocket port |
| `HPE_SETTINGS_PATH` | `data/settings.json` | Settings and connected-system credentials |
| `HPE_DATA_DIR` | `data/` | Audits, journals, terminal recordings, and runtime state |
| `HPE_CONFIG_BACKUP_INTERVAL_MS` | `3600000` (hourly) | Running-config backup sweep interval; minimum 60000 |
| `HPE_METRICS_SAMPLE_MS` | `300000` (5 minutes) | Metrics-history sample cadence for table sparklines; minimum 1000 |
| `HPE_SESSION_TTL_MS` | `43200000` (12 hours) | Signed-in session lifetime; must be between 900000 (15m) and 2592000000 (30d) |
| `HPE_MAINTENANCE_INTERVAL_MS` | `60000` (1 minute) | Maintenance-window scheduler tick; minimum 1000 |

Example:

```bash
PORT=9000 \
HPE_SETTINGS_PATH=/var/lib/hpe-network-tools/settings.json \
HPE_DATA_DIR=/var/lib/hpe-network-tools \
npm start --workspace server
```

Protect the settings and data paths with operating-system permissions and
back them up according to your recovery policy. Settings are written with
owner-only permissions.

## Updating

```bash
git pull --ff-only
npm install
npm run build
```

Restart the running server after the build completes.

## Validation

```bash
npm run typecheck
npm run lint
npm test
npm run build
bash scripts/smoke.sh
```

The smoke script reads API and SPA routes. It assumes the demo no-auth
server; against a deployment with authentication enabled, every route
answers 401 unless you pass a token in `SMOKE_TOKEN`, which the script
sends as an `Authorization: Bearer` header with every request:

```bash
SMOKE_TOKEN=<token> bash scripts/smoke.sh
```

Do not add mutation requests to a production smoke run.

## Troubleshooting

### Port already in use

Start production on another port:

```bash
PORT=5174 npm start --workspace server
```

### Portal page does not load

Check the API:

```bash
curl http://localhost:5173/api/health
```

An `{"ok":true}` response confirms the production server is listening.

### Live pages show unavailable data

Open **Connected systems**, confirm the system is linked, review its last sync
and permission state, then use **Sync all**. The portal intentionally shows an
error instead of replacing failed live data with demo data.
