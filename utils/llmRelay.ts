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
 *      域名，请求直接改写到「设置 → 网络代理 (Worker)」的 /llm 路由，不做注定失败的
 *      直连尝试（直连 CORS 失败时上游可能已经计费生成了一次）。
 *   2) 被动学习：直连抛网络型错误（TypeError: Failed to fetch / Load failed）时，把
 *      域名记进 localStorage；GET /models 立即经代理自动重试一次，POST 生成类请求
 *      遵守"不静默重发"约定，只记下域名并提示用户重新发送。
 *
 * key 的去向：转发时 key 仍在 Authorization / x-api-key 头里，经过用户自己配置的
 * 代理 Worker（默认公共实例可在设置里换成自托管）透传给服务商，Worker 不读不存。
 * 私网 / 回环地址永不转发（Worker 也够不着），指向代理 Worker 自身的地址不转发（防环）。
 */

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
export const buildLlmRelayUrl = (targetUrl: string, proxyBase: string = getProxyWorkerUrl()): string =>
    `${proxyBase.replace(/\/+$/, '')}/llm?target=${encodeURIComponent(targetUrl)}`;
