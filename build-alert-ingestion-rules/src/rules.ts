export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Channel = "slack" | "discord" | "email";

export interface Alert {
  id: string;
  source: string;
  severity: Severity;
  message: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  status: "active" | "acknowledged" | "resolved";
  ruleId?: string;
}

export interface RuleCondition {
  field: "severity" | "source" | "metadata";
  operator: ">=" | "==" | "contains" | "matches";
  value: string | number;
}

export interface RuleAction {
  channel: Channel;
  target: string;
  template?: string;
}

export interface EscalationPolicy {
  afterMinutes: number;
  channel: Channel;
  target: string;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: RuleCondition[];
  actions: RuleAction[];
  escalation?: EscalationPolicy;
  cooldownMinutes: number;
}

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0, low: 1, medium: 2, high: 3, critical: 4,
};

export class RulesEngine {
  private rules: Map<string, Rule> = new Map();
  private lastFired: Map<string, number> = new Map();
  private escalationTimers: Map<string, NodeJS.Timeout> = new Map();

  addRule(rule: Rule): void {
    this.rules.set(rule.id, rule);
  }

  removeRule(id: string): boolean {
    this.escalationTimers.get(id)?.clear();
    this.escalationTimers.delete(id);
    return this.rules.delete(id);
  }

  getRules(): Rule[] {
    return Array.from(this.rules.values());
  }

  evaluate(alert: Alert): { rule: Rule; actions: RuleAction[] }[] {
    const results: { rule: Rule; actions: RuleAction[] }[] = [];
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      if (this.isInCooldown(rule.id, alert.source)) continue;
      if (this.matchesConditions(alert, rule)) {
        results.push({ rule, actions: rule.actions });
        this.lastFired.set(`${rule.id}:${alert.source}`, Date.now());
        if (rule.escalation) {
          this.scheduleEscalation(alert, rule);
        }
      }
    }
    return results.sort((a, b) =>
      SEVERITY_RANK[a.actions[0]?.channel === "email" ? 0 : 1] -
      SEVERITY_RANK[b.actions[0]?.channel === "email" ? 0 : 1]
    );
  }

  private matchesConditions(alert: Alert, rule: Rule): boolean {
    return rule.conditions.every((cond) => {
      const actual = this.resolveField(alert, cond);
      if (actual === undefined) return false;
      switch (cond.operator) {
        case ">=":
          return typeof actual === "number"
            ? actual >= (cond.value as number)
            : SEVERITY_RANK[actual as Severity] >= SEVERITY_RANK[cond.value as Severity];
        case "==":
          return String(actual) === String(cond.value);
        case "contains":
          return String(actual).includes(String(cond.value));
        case "matches":
          return new RegExp(String(cond.value)).test(String(actual));
        default:
          return false;
      }
    });
  }

  private resolveField(alert: Alert, cond: RuleCondition): unknown {
    if (cond.field === "severity") return alert.severity;
    if (cond.field === "source") return alert.source;
    if (cond.field === "metadata") {
      const key = String(cond.value).split(".")[0];
      return alert.metadata[key];
    }
    return undefined;
  }

  private isInCooldown(ruleId: string, source: string): boolean {
    const key = `${ruleId}:${source}`;
    const last = this.lastFired.get(key);
    if (!last) return false;
    const rule = this.rules.get(ruleId);
    return Date.now() - last < (rule?.cooldownMinutes ?? 5) * 60_000;
  }

  private scheduleEscalation(alert: Alert, rule: Rule): void {
    const key = `esc:${alert.id}:${rule.id}`;
    this.escalationTimers.get(key)?.clear();
    const timer = setTimeout(() => {
      const esc = rule.escalation!;
      console.log(`[ESCALATION] Alert ${alert.id} escalated after ${esc.afterMinutes}m → ${esc.channel}:${esc.target}`);
      this.escalationTimers.delete(key);
    }, rule.escalation.afterMinutes * 60_000);
    this.escalationTimers.set(key, timer);
  }
}