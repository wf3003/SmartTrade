/**
 * SmartTrade - 共享 AI 客户端
 * 所有需要调用 DeepSeek 的模块共用这一个实例
 */
import OpenAI from "openai";
import { CONFIG } from "./config";

// 避免 HTTP 代理干扰直连 DeepSeek API
const _savedHttpsProxy = process.env.HTTPS_PROXY;
const _savedHttpProxy = process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;

export const openai = new OpenAI({
  apiKey: CONFIG.ai.apiKey,
  baseURL: CONFIG.ai.baseURL,
});

// 恢复代理，不影响交易所模块
process.env.HTTPS_PROXY = _savedHttpsProxy;
process.env.HTTP_PROXY = _savedHttpProxy;
