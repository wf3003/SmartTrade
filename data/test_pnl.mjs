import ccxt from "ccxt";

const IS_SANDBOX = true;
const client = new ccxt.okx({
  apiKey: "b1e457eb-08b1-452f-909b-b82971b748dc",
  secret: "7947DF4FF718B2D8E28053B33A8BF59D",
  password: "Aa1357913579~",
  enableRateLimit: true,
  options: { defaultType: "swap", sandboxMode: IS_SANDBOX },
});
client.httpsProxy = "http://127.0.0.1:7890";
if (IS_SANDBOX && typeof client.setSandboxMode === "function") client.setSandboxMode(true);
await client.loadMarkets();
console.log("环境:", IS_SANDBOX ? "沙盒" : "正式");

const swap = "BTC/USDT:USDT";
const o = await client.createOrder(swap, "market", "buy", 1, undefined, { tdMode: "isolated", posSide: "long" });
console.log("开仓:", o.id);
await new Promise(r => setTimeout(r, 2000));
const c = await client.createOrder(swap, "market", "sell", 1, undefined, { tdMode: "isolated", posSide: "long", reduceOnly: true });
console.log("平仓:", c.id);
await new Promise(r => setTimeout(r, 3000));

const f = await client.fetchOrder(c.id, swap);
console.log("\nfetchOrder avg:", f.average, "filled:", f.filled);

const ords = await client.fetchClosedOrders(swap, undefined, 30);
for (const x of ords) {
  if (x.id === c.id) {
    console.log("\nfetchClosedOrders:");
    console.log("  avg:", x.average);
    console.log("  fee:", x.fee?.cost);
    console.log("  info.pnl:", x.info?.pnl);
    console.log("  info.avgPx:", x.info?.avgPx);
    console.log("  info.fee:", x.info?.fee);
  }
}
console.log("\n跑完");
