import ccxt from "ccxt";

async function test(sandbox) {
  const label = sandbox ? "SANDBOX" : "PRODUCTION";
  const client = new ccxt.okx({
    apiKey: "b1e457eb-08b1-452f-909b-b82971b748dc",
    secret: "7947DF4FF718B2D8E28053B33A8BF59D",
    password: "Aa1357913579~",
    enableRateLimit: true,
    options: { defaultType: "swap", sandboxMode: sandbox },
  });
  client.httpsProxy = "http://127.0.0.1:7890";
  try {
    if (sandbox && typeof client.setSandboxMode === "function") client.setSandboxMode(true);
    await client.loadMarkets();
    console.log(`${label}: connected`);
    const cfg = await client.privateGetAccountConfig();
    const acct = cfg?.data?.[0] || {};
    console.log(`${label}: posMode=${acct.posMode || "?"} acctLv=${acct.acctLv || "?"}`);
    
    const swap = "BTC/USDT:USDT";
    // Try without posSide
    try {
      const o = await client.createOrder(swap, "market", "buy", 1, undefined, { tdMode: "isolated" });
      console.log(`${label}: OK no posSide, avg=${o.average}`);
      try { await client.createOrder(swap, "market", "sell", 1, undefined, { tdMode:"isolated", reduceOnly:true, posSide:"long" }); } catch {}
    } catch(e) { console.log(`${label}: FAIL no posSide — ${e.message?.slice(0,120)}`); }
    
    // Try with posSide
    try {
      const o = await client.createOrder(swap, "market", "buy", 1, undefined, { tdMode: "isolated", posSide: "long" });
      console.log(`${label}: OK with posSide, avg=${o.average}`);
      try { await client.createOrder(swap, "market", "sell", 1, undefined, { tdMode:"isolated", reduceOnly:true, posSide:"long" }); } catch {}
    } catch(e) { console.log(`${label}: FAIL with posSide — ${e.message?.slice(0,120)}`); }
  } catch(e) {
    console.log(`${label}: ${e.message?.slice(0,150)}`);
  }
}

await test(true);
await test(false);
