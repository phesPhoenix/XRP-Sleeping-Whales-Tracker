const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const XRPL_WS = "wss://xrplcluster.com";
const DROPS_PER_XRP = 1_000_000;
const MIN_DORMANCY_YEARS = 5;
const MIN_DORMANCY_SECONDS = MIN_DORMANCY_YEARS * 365.25 * 24 * 3600;
const MAX_EVENTS = 100;

const KNOWN_ADDRESSES = {
  rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY: "Ripple Escrow",
  rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh: "Ripple Genesis",
  rEy8TFcrAPvhpKrwyrscNYyqBGUkE9hKaJ: "Bithumb",
  rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w: "Binance",
  rGWrZyax5eXbi5gs49MRZKkE9CaYmwmDdX: "Upbit",
  rJb5KsHsDmVmwBSKDALcQVnMwmSfPaV7AC: "Coinbase",
  rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3: "Kraken",
  rEXZpKMBBWGXNAhxTpfHBq5jjFGKxj5rFK: "Uphold",
};

const EXCHANGE_ADDRESSES = new Set([
  "rEy8TFcrAPvhpKrwyrscNYyqBGUkE9hKaJ",
  "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w",
  "rGWrZyax5eXbi5gs49MRZKkE9CaYmwmDdX",
  "rJb5KsHsDmVmwBSKDALcQVnMwmSfPaV7AC",
  "rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3",
  "rEXZpKMBBWGXNAhxTpfHBq5jjFGKxj5rFK",
]);

// In-memory store
const events = [];
const stats = { total: 0, last24h: 0, longestDormancy: 0 };
let wsConnected = false;
let ws;
let reconnectTimeout;

// SSE clients
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  }
}

function labelAddress(addr) {
  return KNOWN_ADDRESSES[addr] || null;
}

function getDirection(from, to) {
  if (EXCHANGE_ADDRESSES.has(to)) return "to-exchange";
  if (EXCHANGE_ADDRESSES.has(from)) return "from-exchange";
  return "wallet-to-wallet";
}

async function fetchAccountInfo(address) {
  return new Promise((resolve) => {
    const tempWs = new WebSocket(XRPL_WS);
    const timeout = setTimeout(() => { tempWs.close(); resolve(null); }, 5000);

    tempWs.on("open", () => {
      tempWs.send(JSON.stringify({
        command: "account_info",
        account: address,
        ledger_index: "validated",
      }));
    });

    tempWs.on("message", (data) => {
      clearTimeout(timeout);
      try {
        const msg = JSON.parse(data);
        resolve(msg?.result?.account_data || null);
      } catch { resolve(null); }
      tempWs.close();
    });

    tempWs.on("error", () => { clearTimeout(timeout); resolve(null); });
  });
}

async function fetchLastTxTime(address) {
  return new Promise((resolve) => {
    const tempWs = new WebSocket(XRPL_WS);
    const timeout = setTimeout(() => { tempWs.close(); resolve(null); }, 6000);

    tempWs.on("open", () => {
      tempWs.send(JSON.stringify({
        command: "account_tx",
        account: address,
        limit: 2,
        forward: false,
      }));
    });

    tempWs.on("message", (data) => {
      clearTimeout(timeout);
      try {
        const msg = JSON.parse(data);
        const txs = msg?.result?.transactions;
        if (txs && txs.length >= 2) {
          // Second result is the previous tx (first is the current one)
          const prevTx = txs[1];
          const rippleEpoch = 946684800;
          const closeTime = prevTx?.tx?.date;
          if (closeTime) resolve(closeTime + rippleEpoch);
          else resolve(null);
        } else resolve(null);
      } catch { resolve(null); }
      tempWs.close();
    });

    tempWs.on("error", () => { clearTimeout(timeout); resolve(null); });
  });
}

async function handleTransaction(msg) {
  const tx = msg.transaction;
  const meta = msg.meta;
  if (!tx || meta?.TransactionResult !== "tesSUCCESS") return;
  if (tx.TransactionType !== "Payment") return;
  if (typeof tx.Amount !== "string") return;

  const xrp = parseInt(tx.Amount) / DROPS_PER_XRP;
  if (xrp < 10000) return; // skip tiny txs to avoid hammering account_tx

  const lastTxUnix = await fetchLastTxTime(tx.Account);
  if (!lastTxUnix) return;

  const nowUnix = Math.floor(Date.now() / 1000);
  const dormancySeconds = nowUnix - lastTxUnix;
  if (dormancySeconds < MIN_DORMANCY_SECONDS) return;

  const dormancyYears = dormancySeconds / (365.25 * 24 * 3600);
  const direction = getDirection(tx.Account, tx.Destination);

  const event = {
    id: `${tx.hash}-${Date.now()}`,
    hash: tx.hash,
    timestamp: new Date().toISOString(),
    from: tx.Account,
    fromLabel: labelAddress(tx.Account),
    to: tx.Destination,
    toLabel: labelAddress(tx.Destination),
    amountXRP: Math.round(xrp),
    dormancyYears: parseFloat(dormancyYears.toFixed(1)),
    dormancySeconds,
    direction,
  };

  events.unshift(event);
  if (events.length > MAX_EVENTS) events.pop();

  stats.total++;
  stats.last24h = events.filter(
    (e) => Date.now() - new Date(e.timestamp).getTime() < 86400000
  ).length;
  if (dormancyYears > stats.longestDormancy) stats.longestDormancy = parseFloat(dormancyYears.toFixed(1));

  console.log(`WHALE REACTIVATED: ${tx.Account} | ${dormancyYears.toFixed(1)}yr dormant | ${xrp.toLocaleString()} XRP`);
  broadcast({ type: "event", event, stats });
}

function connectXRPL() {
  console.log("Connecting to XRPL...");
  ws = new WebSocket(XRPL_WS);

  ws.on("open", () => {
    wsConnected = true;
    console.log("Connected to XRPL");
    ws.send(JSON.stringify({ command: "subscribe", streams: ["transactions"] }));
    broadcast({ type: "status", connected: true });
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "transaction" && msg.validated) handleTransaction(msg);
    } catch (_) {}
  });

  ws.on("close", () => {
    wsConnected = false;
    broadcast({ type: "status", connected: false });
    console.warn("XRPL disconnected, reconnecting in 5s...");
    clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connectXRPL, 5000);
  });

  ws.on("error", (err) => {
    console.error("XRPL error:", err.message);
    ws.close();
  });
}

// ── REST API ──────────────────────────────────────────────────────────────────
app.get("/api/events", (req, res) => {
  res.json({ events, stats, connected: wsConnected });
});

app.get("/api/status", (req, res) => {
  res.json({ connected: wsConnected, stats });
});

// SSE endpoint for live updates
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify({ type: "init", events, stats, connected: wsConnected })}\n\n`);

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
  connectXRPL();
});
