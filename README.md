# XRPL Dormant Whale Tracker

A clean, minimal website that monitors the XRP Ledger in real time and surfaces wallets that have been inactive for 5+ years suddenly moving funds.

---

## Structure

```
xrpl-whale-site/
├── backend/        # Node.js + Express — XRPL WebSocket + REST API + SSE
└── frontend/       # React + Vite — dashboard UI
```

---



## What it shows

- **Stats row** — total detected, last 24h, longest dormancy seen, monitoring status
- **Activity chart** — bar chart of whale events over the last 30 days
- **Live feed** — every dormant wallet reactivation, filterable by direction:
  - **To exchange** — whale moving XRP toward a sell (bearish signal)
  - **From exchange** — whale withdrawing to cold storage (accumulation signal)
  - **Wallet → Wallet** — internal move, ambiguous

Each event shows:
- From/to addresses (labeled if known)
- Amount in XRP
- How long the wallet was dormant
- Direction classification
- Link to XRPSCAN for full tx details

New events flash green briefly when they arrive via SSE (Server-Sent Events) — no polling, fully live.

---

## Deploying

**Backend** → Railway, Render, or Fly.io (needs persistent WebSocket connection)
**Frontend** → Vercel or Netlify (static build: `npm run build`)

For production, set `VITE_API_URL` in the frontend to point to your deployed backend URL, and update the `API` constant in `App.jsx`.

---

## Expanding later

The backend is modular — adding ETF flow monitoring or ODL corridor tracking means adding new polling loops in `server.js` and new sections in `App.jsx`. The SSE broadcast system already handles multiple event types.
