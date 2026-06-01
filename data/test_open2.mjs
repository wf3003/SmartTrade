import ccxt from "ccxt";

const client = new ccxt.okx({
  apiKey: "b1e457eb-08b1-452f-909b-b82971b748dc",
  secret: "7947DF4FF718B2D8E28053B33A8BF59D",
  password: "Aa1357913579~",
  enableRateLimit: true,
  options: { defaultType: "swap" },
});
client.httpsProxy = "http://127.0.0.1:7890";

await client.loadMarkets();
console.log("connected");

try {
  const cfg = await client.privateGetAccountConfig();
  console.log("Config:", JSON.stringify(cfg?.data?.[0]));
} catch(e) { console.log("Config err:", e.message?.slice(0,100)); }

try {
  const o = await client.createOrder("BTC/USDT:USDT", "market", "buy", 1, undefined, { tdMode: "isolated" });
  console.log("OK:", o.id, "avg:", o.average, "status:", o.status);
} catch(e) { console.log("No posSide:", e.message?.slice(0,200)); }

try {
  const o = await client.createOrder("BTC/USDT:USDT", "market", "buy", 1, undefined, { tdMode: "isolated", posSide: "long" });
  console.log("With posSide:", o.id, "avg:", o.average, "status:", o.status);
  try { await client.createOrder("BTC/USDT:USDT", "market", "sell", 1, undefined, { tdMode: "isolated", posSide: "long", reduceOnly: true }); } catch {}
} catch(e) { console.log("With posSide:", e.message?.slice(0,200)); }
