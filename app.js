import { analyze, imageToBase64, MODELS, DEFAULT_MODEL, PROVIDER } from './lib/ai.js';
import {
  getSettings, saveSettings, getStore, signIn, signOut, getSession,
  migrateLocalToCloud, localCardCount, sortCards,
} from './lib/store.js';

const $ = (id) => document.getElementById(id);

const LANG_NAMES = {
  en: '英文', ja: '日文', ko: '韓文', fr: '法文', de: '德文', es: '西班牙文', it: '義大利文',
  pt: '葡萄牙文', ru: '俄文', th: '泰文', vi: '越南文', id: '印尼文', ms: '馬來文', nl: '荷蘭文',
};
const SPEECH_LANG = { en: 'en-US', ja: 'ja-JP', ko: 'ko-KR', fr: 'fr-FR', de: 'de-DE', es: 'es-ES', it: 'it-IT', pt: 'pt-PT', ru: 'ru-RU', th: 'th-TH', vi: 'vi-VN' };
const SOURCE_LABEL = { word: '手動輸入', text: '文字', screenshot: '截圖', shortcut: 'iPhone 分享' };

const state = {
  cards: [],
  langFilter: 'all',
  query: '',
  candidates: [],   // AI 找到、尚未存入的單字
  candidateSource: '',
  shotBlob: null,
  busy: false,
};

/* ---------------- 共用小工具 ---------------- */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false || c === '') continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function setStatus(msg, kind = '') {
  const s = $('status');
  if (!msg) { s.hidden = true; return; }
  s.hidden = false;
  s.className = `status ${kind}`;
  s.textContent = msg;
}

function langName(code) {
  return LANG_NAMES[code] || (code || '').toUpperCase();
}

function wordKey(c) {
  return `${(c.language || '').toLowerCase()}|${(c.word || '').trim().toLowerCase()}`;
}

/** 目前 AI 服務的 API Key（換服務後舊的 Key 不能用，視為沒設定） */
function currentKey(s = getSettings()) {
  return s.apiProvider === PROVIDER.name ? s.apiKey : '';
}

function speak(word, lang) {
  if (!('speechSynthesis' in window)) { toast('這個瀏覽器不支援朗讀'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  u.lang = SPEECH_LANG[lang] || lang || 'en-US';
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

/* ---------------- 單字庫 ---------------- */
async function loadCards() {
  try {
    state.cards = await getStore().list();
  } catch (e) {
    toast(e.message);
  }
  renderLibrary();
}

function renderLibrary() {
  const grid = $('cardGrid');
  const q = state.query.trim().toLowerCase();
  const filtered = state.cards.filter((c) => {
    if (state.langFilter !== 'all' && c.language !== state.langFilter) return false;
    if (!q) return true;
    return [c.word, c.translation, c.reading, c.example].some((f) => (f || '').toLowerCase().includes(q));
  });

  $('cardCount').textContent = state.cards.length;
  $('emptyState').hidden = state.cards.length > 0;

  // 語言篩選
  const langs = [...new Set(state.cards.map((c) => c.language).filter(Boolean))];
  const chips = $('langChips');
  chips.replaceChildren();
  if (langs.length > 1) {
    const mk = (code, label) => el('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(state.langFilter === code),
      onclick: () => { state.langFilter = code; renderLibrary(); },
    }, label);
    chips.append(mk('all', '全部'), ...langs.map((l) => mk(l, langName(l))));
  }

  grid.replaceChildren(...filtered.map(renderCard));
  if (state.cards.length && !filtered.length) {
    grid.append(el('p', { class: 'empty' }, '找不到符合的單字'));
  }
}

function renderCard(c) {
  return el('article', { class: `card${c.pinned ? ' pinned' : ''}` },
    el('div', { class: 'card-top' },
      el('span', { class: 'word', lang: c.language }, c.word),
      el('button', { class: 'speak', type: 'button', 'aria-label': `朗讀 ${c.word}`, onclick: () => speak(c.word, c.language) }, '🔊'),
      c.reading && el('span', { class: 'reading' }, c.reading),
    ),
    el('div', { class: 'tags' },
      el('span', { class: 'tag lang' }, langName(c.language)),
      c.pos && el('span', { class: 'tag' }, c.pos),
    ),
    el('div', { class: 'translation' }, c.translation),
    c.example && el('div', { class: 'example' },
      el('p', { lang: c.language }, c.example),
      c.example_translation && el('p', { class: 'ex-tr' }, c.example_translation),
    ),
    el('div', { class: 'card-foot' },
      el('span', { class: 'source', title: c.source || '' }, c.source || ''),
      el('div', { class: 'card-actions' },
        el('button', { class: 'pin', type: 'button', 'aria-pressed': String(!!c.pinned), onclick: () => togglePin(c) }, c.pinned ? '取消置頂' : '置頂'),
        el('button', { class: 'del', type: 'button', onclick: () => removeCard(c) }, '刪除'),
      ),
    ),
  );
}

async function togglePin(card) {
  const pinned = !card.pinned;
  card.pinned = pinned;
  state.cards = sortCards(state.cards);
  renderLibrary();
  try {
    await getStore().update(card.id, { pinned });
  } catch (e) {
    card.pinned = !pinned;
    state.cards = sortCards(state.cards);
    renderLibrary();
    toast(e.message);
  }
}

async function removeCard(card) {
  if (!confirm(`確定要刪除「${card.word}」嗎？`)) return;
  const before = state.cards;
  state.cards = state.cards.filter((c) => c.id !== card.id);
  renderLibrary();
  try {
    await getStore().remove(card.id);
    toast(`已刪除「${card.word}」`);
  } catch (e) {
    state.cards = before;
    renderLibrary();
    toast(e.message);
  }
}

/* ---------------- 新增：分析 ---------------- */
async function runAnalyze(mode, payload) {
  if (state.busy) return;
  const settings = getSettings();
  const apiKey = currentKey(settings);
  if (!apiKey) {
    setStatus(`還沒設定 ${PROVIDER.name} API Key，請先按右上角的齒輪到「設定」填入。`, 'error');
    return;
  }
  state.busy = true;
  setBusyUI(true);
  hideResults();
  setStatus(mode === 'screenshot' ? 'AI 正在讀取截圖…' : 'AI 正在查詢…', 'loading');
  try {
    const opts = { apiKey, model: settings.model || DEFAULT_MODEL, mode };
    if (mode === 'screenshot') opts.image = await imageToBase64(payload);
    else opts.text = payload;
    const items = await analyze(opts);
    if (!items.length) {
      setStatus('沒有找到可以學的外文單字。', 'error');
      return;
    }
    setStatus('');
    showResults(items, mode);
  } catch (e) {
    setStatus(e.message || '發生錯誤，請再試一次。', 'error');
  } finally {
    state.busy = false;
    setBusyUI(false);
  }
}

function setBusyUI(busy) {
  document.querySelectorAll('.tab-pane button[type="submit"]').forEach((b) => {
    b.disabled = busy || (b.id === 'shotSubmit' && !state.shotBlob);
  });
}

function showResults(items, mode) {
  const existing = new Set(state.cards.map(wordKey));
  state.candidates = items.map((it) => ({ ...it, dup: existing.has(wordKey(it)) }));
  state.candidateSource = SOURCE_LABEL[mode] || '';
  const preselect = state.candidates.length === 1;

  const list = $('candidateList');
  list.replaceChildren(...state.candidates.map((c, i) => el('li', {},
    el('label', { class: `candidate${c.dup ? ' dup' : ''}` },
      el('input', { type: 'checkbox', 'data-i': i, checked: preselect && !c.dup, onchange: updateSaveButton }),
      el('div', {},
        el('div', {}, el('span', { class: 'c-word', lang: c.language }, c.word), ' ',
          el('span', { class: 'c-meta' }, [c.reading, c.pos, langName(c.language)].filter(Boolean).join('・'))),
        el('div', { class: 'c-tr' }, c.translation),
        c.dup && el('div', { class: 'c-meta' }, '已經在單字庫裡'),
      ),
    ),
  )));
  $('resultsCount').textContent = `找到 ${state.candidates.length} 個單字，勾選要加入的：`;
  $('results').hidden = false;
  updateSaveButton();
}

function checkedBoxes() {
  return [...$('candidateList').querySelectorAll('input[type="checkbox"]')];
}

function updateSaveButton() {
  const n = checkedBoxes().filter((b) => b.checked).length;
  const btn = $('saveResults');
  btn.disabled = n === 0;
  btn.textContent = n ? `加入單字庫（${n}）` : '加入單字庫';
  $('toggleAll').textContent = n === checkedBoxes().length ? '全不選' : '全選';
}

function hideResults() {
  $('results').hidden = true;
  state.candidates = [];
}

async function saveCandidates() {
  const picked = checkedBoxes().filter((b) => b.checked).map((b) => state.candidates[Number(b.dataset.i)]);
  if (!picked.length) return;
  const btn = $('saveResults');
  btn.disabled = true;
  try {
    const toSave = picked.map(({ dup, ...c }) => ({ ...c, source: state.candidateSource }));
    const saved = await getStore().add(toSave);
    state.cards = sortCards([...saved, ...state.cards]);
    renderLibrary();
    hideResults();
    toast(`已加入 ${saved.length} 個單字`);
    $('wordInput').value = '';
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

/* ---------------- 分頁 ---------------- */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('.tab-pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  setStatus('');
}

/* ---------------- 截圖 ---------------- */
function setShot(blob) {
  if (!blob || !blob.type.startsWith('image/')) return;
  state.shotBlob = blob;
  const img = $('shotPreview');
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob);
  img.hidden = false;
  $('shotHint').hidden = true;
  $('shotSubmit').disabled = false;
}

/* ---------------- 設定 ---------------- */
function maskKey(k) {
  return k ? `目前：${k.slice(0, 6)}…${k.slice(-4)}（要更換才需要重新貼上）` : PROVIDER.keyHelp;
}

function openSettings() {
  const s = getSettings();
  $('aiLegend').textContent = `AI 服務（${PROVIDER.name}）`;
  $('apiKey').value = '';
  $('apiKey').placeholder = PROVIDER.keyPlaceholder;
  $('apiKeyHint').textContent = maskKey(currentKey(s));
  const selected = MODELS.some((m) => m.id === s.model) ? s.model : DEFAULT_MODEL;
  $('model').replaceChildren(...MODELS.map((m) => el('option', { value: m.id, selected: selected === m.id }, m.label)));
  $('supabaseUrl').value = s.supabaseUrl;
  $('supabaseKey').value = s.supabaseKey;
  $('password').value = '';
  $('authStatus').hidden = true;
  renderAuth();
  $('settings').showModal();
}

function collectSettings() {
  const patch = {
    model: $('model').value,
    supabaseUrl: $('supabaseUrl').value,
    supabaseKey: $('supabaseKey').value,
  };
  const newKey = $('apiKey').value.trim();
  if (newKey) {
    patch.apiKey = newKey;
    patch.apiProvider = PROVIDER.name;
  }
  return saveSettings(patch);
}

function renderAuth() {
  const session = getSession();
  $('loggedOut').hidden = !!session;
  $('loggedIn').hidden = !session;
  if (session) $('loggedEmail').textContent = session.email || '（未知）';
  const sync = $('syncStatus');
  sync.textContent = session ? `雲端同步中・${session.email || ''}` : '僅存在這台裝置';
  sync.classList.toggle('cloud', !!session);
}

function authStatus(msg, kind = '') {
  const s = $('authStatus');
  s.hidden = !msg;
  s.className = `status ${kind}`;
  s.textContent = msg || '';
}

async function doLogin() {
  collectSettings();
  const email = $('email').value;
  const password = $('password').value;
  if (!email || !password) { authStatus('請輸入 Email 和密碼', 'error'); return; }
  authStatus('登入中…', 'loading');
  try {
    await signIn(email, password);
    renderAuth();
    authStatus('');
    const n = localCardCount();
    if (n && confirm(`這台裝置上有 ${n} 個還沒同步的單字，要上傳到雲端嗎？`)) {
      const moved = await migrateLocalToCloud();
      toast(`已上傳 ${moved} 個單字`);
    }
    await loadCards();
    toast('登入成功，開始雲端同步');
  } catch (e) {
    authStatus(e.message, 'error');
  }
}

/* ---------------- 從 iPhone 捷徑或網址帶入文字 ---------------- */
function handleIncomingText() {
  const params = new URLSearchParams(location.search);
  const text = (params.get('text') || params.get('word') || '').trim();
  if (!text) return;
  history.replaceState(null, '', location.pathname);
  const isWord = text.split(/\s+/).length <= 3 && text.length <= 40;
  if (isWord) {
    switchTab('word');
    $('wordInput').value = text;
    runAnalyze('word', text);
  } else {
    switchTab('text');
    $('textInput').value = text;
    runAnalyze('text', text);
  }
  state.incoming = true;
}

/* ---------------- 綁定事件 ---------------- */
function bind() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('wordForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('wordInput').value.trim();
    if (v) runAnalyze('word', v);
  });
  $('textForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('textInput').value.trim();
    if (v) runAnalyze('text', v.slice(0, 6000));
  });
  $('shotForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.shotBlob) runAnalyze('screenshot', state.shotBlob);
  });

  $('shotInput').addEventListener('change', (e) => setShot(e.target.files[0]));
  const dz = $('dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    setShot(e.dataTransfer.files[0]);
  });
  document.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) { switchTab('screenshot'); setShot(file); }
  });

  $('toggleAll').addEventListener('click', () => {
    const boxes = checkedBoxes();
    const all = boxes.every((b) => b.checked);
    boxes.forEach((b) => { b.checked = !all; });
    updateSaveButton();
  });
  $('saveResults').addEventListener('click', saveCandidates);
  $('discardResults').addEventListener('click', hideResults);

  $('search').addEventListener('input', (e) => { state.query = e.target.value; renderLibrary(); });

  $('openSettings').addEventListener('click', openSettings);
  $('saveSettings').addEventListener('click', () => {
    collectSettings();
    $('settings').close();
    toast('設定已儲存');
    loadCards();
  });
  $('loginBtn').addEventListener('click', doLogin);
  $('logoutBtn').addEventListener('click', async () => {
    if (!confirm('登出後，這台裝置會看不到雲端的單字（資料不會被刪除）。確定登出？')) return;
    signOut();
    renderAuth();
    await loadCards();
    toast('已登出');
  });
}

/* ---------------- 啟動 ---------------- */
bind();
renderAuth();
loadCards();
handleIncomingText();
if (!currentKey() && !state.incoming) {
  setStatus(`第一次使用：請先按右上角的齒輪，填入 ${PROVIDER.name} API Key。`);
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
