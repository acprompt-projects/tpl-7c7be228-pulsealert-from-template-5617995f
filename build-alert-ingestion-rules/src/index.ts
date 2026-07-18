import express, { Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { Alert, Rule, RulesEngine, Severity } from "./rules";

interface StoredAlert extends Alert {
  routedChannels: string[];
}

class AlertStore {
  private alerts: Map<string, StoredAlert> = new Map();

  add(alert: Alert, channels: string[]): StoredAlert {
    const stored: StoredAlert = { ...alert, routedChannels: channels };
    this.alerts.set(alert.id, stored);
    return stored;
  }

  get(id: string): StoredAlert | undefined {
    return this.alerts.get(id);
  }

  list(limit = 50, status?: string): StoredAlert[] {
    let items = Array.from(this.alerts.values())
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    if (status) items = items.filter((a) => a.status === status);
    return items.slice(0, limit);
  }

  updateStatus(id: string, status: "active" | "acknowledged" | "resolved"): StoredAlert | null {
    const alert = this.alerts.get(id);
    if (!alert) return null;
    alert.status = status;
    return alert;
  }
}

const VALID_SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

const app = express();
app.use(express.json());

const engine = new RulesEngine();
const store = new AlertStore();

// Seed default rules
engine.addRule({
  id: "rule-critical", name: "Critical Alerts → Slack + Email",
  enabled: true, cooldownMinutes: 1,
  conditions: [{ field: "severity", operator: ">=", value: "critical" }],
  actions: [
    { channel: "slack", target: "#ops-critical" },
    { channel: "email", target: "oncall@example.com" },
  ],
  escalation: { afterMinutes: 15, channel: "email", target: "vp-eng@example.com" },
});
engine.addRule({
  id: "rule-high", name: "High Alerts → Slack",
  enabled: true, cooldownMinutes: 5,
  conditions: [{ field: "severity", operator: ">=", value: "high" }],
  actions: [{ channel: "slack", target: "#ops-alerts" }],
});
engine.addRule({
  id: "rule-api-down", name: "API Down → Discord + Email",
  enabled: true, cooldownMinutes: 3,
  conditions: [
    { field: "source", operator: "contains", value: "api" },
    { field: "severity", operator: ">=", value: "high" },
  ],
  actions: [
    { channel: "discord", target: "api-monitor-channel" },
    { channel: "email", target: "api-team@example.com" },
  ],
});

// ---- REST API ----

app.post("/alerts", (req: Request, res: Response) => {
  const { source, severity, message, metadata } = req.body;
  if (!source || !severity || !message) {
    res.status(400).json({ error: "source, severity, and message are required" });
    return;
  }
  if (!VALID_SEVERITIES.includes(severity)) {
    res.status(400).json({ error: `severity must be one of: ${VALID_SEVERITIES.join(",")}` });
    return;
  }

  const alert: Alert = {
    id: uuid(), source, severity, message,
    metadata: metadata ?? {}, timestamp: new Date().toISOString(), status: "active",
  };

  const matches = engine.evaluate(alert);
  const channels = matches.flatMap((m) => m.actions.map((a) => `${a.channel}:${a.target}`));
  const matchedRule = matches[0]?.rule.id;
  alert.ruleId = matchedRule;

  // Simulate routing notifications
  for (const match of matches) {
    for (const action of match.actions) {
      console.log(`[ROUTE] Alert ${alert.id} → ${action.channel}:${action.target} (rule: ${match.rule.name})`);
    }
  }

  const stored = store.add(alert, channels);
  res.status(201).json(stored);
});

app.get("/alerts", (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const status = req.query.status as string | undefined;
  res.json(store.list(limit, status));
});

app.get("/alerts/:id", (req: Request, res: Response) => {
  const alert = store.get(req.params.id);
  if (!alert) { res.status(404).json({ error: "not found" }); return; }
  res.json(alert);
});

app.patch("/alerts/:id/status", (req: Request, res: Response) => {
  const { status } = req.body;
  if (!["acknowledged", "resolved"].includes(status)) {
    res.status(400).json({ error: "status must be acknowledged or resolved" });
    return;
  }
  const updated = store.updateStatus(req.params.id, status);
  if (!updated) { res.status(404).json({ error: "not found" }); return; }
  res.json(updated);
});

app.get("/rules", (_req: Request, res: Response) => {
  res.json(engine.getRules());
});

app.post("/rules", (req: Request, res: Response) => {
  const rule = req.body as Rule;
  if (!rule.id || !rule.name || !rule.conditions?.length || !rule.actions?.length) {
    res.status(400).json({ error: "id, name, conditions[], and actions[] are required" });
    return;
  }
  engine.addRule(rule);
  res.status(201).json(rule);
});

app.delete("/rules/:id", (req: Request, res: Response) => {
  const removed = engine.removeRule(req.params.id);
  if (!removed) { res.status(404).json({ error: "not found" }); return; }
  res.status(204).end();
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", rules: engine.getRules().length, uptime: process.uptime() });
});

const PORT = parseInt(process.env.PORT || "3000");
app.listen(PORT, () => console.log(`pulsealert-ingestion listening on :${PORT}`));

export { app, engine, store };