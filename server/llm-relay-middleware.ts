/**
 * vite dev 中间件：/api/llm —— 海外 LLM 白名单透传（本地开发等价于
 * Vercel 的 api/llm.ts 与 Netlify 的 llm-proxy）。Node req/res 与 Web
 * Request/Response 之间做一层薄适配，核心逻辑共用 api/llm-shared.ts。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleLlmRelayRequest } from '../api/llm-shared';

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });

export const llmRelayMiddleware = async (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): Promise<void> => {
  try {
    const host = req.headers.host || 'localhost';
    // use('/api/llm', …) 挂载后 req.url 只剩查询串部分，补回完整路径
    const url = `http://${host}/api/llm${req.url || ''}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const method = (req.method || 'GET').toUpperCase();
    const body = method === 'POST' || method === 'PUT' ? await readBody(req) : undefined;
    const response = await handleLlmRelayRequest(new Request(url, { method, headers, body }));

    res.statusCode = response.status;
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() === 'content-length') return; // 流式回传，长度未知
      res.setHeader(name, value);
    });
    if (!response.body) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    next();
  }
};
