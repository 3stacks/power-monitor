# Power Monitor

A simple network-based power outage detector with a status page dashboard. Designed to run on a battery-backed device (like a MacBook) to detect when your home network goes down due to power outages.

## How it works

1. Pings an external host (default: 8.8.8.8) every minute
2. When the network goes down, records the start of an outage
3. When the network returns, records the end and calculates duration
4. Provides a web dashboard showing 7-day uptime and outage history

Since the monitoring device has battery backup, it stays online during power outages while your router loses power - allowing it to detect the network drop.

## Features

- Real-time network monitoring with 1-minute ping interval
- SQLite database for persistent outage history
- Web dashboard with 7-day uptime visualization
- Auto-refresh status page (Atlassian Status Page style)
- Freezer safety warnings (alerts at 1hr and 4hr outages)
- Handles server restarts gracefully (closes unclosed outages)
- JSON API endpoint for integrations

## Quick Start

### Native (recommended for macOS)

```bash
git clone git@github.com:3stacks/power-monitor.git
cd power-monitor
npm install
npm run build
npm start
```

Dashboard: http://localhost:3333

### Docker

```bash
git clone git@github.com:3stacks/power-monitor.git
cd power-monitor
docker compose up -d
```

Dashboard: http://localhost:3333

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PING_TARGET` | `8.8.8.8` | Host to ping for connectivity check |
| `PING_INTERVAL_MS` | `60000` | Ping interval in milliseconds |
| `PING_TIMEOUT_S` | `5` | Ping timeout in seconds |
| `DB_PATH` | `./power-monitor.db` | SQLite database path |
| `WEB_PORT` | `3333` | Web dashboard port |

## CLI Commands

```bash
# Start monitoring with web dashboard
npm start

# View outage history in terminal
npm run history
```

## API

### GET /
Returns the HTML status page dashboard.

### GET /api/status
Returns JSON with current status and outage data:

```json
{
  "status": "operational",
  "currentOutage": null,
  "uptimeData": [...],
  "recentOutages": [...]
}
```

## Running on Boot (macOS)

Create `~/Library/LaunchAgents/com.power-monitor.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.power-monitor</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/power-monitor/build/index.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>/path/to/power-monitor</string>
</dict>
</plist>
```

Then:
```bash
launchctl load ~/Library/LaunchAgents/com.power-monitor.plist
```

## Freezer Safety

The dashboard warns about extended outages:
- **Yellow (1+ hour)**: Check freezer
- **Red (4+ hours)**: Freezer contents may be compromised

A typical freezer stays safe for 24-48 hours if kept closed, but 4 hours is a reasonable "check on it" threshold.

## License

ISC
