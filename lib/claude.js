// 備用：呼叫 Claude API（付費，依用量計費）。
// 目前 App 使用 gemini.js；要改用 Claude，把 lib/ai.js 裡的 './gemini.js' 改成 './claude.js'。

import { SYSTEM, CARD_SCHEMA, buildPrompt, parseItems, AIError } from './prompt.js';

export const PROVIDER = {
  name: 'Claude',
  keyPlaceholder: 'sk-ant-…',
  keyHelp: '還沒設定。到 console.anthropic.com 建立 API Key 後貼在這裡。',
};

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（品質最好・預設）' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（品質與費用平衡）' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（最便宜，約 Opus 的 1/40）' },
];
export const DEFAULT_MODEL = 'claude-opus-5-5';

// 支援伺服器端 refusal fallback 的模型
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

export async function analyze({ apiKey, model, mode, text, image }) {
  if (!apiKey) throw new AIError('還沒設定 Claude API Key，請先到「設定」填入。');
  if (!MODELS.some((m) => m.id === model)) model = DEFAULT_MODEL;

  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
  content.push({ type: 'text', text: buildPrompt(mode, text) });

  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const body = {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: 'user', content }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: CARD_SCHEMA } },
  };
  if (FALLBACK_MODELS.has(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new AIError('連不上 Claude，請檢查網路連線。');
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
    if (res.status === 401) throw new AIError('API Key 無效，請到「設定」重新貼上。');
    if (res.status === 403) throw new AIError(`這把 API Key 沒有權限使用這個模型。${detail}`);
    if (res.status === 429) throw new AIError('請求太頻繁，或已達花費上限，請稍後再試。');
    if (res.status === 529 || res.status >= 500) throw new AIError('Claude 伺服器忙碌中，請稍後再試。');
    throw new AIError(`Claude 回傳錯誤（${res.status}）：${detail}`);
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new AIError('AI 拒絕處理這段內容，請換一段文字或圖片。');
  if (data.stop_reason === 'max_tokens') throw new AIError('內容太長，AI 沒有回答完，請縮短文字再試。');

  const raw = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return parseItems(raw);
  } catch {
    throw new AIError('AI 回傳的格式無法解析，請再試一次。');
  }
}
