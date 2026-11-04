/**
 * Vercel Edge Function: /api/llm?target=<绝对地址>
 *
 * 海外 LLM 白名单透传（绕浏览器 CORS）。核心逻辑在 ./llm-shared.ts，
 * 与 Netlify 版、vite dev 版、Cloudflare Worker 版（worker/index.js /llm）行为一致。
 * 部署到 Vercel 时随站点自动生效，无需任何配置。
 */
import { handleLlmRelayRequest } from './llm-shared';

export const config = { runtime: 'edge' };

export default async function handler(request: Request): Promise<Response> {
  return handleLlmRelayRequest(request);
}
