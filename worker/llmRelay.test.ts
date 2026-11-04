import {afterEach, expect, it, vi} from 'vitest';
// @ts-expect-error Plain JavaScript Worker runtime.
import worker from './index.js';

afterEach(() => vi.unstubAllGlobals());

const ORIGIN = 'https://app.test';

it('缺少 target 参数 → 400，不发起任何上游请求', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const r = await worker.fetch(new Request('https://proxy.test/llm', {method: 'POST', headers: {Origin: ORIGIN}}), {}, {});
    expect(r.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
});

it('白名单外的域名 / 非 https → 400，不发起任何上游请求', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const target of [
        'https://evil.example.com/v1/chat/completions',
        'http://integrate.api.nvidia.com/v1/chat/completions',
        'https://192.168.1.1/v1/chat/completions',
        'not-a-url',
    ]) {
        const r = await worker.fetch(new Request(`https://proxy.test/llm?target=${encodeURIComponent(target)}`, {
            method: 'POST', headers: {Origin: ORIGIN, Authorization: 'Bearer k'},
        }), {}, {});
        expect(r.status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
});

it('GET/POST 以外的方法 → 405', async () => {
    const r = await worker.fetch(new Request('https://proxy.test/llm?target=https%3A%2F%2Fapi.openai.com%2Fv1%2Fmodels', {
        method: 'PUT', headers: {Origin: ORIGIN},
    }), {}, {});
    expect(r.status).toBe(405);
});

it('英伟达 POST 透传：目标地址、方法、body、鉴权头原样转发，响应带 CORS 头', async () => {
    const fetcher = vi.fn(async (input: any, init: any) => {
        expect(String(input)).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
        expect(init.method).toBe('POST');
        expect(init.headers.authorization).toBe('Bearer nvapi-test-key');
        expect(init.headers['content-type']).toBe('application/json');
        // 浏览器侧杂头不透传
        expect(init.headers.cookie).toBeUndefined();
        expect(init.headers['x-custom-junk']).toBeUndefined();
        expect(JSON.parse(init.body).model).toBe('meta/llama-3.1-8b-instruct');
        return new Response(JSON.stringify({choices: [{message: {role: 'assistant', content: 'hi'}}]}), {
            status: 200, headers: {'Content-Type': 'application/json', 'x-request-id': 'req-1'},
        });
    });
    vi.stubGlobal('fetch', fetcher);
    const r = await worker.fetch(new Request(`https://proxy.test/llm?target=${encodeURIComponent('https://integrate.api.nvidia.com/v1/chat/completions')}`, {
        method: 'POST',
        headers: {
            Origin: ORIGIN,
            Authorization: 'Bearer nvapi-test-key',
            'Content-Type': 'application/json',
            Cookie: 'session=secret',
            'X-Custom-Junk': 'junk',
        },
        body: JSON.stringify({model: 'meta/llama-3.1-8b-instruct', messages: [{role: 'user', content: 'hi'}]}),
    }), {}, {});
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(r.headers.get('x-request-id')).toBe('req-1');
    const data = await r.json();
    expect(data.choices[0].message.content).toBe('hi');
    expect(fetcher).toHaveBeenCalledTimes(1);
});

it('GET /models 透传，上游状态码原样返回（401 也如实回传）', async () => {
    const fetcher = vi.fn(async () => new Response('{"error":"unauthorized"}', {status: 401, headers: {'Content-Type': 'application/json'}}));
    vi.stubGlobal('fetch', fetcher);
    const r = await worker.fetch(new Request(`https://proxy.test/llm?target=${encodeURIComponent('https://api.openai.com/v1/models')}`, {
        method: 'GET', headers: {Origin: ORIGIN, Authorization: 'Bearer k'},
    }), {}, {});
    expect(r.status).toBe(401);
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await r.text()).toContain('unauthorized');
});

it('SSE 流式响应原样回传，content-type 保留', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"你"}}\n\ndata: {"choices":[{"delta":{"content":"好"}}\n\ndata: [DONE]\n\n';
    const fetcher = vi.fn(async () => new Response(sse, {status: 200, headers: {'Content-Type': 'text/event-stream'}}));
    vi.stubGlobal('fetch', fetcher);
    const r = await worker.fetch(new Request(`https://proxy.test/llm?target=${encodeURIComponent('https://integrate.api.nvidia.com/v1/chat/completions')}`, {
        method: 'POST', headers: {Origin: ORIGIN, Authorization: 'Bearer k', 'Content-Type': 'application/json'},
        body: JSON.stringify({model: 'm', messages: [], stream: true}),
    }), {}, {});
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(await r.text()).toBe(sse);
});

it('Anthropic 原生头（x-api-key / anthropic-version）也透传', async () => {
    const fetcher = vi.fn(async (_input: any, init: any) => {
        expect(init.headers['x-api-key']).toBe('sk-ant-test');
        expect(init.headers['anthropic-version']).toBe('2023-06-01');
        expect(init.headers.authorization).toBeUndefined();
        return new Response('{}', {status: 200, headers: {'Content-Type': 'application/json'}});
    });
    vi.stubGlobal('fetch', fetcher);
    const r = await worker.fetch(new Request(`https://proxy.test/llm?target=${encodeURIComponent('https://api.anthropic.com/v1/messages')}`, {
        method: 'POST',
        headers: {Origin: ORIGIN, 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'},
        body: JSON.stringify({model: 'claude-opus-4-8', messages: []}),
    }), {}, {});
    expect(r.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
});

it('上游连接失败 → 502，不回传 key', async () => {
    const fetcher = vi.fn(async () => { throw new Error('connect reset'); });
    vi.stubGlobal('fetch', fetcher);
    const r = await worker.fetch(new Request(`https://proxy.test/llm?target=${encodeURIComponent('https://integrate.api.nvidia.com/v1/models')}`, {
        method: 'GET', headers: {Origin: ORIGIN, Authorization: 'Bearer nvapi-secret'},
    }), {}, {});
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain('nvapi-secret');
});
