/**
 * SmartTrade - Web 仪表盘 (Express)
 */
import express from "express";
import path from "path";
import { CONFIG } from "./config";
import { logger } from "./logger";
import { db, getTradesToday, getDecisionsToday, getDecisionsHistory, getTradesHistory, getTradeStats, syncExchangeOrders, getExchangeOrders } from "./db";
import { exchangeManager } from "./exchanges";
import { latestReport, cachedPositions, cachedAccount } from "./state";

let _app: express.Express | null = null;
let cycleStartTime = new Date().toISOString();
// 行情缓存（5秒有效，减少 dashboard 重复请求）
let cachedTickers: Record<string, number> = {};
let cachedTickersAt = 0;
export let cycleNumber = 0;
export function newCycle() {
  cycleNumber++;
  cycleStartTime = new Date().toISOString();
}

export async function startServer(host?: string, port?: number) {
  const app = express();
  _app = app;
  const h = host || CONFIG.host;
  const p = port || CONFIG.port;

  app.use(express.static(path.join(process.cwd(), "public")));

  app.get("/api/status", async (req, res) => {
    try {
      // 使用缓存数据，不阻塞各交易所 API（策略周期已在拉 K 线）
      const fetchWithTimeout = <T>(p: Promise<T>, fallback: T, ms = 3000): Promise<T> =>
        Promise.race([p, new Promise<T>(r => setTimeout(() => r(fallback), ms))]);
      const account = cachedAccount.totalEquity ? cachedAccount : await fetchWithTimeout(exchangeManager.getAccount(), cachedAccount);
      const positions = cachedPositions.length ? cachedPositions : await fetchWithTimeout(exchangeManager.getPositions(), cachedPositions);

      // 并行获取全币种行情（5秒缓存防限频）
      const now = Date.now();
      let tickers: Record<string, number> = {};
      if (now - cachedTickersAt < 5000 && Object.keys(cachedTickers).length > 0) {
        tickers = cachedTickers;
      } else {
        const tResults = await Promise.allSettled(
          CONFIG.symbols.map(sym => exchangeManager.getTicker(sym).catch(() => null))
        );
        for (let i = 0; i < CONFIG.symbols.length; i++) {
          const t = (tResults[i] as any).value;
          if (t) tickers[CONFIG.symbols[i]] = t.price;
        }
        cachedTickers = tickers;
        cachedTickersAt = now;
      }

      const enrichedPositions = positions.map(p => ({
        ...p,
        markPrice: tickers[p.symbol] || 0,
      }));

      // 只返回当前周期的决策
      const decisions = getDecisionsToday().filter((d: any) => d.time >= cycleStartTime);
      // 交易记录：本地 trades 表（沙盒无历史API）
      const allTrades = getTradesHistory(7) as any[];
      const trades = allTrades.filter(t => t.status === 'open' || t.status === 'closed');

      const equityHistory = (db.prepare(
        `SELECT time, total_equity FROM account_snapshots ORDER BY id DESC LIMIT 200`
      ).all() as any[]).reverse().map((r: any) => ({ time: r.time, equity: r.total_equity }));

      res.json({
        ok: true,
        tickers,
        account,
        positions: enrichedPositions,
        recentTrades: trades,
        recentDecisions: decisions,
        fullReport: latestReport,
        cycle: { number: cycleNumber, time: cycleStartTime },
        equityHistory,
        config: {
          symbols: CONFIG.symbols,
          maxLeverage: CONFIG.maxLeverage,
          defaultLeverage: CONFIG.defaultLeverage,
          maxPositions: CONFIG.maxPositions,
          model: CONFIG.ai.model,
          trailStopRange: "1.5%/0.6%→3%/0.5%",
          stopLossUsdt: CONFIG.accountStopLossUsdt,
          takeProfitUsdt: CONFIG.accountTakeProfitUsdt,
          initialBalance: CONFIG.initialBalance,
        },
      });
    } catch (e: any) {
      res.json({ ok: false, error: e.message });
    }
  });

  app.get("/api/trades", (req, res) => {
    res.json(getTradesToday());
  });

  app.get("/api/decisions", (req, res) => {
    res.json(getDecisionsToday());
  });

  // 定时同步交易所订单（每 30 秒）
  (async function orderSyncLoop() {
    while (true) {
      try {
        const orders = await exchangeManager.getExchangeTrades(CONFIG.symbols, 72);
        const added = syncExchangeOrders(orders);
        if (added > 0) logger.info(`📝 同步交易所订单: +${added}条`);
      } catch {}
      await new Promise(r => setTimeout(r, 30000));
    }
  })();

  app.get("/api/exchange-orders", (req, res) => {
    res.json(getExchangeOrders(Number(req.query.limit) || 50));
  });

  app.get("/api/exchange-trades", async (req, res) => {
    try {
      const hours = Number(req.query.hours) || 24;
      const trades = await exchangeManager.getExchangeTrades(CONFIG.symbols, hours);
      res.json(trades);
    } catch (e: any) {
      res.json({ error: e.message });
    }
  });

  app.get("/api/history", (req, res) => {
    const days = Number(req.query.days) || 7;
    res.json({
      decisions: getDecisionsHistory(days),
      trades: getTradesHistory(days),
      stats: getTradeStats(days),
    });
  });

  app.get("/", (req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "index.html"));
  });

  return new Promise<void>((resolve) => {
    app.listen(p, h, () => {
      logger.info(`🌐 仪表盘 → http://localhost:${p}`);
      resolve();
    });
  });
}
