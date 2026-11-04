/**
 * Netlify Function: /.netlify/functions/llm-proxy（netlify.toml 把 /api/llm 重写到这里）
 *
 * 海外 LLM 白名单透传（绕浏览器 CORS），核心逻辑在 api/llm-shared.ts。
 * 部署到 Netlify 时随站点自动生效，无需任何配置。
 */
import { handleLlmRelayRequest } from '../../api/llm-shared';

export default async (req: Request): Promise<Response> => handleLlmRelayRequest(req);
