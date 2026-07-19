import { useState, useEffect, useRef, useCallback } from "react";

const SEVERITY_CONFIG = {
  critical: { bg: "bg-red-100", border: "border-red-500", text: "text-red-800", badge: "bg-red-600", dot: "bg-red-500" },
  warning: { bg: "bg-amber-100", border: "border-amber-500", text: "text-amber-800", badge: "bg-amber-500", dot: "bg-amber-500" },
  info: { bg: "bg-sky-100", border: "border-sky-500", text: "text-sky-800", badge: "bg-sky-500", dot: "bg-sky-500" },
};

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:3001/ws/alerts";
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001/api";

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function useWebSocket(url) {
  const [alerts, setAlerts] = useState([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectRef = useRef(null);

  const connect = useCallback(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      reconnectRef.current = setTimeout(connect, 3000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const incoming = Array.isArray(data) ? data : [data];
        setAlerts((prev) => [...incoming.reverse(), ...prev].slice(0, 500));
      } catch { /* ignore bad frames */ }
    };
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const acknowledge = useCallback(async (alertId) => {
    try {
      await fetch(`${API_URL}/alerts/${alertId}/ack`, { method: "POST", headers: { "Content-Type": "application/json" } });
      setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, acknowledged: true } : a)));
    } catch {
      setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, acknowledged: true } : a)));
    }
  }, []);

  const acknowledgeAll = useCallback(async (ids) => {
    for (const id of ids) { await acknowledge(id); }
  }, [acknowledge]);

  return { alerts, connected, acknowledge, acknowledgeAll };
}

function StatCard({ label, value, color, icon }) {
  return (
    <div className={`rounded-lg border-l-4 ${color.border} ${color.bg} p-4 shadow-sm`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
          <p className={`mt-1 text-3xl font-bold ${color.text}`}>{value}</p>
        </div>
        <span className="text-2xl">{icon}</span>
      </div>
    </div>
  );
}

function SeverityChart({ counts }) {
  const total = counts.critical + counts.warning + counts.info || 1;
  return (
    <div className="space-y-3">
      {["critical", "warning", "info"].map((sev) => {
        const pct = Math.round((counts[sev] / total) * 100);
        const cfg = SEVERITY_CONFIG[sev];
        return (
          <div key={sev}>
            <div className="flex justify-between text-sm mb-1">
              <span className={`font-medium capitalize ${cfg.text}`}>{sev}</span>
              <span className="text-gray-500">{counts[sev]} ({pct}%)</span>
            </div>
            <div className="h-2 w-full rounded-full bg-gray-200">
              <div className={`h-2 rounded-full ${cfg.badge} transition-all duration-500`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AlertRow({ alert, onAck }) {
  const cfg = SEVERITY_CONFIG[alert.severity] || SEVERITY_CONFIG.info;
  return (
    <div className={`flex items-start gap-3 rounded-lg border ${cfg.border} ${cfg.bg} p-3 transition-all hover:shadow-md ${alert.acknowledged ? "opacity-50" : ""}`}>
      <div className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${cfg.dot} ${alert.acknowledged ? "" : "animate-pulse"}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`inline-block rounded px-2 py-0.5 text-xs font-semibold text-white ${cfg.badge}`}>{alert.severity.toUpperCase()}</span>
          <span className="font-semibold text-gray-900 truncate">{alert.service || alert.source || "Unknown"}</span>
          <span className="ml-auto shrink-0 text-xs text-gray-500">{formatTime(alert.timestamp)}</span>
        </div>
        <p className="mt-1 text-sm text-gray-700 break-words">{alert.message || alert.description || JSON.stringify(alert)}</p>
        {alert.metadata && Object.keys(alert.metadata).length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {Object.entries(alert.metadata).map(([k, v]) => (
              <span key={k} className="rounded bg-white/60 px-1.5 py-0.5 text-xs text-gray-600">{k}: {String(v)}</span>
            ))}
          </div>
        )}
      </div>
      {!alert.acknowledged && (
        <button onClick={() => onAck(alert.id)} className="shrink-0 rounded bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-sm ring-1 ring-gray-300 hover:bg-gray-50 active:bg-gray-100">
          ACK
        </button>
      )}
    </div>
  );
}

export default function App() {
  const { alerts, connected, acknowledge, acknowledgeAll } = useWebSocket(WS_URL);
  const [severityFilter, setSeverityFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");

  const filtered = alerts.filter((a) => {
    if (severityFilter !== "all" && a.severity !== severityFilter) return false;
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      return ((a.message || "") + (a.service || "") + (a.source || "")).toLowerCase().includes(s);
    }
    return true;
  });

  const counts = { critical: 0, warning: 0, info: 0 };
  alerts.forEach((a) => { if (counts[a.severity] !== undefined) counts[a.severity]++; });
  const unacked = alerts.filter((a) => !a.acknowledged);
  const unackedIds = unacked.filter((a) => severityFilter === "all" || a.severity === severityFilter).map((a) => a.id);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-gray-900">🚨 PulseAlert</h1>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${connected ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
              {connected ? "Live" : "Disconnected"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input type="text" placeholder="Search alerts…" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
            <button onClick={() => acknowledgeAll(unackedIds)} disabled={unackedIds.length === 0} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed">
              Ack All ({unackedIds.length})
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 space-y-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Total Alerts" value={alerts.length} color={SEVERITY_CONFIG.info} icon="📊" />
          <StatCard label="Critical" value={counts.critical} color={SEVERITY_CONFIG.critical} icon="🔴" />
          <StatCard label="Warning" value={counts.warning} color={SEVERITY_CONFIG.warning} icon="🟡" />
          <StatCard label="Unacknowledged" value={unacked.length} color={SEVERITY_CONFIG.critical} icon="⚠️" />
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center gap-2">
              {["all", "critical", "warning", "info"].map((s) => (
                <button key={s} onClick={() => setSeverityFilter(s)} className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${severityFilter === s ? "bg-gray-900 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"}`}>
                  {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
              <span className="ml-auto text-sm text-gray-500">{filtered.length} alert{filtered.length !== 1 ? "s" : ""}</span>
            </div>
            <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
              {filtered.length === 0 && <p className="py-12 text-center text-gray-400">No alerts matching filter</p>}
              {filtered.map((a) => (<AlertRow key={a.id} alert={a} onAck={acknowledge} />))}
            </div>
          </div>
          <div className="space-y-6">
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">Severity Distribution</h2>
              <SeverityChart counts={counts} />
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">Top Services</h2>
              {(() => {
                const svc = {};
                alerts.forEach((a) => { const s = a.service || a.source || "unknown"; svc[s] = (svc[s] || 0) + 1; });
                return Object.entries(svc).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => (
                  <div key={name} className="flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0">
                    <span className="text-sm text-gray-700 truncate">{name}</span>
                    <span className="ml-2 shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">{count}</span>
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}