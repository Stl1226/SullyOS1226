/**
 * NVIDIA 的 OpenAI 兼容接口（integrate.api.nvidia.com）不返回 CORS 响应头，
 * 浏览器直连 `/v1/models` 和 `/v1/chat/completions` 都会被拦在预检阶段。
 *
 * 这里把 NVIDIA 请求改写到同源的 Netlify Function（netlify/functions/nvidia-proxy.ts），
 * 由服务端转发。仅改写 NVIDIA 官方域名，其他服务商保持原样直连。
 */

const NVIDIA_API_HOST = 'integrate.api.nvidia.com';
export const NVIDIA_PROXY_PATH = '/.netlify/functions/nvidia-proxy';

export function isNvidiaApiUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname.toLowerCase() === NVIDIA_API_HOST;
    } catch {
        return false;
    }
}

/**
 * 生成同源代理地址。用户可能只填了域名（没带 /v1），而 NVIDIA 的接口都在 /v1 下，
 * 这里顺手补齐，避免模型列表和对话都打空。
 */
export function buildNvidiaProxyUrl(value: string, siteOrigin?: string): string | null {
    if (!isNvidiaApiUrl(value)) return null;
    const origin = siteOrigin ?? (typeof window !== 'undefined' ? window.location.origin : '');
    if (!origin || !/^https?:\/\//i.test(origin)) return null;
    try {
        const target = new URL(value);
        let path = target.pathname || '/';
        if (!/^\/v1(?:\/|$)/.test(path)) {
            path = path === '/' ? '/v1' : `/v1${path}`;
        }
        const proxy = new URL(NVIDIA_PROXY_PATH, origin);
        proxy.searchParams.set('path', path + target.search);
        return proxy.href;
    } catch {
        return null;
    }
}

/**
 * 把一次 fetch 的入参改写到代理地址，保留 method / headers / body / signal。
 * 不适用于 NVIDIA 的请求返回 null，调用方继续走原来的直连逻辑。
 */
export async function redirectNvidiaRequest(
    resource: RequestInfo | URL,
    init: RequestInit | undefined,
    inputUrl: string,
    siteOrigin?: string,
): Promise<{ url: string; init: RequestInit } | null> {
    const url = buildNvidiaProxyUrl(inputUrl, siteOrigin);
    if (!url) return null;

    if (resource instanceof Request) {
        const method = (init?.method || resource.method || 'GET').toUpperCase();
        let body = init?.body;
        if (body === undefined && method !== 'GET' && method !== 'HEAD') {
            body = await resource.clone().text();
        }
        const headers = new Headers(resource.headers);
        if (init?.headers) {
            new Headers(init.headers).forEach((value, name) => headers.set(name, value));
        }
        return {
            url,
            init: { ...init, method, headers, body, signal: init?.signal ?? resource.signal },
        };
    }

    return { url, init: init || {} };
}
