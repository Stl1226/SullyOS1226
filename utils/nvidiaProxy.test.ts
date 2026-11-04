import { describe, expect, it } from 'vitest';
import { buildNvidiaProxyUrl, isNvidiaApiUrl, redirectNvidiaRequest } from './nvidiaProxy';

const SITE = 'https://sully.example';

describe('NVIDIA 代理路由', () => {
    it('识别 NVIDIA 官方域名', () => {
        expect(isNvidiaApiUrl('https://integrate.api.nvidia.com/v1/models')).toBe(true);
        expect(isNvidiaApiUrl('https://api.openai.com/v1/models')).toBe(false);
        expect(isNvidiaApiUrl('https://integrate.api.nvidia.com.evil.test/v1/models')).toBe(false);
        expect(isNvidiaApiUrl('http://integrate.api.nvidia.com/v1/models')).toBe(false);
    });

    it('把 /v1 接口改写到同源 Netlify Function', () => {
        expect(buildNvidiaProxyUrl('https://integrate.api.nvidia.com/v1/models', SITE))
            .toBe(`${SITE}/.netlify/functions/nvidia-proxy?path=%2Fv1%2Fmodels`);
        expect(buildNvidiaProxyUrl('https://integrate.api.nvidia.com/v1/chat/completions', SITE))
            .toBe(`${SITE}/.netlify/functions/nvidia-proxy?path=%2Fv1%2Fchat%2Fcompletions`);
    });

    it('只填域名时自动补 /v1', () => {
        expect(buildNvidiaProxyUrl('https://integrate.api.nvidia.com/models', SITE))
            .toBe(`${SITE}/.netlify/functions/nvidia-proxy?path=%2Fv1%2Fmodels`);
        expect(buildNvidiaProxyUrl('https://integrate.api.nvidia.com/chat/completions', SITE))
            .toBe(`${SITE}/.netlify/functions/nvidia-proxy?path=%2Fv1%2Fchat%2Fcompletions`);
        expect(buildNvidiaProxyUrl('https://integrate.api.nvidia.com', SITE))
            .toBe(`${SITE}/.netlify/functions/nvidia-proxy?path=%2Fv1`);
    });

    it('保留查询参数', () => {
        expect(buildNvidiaProxyUrl('https://integrate.api.nvidia.com/v1/models?limit=10', SITE))
            .toBe(`${SITE}/.netlify/functions/nvidia-proxy?path=%2Fv1%2Fmodels%3Flimit%3D10`);
    });

    it('不改写其他服务商', () => {
        expect(buildNvidiaProxyUrl('https://api.openai.com/v1/models', SITE)).toBeNull();
        expect(buildNvidiaProxyUrl('https://api.anthropic.com/v1/messages', SITE)).toBeNull();
    });

    it('保留 Request 的 method、headers 和 body', async () => {
        const request = new Request('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'meta/llama-3.1-8b-instruct', messages: [] }),
        });

        const redirected = await redirectNvidiaRequest(request, undefined, request.url, SITE);

        expect(redirected?.url).toBe(`${SITE}/.netlify/functions/nvidia-proxy?path=%2Fv1%2Fchat%2Fcompletions`);
        expect(redirected?.init.method).toBe('POST');
        expect((redirected?.init.headers as Headers).get('authorization')).toBe('Bearer test-key');
        expect(redirected?.init.body).toBe(JSON.stringify({ model: 'meta/llama-3.1-8b-instruct', messages: [] }));
    });

    it('非 NVIDIA 请求保持原样', async () => {
        expect(await redirectNvidiaRequest('https://api.openai.com/v1/models', {}, 'https://api.openai.com/v1/models', SITE)).toBeNull();
    });
});
