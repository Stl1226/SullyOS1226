import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildLlmRelayUrl,
  isLlmRelayCandidateUrl,
  isPrivateLlmHost,
  markLlmHostNeedsRelay,
  resetLlmRelayLearnedHosts,
  shouldRelayLlmUrl,
} from './llmRelay';
import { DEFAULT_PROXY_WORKER, setProxyWorkerUrl } from './proxyWorker';

describe('llmRelay 海外 LLM 代理转发', () => {
  beforeEach(() => {
    localStorage.clear();
    resetLlmRelayLearnedHosts();
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
    expect(buildLlmRelayUrl(target)).toBe(
      `${DEFAULT_PROXY_WORKER}/llm?target=${encodeURIComponent(target)}`,
    );
    setProxyWorkerUrl('https://my-worker.example.com/');
    expect(buildLlmRelayUrl(target)).toBe(
      `https://my-worker.example.com/llm?target=${encodeURIComponent(target)}`,
    );
    setProxyWorkerUrl('');
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
