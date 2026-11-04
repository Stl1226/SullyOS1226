import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildLlmRelayUrl,
  buildWorkerLlmRelayUrl,
  getLlmRelayRoute,
  isLlmRelayCandidateUrl,
  isLlmRelayUnavailableResponse,
  isPrivateLlmHost,
  LLM_RELAY_HEADER,
  markLlmHostNeedsRelay,
  markLlmRelayApiUnavailable,
  nativeLlmFetch,
  resetLlmRelayLearnedHosts,
  resetLlmRelayRoute,
  shouldRelayLlmUrl,
} from './llmRelay';
import { CapacitorHttp } from '@capacitor/core';
import { DEFAULT_PROXY_WORKER, setProxyWorkerUrl } from './proxyWorker';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
  CapacitorHttp: { request: vi.fn() },
}));

describe('llmRelay 海外 LLM 代理转发', () => {
  beforeEach(() => {
    localStorage.clear();
    resetLlmRelayLearnedHosts();
    resetLlmRelayRoute();
  });

  it('识别 LLM 请求地址：chat/completions、Anthropic /messages、/models', () => {
    expect(isLlmRelayCandidateUrl('https://integrate.api.nvidia.com/v1/chat/completions')).toBe(true);
    expect(isLlmRelayCandidateUrl('https://api.anthropic.com/v1/messages')).toBe(true);
    expect(isLlmRelayCandidateUrl('https://api.anthropic.com/v1/messages/models')).toBe(true);
    expect(isLlmRelayCandidateUrl('https://api.openai.com/v1/models')).toBe(true);
    expect(isLlmRelayCandidateUrl('https://example.com/index.html')).toBe(false);
    expect(isLlmRelayCandidateUrl('https://example.com/search?q=models')).toBe(false);
    expect(isLlmRelayCandidateUrl('not-a-url')).toBe(false);
  });

  it('已知无 CORS 域名（英伟达 / OpenAI）从第一次请求起就走代理', () => {
    expect(shouldRelayLlmUrl('https://integrate.api.nvidia.com/v1/chat/completions')).toBe(true);
    expect(shouldRelayLlmUrl('https://api.openai.com/v1/chat/completions')).toBe(true);
    // 国内服务商有 CORS，不主动转发
    expect(shouldRelayLlmUrl('https://api.deepseek.com/v1/chat/completions')).toBe(false);
  });

  it('私网 / 回环地址永不转发', () => {
    expect(isPrivateLlmHost('localhost')).toBe(true);
    expect(isPrivateLlmHost('127.0.0.1')).toBe(true);
    expect(isPrivateLlmHost('192.168.1.10')).toBe(true);
    expect(isPrivateLlmHost('10.0.0.2')).toBe(true);
    expect(isPrivateLlmHost('172.16.0.1')).toBe(true);
    expect(isPrivateLlmHost('172.32.0.1')).toBe(false);
    expect(isPrivateLlmHost('nas.local')).toBe(true);
    expect(isPrivateLlmHost('integrate.api.nvidia.com')).toBe(false);
    expect(shouldRelayLlmUrl('http://192.168.1.10:1234/v1/chat/completions')).toBe(false);
    // 学到私网域名也不该发生，但即使发生了也不转发
    markLlmHostNeedsRelay('192.168.1.10');
    expect(shouldRelayLlmUrl('http://192.168.1.10/v1/models')).toBe(false);
  });

  it('失败自学习：标记后的域名开始转发，未标记的不转发', () => {
    const url = 'https://api.example-llm.com/v1/chat/completions';
    expect(shouldRelayLlmUrl(url)).toBe(false);
    markLlmHostNeedsRelay('api.example-llm.com');
    expect(shouldRelayLlmUrl(url)).toBe(true);
    // 大小写不敏感
    markLlmHostNeedsRelay('API.EXAMPLE-2.COM');
    expect(shouldRelayLlmUrl('https://api.example-2.com/v1/models')).toBe(true);
    // 其他域名不受影响
    expect(shouldRelayLlmUrl('https://other.example.com/v1/chat/completions')).toBe(false);
  });

  it('非 LLM 地址即使域名已学习也不转发', () => {
    markLlmHostNeedsRelay('api.example-llm.com');
    expect(shouldRelayLlmUrl('https://api.example-llm.com/dashboard')).toBe(false);
  });

  it('转发地址构造：target 全量编码，跟随用户配置的 Worker', () => {
    const target = 'https://integrate.api.nvidia.com/v1/chat/completions';
    expect(buildWorkerLlmRelayUrl(target)).toBe(
      `${DEFAULT_PROXY_WORKER}/llm?target=${encodeURIComponent(target)}`,
    );
    setProxyWorkerUrl('https://my-worker.example.com/');
    expect(buildWorkerLlmRelayUrl(target)).toBe(
      `https://my-worker.example.com/llm?target=${encodeURIComponent(target)}`,
    );
    setProxyWorkerUrl('');
  });

  it('路由选择：浏览器默认同源 /api/llm，学到不可用后切 Worker；无 window 时用 Worker', () => {
    const target = 'https://integrate.api.nvidia.com/v1/chat/completions';
    // node 测试环境没有 window：等同原生壳 / file://，直接 Worker 路由
    expect(getLlmRelayRoute()).toBe('worker');
    // 模拟浏览器页面环境（stub 一个 http(s) window）
    vi.stubGlobal('window', { location: { protocol: 'http:', origin: 'http://localhost' } });
    expect(getLlmRelayRoute()).toBe('api');
    expect(buildLlmRelayUrl(target)).toBe(
      `http://localhost/api/llm?target=${encodeURIComponent(target)}`,
    );
    markLlmRelayApiUnavailable();
    expect(getLlmRelayRoute()).toBe('worker');
    expect(buildLlmRelayUrl(target)).toBe(
      `${DEFAULT_PROXY_WORKER}/llm?target=${encodeURIComponent(target)}`,
    );
    // 显式指定路由不受学习记录影响
    expect(buildLlmRelayUrl(target, 'api')).toBe(
      `http://localhost/api/llm?target=${encodeURIComponent(target)}`,
    );
    vi.unstubAllGlobals();
  });

  it('路由不可用判定：无标识头的 404/HTML 才算路由不存在', () => {
    const withHeader = (status: number, contentType = 'application/json') =>
      new Response('{}', { status, headers: { 'content-type': contentType, [LLM_RELAY_HEADER]: 'api' } });
    const noHeader = (status: number, contentType = 'application/json') =>
      new Response('x', { status, headers: { 'content-type': contentType } });
    // 静态托管回退页 / 404：路由不存在
    expect(isLlmRelayUnavailableResponse(noHeader(404))).toBe(true);
    expect(isLlmRelayUnavailableResponse(noHeader(405))).toBe(true);
    expect(isLlmRelayUnavailableResponse(noHeader(200, 'text/html; charset=utf-8'))).toBe(true);
    // 上游真实响应（带标识头）：就算 4xx 也不能换路由重发（可能已计费）
    expect(isLlmRelayUnavailableResponse(withHeader(404))).toBe(false);
    expect(isLlmRelayUnavailableResponse(withHeader(429))).toBe(false);
    expect(isLlmRelayUnavailableResponse(noHeader(401))).toBe(false);
    expect(isLlmRelayUnavailableResponse(noHeader(200))).toBe(false);
  });

  it('nativeLlmFetch 原生传输：stream 置 false、鉴权头透传、杂头丢弃、整包 JSON 返回', async () => {
    vi.mocked(CapacitorHttp.request).mockResolvedValue({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      data: '{"choices":[{"message":{"content":"你好"}}]}',
    } as any);
    const res = await nativeLlmFetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer nvapi-k', 'Content-Type': 'application/json', Cookie: 's=1' },
      body: JSON.stringify({ model: 'm', messages: [], stream: true }),
    });
    const call = vi.mocked(CapacitorHttp.request).mock.calls[0][0] as any;
    expect(call.url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe('Bearer nvapi-k');
    expect(call.headers.cookie).toBeUndefined();
    expect(call.data.stream).toBe(false); // 原生桥没有 SSE，改要整包
    expect(call.data.model).toBe('m');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(await res.text()).choices[0].message.content).toBe('你好');
  });

  it('nativeLlmFetch GET 无 body / Anthropic 头透传 / 网络失败抛 TypeError', async () => {
    vi.mocked(CapacitorHttp.request).mockResolvedValue({ status: 401, headers: {}, data: '{"error":"no"}' } as any);
    vi.mocked(CapacitorHttp.request).mockClear();
    const res = await nativeLlmFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      body: '{"model":"m"}',
    });
    const call = vi.mocked(CapacitorHttp.request).mock.calls[0][0] as any;
    expect(call.headers['x-api-key']).toBe('k');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(res.status).toBe(401);

    vi.mocked(CapacitorHttp.request).mockRejectedValue(new Error('Connection refused'));
    await expect(nativeLlmFetch('https://integrate.api.nvidia.com/v1/models'))
      .rejects.toBeInstanceOf(TypeError); // 上层靠 TypeError 识别网络型失败
  });

  it('指向代理 Worker 自身的地址不转发（防套娃）', () => {
    markLlmHostNeedsRelay(new URL(DEFAULT_PROXY_WORKER).hostname);
    expect(shouldRelayLlmUrl(`${DEFAULT_PROXY_WORKER}/llm?target=x`)).toBe(false);
    // /llm 路径本身也不是候选地址
    expect(isLlmRelayCandidateUrl(`${DEFAULT_PROXY_WORKER}/llm?target=x`)).toBe(false);
  });

  it('非法地址一律不转发', () => {
    expect(shouldRelayLlmUrl('not-a-url')).toBe(false);
    expect(shouldRelayLlmUrl('ftp://integrate.api.nvidia.com/v1/models')).toBe(false);
  });
});
