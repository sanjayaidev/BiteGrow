'use strict';
// Chat completions from Alibaba Cloud Model Studio (DashScope), the one AI provider every restaurant shares.
// The key, workspace, region and model are server settings (see .env.example); restaurants never handle a key.
//
// Model Studio speaks the OpenAI "chat/completions" format on a workspace-specific address:
//   https://<workspace id>.<region>.maas.aliyuncs.com/compatible-mode/v1

const DEFAULT_REGION = 'ap-southeast-1';
const DEFAULT_MODEL = 'qwen-plus';
const TIMEOUT_MS = 25_000;

const isConfigured = (env = process.env) => !!(env.ALIBABA_API_KEY && env.ALIBABA_WORKSPACE_ID);

/**
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
 * @param {object} [opts]
 * @param {boolean} [opts.json]        ask for a JSON object (the chat bots parse the answer); plain text otherwise
 * @param {number}  [opts.maxTokens]
 * @param {number}  [opts.temperature]
 * @returns {Promise<string>} the assistant's text
 */
async function callDashScopeChat(messages, { json = false, maxTokens = 400, temperature = 0.3, fetchImpl = (...a) => fetch(...a), env = process.env } = {}) {
  if (!isConfigured(env)) throw new Error('The AI assistant is not set up on this server (ALIBABA_API_KEY and ALIBABA_WORKSPACE_ID are missing)');

  const region = env.ALIBABA_REGION || DEFAULT_REGION;
  const model = env.ALIBABA_MODEL || DEFAULT_MODEL;
  const url = `https://${env.ALIBABA_WORKSPACE_ID}.${region}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ALIBABA_API_KEY}` },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`AI provider returned ${res.status}${payload && payload.error && payload.error.message ? `: ${payload.error.message}` : ''}`);
  const text = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('AI provider returned no text');
  return text.trim();
}

module.exports = { callDashScopeChat, isConfigured, DEFAULT_MODEL, DEFAULT_REGION };
