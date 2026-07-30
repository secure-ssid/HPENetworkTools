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

This starts:

- React/Vite on `http://localhost:5173`
- Express API on `http://localhost:8177`

The Vite server proxies `/api` requests to the Express server. Press `Ctrl+C`
in the terminal that started the command to stop both processes.

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

Open `http://localhost:8177`.

## Runtime environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8177` | Production HTTP port |
| `HPE_SETTINGS_PATH` | `data/settings.json` | Settings and connected-system credentials |
| `HPE_DATA_DIR` | `data/` | Audits, journals, terminal recordings, and runtime state |

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
npm test
npm run build
bash scripts/smoke.sh
```

The smoke script reads API and SPA routes. Do not add mutation requests to a
production smoke run.

## Troubleshooting

### Port already in use

Start production on another port:

```bash
PORT=8178 npm start --workspace server
```

### Portal page does not load

Check the API:

```bash
curl http://localhost:8177/api/health
```

An `{"ok":true}` response confirms the production server is listening.

### Live pages show unavailable data

Open **Connected systems**, confirm the system is linked, review its last sync
and permission state, then use **Sync all**. The portal intentionally shows an
error instead of replacing failed live data with demo data.
