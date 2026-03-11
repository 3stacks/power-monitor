# Homeserver Deployment

This project follows the unified self-hosted deployment pattern for Luke's homeserver.

## Architecture

```
┌─────────────────┐     push      ┌─────────────────┐
│   Local Dev     │──────────────▶│     Gitea       │
│   (source)      │               │   (CI/CD)       │
└─────────────────┘               └────────┬────────┘
                                           │
                                           │ build & push
                                           ▼
                                  ┌─────────────────┐
                                  │ Docker Registry │
                                  │ registry.home.  │
                                  │ lukeboyle.com   │
                                  └────────┬────────┘
                                           │
                                           │ pull
                                           ▼
                                  ┌─────────────────┐
                                  │   Homeserver    │
                                  │   (Docker)      │
                                  └─────────────────┘
```

## Components

### 1. Source Repository (this repo)

- `Dockerfile` - Multi-stage build for production image
- `docker-compose.yml` - Local development (uses `build: .`)
- `.gitea/workflows/build.yml` - CI/CD pipeline
- `deploy/` - Server-side deployment configs

### 2. Gitea Workflow (`.gitea/workflows/build.yml`)

Triggers on push to `main` or version tags (`v*`). Builds and pushes to the registry with tags:
- `latest` - from main branch
- `main` - branch name
- `{sha}` - commit SHA
- `{version}` - from git tags (e.g., `v1.0.0` → `1.0.0`)

### 3. Docker Registry

Self-hosted at `registry.home.lukeboyle.com:5000` (proxied via Caddy).

### 4. Homeserver Deployment

Located at `~/power-monitor/` on the homeserver:
- `docker-compose.yml` - Uses image from registry
- `.env` - Environment-specific configuration

## Deployment Steps

### Initial Setup (one-time)

On the homeserver:

```bash
mkdir -p ~/power-monitor
cd ~/power-monitor

# Copy deployment files from this repo's deploy/ folder
# Or create from templates below
```

Create `docker-compose.yml`:
```yaml
services:
  power-monitor:
    image: registry.home.lukeboyle.com/power-monitor:${POWER_MONITOR_VERSION:-latest}
    container_name: power-monitor
    restart: unless-stopped
    volumes:
      - ${DATA_PATH:-./data}:/data
    ports:
      - "${WEB_PORT:-3333}:3333"
    environment:
      - PING_TARGET=${PING_TARGET:-8.8.8.8}
      - PING_INTERVAL_MS=${PING_INTERVAL_MS:-60000}
      - MIN_OUTAGE_DURATION_MS=${MIN_OUTAGE_DURATION_MS:-300000}
      - DB_PATH=/data/power-monitor.db
      - WEB_PORT=3333
```

Create `.env` from `.env.example`:
```bash
cp .env.example .env
# Edit as needed
```

### Deploying Updates

After pushing to main:

```bash
cd ~/power-monitor
docker compose pull
docker compose up -d
```

### Pinning Versions

To pin to a specific version, set in `.env`:
```
POWER_MONITOR_VERSION=abc1234
```

Or use a git tag version:
```
POWER_MONITOR_VERSION=1.0.0
```

## Unified Pattern

This pattern is used across all self-hosted projects:

| Project | Registry Image | Port |
|---------|---------------|------|
| power-monitor | `registry.home.lukeboyle.com/power-monitor` | 3333 |
| chore-calendar | `registry.home.lukeboyle.com/chore-calendar` | 6969 |
| afrikaans-reader | `registry.home.lukeboyle.com/afrikaans-reader` | 3400 |
| septuagint-interactive | `registry.home.lukeboyle.com/septuagint-interactive` | TBD |
| strong-app-visualiser | `registry.home.lukeboyle.com/strong-app-visualiser` | TBD |

Each project has:
- `.gitea/workflows/build.yml` - Same structure, different image name
- `deploy/docker-compose.yml` - Server-side compose file
- `deploy/.env.example` - Environment template
- `deploy/README.md` - This documentation

## Troubleshooting

### Check running containers
```bash
docker ps | grep power-monitor
```

### View logs
```bash
docker compose logs -f power-monitor
```

### Rebuild from scratch
```bash
docker compose down
docker compose pull
docker compose up -d
```

### Check registry images
```bash
docker images | grep registry.home
```
