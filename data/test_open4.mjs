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
const qty = 1;

// 1. 开仓
console.log("\n--- 开仓 ---");
const openOrder = await client.createOrder(swap, "market", "buy", qty, undefined, { tdMode: "isolated", posSide: "long" });
console.log("open: id=", openOrder.id, "avg=", openOrder.average, "price=", openOrder.price);

// 2. fetchOrder
const f1 = await client.fetchOrder(openOrder.id, swap);
console.log("fetchOrder avg=", f1.average, "filled=", f1.filled);

// 3. fetchMyTrades
try {
  const ts = await client.fetchMyTrades(swap, undefined, 10);
  for (const t of ts) {
    if (t.order === openOrder.id) console.log("open trade: price=", t.price, "cost=", t.cost, "pnl=", t.info?.pnl);
  }
} catch(e) { console.log("trades err:", e.message?.slice(0,80)); }

// 4. 平仓
console.log("\n--- 平仓 ---");
const closeOrder = await client.createOrder(swap, "market", "sell", qty, undefined, { tdMode: "isolated", posSide: "long", reduceOnly: true });
console.log("close: id=", closeOrder.id, "avg=", closeOrder.average);

// 5. fetchOrder
const f2 = await client.fetchOrder(closeOrder.id, swap);
console.log("fetchOrder avg=", f2.average, "filled=", f2.filled);

// 6. fetchMyTrades for close
await new Promise(r => setTimeout(r, 1500));
try {
  const ts2 = await client.fetchMyTrades(swap, undefined, 20);
  let found = false;
  for (const t of ts2) {
    if (t.order === closeOrder.id) {
      console.log("close trade: price=", t.price, "cost=", t.cost, "fee=", t.fee?.cost, "pnl=", t.info?.pnl);
      found = true;
    }
  }
  if (!found) console.log("close trade not in fetchMyTrades (maybe need more delay)");
} catch(e) { console.log("err:", e.message?.slice(0,80)); }

console.log("\ndone");
