/**
 * SmartTrade - 多交易所统一接口 (ccxt)
 * 支持 OKX / Gate.io / Binance 合约交易
 * 
 * 符号格式:
 *   - 用户配置: BTC/USDT（只写基础币种）
 *   - 内部使用: BTC/USDT:USDT（OKX/Gate 合约符号）
 */
import ccxt, { type Exchange as CCXTExchange } from "ccxt";
import { HttpsProxyAgent } from "https-proxy-agent";
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

  private initFailed = false;
  private _binanceClient: any = null;
  private getBinanceClient(): any {
    if (!this._binanceClient) {
      const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "http://127.0.0.1:7890";
      const agent = new (HttpsProxyAgent as any)(proxyUrl);
      this._binanceClient = new (ccxt as any).binance({ timeout: 15000, agent });
    }
    return this._binanceClient;
  } // #3 防无限循环
  get isDegraded(): boolean { return this.clients.size < CONFIG.exchanges.length; }
  async init() {
    if (this.initialized) return;
    if (this.initFailed) return; // #3 不再重试
    for (const name of CONFIG.exchanges) {
      let connected = false;
      // #3 OKX容错: 指数退避重试 (2s→5s→15s→30s)
      const backoff = [2000, 5000, 15000, 30000];
      for (let attempt = 0; attempt < backoff.length; attempt++) {
      try {
        const client = this.createClient(name);
        if (client) {
          await client.loadMarkets();
          this.clients.set(name, client);
          const swapCount = Object.values(client.markets).filter((m: any) => m.swap).length;
          logger.info(`✅ ${name.toUpperCase()} 已连接 (${swapCount} 个合约)`);
              connected = true;
              // #8 多交易所冗余: 连接成功后尝试启用备用交易所
              if (name === "okx" && CONFIG.exchanges.includes("gate")) {
                try { await this.connectOne("gate"); } catch {}
              }
              break;
        }
      } catch (e: any) {
            if (attempt < backoff.length - 1) {
              logger.warn(`⚠️ ${name.toUpperCase()} 连接失败(${attempt+1}/${backoff.length}), ${backoff[attempt]}ms后重试...`);
              await new Promise(r => setTimeout(r, backoff[attempt]));
            } else {
              logger.warn(`⚠️ ${name.toUpperCase()} 连接失败: ${e.message}`);
            }
      }
    }
        if (!connected) logger.warn(`⚠️ ${name.toUpperCase()} ${backoff.length}次重试均失败`);
      }
    if (this.clients.size === 0) {
      this.initFailed = true;
      throw new Error("无可用交易所");
    }
    if (this.isDegraded) {
      logger.warn(`⚡ 降级模式: ${this.clients.size}/${CONFIG.exchanges.length}个交易所可用`);
    }
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

  /** #8 单独连接指定交易所（降级恢复用） */
  private async connectOne(name: string) {
    if (this.clients.has(name)) return;
    const client = this.createClient(name);
    if (client) {
      await client.loadMarkets();
      this.clients.set(name, client);
      const swapCount = Object.values(client.markets).filter((m: any) => m.swap).length;
      logger.info(`✅ ${name.toUpperCase()} (备用)已连接 (${swapCount}个合约)`);
    }
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
  /** 返回指定币种 OHLCV 数组（供 SuperFilter 使用） */
  async getSuperFilterData(symbol: string, limit = 200, tf = "3m"): Promise<{ opens: number[]; highs: number[]; lows: number[]; closes: number[] } | null> {
    const data = await this.getOHLCV(symbol, tf, limit);
    if (!data || !data.candles) return null;
    const c = data.candles;
    return { opens: c.map((x: any) => x.open), highs: c.map((x: any) => x.high), lows: c.map((x: any) => x.low), closes: c.map((x: any) => x.close) };
  }

  /** 返回 4h OHLCV 用于长周期信号确认 */
  async getSuperFilterData4h(symbol: string): Promise<{ opens: number[]; highs: number[]; lows: number[]; closes: number[] } | null> {
    return this.getSuperFilterData(symbol, 50, "4h");
  }


  /**
   * 从币安公开API获取K线数据（无需API Key, 数据质量远优于模拟盘）
   */
  async getBinanceOHLCV(symbol: string, timeframe: string, limit: number): Promise<{ opens: number[]; highs: number[]; lows: number[]; closes: number[]; volumes: number[] } | null> {
    try {
      // 延迟导入避免顶层依赖
      const binance = this.getBinanceClient();
      // 币安符号格式: BTC/USDT → BTCUSDT, ETH/USDT → ETHUSDT
      const base = symbol.replace("/USDT:USDT","").replace("/USDT","").replace(":USDT","");
      const binanceSymbol = base + "/USDT";
      const raw = await (binance as any).fetchOHLCV(binanceSymbol, timeframe, undefined, limit);
      if (!raw || !raw.length) return null;
      return {
        opens: raw.map((c: any) => c[1]),
        highs: raw.map((c: any) => c[2]),
        lows: raw.map((c: any) => c[3]),
        closes: raw.map((c: any) => c[4]),
        volumes: raw.map((c: any) => c[5]),
      };
    } catch (e: any) { console.error(`[binance] OHLCV fetch error: ${e?.message}`); return null; }
  }

  /**
   * 从币安获取成交量前N的USDT币种（无API限制,走代理）
   */
  async getBinanceTopSymbols(count: number, exclude?: Set<string>): Promise<string[]> {
    try {
      const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "http://127.0.0.1:7890";
      const binance = new ccxt.binance({ timeout: 15000, proxies: { https: proxy, http: proxy } });
      const tickers = await binance.fetchTickers();
      return Object.entries(tickers as Record<string, any>)
        .filter(([sym, t]) => sym.endsWith("/USDT") && !exclude?.has(sym) && (t.quoteVolume || 0) > 1e6 && !["USDC","USD1","USDT","BUSD","TUSD","USDP","USDD"].includes(sym.split("/")[0]))
        .sort((a, b) => (b[1]?.quoteVolume || 0) - (a[1]?.quoteVolume || 0))
        .slice(0, count)
        .map(([sym]) => sym);
    } catch { return []; }
  }

  /**
   * 获取按24h成交量排序的USDT合约符号（动态选币）
   */
  async getTopVolumeSymbols(count: number, exclude?: Set<string>): Promise<string[]> {
    try {
      const all = await this.clients.values().next().value?.fetchTickers();
      if (!all) return [];
      return Object.entries(all as Record<string, any>)
        .filter(([sym, t]) => sym.endsWith("/USDT:USDT") && !exclude?.has(sym.replace(/:USDT/g, "")) && (t?.baseVolume || t?.quoteVolume || 0) > 0)
        .sort((a, b) => (b[1]?.quoteVolume || 0) - (a[1]?.quoteVolume || 0))
        .slice(0, count)
        .map(([sym]) => sym.replace(/:USDT/g, ""));
    } catch { return []; }
  }

  /**
   * 获取多时间框架 OHLCV 数据（用于 AI 分析）
   */
  async getOHLCV(symbol: string, timeframe: string, limit: number = 15): Promise<{
    timeframe: string; candles: { open: number; high: number; low: number; close: number; volume: number; }[]
  } | null> {
    const found = this.findSwapClient(symbol);
    if (!found) return null;
    try {
      const raw = await found.client.fetchOHLCV(found.swapSymbol, timeframe, undefined, limit);
      const candles = raw.map((c: any) => ({
        open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] ?? 0,
      }));
      return { timeframe, candles };
    } catch {
      return null;
    }
  }

  /**
   * 批量获取多时间框架数据
   */
  async getMultiTimeframeData(symbol: string): Promise<Record<string, { open: number; high: number; low: number; close: number; volume: number; }[]>> {
    const frames = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];
    const results: Record<string, any> = {};
    for (const tf of frames) {
      const limit = tf === "5m" ? 200 : tf === "15m" ? 100 : 60; // 5min 200根供SuperFilter
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
      } catch (e: any) {
        logger.warn(`⚠️ ${name} getPositions 异常: ${(e?.message || String(e) || '?').slice(0, 120)}`);
      }
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
                // upl = 总未实现盈亏（优先）, isoUpl = 逐仓未实现盈亏
                unrealized = parseFloat(detail.upl || detail.isoUpl || "0");
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
      let setMethod = "";
      // 方式一：完整参数
      try {
        await client.setLeverage(leverage, swapSymbol, {
          mgnMode: "isolated",
          posSide: side === "long" ? "long" : "short",
        });
        setOK = true;
        setMethod = "mgnMode+posSide";
      } catch {}
      // 方式二：不带 posSide
      if (!setOK) {
        try { await client.setLeverage(leverage, swapSymbol, { mgnMode: "isolated" }); setOK = true; setMethod = "mgnMode"; } catch {}
      }
      // 方式三：纯默认
      if (!setOK) {
        try { await client.setLeverage(leverage, swapSymbol); setOK = true; setMethod = "default"; } catch {}
      }
      if (!setOK) {
        throw new Error(`setLeverage 全失败: ${symbol} → ${leverage}x 无法设置，禁止以错误杠杆开仓`);
      }
      logger.info(`🔧 ${symbol} 杠杆已设置: ${leverage}x (${setMethod})`);
    }
    // 设置逐仓模式 — 依赖已有的持仓模式，不自作主张切换
    if (typeof (client as any).setMarginMode === "function") {
      try { await (client as any).setMarginMode("isolated", swapSymbol); } catch {}
    }

    const orderSide = side === "long" ? "buy" : "sell";
    const params: any = {
      reduceOnly: false,
      tdMode: "isolated",
      leverage,  // 兜底：部分 ccxt 版本支持直接传杠杆
    };
    // OKX 单向持仓不传 posSide（双向持仓时取消下面注释）
    // if (client.id === "okx" || client.id === "gate") {
    //   params.posSide = side;
    // }

    // 最多重试 3 次，处理 demo 环境偶发 50001
    let lastError: any, fallbackPosSide = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (fallbackPosSide && params.posSide) delete params.posSide;
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
          // ccxt error message 格式: "okx {"code":"1","data":[...]}"
          // 去掉前缀再解析，否则 JSON.parse 失败
          const raw = e.message?.includes(" ") ? e.message.substring(e.message.indexOf("{") || e.message.indexOf("[")) : e.message;
          const body = JSON.parse(raw);
          if (body.msg) msg = body.msg;
          if (body.code) code = String(body.code);
          if (body.data?.[0]?.sCode) code = String(body.data?.[0]?.sCode);
          if (body.data?.[0]?.sMsg) msg = body.data[0].sMsg;
        } catch {}
        // 50001服务暂不可用 → 重试; 51000 posSide 需要/不需要 → 双向自适应重试
        if (code === "51000" && attempt < 3) {
          if (params.posSide) {
            // posSide 已传但不被接受（单向持仓模式不需要）→ 移除重试
            delete params.posSide;
            logger.warn(`🔧 ${symbol} posSide不支持(单向持仓), 降级重试`);
          } else {
            // posSide 未传但被要求（双向持仓模式需要）→ 补上重试
            params.posSide = side;
            logger.warn(`🔧 ${symbol} 需要posSide(双向持仓), 补上重试`);
          }
          lastError = { message: msg };
          continue;
        }
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
    // OKX 必须匹配持仓的 tdMode，否则会报 51169（仓位不存在）
    try {
      const order = await client.createOrder(swapSymbol, "market", orderSide, qty, undefined, params);
      let avgPrice = order?.price || order?.average || 0;
      // OKX market order 返回可能不含 avgPx（订单刚创建），补 fetchOrder 拿实际成交价
      if (!avgPrice && order?.id) {
        try {
          const filled = await (client as any).fetchOrder(order.id, swapSymbol);
          avgPrice = filled?.average || filled?.price || avgPrice;
        } catch {}
      }
      const fee = order?.fee?.cost || 0;
      return { order, avgPrice, fee };
    } catch (e: any) {
      const msg = e.message || String(e);
      // 51000: 双向持仓需要 posSide → 补上重试
      if (msg.includes("51000") && !params.posSide) {
        params.posSide = side;
        try {
          const order = await client.createOrder(swapSymbol, "market", orderSide, qty, undefined, params);
          let avgPrice = order?.price || order?.average || 0;
          if (!avgPrice && order?.id) { try { const f = await (client as any).fetchOrder(order.id, swapSymbol); avgPrice = f?.average || f?.price || avgPrice; } catch {} }
          return { order, avgPrice, fee: order?.fee?.cost || 0 };
        } catch (e2: any) {
          const msg2 = e2.message || String(e2);
          // 加上 posSide 还是 51000 → 摘掉再试
          if (msg2.includes("51000") && params.posSide) {
            delete params.posSide;
            const order = await client.createOrder(swapSymbol, "market", orderSide, qty, undefined, params);
            let avgPrice = order?.price || order?.average || 0;
            if (!avgPrice && order?.id) { try { const f = await (client as any).fetchOrder(order.id, swapSymbol); avgPrice = f?.average || f?.price || avgPrice; } catch {} }
            return { order, avgPrice, fee: order?.fee?.cost || 0 };
          }
          throw e2;
        }
      }
      // 51000 且已带 posSide → 摘掉重试
      if (msg.includes("51000") && params.posSide) {
        delete params.posSide;
        const order = await client.createOrder(swapSymbol, "market", orderSide, qty, undefined, params);
        let avgPrice = order?.price || order?.average || 0;
        if (!avgPrice && order?.id) { try { const f = await (client as any).fetchOrder(order.id, swapSymbol); avgPrice = f?.average || f?.price || avgPrice; } catch {} }
        return { order, avgPrice, fee: order?.fee?.cost || 0 };
      }
      // 51169: 仓位不存在 — 可能是 hedge mode 需要 posSide，不要直接放弃
      if (msg.includes("51169") || msg.includes("no position") || msg.includes("don't have any positions")) {
        if (!params.posSide) {
          // 尝试一：补上 posSide 重试（hedge mode 必须指定方向）
          params.posSide = side;
          logger.warn(`🔧 ${symbol} 51169 尝试补posSide:${side} 重试`);
          try {
            const order = await client.createOrder(swapSymbol, "market", orderSide, qty, undefined, params);
            let avgPrice = order?.price || order?.average || 0;
            if (!avgPrice && order?.id) { try { const f = await (client as any).fetchOrder(order.id, swapSymbol); avgPrice = f?.average || f?.price || avgPrice; } catch {} }
            return { order, avgPrice, fee: order?.fee?.cost || 0 };
          } catch (e2: any) {
            const msg2 = e2.message || String(e2);
            logger.warn(`🔧 ${symbol} 补posSide仍失败: ${msg2.slice(0,100)}`);
          }
          // 加上 posSide 仍失败 → 摘掉 posSide 再试一次
          delete params.posSide;
          logger.warn(`🔧 ${symbol} 摘掉posSide 最后一次重试`);
          try {
            const order = await client.createOrder(swapSymbol, "market", orderSide, qty, undefined, params);
            let avgPrice = order?.price || order?.average || 0;
            if (!avgPrice && order?.id) { try { const f = await (client as any).fetchOrder(order.id, swapSymbol); avgPrice = f?.average || f?.price || avgPrice; } catch {} }
            return { order, avgPrice, fee: order?.fee?.cost || 0 };
          } catch (e3: any) {
            const msg3 = e3.message || String(e3);
            logger.warn(`🔧 ${symbol} 摘掉posSide仍失败: ${msg3.slice(0,100)}`);
          }
        } else {
          // 已有 posSide 还 51169 → 摘掉重试
          delete params.posSide;
          logger.warn(`🔧 ${symbol} 51169 摘掉posSide 重试`);
          try {
            const order = await client.createOrder(swapSymbol, "market", orderSide, qty, undefined, params);
            let avgPrice = order?.price || order?.average || 0;
            if (!avgPrice && order?.id) { try { const f = await (client as any).fetchOrder(order.id, swapSymbol); avgPrice = f?.average || f?.price || avgPrice; } catch {} }
            return { order, avgPrice, fee: order?.fee?.cost || 0 };
          } catch (e2: any) {
            const msg2 = e2.message || String(e2);
            logger.warn(`🔧 ${symbol} 摘掉posSide仍失败: ${msg2.slice(0,100)}`);
          }
          // 再补上 posSide 最后一次尝试
          params.posSide = side;
          logger.warn(`🔧 ${symbol} 补回posSide:${side} 最后一次重试`);
          try {
            const order = await client.createOrder(swapSymbol, "market", orderSide, qty, undefined, params);
            let avgPrice = order?.price || order?.average || 0;
            if (!avgPrice && order?.id) { try { const f = await (client as any).fetchOrder(order.id, swapSymbol); avgPrice = f?.average || f?.price || avgPrice; } catch {} }
            return { order, avgPrice, fee: order?.fee?.cost || 0 };
          } catch (e3: any) {
            const msg3 = e3.message || String(e3);
            logger.warn(`🔧 ${symbol} 补回posSide仍失败: ${msg3.slice(0,100)}`);
          }
        }
        // 所有重试均失败，此时才确认仓位真的不存在
        logger.warn(`closePosition: ${symbol} 仓位已不存在（所有重试均失败）`);
        return { order: null, avgPrice: 0, fee: 0 };
      }
      throw e;
    }
  }
}

export const exchangeManager = new ExchangeManager();
