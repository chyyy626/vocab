// 單字卡儲存：有登入 Supabase 就存雲端（手機、電腦同步），否則先存在這台裝置。
// 直接呼叫 Supabase REST API，不依賴外部套件，之後 Chrome 擴充功能也能共用。

const KEYS = {
  settings: 'vocab.settings',
  session: 'vocab.session',
  localCards: 'vocab.localCards',
};

function readJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 私密瀏覽等情況寫不進去，忽略 */ }
}

export function getSettings() {
  return { apiKey: '', model: '', supabaseUrl: '', supabaseKey: '', ...readJSON(KEYS.settings, {}) };
}
export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  next.supabaseUrl = (next.supabaseUrl || '').trim().replace(/\/+$/, '');
  next.supabaseKey = (next.supabaseKey || '').trim();
  next.apiKey = (next.apiKey || '').trim();
  writeJSON(KEYS.settings, next);
  return next;
}

export function sortCards(cards) {
  return [...cards].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
}

const CARD_COLUMNS = ['word', 'language', 'reading', 'translation', 'pos', 'example', 'example_translation', 'source'];
function cleanCard(c) {
  return Object.fromEntries(CARD_COLUMNS.map((k) => [k, String(c[k] ?? '')]));
}

export class StoreError extends Error {}

/* ---------- 本機模式 ---------- */
class LocalStore {
  kind = 'local';
  async list() {
    return sortCards(readJSON(KEYS.localCards, []));
  }
  async add(cards) {
    const now = Date.now();
    const created = cards.map((c, i) => ({
      ...cleanCard(c),
      id: crypto.randomUUID(),
      pinned: false,
      created_at: new Date(now + i).toISOString(),
    }));
    writeJSON(KEYS.localCards, [...readJSON(KEYS.localCards, []), ...created]);
    return created;
  }
  async update(id, patch) {
    const all = readJSON(KEYS.localCards, []).map((c) => (c.id === id ? { ...c, ...patch } : c));
    writeJSON(KEYS.localCards, all);
  }
  async remove(id) {
    writeJSON(KEYS.localCards, readJSON(KEYS.localCards, []).filter((c) => c.id !== id));
  }
}

/* ---------- Supabase 雲端模式 ---------- */
class SupabaseStore {
  kind = 'cloud';
  constructor(url, key) {
    this.url = url;
    this.key = key;
  }

  async #accessToken() {
    let s = readJSON(KEYS.session, null);
    if (!s) throw new StoreError('登入已失效，請到「設定」重新登入。');
    if (s.expires_at * 1000 < Date.now() + 60_000) {
      s = await refreshSession(this.url, this.key, s.refresh_token);
    }
    return s.access_token;
  }

  async #req(path, { method = 'GET', body, prefer } = {}) {
    const headers = {
      apikey: this.key,
      Authorization: `Bearer ${await this.#accessToken()}`,
      'Content-Type': 'application/json',
    };
    if (prefer) headers.Prefer = prefer;
    let res;
    try {
      res = await fetch(`${this.url}/rest/v1/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new StoreError('連不上雲端資料庫，請檢查網路。');
    }
    if (res.status === 401) {
      writeJSON(KEYS.session, null);
      throw new StoreError('登入已失效，請到「設定」重新登入。');
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new StoreError(`雲端資料庫錯誤（${res.status}）：${t.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async list() {
    return this.#req('cards?select=*&order=pinned.desc,created_at.desc');
  }
  async add(cards) {
    return this.#req('cards', { method: 'POST', body: cards.map(cleanCard), prefer: 'return=representation' });
  }
  async update(id, patch) {
    await this.#req(`cards?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' });
  }
  async remove(id) {
    await this.#req(`cards?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
  }
}

/* ---------- 登入 ---------- */
async function authRequest(url, key, grantType, payload) {
  let res;
  try {
    res = await fetch(`${url}/auth/v1/token?grant_type=${grantType}`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new StoreError('連不上 Supabase，請確認網址是否正確、網路是否正常。');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (grantType === 'refresh_token') writeJSON(KEYS.session, null);
    const msg = data.error_description || data.msg || data.message || '';
    if (/invalid login credentials/i.test(msg)) throw new StoreError('Email 或密碼錯誤。');
    if (/email not confirmed/i.test(msg)) throw new StoreError('這個帳號的 Email 還沒驗證，請到 Supabase 後台確認使用者。');
    throw new StoreError(grantType === 'refresh_token' ? '登入已失效，請重新登入。' : `登入失敗：${msg || res.status}`);
  }
  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    email: data.user?.email || '',
  };
  writeJSON(KEYS.session, session);
  return session;
}

function refreshSession(url, key, refreshToken) {
  return authRequest(url, key, 'refresh_token', { refresh_token: refreshToken });
}

export async function signIn(email, password) {
  const { supabaseUrl, supabaseKey } = getSettings();
  if (!supabaseUrl || !supabaseKey) throw new StoreError('請先填入 Supabase 網址和金鑰。');
  return authRequest(supabaseUrl, supabaseKey, 'password', { email: email.trim(), password });
}

export function signOut() {
  writeJSON(KEYS.session, null);
}

export function getSession() {
  return readJSON(KEYS.session, null);
}

export function getStore() {
  const { supabaseUrl, supabaseKey } = getSettings();
  if (supabaseUrl && supabaseKey && getSession()) return new SupabaseStore(supabaseUrl, supabaseKey);
  return new LocalStore();
}

/** 登入雲端後，把之前存在本機的單字搬上去。回傳搬移數量。 */
export async function migrateLocalToCloud() {
  const local = readJSON(KEYS.localCards, []);
  if (!local.length) return 0;
  const store = getStore();
  if (store.kind !== 'cloud') return 0;
  await store.add(local);
  writeJSON(KEYS.localCards, []);
  return local.length;
}

export function localCardCount() {
  return readJSON(KEYS.localCards, []).length;
}
