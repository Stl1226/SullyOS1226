import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleLlmRelayRequest, LLM_RELAY_HEADER } from './llm-shared';

afterEach(() => vi.unstubAllGlobals());

const req = (url: string, init?: RequestInit) =>
  new Request(`https://site.test/api/llm${url}`, init);

describe('llm-shared 海外 LLM 透传核心（Vercel/Netlify/vite dev 共用）', () => {
  it('缺 target / 白名单外域名 / 非 https → 400，不发起上游请求', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await handleLlmRelayRequest(req(''))).status).toBe(400);
    expect((await handleLlmRelayRequest(req('?target=https://evil.example.com/v1/models'))).status).toBe(400);
    expect((await handleLlmRelayRequest(req('?target=http://integrate.api.nvidia.com/v1/models'))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('错误响应也带转发标识头（客户端靠它区分路由不存在）', async () => {
    const r = await handleLlmRelayRequest(req(''));
    expect(r.headers.get(LLM_RELAY_HEADER)).toBe('api');
  });

  it('英伟达 POST 透传：鉴权头转发、杂头丢弃、标识头+SSE content-type 回传', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"好"}}\n\ndata: [DONE]\n\n';
    const fetcher = vi.fn(async (input: any, init: any) => {
      expect(String(input)).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
      expect(init.headers.authorization).toBe('Bearer nvapi-k');
      expect((init.headers as any).cookie).toBeUndefined();
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetcher);
    const r = await handleLlmRelayRequest(req(`?target=${encodeURIComponent('https://integrate.api.nvidia.com/v1/chat/completions')}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer nvapi-k', 'Content-Type': 'application/json', Cookie: 's=1' },
      body: JSON.stringify({ model: 'm', messages: [], stream: true }),
    }));
    expect(r.status).toBe(200);
    expect(r.headers.get(LLM_RELAY_HEADER)).toBe('api');
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(await r.text()).toBe(sse);
  });

  it('GET /models 透传上游状态码；OPTIONS 预检 204', async () => {
    const fetcher = vi.fn(async () => new Response('{"error":"no"}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const r = await handleLlmRelayRequest(req(`?target=${encodeURIComponent('https://api.openai.com/v1/models')}`, {
      headers: { Authorization: 'Bearer k' },
    }));
    expect(r.status).toBe(401);
    expect(r.headers.get(LLM_RELAY_HEADER)).toBe('api');
    const preflight = await handleLlmRelayRequest(req('?target=x', { method: 'OPTIONS' }));
    expect(preflight.status).toBe(204);
  });
});
