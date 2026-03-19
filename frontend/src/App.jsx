import { useState, useEffect, useRef } from "react";
import "./App.css";

const API = "https://xrp-sleeping-whales-tracker-production.up.railway.app";

function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function shortAddr(addr, label) {
  if (label) return label;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function directionMeta(direction) {
  if (direction === "to-exchange") return { label: "To exchange", color: "var(--color-danger)" };
  if (direction === "from-exchange") return { label: "From exchange", color: "var(--color-success)" };
  return { label: "Wallet → Wallet", color: "var(--color-neutral)" };
}

function StatCard({ label, value, sub }) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

function EventRow({ event, isNew }) {
  const dir = directionMeta(event.direction);
  return (
    <div className={`event-row ${isNew ? "event-new" : ""}`}>
      <div className="event-top">
        <div className="event-addresses">
          <a
            href={`https://xrpscan.com/account/${event.from}`}
            target="_blank"
            rel="noreferrer"
            className="addr from-addr"
          >
            {shortAddr(event.from, event.fromLabel)}
          </a>
          <span className="addr-arrow">→</span>
          <a
            href={`https://xrpscan.com/account/${event.to}`}
            target="_blank"
            rel="noreferrer"
            className="addr"
          >
            {shortAddr(event.to, event.toLabel)}
          </a>
        </div>
        <span className="event-time">{timeAgo(event.timestamp)}</span>
      </div>
      <div className="event-bottom">
        <span className="event-amount">{event.amountXRP.toLocaleString()} XRP</span>
        <span className="dormancy-badge">{event.dormancyYears}yr dormant</span>
        <span className="direction-badge" style={{ color: dir.color }}>{dir.label}</span>
        <a
          href={`https://xrpscan.com/tx/${event.hash}`}
          target="_blank"
          rel="noreferrer"
          className="tx-link"
        >
          View tx ↗
        </a>
      </div>
    </div>
  );
}

function ActivityChart({ events }) {
  // Group events by day for last 30 days
  const days = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days[d.toDateString()] = 0;
  }
  for (const e of events) {
    const key = new Date(e.timestamp).toDateString();
    if (key in days) days[key]++;
  }

  const entries = Object.entries(days);
  const max = Math.max(...Object.values(days), 1);

  return (
    <div className="chart-wrap">
      <div className="chart-bars">
        {entries.map(([day, count]) => (
          <div key={day} className="chart-bar-col" title={`${day}: ${count} event${count !== 1 ? "s" : ""}`}>
            <div
              className="chart-bar"
              style={{ height: `${Math.max((count / max) * 100, count > 0 ? 8 : 2)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="chart-labels">
        <span>30d ago</span>
        <span>today</span>
      </div>
    </div>
  );
}

export default function App() {
  const [events, setEvents] = useState([]);
  const [stats, setStats] = useState({ total: 0, last24h: 0, longestDormancy: 0 });
  const [connected, setConnected] = useState(false);
  const [newIds, setNewIds] = useState(new Set());
  const [filter, setFilter] = useState("all");
  const esRef = useRef(null);

  useEffect(() => {
    // Initial fetch
    fetch(`${API}/api/events`)
      .then((r) => r.json())
      .then(({ events, stats, connected }) => {
        setEvents(events);
        setStats(stats);
        setConnected(connected);
      })
      .catch(console.error);

    // SSE live stream
    const es = new EventSource(`${API}/api/stream`);
    esRef.current = es;

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === "init") {
        setEvents(msg.events);
        setStats(msg.stats);
        setConnected(msg.connected);
      }

      if (msg.type === "event") {
        setEvents((prev) => [msg.event, ...prev].slice(0, 100));
        setStats(msg.stats);
        setNewIds((prev) => new Set([...prev, msg.event.id]));
        setTimeout(() => {
          setNewIds((prev) => { const n = new Set(prev); n.delete(msg.event.id); return n; });
        }, 3000);
      }

      if (msg.type === "status") {
        setConnected(msg.connected);
      }
    };

    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  const filtered = filter === "all"
    ? events
    : events.filter((e) => e.direction === filter);

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1>Dormant Whale Tracker</h1>
          <p className="header-sub">XRP wallets silent for 5+ years, now moving</p>
        </div>
        <div className="status-dot-wrap">
          <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
          <span className="status-label">{connected ? "Live" : "Reconnecting"}</span>
        </div>
      </header>

      <div className="stats-row">
        <StatCard label="Total detected" value={stats.total} />
        <StatCard label="Last 24h" value={stats.last24h} />
        <StatCard
          label="Longest dormancy"
          value={stats.longestDormancy > 0 ? `${stats.longestDormancy}yr` : "—"}
        />
        <StatCard label="Watching" value="All wallets" sub="≥ 5yr dormant" />
      </div>

      <div className="section">
        <div className="section-header">
          <h2>Activity — last 30 days</h2>
        </div>
        <ActivityChart events={events} />
      </div>

      <div className="section">
        <div className="section-header">
          <h2>Live feed</h2>
          <div className="filter-tabs">
            {[
              { key: "all", label: "All" },
              { key: "to-exchange", label: "To exchange" },
              { key: "from-exchange", label: "From exchange" },
              { key: "wallet-to-wallet", label: "Wallet → Wallet" },
            ].map((f) => (
              <button
                key={f.key}
                className={`filter-tab ${filter === f.key ? "active" : ""}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="empty-state">
            <p>Watching the ledger for dormant whale activity…</p>
            <p className="empty-sub">Events will appear here in real time as wallets wake up.</p>
          </div>
        ) : (
          <div className="event-list">
            {filtered.map((e) => (
              <EventRow key={e.id} event={e} isNew={newIds.has(e.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
