import { contentIdFromUrl } from './common.js';

const DEFAULTS = { autoNotFound: true, autoDedupe: true, retentionDays: 7 };
const SWITCHES = ['autoNotFound', 'autoDedupe'];
const DAY = 86_400_000;
const REASON = { notFound: '不存在', duplicate: '重複' };
const $ = (id) => document.getElementById(id);

let filter = 'all';
let log = [];
let retentionDays = DEFAULTS.retentionDays;

// 削除処理（1時間ごと）を待たずに、期限切れは表示から外す
const setLog = (entries) => {
  log = retentionDays > 0 ? entries.filter((e) => e.at >= Date.now() - retentionDays * DAY) : entries;
};

// ---- 時刻表示 ----
function relTime(at) {
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 60) return 'たった今';
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}日前`;
  return new Date(at).toLocaleDateString();
}

// ---- 現在の状況 ----
async function refreshStatus() {
  const st = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null);
  if (!st) return;
  $('statTotal').textContent = st.total;
  $('statDup').textContent = st.duplicates;
  $('statSleep').textContent = st.sleeping;
  $('statDup').parentElement.classList.toggle('warn', st.duplicates > 0);
  showProgress(st.scan);
}

function showProgress(scan) {
  $('scan').disabled = !!scan;
  $('scan').textContent = scan ? '整理中…' : '今すぐ全タブを整理';
  $('progress').hidden = !scan;
  $('result').hidden = !!scan;
  if (!scan) return;
  const fill = $('progressFill');
  if (!scan.total) {
    fill.classList.add('indeterminate');
    fill.style.width = '';
    $('progressText').textContent = '準備中…（重複を整理しています）';
  } else {
    fill.classList.remove('indeterminate');
    fill.style.width = `${(scan.done / scan.total) * 100}%`;
    $('progressText').textContent = `${scan.done} / ${scan.total} タブを確認済み（未読み込みのタブは再読み込みして確認します）`;
  }
}

function showResult(r) {
  if (!r) { $('result').textContent = ''; return; }
  let text = `前回の整理（${relTime(r.at)}）：重複 ${r.duplicates} 件・不存在 ${r.notFound} 件を閉じました`;
  if (r.unchecked) text += `。確認できなかった ${r.unchecked} 件はそのままです`;
  $('result').textContent = text;
}

// ---- 履歴 ----
// 不存在タブのタイトルは "Content not found · Gofile" なので、意味のある時だけ表示する
function displayName(e) {
  const t = (e.title || '').replace(/\s*·\s*Gofile\s*$/, '').trim();
  if (!t || /^(Content not found|Files)$/.test(t)) return null;
  return t;
}

function renderLog() {
  const counts = { all: log.length, notFound: 0, duplicate: 0 };
  for (const e of log) counts[e.reason] = (counts[e.reason] || 0) + 1;
  $('cntAll').textContent = counts.all;
  $('cntNotFound').textContent = counts.notFound;
  $('cntDuplicate').textContent = counts.duplicate;

  const items = visibleEntries();
  $('reopenAll').disabled = !items.length;
  $('clear').disabled = !log.length;

  const ul = $('log');
  ul.textContent = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = log.length ? 'この条件の履歴はありません' : 'まだ閉じたタブはありません';
    ul.append(li);
    return;
  }
  for (const e of items) {
    const id = e.contentId || contentIdFromUrl(e.url) || e.url;
    const name = displayName(e);

    const li = document.createElement('li');
    li.className = 'item';
    li.title = e.url;

    const tag = document.createElement('span');
    tag.className = `tag ${e.reason}`;
    tag.textContent = REASON[e.reason] || e.reason;

    const info = document.createElement('div');
    info.className = 'info';
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = name || id;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = name ? `${id} · ${relTime(e.at)}` : relTime(e.at);
    info.append(nameEl, meta);

    const btn = document.createElement('button');
    btn.className = 'reopen';
    btn.textContent = '↻';
    btn.title = '開き直す（同じタブが開いていればそこへ移動）';
    btn.addEventListener('click', () => reopen([e], true));

    li.append(tag, info, btn);
    ul.append(li);
  }
}

const visibleEntries = () => (filter === 'all' ? log : log.filter((e) => e.reason === filter));

// 開き直す。同じ contentId のタブが既に開いていれば新しく開かずそこを使う。
async function reopen(entries, focus) {
  const tabs = await chrome.tabs.query({});
  const openIds = new Map();
  for (const t of tabs) {
    const id = contentIdFromUrl(t.pendingUrl || t.url);
    if (id && !openIds.has(id)) openIds.set(id, t);
  }
  const done = new Set();
  for (const e of entries) {
    const id = e.contentId || contentIdFromUrl(e.url);
    const existing = id && openIds.get(id);
    if (existing) {
      if (focus) {
        await chrome.tabs.update(existing.id, { active: true });
        await chrome.windows.update(existing.windowId, { focused: true });
      }
    } else if (!done.has(id || e.url)) {
      await chrome.tabs.create({ url: e.url, active: focus });
    }
    done.add(id || e.url);
  }
  // 開き直した分は履歴から外す
  const removed = new Set(entries);
  await chrome.storage.local.set({ log: log.filter((e) => !removed.has(e)) });
}

// ---- 初期化 ----
async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  for (const key of SWITCHES) {
    $(key).checked = s[key];
    $(key).addEventListener('change', (e) => chrome.storage.sync.set({ [key]: e.target.checked }));
  }
  retentionDays = Number(s.retentionDays);
  $('retentionDays').value = String(retentionDays);
  $('retentionDays').addEventListener('change', async (e) => {
    retentionDays = Number(e.target.value);
    await chrome.storage.sync.set({ retentionDays }); // background が期限切れを削除する
    const d = await chrome.storage.local.get('log');
    setLog(d.log || []);
    renderLog();
  });

  const data = await chrome.storage.local.get(['log', 'lastScan']);
  setLog(data.log || []);
  renderLog();
  showResult(data.lastScan);
  refreshStatus();

  // 自動クローズや整理で履歴が変わったら表示を更新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.log) { setLog(changes.log.newValue || []); renderLog(); refreshStatus(); }
    if (changes.lastScan) showResult(changes.lastScan.newValue);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'progress') { showProgress(msg.scan); if (!msg.scan) refreshStatus(); }
  });

  // 「○分前」の表示を更新
  setInterval(() => { setLog(log); renderLog(); chrome.storage.local.get('lastScan').then((d) => showResult(d.lastScan)); }, 30_000);
}

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    filter = chip.dataset.filter;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderLog();
  });
});

$('scan').addEventListener('click', async () => {
  showProgress({ done: 0, total: 0 });
  const r = await chrome.runtime.sendMessage({ type: 'scanAll' }).catch(() => null);
  if (r?.busy) return; // 既に整理中（進捗は progress メッセージで届く）
  refreshStatus();
});

$('reopenAll').addEventListener('click', () => reopen(visibleEntries(), false));

$('clear').addEventListener('click', () => chrome.storage.local.set({ log: [] }));

init();
