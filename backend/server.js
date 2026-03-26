const express = require("express");
const WebSocket = require("ws");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;
const XRPL_WS = "wss://s1.ripple.com";
const DROPS_PER_XRP = 1_000_000;
const THRESHOLD_XRP = 10_000_000;
const ESCROW_BLACKLIST = new Set([
  "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
  "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY",
  "rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn",
  "rN7n3473SaZBCG4dFL83w7PB5Nd8HPKZND",
  "rBSWZVHkBBNnNjMwUGMsYLTpYQMRyGHSAJ",
]);
const MAX_EVENTS = 50;

const KNOWN = {
  rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY: "Ripple Escrow",
  rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh: "Ripple Genesis",
  rEy8TFcrAPvhpKrwyrscNYyqBGUkE9hKaJ: "Bithumb",
  rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w: "Binance",
  rGWrZyax5eXbi5gs49MRZKkE9CaYmwmDdX: "Upbit",
  rJb5KsHsDmVmwBSKDALcQVnMwmSfPaV7AC: "Coinbase",
  rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3: "Kraken",
  rEXZpKMBBWGXNAhxTpfHBq5jjFGKxj5rFK: "Uphold",
};

function label(addr) {
  return KNOWN[addr] ? `${KNOWN[addr]}` : `${addr.slice(0, 8)}…`;
}

// state
const events = [];
let price = null;
let priceHistory = []; // { t, p }
let wsConnected = false;
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  }
}

async function fetchPrice() {
  try {
    const r = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd");
    const p = r.data.ripple.usd;
    price = p;
    const entry = { t: Date.now(), p };
    priceHistory.push(entry);
    if (priceHistory.length > 60) priceHistory.shift(); // keep 1hr of 1-min samples
    broadcast({ type: "price", price: p, history: priceHistory });
  } catch (_) {}
}

setInterval(fetchPrice, 60_000);
fetchPrice();

let ws;
let reconnectTimeout;

function connect() {
  ws = new WebSocket(XRPL_WS);

  ws.on("open", () => {
    wsConnected = true;
    ws.send(JSON.stringify({ command: "subscribe", streams: ["transactions"] }));
    broadcast({ type: "status", connected: true });
    console.log("XRPL connected");
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "transaction" && msg.validated) handle(msg);
    } catch (_) {}
  });

  ws.on("close", () => {
    wsConnected = false;
    broadcast({ type: "status", connected: false });
    clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connect, 5000);
  });

  ws.on("error", () => ws.close());
}

function handle(msg) {
  const tx = msg.transaction;
  const meta = msg.meta;
  if (!tx || meta?.TransactionResult !== "tesSUCCESS") return;
  if (tx.TransactionType !== "Payment") return;
  if (typeof tx.Amount !== "string") return;

  const xrp = parseInt(tx.Amount) / DROPS_PER_XRP;
  if (xrp < THRESHOLD_XRP) return;
  if (ESCROW_BLACKLIST.has(tx.Account)) return;  


  const usd = price ? Math.round(xrp * price).toLocaleString() : null;

  const event = {
    id: tx.hash,
    ts: Date.now(),
    from: tx.Account,
    fromLabel: label(tx.Account),
    to: tx.Destination,
    toLabel: label(tx.Destination),
    xrp: Math.round(xrp),
    usd,
    hash: tx.hash,
  };

  events.unshift(event);
  if (events.length > MAX_EVENTS) events.pop();

  console.log(`WHALE: ${event.fromLabel} → ${event.toLabel} | ${event.xrp.toLocaleString()} XRP`);
  broadcast({ type: "event", event });
}

connect();

app.get("/api/init", (_, res) => {
  res.json({ events, price, priceHistory, connected: wsConnected });
});

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "init", events, price, priceHistory, connected: wsConnected })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

app.listen(PORT, () => console.log(`Server on :${PORT}`));
