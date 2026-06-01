import ccxt from "ccxt";

const client = new ccxt.okx({
  apiKey: "b1e457eb-08b1-452f-909b-b82971b748dc",
  secret: "7947DF4FF718B2D8E28053B33A8BF59D",
  password: "Aa1357913579~",
  enableRateLimit: true,
  options: { defaultType: "swap", sandboxMode: true },
});
client.httpsProxy = "http://127.0.0.1:7890";
if (typeof client.setSandboxMode === "function") client.setSandboxMode(true);
await client.loadMarkets();
console.log("connected");

const swap = "BTC/USDT:USDT";

// 开+平
let o = await client.createOrder(swap, "market", "buy", 1, undefined, { tdMode: "isolated", posSide: "long" });
console.log("open:", o.id, "avg:", o.average);

// 平
await new Promise(r => setTimeout(r, 1000));
let c = await client.createOrder(swap, "market", "sell", 1, undefined, { tdMode: "isolated", posSide: "long", reduceOnly: true });
console.log("close:", c.id, "avg:", c.average);

// fetchOrder 拿 avgPrice
await new Promise(r => setTimeout(r, 1000));
let fc = await client.fetchOrder(c.id, swap);
console.log("fetchOrder: avg=", fc.average, "filled=", fc.filled);

// fetchClosedOrders — 看有没有 realizedPnl
let closed = await client.fetchClosedOrders(swap, undefined, 5);
for (const oo of closed) {
  if (oo.id === c.id || oo.id === o.id) {
    console.log("closedOrder:", oo.id, "avg=", oo.average, "filled=", oo.filled, "realizedPnl=", oo.realizedPnl, "info.pnl=", oo.info?.pnl, "info.avgPx=", oo.info?.avgPx);
  }
}

// fetchMyTrades
let ts = await client.fetchMyTrades(swap, undefined, 20);
for (const t of ts) {
  if (t.order === c.id) {
    console.log("fill: price=", t.price, "qty=", t.amount, "fee=", t.fee?.cost, "realizedPnl=", t.info?.realizedPnl, "pnl=", t.info?.pnl);
  }
}

console.log("\ndone");
