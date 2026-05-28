/**
 * SmartTrade - 多交易所统一接口 (ccxt)
 * 支持 OKX / Gate.io / Binance 合约交易
 * 
 * 符号格式:
 *   - 用户配置: BTC/USDT（只写基础币种）
 *   - 内部使用: BTC/USDT:USDT（OKX/Gate 合约符号）
 */
import ccxt, { type Exchange as CCXTExchange } from "ccxt";
import { CONFIG } from "./config";
import { logger } from "./logger";

export interface MarketData {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  change24h: number;
  fundingRate?: number;
  openInterest?: number;
}

export interface Position {
  symbol: string;
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  leverage: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  margin: number;
  liquidationPrice?: number;
}

export interface AccountInfo {
  totalEquity: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginUsed: number;
  marginRatio: number;
}

class ExchangeManager {
  private clients: Map<string, CCXTExchange> = new Map();
  private initialized = false;

  async init() {
    if (this.initialized) return;
    for (const name of CONFIG.exchanges) {
      try {
        const client = this.createClient(name);
        if (client) {
          // 加载所有市场（不限制类型，后续自行筛选）
          await client.loadMarkets();
          this.clients.set(name, client);
          const swapCount = Object.values(client.markets).filter((m: any) => m.swap).length;
          logger.info(`✅ ${name.toUpperCase()} 已连接 (${swapCount} 个合约)`);
        }
      } catch (e: any) {
        logger.warn(`⚠️ ${name.toUpperCase()} 连接失败: ${e.message}`);
      }
    }
    if (this.clients.size === 0) throw new Error("无可用交易所");
    this.initialized = true;
  }

  private createClient(name: string): CCXTExchange | null {
    const exClass = (ccxt as any)[name];
    if (!exClass) { logger.warn(`不支持的交易所: ${name}`); return null; }

    let apiKey = "", secret = "", password = "";
    let sandbox = false;
    if (name === "okx") {
      apiKey = CONFIG.okx.apiKey; secret = CONFIG.okx.secret;
      password = CONFIG.okx.passphrase; sandbox = CONFIG.okx.sandbox;
    } else if (name === "gate" || name === "gateio") {
      apiKey = CONFIG.gate.apiKey; secret = CONFIG.gate.secret;
      sandbox = CONFIG.gate.sandbox;
    } else if (name === "binance") {
      apiKey = CONFIG.binance.apiKey; secret = CONFIG.binance.secret;
      sandbox = CONFIG.binance.sandbox;
    }

    const client = new exClass({
      apiKey, secret, password,
      enableRateLimit: true,
      timeout: 30000,
      options: {
        defaultType: CONFIG.tradeMode,
        // OKX 特有的交换市场设置
        ...(name === "okx" ? {
          sandboxMode: sandbox,
          createMarketBuyOrderRequiresPrice: false,
        } : {}),
      },
    });

    // 代理
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
    if (proxyUrl) {
      client.httpsProxy = proxyUrl;
    }

    // 模拟盘
    if (sandbox) {
      if (typeof client.setSandboxMode === "function") {
        client.setSandboxMode(true);
        logger.info(`🔧 ${name.toUpperCase()} 模拟盘`);
      }
    }

    // 密钥空检查
    if (!client.apiKey) {
      logger.warn(`⚠️ ${name.toUpperCase()} 无 API 密钥`);
    }

    return client;
  }

  /**
   * 将用户简写符号转换为合约交易符号
   * BTC/USDT → BTC/USDT:USDT (OKX/Gate 永续合约)
   */
  private toSwapSymbol(raw: string): string {
    // 如果已经是完整格式就原样返回
    if (raw.includes(":")) return raw;
    // ccxt 对 OKX 合约统一使用 base/quote:quote 格式
    const [base, quote] = raw.split("/");
    return `${base}/${quote}:${quote}`;
  }

  /**
   * 查找哪个交易所支持该合约
   */
  private findSwapClient(symbol: string): { client: CCXTExchange; swapSymbol: string } | null {
    const swapSym = this.toSwapSymbol(symbol);
    for (const [name, client] of this.clients) {
      if (client.markets[swapSym]) {
        return { client, swapSymbol: swapSym };
      }
      // 也尝试原始符号
      if (client.markets[symbol]) {
        const m = client.markets[symbol] as any;
        if (m.swap) {
          return { client, swapSymbol: symbol };
        }
      }
    }
    return null;
  }

  /**
   * 获取合约乘数（每张合约对应多少基础币）
   * ETH/USDT → 0.1（每张=0.1ETH）
   * XRP/USDT → 10（每张=10XRP）
   */
  getContractSize(symbol: string): number {
    const swapSym = this.toSwapSymbol(symbol);
    for (const [, client] of this.clients) {
      const m = client.markets[swapSym];
      if (m && (m as any).swap) return (m as any).contractSize || 1;
    }
    return 1;
  }

  async getTicker(symbol: string): Promise<MarketData | null> {
    const found = this.findSwapClient(symbol);
    if (!found) return null;
    try {
      const t = await found.client.fetchTicker(found.swapSymbol);
      if (!t) return null;
      let fr: number | undefined;
      try { fr = (await found.client.fetchFundingRate(found.swapSymbol))?.fundingRate; } catch {}
      return {
        symbol,
        price: t.last || 0,
        bid: t.bid || 0,
        ask: t.ask || 0,
        high24h: t.high || 0,
        low24h: t.low || 0,
        volume24h: t.baseVolume || 0,
        change24h: t.percentage || 0,
        fundingRate: fr,
      };
    } catch (e: any) {
      logger.warn(`行情获取失败 ${symbol}: ${e.message}`);
      return null;
    }
  }

  async getTickers(symbols: string[]): Promise<Map<string, MarketData>> {
    const results = new Map<string, MarketData>();
    await Promise.all(symbols.map(async (sym) => {
      const data = await this.getTicker(sym);
      if (data) results.set(sym, data);
    }));
    return results;
  }


  /**
   * 获取多时间框架 OHLCV 数据（用于 AI 分析）
   */
  async getOHLCV(symbol: string, timeframe: string, limit: number = 15): Promise<{
    timeframe: string; candles: { open: number; high: number; low: number; close: number; }[]
  } | null> {
    const found = this.findSwapClient(symbol);
    if (!found) return null;
    try {
      const raw = await found.client.fetchOHLCV(found.swapSymbol, timeframe, undefined, limit);
      const candles = raw.map((c: any) => ({
        open: c[1], high: c[2], low: c[3], close: c[4],
      }));
      return { timeframe, candles };
    } catch {
      return null;
    }
  }

  /**
   * 批量获取多时间框架数据
   */
  async getMultiTimeframeData(symbol: string): Promise<Record<string, { open: number; high: number; low: number; close: number; }[]>> {
    const frames = ["1m", "5m", "15m", "1h", "1d"];
    const results: Record<string, any> = {};
    for (const tf of frames) {
      const limit = tf === "1h" || tf === "1d" ? 60 : 12;
      const data = await this.getOHLCV(symbol, tf, limit);
      if (data) results[tf] = data.candles;
    }
    return results;
  }

  async getPositions(): Promise<Position[]> {
    const positions: Position[] = [];
    for (const [name, client] of this.clients) {
      try {
        const pos = await client.fetchPositions();
        for (const p of pos) {
          if (!p || (p.contracts === 0 && p.notional === 0)) continue;
          positions.push({
            symbol: (p.symbol || "").replace(/:USDT/g, "").replace(/:.*/, ""),
            side: p.side === "short" ? "short" : "long",
            qty: p.contracts || 0,
            entryPrice: p.entryPrice || 0,
            leverage: p.leverage || CONFIG.defaultLeverage,
            unrealizedPnl: p.unrealizedPnl || 0,
            unrealizedPnlPct: p.percentage || 0,
            margin: p.initialMargin || 0,
            liquidationPrice: p.liquidationPrice,
          });
        }
      } catch {}
    }
    return positions;
  }

  async getAccount(): Promise<AccountInfo> {
    for (const [name, client] of this.clients) {
      try {
        const bal = await client.fetchBalance();
        const b = bal as any;
        const info = b?.info;

        // OKX: 从原始响应提取 unrealized PnL（ccxt 不暴露此值）
        let unrealized = 0;
        let totalEquity = 0;
        let available = 0;
        let marginUsed = 0;

        if (info?.data && Array.isArray(info.data)) {
          for (const account of info.data) {
            for (const detail of (account.details || [])) {
              if (detail.ccy === "USDT") {
                // 只用 USDT 币种计算（交易保证金币种）
                totalEquity = parseFloat(detail.eq || detail.eqUsd || "0");
                available = parseFloat(detail.availBal || "0");
                marginUsed = parseFloat(detail.frozenBal || "0");
                // isoUpl = 逐仓未实现盈亏, upl = 总未实现盈亏
                unrealized = parseFloat(detail.isoUpl || detail.upl || "0");
              }
            }
          }
        }

        // fallback: ccxt 格式
        if (totalEquity === 0) {
          totalEquity = Number(b?.total?.USDT || b?.USDT?.total || 0);
          available = Number(b?.free?.USDT || b?.USDT?.free || 0);
          marginUsed = Number(b?.used?.USDT || b?.USDT?.used || 0);
        }

        return {
          totalEquity,
          availableBalance: available,
          unrealizedPnl: unrealized,
          marginUsed,
          marginRatio: totalEquity > 0 ? (marginUsed / totalEquity) * 100 : 0,
        };
      } catch {}
    }
    return { totalEquity: 0, availableBalance: 0, unrealizedPnl: 0, marginUsed: 0, marginRatio: 0 };
  }

  async openPosition(symbol: string, side: "long" | "short", qty: number, leverage: number): Promise<{ order: any; avgPrice: number; fee: number }> {
    const found = this.findSwapClient(symbol);
    if (!found) throw new Error(`无可用的合约交易所: ${symbol}`);
    const { client, swapSymbol } = found;

    // 设置杠杆 — OKX 需要 mgnMode + posSide 才生效
    if (typeof client.setLeverage === "function") {
      let setOK = false;
      // 方式一：完整参数
      try {
        await client.setLeverage(leverage, swapSymbol, {
          mgnMode: "isolated",
          posSide: side === "long" ? "long" : "short",
        });
        setOK = true;
      } catch {}
      // 方式二：不带 posSide
      if (!setOK) {
        try { await client.setLeverage(leverage, swapSymbol, { mgnMode: "isolated" }); setOK = true; } catch {}
      }
      // 方式三：纯默认
      if (!setOK) {
        try { await client.setLeverage(leverage, swapSymbol); setOK = true; } catch {}
      }
      if (!setOK) {
        logger.warn(`⚠️ setLeverage 全失败: ${symbol} → ${leverage}x 未生效，使用交易所当前杠杆`);
      }
    }
    // 设置持仓模式（OKX 逐仓 isolated）
    if (typeof client.setPositionMode === "function") {
      try { await client.setPositionMode(true, swapSymbol); } catch {}
      if (typeof (client as any).setMarginMode === "function") {
        try { await (client as any).setMarginMode("isolated", swapSymbol); } catch {}
      }
    }

    const orderSide = side === "long" ? "buy" : "sell";
    const params: any = {
      reduceOnly: false,
      tdMode: "isolated",
      leverage,  // 兜底：部分 ccxt 版本支持直接传杠杆
    };
    if (client.id === "okx" || client.id === "gate") {
      params.posSide = side;
    }

    // 最多重试 3 次，处理 demo 环境偶发 50001
    let lastError: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const order = await client.createOrder(swapSymbol, "market", orderSide, qty, undefined, params);
        logger.info(`开仓成功: ${swapSymbol} ${side} ${qty}张 @${leverage}x`);
        const avgPrice = order?.price || order?.average || 0;
        const fee = order?.fee?.cost || 0;
        return { order, avgPrice, fee };
      } catch (e: any) {
        lastError = e;
        let msg = e.message || String(e);
        let code = "";
        try {
          const body = JSON.parse(e.message);
          if (body.msg) msg = body.msg;
          if (body.code) code = String(body.code);
          if (body.data?.[0]?.sMsg) msg = body.data[0].sMsg;
        } catch {}
        // 只有 50001（服务暂不可用）才重试，其他错误直接抛
        if (code === "50001" && attempt < 3) {
          logger.warn(`⏳ 开仓重试 ${attempt}/3 ${symbol}: ${msg}`);
          await new Promise(r => setTimeout(r, 2000 * attempt));
        } else {
          throw new Error(`开仓失败 ${symbol}: ${msg}`);
        }
      }
    }
    throw new Error(`开仓失败 ${symbol} (重试3次无效): ${lastError?.message || lastError}`);
  }

  /**
   * 从交易所获取历史成交记录（含实际盈亏）
   */
  async getExchangeTrades(symbols: string[], hours: number = 24): Promise<any[]> {
    const results: any[] = [];
    const since = Date.now() - hours * 3600000;
    const seen = new Set<string>();
    for (const sym of symbols) {
      const found = this.findSwapClient(sym);
      if (!found) continue;
      try {
        const trades = await (found.client as any).fetchMyTrades(found.swapSymbol, since, 20);
        for (const t of trades) {
          const id = t?.id || t?.info?.tradeId || "";
          const price = t?.price || 0;
          const qty = t?.amount || 0;
          if (!id || seen.has(id) || price <= 0) continue;
          seen.add(id);
          results.push({
            id, symbol: sym, time: t.datetime || t.timestamp,
            side: t.side, qty, price,
            fee: t.fee?.cost || 0, realizedPnl: 0,
            exchange: found.client.id, posSide: t?.info?.posSide || "",
          });
        }
      } catch {}
      try {
        const closed = await (found.client as any).fetchClosedOrders(found.swapSymbol, since, 20);
        for (const o of closed) {
          const rPnl = Number(o?.info?.pnl || o?.info?.realizedPnl || o?.realizedPnl || 0);
          const oid = o?.id || "";
          if (!oid || seen.has(oid) || rPnl === 0) continue;
          seen.add(oid);
          results.push({
            id: oid, symbol: sym, time: o.datetime || o.timestamp,
            side: o.side, qty: o.filled || o.amount || 0,
            price: o.price || o.average || 0, fee: o.fee?.cost || 0,
            realizedPnl: rPnl, exchange: found.client.id,
            posSide: o?.info?.posSide || "",
          });
        }
      } catch {}
    }
    return results.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  }

  async closePosition(symbol: string, side: "long" | "short", qty: number): Promise<{ order: any; avgPrice: number; fee: number }> {
    const found = this.findSwapClient(symbol);
    if (!found) throw new Error(`无可用的合约交易所: ${symbol}`);
    const { client, swapSymbol } = found;
    const orderSide = side === "long" ? "sell" : "buy";
    const params: any = { reduceOnly: true, tdMode: "isolated" };
    if (client.id === "okx" || client.id === "gate") {
      params.posSide = side;
    }
    try {
      const order = await client.createOrder(swapSymbol, "market", orderSide, qty, undefined, params);
      const avgPrice = order?.price || order?.average || 0;
      const fee = order?.fee?.cost || 0;
      return { order, avgPrice, fee };
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("51169") || msg.includes("no position") || msg.includes("don't have any positions")) {
        logger.warn(`closePosition: ${symbol} 仓位已不存在（可能已被其他方式平仓）`);
        return { order: null, avgPrice: 0, fee: 0 };
      }
      throw e;
    }
  }
}

export const exchangeManager = new ExchangeManager();
