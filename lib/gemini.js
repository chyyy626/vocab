// 呼叫 Google Gemini API（免費額度）：辨識外文、翻譯、詞性、例句。
// 使用 generateContent（官方說明仍完整支援），直接用瀏覽器 fetch。

import { SYSTEM, CARD_SCHEMA, buildPrompt, parseItems, AIError } from './prompt.js';

export const PROVIDER = {
  name: 'Gemini',
  keyPlaceholder: 'AIza…',
  keyHelp: '還沒設定。到 aistudio.google.com 用 Google 帳號免費建立 API Key 後貼在這裡。',
};

export const MODELS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash（品質較好・預設）' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite（較快，免費次數通常較多）' },
];
export const DEFAULT_MODEL = 'gemini-3.8-flash';

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model]
 * @param {'word'|'text'|'screenshot'|'region'} opts.mode
 * @param {string} [opts.text]
 * @param {{mediaType:string, data:string}} [opts.image]
 */
export async function analyze({ apiKey, model, mode, text, image }) {
  if (!apiKey) throw new AIError('還沒設定 Gemini API Key，請先到「設定」填入。');
  if (!MODELS.some((m) => m.id === model)) model = DEFAULT_MODEL;

  const parts = [];
  if (image) parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
  parts.push({ text: buildPrompt(mode, text) });

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: CARD_SCHEMA,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingLevel: 'LOW' },
    },
  };

  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AIError('連不上 Gemini，請檢查網路連線。');
  }

  if (!res.ok) {
    let err = {};
    try { err = (await res.json())?.error || {}; } catch { /* ignore */ }
    const msg = err.message || '';
    if (res.status === 429) {
      throw new AIError('免費額度暫時用完了（每分鐘或每天有上限）。請等一下再試；如果是每天的上限，台灣時間下午 3–4 點左右會重置。');
    }
    if ((res.status === 400 && /api key/i.test(msg)) || res.status === 401) {
      throw new AIError('API Key 無效，請到「設定」重新貼上。');
    }
    if (res.status === 403) throw new AIError(`這把 API Key 沒有權限：${msg}`);
    if (res.status === 404) throw new AIError('找不到這個模型，請到「設定」換另一個模型試試。');
    if (res.status >= 500) throw new AIError('Gemini 伺服器忙碌中，請稍後再試。');
    throw new AIError(`Gemini 回傳錯誤（${res.status}）：${msg}`);
  }

  const data = await res.json();
  if (data.promptFeedback?.blockReason) throw new AIError('Gemini 拒絕處理這段內容，請換一段文字或圖片。');
  const cand = data.candidates?.[0];
  if (!cand) throw new AIError('Gemini 沒有回應，請再試一次。');
  if (cand.finishReason === 'MAX_TOKENS') throw new AIError('內容太長，AI 沒有回答完，請縮短文字再試。');
  if (cand.finishReason && cand.finishReason !== 'STOP') {
    throw new AIError(`Gemini 沒有完成回答（${cand.finishReason}），請換一段內容再試。`);
  }

  const raw = (cand.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  try {
    return parseItems(raw);
  } catch {
    throw new AIError('AI 回傳的格式無法解析，請再試一次。');
  }
}
