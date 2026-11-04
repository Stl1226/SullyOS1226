/**
 * NVIDIA API Proxy for Netlify
 *
 * NVIDIA 的 OpenAI 兼容接口不返回 CORS 头，浏览器无法直连。这个函数把同源请求
 * 转发到 https://integrate.api.nvidia.com，并把上游响应（包括 SSE 流）原样带回。
 *
 * 客户端调用：
 *   POST/GET /.netlify/functions/nvidia-proxy?path=%2Fv1%2Fchat%2Fcompletions
 *   Authorization 等请求头照常携带，由函数转发。
 *
 * 只允许 NVIDIA 官方域名，避免变成开放代理。
 */

const NVIDIA_ORIGIN = 'https://integrate.api.nvidia.com';

const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, NVCF-Input-Asset-References, NVCF-Poll-Seconds, NVCF-Trace-Id, X-Request-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
};

/** 只转发必要的请求头，别把 Cookie / Host 等带去上游。 */
const FORWARDED_REQUEST_HEADERS = [
    'authorization',
    'content-type',
    'accept',
    'x-request-id',
    'nvcf-input-asset-references',
    'nvcf-poll-seconds',
    'nvcf-trace-id',
];

/** 回传上游的响应头（其余内容由浏览器自己处理）。 */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'x-request-id', 'cache-control', 'retry-after'];

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
}

export default async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);
    const path = url.searchParams.get('path') || '';
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
        return jsonResponse({ error: 'Invalid path' }, 400);
    }

    let target: URL;
    try {
        target = new URL(path, NVIDIA_ORIGIN);
    } catch {
        return jsonResponse({ error: 'Invalid path' }, 400);
    }
    if (target.origin !== NVIDIA_ORIGIN) {
        return jsonResponse({ error: 'Only NVIDIA API is allowed' }, 400);
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = req.headers.get(name);
        if (value) headers.set(name, value);
    }

    let body: BodyInit | undefined;
    if (req.method === 'POST') {
        const buffer = await req.arrayBuffer();
        if (buffer.byteLength > 0) {
            body = buffer;
            if (!headers.has('content-type')) headers.set('content-type', 'application/json');
        }
    }

    try {
        const upstream = await fetch(target.href, { method: req.method, headers, body });

        const responseHeaders = new Headers(CORS_HEADERS);
        for (const name of FORWARDED_RESPONSE_HEADERS) {
            const value = upstream.headers.get(name);
            if (value) responseHeaders.set(name, value);
        }

        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
        });
    } catch (error: any) {
        return jsonResponse({ error: `NVIDIA proxy failed: ${error?.message || 'network error'}` }, 502);
    }
};
