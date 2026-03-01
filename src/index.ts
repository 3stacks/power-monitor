import Database from "better-sqlite3";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import express from "express";

const execAsync = promisify(exec);

// Config
const PING_TARGET = process.env.PING_TARGET || "8.8.8.8";
const PING_INTERVAL_MS = parseInt(process.env.PING_INTERVAL_MS || "60000", 10);
const PING_TIMEOUT_S = parseInt(process.env.PING_TIMEOUT_S || "5", 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "power-monitor.db");
const WEB_PORT = parseInt(process.env.WEB_PORT || "3333", 10);

// Initialize database
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS outages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_minutes INTEGER,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS pings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    success INTEGER NOT NULL
  );
`);

// State
let currentOutageId: number | null = null;
let lastStatus: boolean | null = null;

// Check for unclosed outages on startup (server crashed during outage)
function checkUnclosedOutages(): void {
  const unclosed = db
    .prepare("SELECT id, started_at FROM outages WHERE ended_at IS NULL")
    .get() as { id: number; started_at: string } | undefined;

  if (unclosed) {
    const now = new Date().toISOString();
    const startedAt = new Date(unclosed.started_at);
    const endedAt = new Date(now);
    const durationMinutes = Math.round(
      (endedAt.getTime() - startedAt.getTime()) / (1000 * 60)
    );

    db.prepare(
      "UPDATE outages SET ended_at = ?, duration_minutes = ?, notes = ? WHERE id = ?"
    ).run(now, durationMinutes, "Closed on startup (server may have lost power)", unclosed.id);

    console.log(
      `[STARTUP] Closed unclosed outage #${unclosed.id} - duration: ${durationMinutes} minutes (approximate)`
    );
  }
}

// Ping function
async function ping(): Promise<boolean> {
  try {
    await execAsync(`ping -c 1 -W ${PING_TIMEOUT_S} ${PING_TARGET}`, {
      timeout: (PING_TIMEOUT_S + 2) * 1000,
    });
    return true;
  } catch {
    return false;
  }
}

// Record ping result
function recordPing(success: boolean): void {
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO pings (timestamp, success) VALUES (?, ?)").run(
    timestamp,
    success ? 1 : 0
  );

  // Keep only last 24 hours of pings
  db.prepare(
    "DELETE FROM pings WHERE timestamp < datetime('now', '-1 day')"
  ).run();
}

// Start an outage
function startOutage(): void {
  const startedAt = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO outages (started_at) VALUES (?)")
    .run(startedAt);
  currentOutageId = result.lastInsertRowid as number;
  console.log(`[OUTAGE STARTED] ${startedAt} - Outage #${currentOutageId}`);
}

// End an outage
function endOutage(): void {
  if (!currentOutageId) return;

  const endedAt = new Date().toISOString();
  const outage = db
    .prepare("SELECT started_at FROM outages WHERE id = ?")
    .get(currentOutageId) as { started_at: string };

  const startedAt = new Date(outage.started_at);
  const durationMinutes = Math.round(
    (new Date(endedAt).getTime() - startedAt.getTime()) / (1000 * 60)
  );

  db.prepare(
    "UPDATE outages SET ended_at = ?, duration_minutes = ? WHERE id = ?"
  ).run(endedAt, durationMinutes, currentOutageId);

  console.log(
    `[OUTAGE ENDED] ${endedAt} - Outage #${currentOutageId} lasted ${durationMinutes} minutes`
  );

  // Freezer warning
  if (durationMinutes >= 60) {
    console.log(`⚠️  WARNING: Outage lasted ${durationMinutes} minutes - check freezer!`);
  }
  if (durationMinutes >= 240) {
    console.log(`🚨 CRITICAL: Outage lasted ${durationMinutes} minutes (4+ hours) - freezer contents may be compromised!`);
  }

  currentOutageId = null;
}

// Main monitoring loop
async function monitor(): Promise<void> {
  const success = await ping();
  recordPing(success);

  const timestamp = new Date().toISOString();

  if (success) {
    if (lastStatus === false) {
      // Was down, now up - end outage
      endOutage();
    }
    console.log(`[${timestamp}] ✓ Network up`);
  } else {
    if (lastStatus !== false) {
      // Was up (or first check), now down - start outage
      startOutage();
    }
    console.log(`[${timestamp}] ✗ Network down`);
  }

  lastStatus = success;
}

// Show outage history
function showHistory(): void {
  const outages = db
    .prepare(
      "SELECT * FROM outages ORDER BY started_at DESC LIMIT 20"
    )
    .all() as Array<{
    id: number;
    started_at: string;
    ended_at: string | null;
    duration_minutes: number | null;
    notes: string | null;
  }>;

  console.log("\n=== Recent Power Outages ===\n");

  if (outages.length === 0) {
    console.log("No outages recorded.");
    return;
  }

  for (const outage of outages) {
    const start = new Date(outage.started_at).toLocaleString();
    const end = outage.ended_at
      ? new Date(outage.ended_at).toLocaleString()
      : "ongoing";
    const duration = outage.duration_minutes
      ? `${outage.duration_minutes} min`
      : "...";
    const notes = outage.notes ? ` (${outage.notes})` : "";

    let warning = "";
    if (outage.duration_minutes && outage.duration_minutes >= 240) {
      warning = " 🚨 FREEZER RISK";
    } else if (outage.duration_minutes && outage.duration_minutes >= 60) {
      warning = " ⚠️";
    }

    console.log(`#${outage.id}: ${start} → ${end} [${duration}]${warning}${notes}`);
  }

  // Stats
  const stats = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(duration_minutes) as total_minutes,
        AVG(duration_minutes) as avg_minutes,
        MAX(duration_minutes) as max_minutes
      FROM outages WHERE ended_at IS NOT NULL`
    )
    .get() as {
    total: number;
    total_minutes: number;
    avg_minutes: number;
    max_minutes: number;
  };

  console.log("\n=== Stats ===");
  console.log(`Total outages: ${stats.total}`);
  console.log(`Total downtime: ${stats.total_minutes || 0} minutes`);
  console.log(`Average outage: ${Math.round(stats.avg_minutes || 0)} minutes`);
  console.log(`Longest outage: ${stats.max_minutes || 0} minutes`);
}

// Get uptime data for last 7 days (by day)
function getUptimeData(): Array<{ date: string; uptimePercent: number; outageMinutes: number }> {
  const days: Array<{ date: string; uptimePercent: number; outageMinutes: number }> = [];

  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = nextDate.toISOString().split("T")[0];

    // Get outages that overlap with this day
    const outages = db.prepare(`
      SELECT started_at, ended_at, duration_minutes
      FROM outages
      WHERE started_at < ? AND (ended_at > ? OR ended_at IS NULL)
    `).all(nextDateStr, dateStr) as Array<{
      started_at: string;
      ended_at: string | null;
      duration_minutes: number | null;
    }>;

    let outageMinutes = 0;
    for (const outage of outages) {
      const outageStart = new Date(outage.started_at);
      const outageEnd = outage.ended_at ? new Date(outage.ended_at) : new Date();
      const dayStart = new Date(dateStr);
      const dayEnd = new Date(nextDateStr);

      const overlapStart = Math.max(outageStart.getTime(), dayStart.getTime());
      const overlapEnd = Math.min(outageEnd.getTime(), dayEnd.getTime());

      if (overlapEnd > overlapStart) {
        outageMinutes += (overlapEnd - overlapStart) / (1000 * 60);
      }
    }

    const totalMinutes = 24 * 60;
    const uptimePercent = Math.max(0, Math.min(100, ((totalMinutes - outageMinutes) / totalMinutes) * 100));

    days.push({
      date: dateStr,
      uptimePercent: Math.round(uptimePercent * 100) / 100,
      outageMinutes: Math.round(outageMinutes),
    });
  }

  return days;
}

// Get recent outages
function getRecentOutages(): Array<{
  id: number;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  notes: string | null;
}> {
  return db.prepare(`
    SELECT * FROM outages ORDER BY started_at DESC LIMIT 10
  `).all() as Array<{
    id: number;
    started_at: string;
    ended_at: string | null;
    duration_minutes: number | null;
    notes: string | null;
  }>;
}

// Generate status page HTML
function generateStatusPage(): string {
  const uptimeData = getUptimeData();
  const outages = getRecentOutages();
  const currentStatus = lastStatus !== false;
  const hasOngoingOutage = currentOutageId !== null;

  // Calculate 7-day average uptime
  const avgUptime = uptimeData.reduce((sum, d) => sum + d.uptimePercent, 0) / uptimeData.length;

  const statusColor = currentStatus ? "#10b981" : "#ef4444";
  const statusText = currentStatus ? "All Systems Operational" : "Network Outage Detected";

  const dayBars = uptimeData.map((day) => {
    const date = new Date(day.date);
    const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
    const dateLabel = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    let barColor = "#10b981"; // green
    if (day.uptimePercent < 100) barColor = "#f59e0b"; // yellow
    if (day.uptimePercent < 95) barColor = "#ef4444"; // red

    return `
      <div class="day-bar">
        <div class="bar" style="background: ${barColor};" title="${day.uptimePercent}% uptime, ${day.outageMinutes} min outage"></div>
        <div class="day-label">${dayName}</div>
        <div class="date-label">${dateLabel}</div>
      </div>
    `;
  }).join("");

  const outageRows = outages.length === 0
    ? '<tr><td colspan="4" class="no-outages">No outages recorded</td></tr>'
    : outages.map((o) => {
        const start = new Date(o.started_at).toLocaleString();
        const end = o.ended_at ? new Date(o.ended_at).toLocaleString() : "Ongoing";
        const duration = o.duration_minutes ? `${o.duration_minutes} min` : "...";
        const notes = o.notes || "";

        let rowClass = "";
        if (o.duration_minutes && o.duration_minutes >= 240) rowClass = "critical";
        else if (o.duration_minutes && o.duration_minutes >= 60) rowClass = "warning";
        else if (!o.ended_at) rowClass = "ongoing";

        return `
          <tr class="${rowClass}">
            <td>${start}</td>
            <td>${end}</td>
            <td>${duration}</td>
            <td>${notes}</td>
          </tr>
        `;
      }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="60">
  <title>Power Monitor Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      padding: 2rem;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 2rem;
      color: #f8fafc;
    }
    .status-banner {
      background: ${statusColor}15;
      border: 1px solid ${statusColor}40;
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 2rem;
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .status-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: ${statusColor};
      box-shadow: 0 0 8px ${statusColor};
    }
    .status-text {
      font-size: 1.1rem;
      font-weight: 500;
    }
    .uptime-section {
      background: #1e293b;
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 2rem;
    }
    .uptime-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    .uptime-title {
      font-size: 0.9rem;
      color: #94a3b8;
    }
    .uptime-percent {
      font-size: 1.5rem;
      font-weight: 600;
      color: #10b981;
    }
    .uptime-bars {
      display: flex;
      gap: 8px;
      justify-content: space-between;
    }
    .day-bar {
      flex: 1;
      text-align: center;
    }
    .bar {
      height: 40px;
      border-radius: 4px;
      margin-bottom: 0.5rem;
    }
    .day-label {
      font-size: 0.75rem;
      color: #94a3b8;
    }
    .date-label {
      font-size: 0.65rem;
      color: #64748b;
    }
    .outages-section {
      background: #1e293b;
      border-radius: 8px;
      padding: 1.5rem;
    }
    .outages-title {
      font-size: 0.9rem;
      color: #94a3b8;
      margin-bottom: 1rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      text-align: left;
      padding: 0.75rem;
      border-bottom: 1px solid #334155;
      color: #94a3b8;
      font-size: 0.8rem;
      font-weight: 500;
    }
    td {
      padding: 0.75rem;
      border-bottom: 1px solid #1e293b;
      font-size: 0.85rem;
    }
    tr.warning td { background: #f59e0b15; }
    tr.critical td { background: #ef444415; }
    tr.ongoing td { background: #3b82f615; }
    .no-outages {
      text-align: center;
      color: #64748b;
      padding: 2rem !important;
    }
    .footer {
      text-align: center;
      margin-top: 2rem;
      color: #64748b;
      font-size: 0.75rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Power Monitor</h1>

    <div class="status-banner">
      <div class="status-dot"></div>
      <div class="status-text">${statusText}</div>
    </div>

    <div class="uptime-section">
      <div class="uptime-header">
        <div class="uptime-title">Uptime - Last 7 Days</div>
        <div class="uptime-percent">${avgUptime.toFixed(2)}%</div>
      </div>
      <div class="uptime-bars">
        ${dayBars}
      </div>
    </div>

    <div class="outages-section">
      <div class="outages-title">Recent Outages</div>
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th>Ended</th>
            <th>Duration</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${outageRows}
        </tbody>
      </table>
    </div>

    <div class="footer">
      Auto-refreshes every 60 seconds • Monitoring ${PING_TARGET}
    </div>
  </div>
</body>
</html>`;
}

// Start web server
function startWebServer(): void {
  const app = express();

  app.get("/", (req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.send(generateStatusPage());
  });

  app.get("/api/status", (req, res) => {
    res.json({
      status: lastStatus !== false ? "operational" : "outage",
      currentOutage: currentOutageId,
      uptimeData: getUptimeData(),
      recentOutages: getRecentOutages(),
    });
  });

  app.listen(WEB_PORT, "0.0.0.0", () => {
    console.log(`Web dashboard: http://0.0.0.0:${WEB_PORT}`);
  });
}

// Main
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--history") || args.includes("-h")) {
    showHistory();
    process.exit(0);
  }

  console.log("=== Power Monitor Starting ===");
  console.log(`Ping target: ${PING_TARGET}`);
  console.log(`Interval: ${PING_INTERVAL_MS / 1000}s`);
  console.log(`Database: ${DB_PATH}`);
  console.log("");

  // Check for unclosed outages
  checkUnclosedOutages();

  // Start web server
  startWebServer();

  // Initial check
  await monitor();

  // Start interval
  setInterval(monitor, PING_INTERVAL_MS);

  console.log("\nMonitoring... (Ctrl+C to stop)\n");
}

main().catch(console.error);
