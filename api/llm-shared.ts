/**
 * 海外 LLM 白名单透传代理 —— 平台无关核心（Web 标准 Request/Response）。
 *
 * 背景同 worker/index.js 的 /llm 路由：英伟达 NIM、OpenAI 等海外官方接口不返回
 * CORS 头，浏览器直连必挂。这份核心被三处复用，让「代理跟着网站一起部署」，
 * 用户无需任何额外账号或配置：
 *   - api/llm.ts                → Vercel Edge Function（/api/llm）
 *   - netlify/functions/llm-proxy.ts → Netlify Function（经 netlify.toml 重写到 /api/llm）
 *   - server/llm-relay-middleware.ts → vite dev 本地开发
 * Cloudflare Worker 版（/llm）逻辑相同但独立实现（worker/index.js 要求单文件）。
 *
 * 安全约束与 Worker 版一致：只放行白名单内的海外 LLM 域名、只允许 https、
 * 只透传鉴权/内容头、不读不存 key、SSE 流式原样回传。
 */

/** 响应带这个头说明请求确实经过了转发层；缺失 = 静态托管 404 页，客户端据此换路由。 */
export const LLM_RELAY_HEADER = 'x-sully-llm-relay';

const LLM_HOSTS: ReadonlySet<string> = new Set([
  'integrate.api.nvidia.com', // 英伟达 NIM
  'api.openai.com',
  'api.anthropic.com',
  'api.x.ai',
  'api.mistral.ai',
  'api.groq.com',
  'api.together.xyz',
  'api.perplexity.ai',
  'api.cohere.com',
  'api.fireworks.ai',
  'api.cerebras.ai',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
  'api.deepseek.com',
  'api.moonshot.ai',
]);

const hostAllowed = (hostname: string): boolean => {
  const h = hostname.toLowerCase();
  if (LLM_HOSTS.has(h)) return true;
  for (const allowed of LLM_HOSTS) if (h.endsWith('.' + allowed)) return true;
  return false;
};

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, x-goog-api-key, Accept',
  'Access-Control-Max-Age': '86400',
};

const jsonError = (message: string, status: number): Response =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', [LLM_RELAY_HEADER]: 'api' },
  });

const FORWARD_HEADERS = [
  'authorization',
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
  'x-goog-api-key',
  'content-type',
  'accept',
] as const;

export async function handleLlmRelayRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonError('Method not allowed', 405);
  }
  const targetUrl = new URL(req.url).searchParams.get('target');
  if (!targetUrl) return jsonError('Missing target parameter', 400);

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return jsonError('Invalid target URL', 400);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !hostAllowed(parsed.hostname)) {
    return jsonError('Host not allowed', 400);
  }

  try {
    const forwardHeaders: Record<string, string> = {};
    for (const name of FORWARD_HEADERS) {
      const value = req.headers.get(name);
      if (value) forwardHeaders[name] = value;
    }
    if (!forwardHeaders['content-type'] && req.method === 'POST') forwardHeaders['content-type'] = 'application/json';
    const upstream = await fetch(parsed.href, {
      method: req.method,
      headers: forwardHeaders,
      body: req.method === 'POST' ? await req.text() : undefined,
      redirect: 'follow',
    });
    const headers = new Headers(CORS_HEADERS);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json; charset=utf-8');
    headers.set(LLM_RELAY_HEADER, 'api');
    const requestId = upstream.headers.get('request-id') || upstream.headers.get('x-request-id');
    if (requestId) headers.set('x-request-id', requestId);
    // upstream.body 直接回传：SSE 流式逐块到达，不在代理侧攒整包。
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return jsonError(`LLM upstream fetch failed: ${String((e as Error)?.message || e)}`, 502);
  }
}
