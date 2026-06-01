import ccxt from "ccxt";
import "dotenv/config";

async function main() {
  const client = new ccxt.okx({
    apiKey: process.env.OKX_API_KEY,
    secret: process.env.OKX_API_SECRET,
    password: process.env.OKX_API_PASSPHRASE,
    enableRateLimit: true,
    options: { defaultType: "swap", sandboxMode: true },
  });

  client.httpsProxy = process.env.HTTPS_PROXY || "";
  console.log("Proxy:", client.httpsProxy || "none");

  await client.loadMarkets();
  console.log("OKX sandbox connected");

  const swapSymbol = "BTC/USDT:USDT";
  const market = client.market(swapSymbol);
  const minQty = market.contractSize > 0 ? 0.001 / market.contractSize : 1;
  const qty = Math.max(minQty, 1);
  console.log("Test qty:", qty);

  // Test A: without posSide
  console.log("\nTest A: no posSide");
  try {
    const order = await client.createOrder(swapSymbol, "market", "buy", qty, undefined, { tdMode: "isolated" });
    console.log("OK:", order.id, "avg:", order.average, "status:", order.status);
    // Close
    await client.privatePostTradeCancelOrder({ instId: market.id, ordId: order.id }).catch(() => {});
    console.log("Closed");
  } catch(e) {
    const s = e.message?.slice(0, 300);
    console.log("FAIL:", s);
  }

  // Test B: with posSide
  console.log("\nTest B: posSide=long");
  try {
    const order = await client.createOrder(swapSymbol, "market", "buy", qty, undefined, { tdMode: "isolated", posSide: "long" });
    console.log("OK:", order.id, "avg:", order.average, "status:", order.status);
  } catch(e) {
    const s = e.message?.slice(0, 300);
    console.log("FAIL:", s);
  }

  // Test C: check mode
  try {
    console.log("\nTest C: fetch account config");
    const cfg = await client.privateGetAccountConfig();
    console.log(JSON.stringify(cfg?.data?.[0]));
  } catch(e) { console.log("FAIL:", e.message?.slice(0,100)); }

  console.log("\nDone");
}

main().catch(e => { console.error(e.message?.slice(0,400)); process.exit(1); });
