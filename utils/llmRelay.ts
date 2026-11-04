/**
 * 海外 LLM 代理转发（绕 CORS / 直连不可达）
 *
 * 背景：SullyOS 的大模型请求是浏览器直连用户填的 baseUrl。国内服务商（DeepSeek、
 * Moonshot、各类中转站）基本都放开了 CORS，所以一直没问题；但不少海外官方接口
 * 不返回 Access-Control-Allow-Origin —— 实测英伟达 NIM（integrate.api.nvidia.com）
 * 就是典型，浏览器 fetch 必然报 Failed to fetch（OpenAI 官方接口同样不支持浏览器
 * 直连）。这层失败对调用方呈现为"网络错误"，和断网/GFW 无法区分。
 *
 * 策略（在 OSContext 全局 fetch 拦截器里生效，覆盖全部 /chat/completions、
 * /messages、/models 调用点）：
 *   1) 主动转发：KNOWN_NOCORS_HOSTS 里的域名（英伟达 / OpenAI）+ 用户机器上学到过的
 *      域名，请求直接改写到转发路由，不做注定失败的直连尝试（直连 CORS 失败时
 *      上游可能已经计费生成了一次）。
 *   2) 被动学习：直连抛网络型错误（TypeError: Failed to fetch / Load failed）时，把
 *      域名记进 localStorage；GET /models 立即经代理自动重试一次，POST 生成类请求
 *      遵守"不静默重发"约定，只记下域名并提示用户重新发送。
 *
 * 转发路由有两条，自动选择、自动降级，用户零配置：
 *   - 'api'    同源 /api/llm：随网站一起部署（Vercel api/llm.ts、Netlify 经
 *              netlify.toml 重写、vite dev 中间件），优先使用。纯静态托管没有
 *              这个路由时，响应是没有转发标识头的 404/HTML——请求根本没出站，
 *              换路由安全重发，并把选择记进 localStorage。
 *   - 'worker' 「设置 → 网络代理 (Worker)」的 /llm 路由：自托管 Worker 或作者
 *              公共实例，作为同源路由不可用时的兜底，也是原生 App / file:// 的
 *              首选（原生壳的 https://localhost 没有 /api）。
 *
 * key 的去向：转发时 key 仍在 Authorization / x-api-key 头里，只经过用户自己
 * 部署的站点/Worker 透传给服务商，不读不存。私网 / 回环地址永不转发，指向代理
 * 自身的地址不转发（防环）。
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { getProxyWorkerUrl } from './proxyWorker';

/** 已确认浏览器直连必挂（无 CORS）的官方域名，从第一次请求起就走代理。 */
const KNOWN_NOCORS_HOSTS: ReadonlySet<string> = new Set([
    'integrate.api.nvidia.com', // 英伟达 NIM，实测无 ACAO 头
    'api.openai.com',           // OpenAI 官方不支持浏览器直连
]);

const LEARNED_HOSTS_LS_KEY = 'sully_llm_relay_hosts_v1';

/** 是否是 LLM 请求（OpenAI 兼容 / Anthropic 原生），只有这类地址才考虑转发。 */
export const isLlmRelayCandidateUrl = (url: string): boolean => {
    try {
        const { pathname } = new URL(url);
        return /\/chat\/completions\/?$/.test(pathname)
            || /\/messages(\/(?:chat\/completions|models))?\/?$/.test(pathname)
            || /\/models\/?$/.test(pathname);
    } catch {
        return false;
    }
};

/** 回环 / 私网 / 链路本地地址：Worker 够不着，也绝不把内网地址交给公共代理。 */
export const isPrivateLlmHost = (hostname: string): boolean => {
    const h = hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === '[::1]') return true;
    const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        if (a === 127 || a === 10 || a === 0) return true;
        if (a === 192 && b === 168) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 169 && b === 254) return true;
    }
    return false;
};

const readLearnedHosts = (): Set<string> => {
    try {
        const raw = localStorage.getItem(LEARNED_HOSTS_LS_KEY);
        if (!raw) return new Set();
        const list = JSON.parse(raw);
        if (!Array.isArray(list)) return new Set();
        return new Set(list.filter((h): h is string => typeof h === 'string' && h.length > 0));
    } catch {
        return new Set();
    }
};

/** 把直连失败过的域名记下来（最多留 50 个，防无限膨胀）。 */
export const markLlmHostNeedsRelay = (hostname: string): void => {
    const host = hostname.toLowerCase();
    if (!host || isPrivateLlmHost(host) || KNOWN_NOCORS_HOSTS.has(host)) return;
    try {
        const hosts = readLearnedHosts();
        if (hosts.has(host)) return;
        hosts.add(host);
        const list = [...hosts].slice(-50);
        localStorage.setItem(LEARNED_HOSTS_LS_KEY, JSON.stringify(list));
    } catch {
        /* localStorage 不可用时只是下次还要再失败一次才学习 */
    }
};

/** 测试用：清掉学习记录。 */
export const resetLlmRelayLearnedHosts = (): void => {
    try { localStorage.removeItem(LEARNED_HOSTS_LS_KEY); } catch { /* ignore */ }
};

/** 该 LLM 地址是否应该走代理转发。 */
export const shouldRelayLlmUrl = (url: string): boolean => {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
        const host = parsed.hostname.toLowerCase();
        if (isPrivateLlmHost(host)) return false;
        // 目标已经是代理 Worker 自身时不转发，防止 target 套娃。
        try {
            if (new URL(getProxyWorkerUrl()).hostname.toLowerCase() === host) return false;
        } catch { /* 代理地址配置坏了就按不转发处理 */ }
        if (!isLlmRelayCandidateUrl(url)) return false;
        return KNOWN_NOCORS_HOSTS.has(host) || readLearnedHosts().has(host);
    } catch {
        return false;
    }
};

/** 把目标 LLM 地址改写成经代理 Worker 转发的地址。 */
export const buildWorkerLlmRelayUrl = (targetUrl: string, proxyBase: string = getProxyWorkerUrl()): string =>
    `${proxyBase.replace(/\/+$/, '')}/llm?target=${encodeURIComponent(targetUrl)}`;

// ─── 转发路由选择（同源 /api/llm 优先，Worker 兜底） ───

export type LlmRelayRoute = 'api' | 'worker';

/** 转发层在响应上打的标识头（见 api/llm-shared.ts / worker /llm）。 */
export const LLM_RELAY_HEADER = 'x-sully-llm-relay';

const ROUTE_LS_KEY = 'sully_llm_relay_route_v1';

const isNativeCapacitor = (): boolean => {
    try { return Capacitor.isNativePlatform(); } catch { return false; }
};

// ─── 原生壳（安卓/iOS）传输 ───

/** 原生平台只透传这些头（与转发层同一套白名单）。 */
const NATIVE_FORWARD_HEADERS = [
    'authorization',
    'content-type',
    'x-api-key',
    'anthropic-version',
    'anthropic-beta',
    'anthropic-dangerous-direct-browser-access',
    'x-goog-api-key',
    'accept',
];

const readHeaders = (src: HeadersInit | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!src) return out;
    if (src instanceof Headers) src.forEach((v, k) => { out[k.toLowerCase()] = v; });
    else if (Array.isArray(src)) for (const [k, v] of src) out[k.toLowerCase()] = v;
    else for (const [k, v] of Object.entries(src)) out[k.toLowerCase()] = v;
    return out;
};

/**
 * 原生 App 里的 LLM 传输：走 Android/iOS 原生网络栈（CapacitorHttp），
 * 没有浏览器 CORS 限制——英伟达 / OpenAI 这类接口直接通，零代理、零账号、
 * 零配置。项目是 Capacitor 6，CapacitorHttp 在 @capacitor/core 里自带。
 *
 * 原生桥不支持流式响应，所以把 body 里的 stream 置为 false，让上游返回整包
 * JSON。safeApi 的 parseRawBodyText 本来就按 content-type 分流（SSE 或 JSON），
 * 整包 JSON 能正常解析，代价是回复一次性出现而不是逐字打出。
 *
 * 只在 shouldRelayLlmUrl 命中的域名上启用；国内服务商在 WebView 里本来就能
 * 直连，维持原状不动。
 */
export const nativeLlmFetch = async (resource: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof resource === 'string'
        ? resource
        : resource instanceof URL
            ? resource.href
            : resource.url;
    const srcHeaders = {
        ...(typeof resource === 'object' && !(resource instanceof URL) && 'headers' in resource
            ? readHeaders(resource.headers as HeadersInit)
            : {}),
        ...readHeaders(init?.headers),
    };
    const headers: Record<string, string> = {};
    for (const key of NATIVE_FORWARD_HEADERS) if (srcHeaders[key]) headers[key] = srcHeaders[key];

    let data: unknown;
    if (typeof init?.body === 'string' && init.body) {
        try {
            const parsed = JSON.parse(init.body);
            if (parsed && typeof parsed === 'object' && (parsed as any).stream === true) {
                (parsed as any).stream = false; // 原生桥没有 SSE，改要整包 JSON
            }
            data = parsed;
        } catch {
            data = init.body;
        }
    }

    const method = (init?.method
        || (typeof resource === 'object' && !(resource instanceof URL) && 'method' in resource ? (resource as Request).method : 'GET')
    ).toUpperCase();

    let res: { status?: number; headers?: Record<string, string>; data?: unknown };
    try {
        res = await CapacitorHttp.request({ method, url, headers, data, responseType: 'text' });
    } catch (e) {
        // 对齐 fetch 语义：网络层失败抛 TypeError，上层（OSContext 拦截器）按这个识别。
        throw new TypeError(`Failed to fetch (native): ${(e as any)?.message || e}`);
    }

    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(res.headers || {})) {
        try { responseHeaders.set(k, String(v)); } catch { /* 忽略非法头 */ }
    }
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
    const status = res.status && res.status >= 200 && res.status <= 599 ? res.status : 200;
    return new Response(text, { status, headers: responseHeaders });
};

/** 同源 /api/llm 只有在真浏览器 + http(s) 页面时才可能存在。 */
export const isSameOriginRelayEligible = (): boolean => {
    if (typeof window === 'undefined' || typeof window.location === 'undefined') return false;
    const proto = window.location.protocol || '';
    if (proto !== 'http:' && proto !== 'https:') return false;
    // 原生壳的页面源是 https://localhost / capacitor://localhost，背后没有 serverless。
    if (isNativeCapacitor()) return false;
    return true;
};

/** 当前应使用的转发路由：显式学到过就用学到的，否则能同源就同源。 */
export const getLlmRelayRoute = (): LlmRelayRoute => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(ROUTE_LS_KEY); } catch { /* ignore */ }
    if (stored === 'worker') return 'worker';
    if (stored === 'api') return isSameOriginRelayEligible() ? 'api' : 'worker';
    return isSameOriginRelayEligible() ? 'api' : 'worker';
};

/** 同源 /api/llm 不存在（纯静态托管）：之后直接用 Worker 路由。 */
export const markLlmRelayApiUnavailable = (): void => {
    try { localStorage.setItem(ROUTE_LS_KEY, 'worker'); } catch { /* ignore */ }
};

/** 测试用：清掉路由学习记录。 */
export const resetLlmRelayRoute = (): void => {
    try { localStorage.removeItem(ROUTE_LS_KEY); } catch { /* ignore */ }
};

/** 构造转发地址。route 缺省按 getLlmRelayRoute() 自动选。 */
export const buildLlmRelayUrl = (targetUrl: string, route: LlmRelayRoute = getLlmRelayRoute()): string => {
    if (route === 'api' && typeof window !== 'undefined' && window.location?.origin) {
        return `${window.location.origin}/api/llm?target=${encodeURIComponent(targetUrl)}`;
    }
    return buildWorkerLlmRelayUrl(targetUrl);
};

/**
 * 转发响应是否说明「这条路由根本不存在」（纯静态托管把 /api/llm 回退成
 * index.html 或 404）。特征：没有转发标识头 + 404/405/HTML。此时请求没出过站，
 * 换路由重发是安全的（不会重复计费）。有标识头的是上游真实响应，不许动。
 */
export const isLlmRelayUnavailableResponse = (response: Response): boolean => {
    if (response.headers.get(LLM_RELAY_HEADER)) return false;
    if (response.status === 404 || response.status === 405) return true;
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    return contentType.includes('text/html');
};
