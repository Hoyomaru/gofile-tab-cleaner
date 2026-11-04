import { contentIdFromUrl } from './common.js';

const DEFAULTS = { autoNotFound: true, autoDedupe: true, autoRetry: true, retentionDays: 7 };
const SWITCHES = ['autoNotFound', 'autoDedupe', 'autoRetry'];
const DAY = 86_400_000;
const REASON = { notFound: '不存在', duplicate: '重複' };
// 理由ごとの札の色（共通の状態色。不存在は注意、重複は目立たせない）
const REASON_TONE = { notFound: 'warn', duplicate: '' };
const REOPEN_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/></svg>';
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
  const bar = $('progressBar');
  if (!scan.total) {
    fill.classList.add('indeterminate');
    fill.style.width = '';
    bar.removeAttribute('aria-valuenow');
    $('progressText').textContent = '準備中…（重複を整理しています）';
  } else {
    const pct = Math.round((scan.done / scan.total) * 100);
    fill.classList.remove('indeterminate');
    fill.style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', String(pct));
    $('progressText').textContent = `${scan.done} / ${scan.total} タブを確認済み（未読み込みのタブは読み込み直して確認します）`;
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
    tag.className = `tag ${REASON_TONE[e.reason] || ''}`;
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
    btn.innerHTML = REOPEN_ICON;
    btn.title = '開き直す（同じタブが開いていればそこへ移動）';
    btn.setAttribute('aria-label', `${name || id} を開き直す`);
    btn.addEventListener('click', () => reopen([e], true));

    li.append(tag, info, btn);
    ul.append(li);
  }
}

const visibleEntries = () => (filter === 'all' ? log : log.filter((e) => e.reason === filter));

// 開き直す。実際の処理は background が行う（まとめて開く時は間隔をあけるので、
// ポップアップを閉じても最後まで開けるように）。
const reopen = (entries, focus) =>
  chrome.runtime.sendMessage({ type: 'reopen', entries, focus }).catch(() => {});

// ---- 自動処理の1行まとめ（たたんだ時に見える） ----
const SWITCH_LABELS = { autoNotFound: '不存在', autoDedupe: '重複', autoRetry: '再試行' };
function renderAutoSummary() {
  const on = SWITCHES.filter((k) => $(k).checked).map((k) => SWITCH_LABELS[k]);
  const days = retentionDays > 0 ? `履歴 ${retentionDays}日` : '履歴 無期限';
  $('autoSummary').textContent = `${on.length ? on.join('・') + ' オン' : 'すべてオフ'} ・ ${days}`;
}

// ---- 2回押して確定するボタン（共通の決まりごと） ----
// 1回目でボタンの文字が data-confirm に変わり、4秒以内にもう一度押すと実行する
function confirmTwice(button, action) {
  const label = button.textContent;
  let timer = null;
  const reset = () => {
    clearTimeout(timer);
    timer = null;
    button.textContent = label;
    button.classList.remove('armed');
  };
  button.addEventListener('click', () => {
    if (timer) { reset(); action(); return; }
    button.textContent = button.dataset.confirm;
    button.classList.add('armed');
    timer = setTimeout(reset, 4000);
  });
  button.addEventListener('blur', () => { if (timer) reset(); });
}

// ---- 初期化 ----
async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  for (const key of SWITCHES) {
    $(key).checked = s[key];
    $(key).addEventListener('change', (e) => {
      chrome.storage.sync.set({ [key]: e.target.checked });
      renderAutoSummary();
    });
  }
  retentionDays = Number(s.retentionDays);
  $('retentionDays').value = String(retentionDays);
  renderAutoSummary();
  $('retentionDays').addEventListener('change', async (e) => {
    retentionDays = Number(e.target.value);
    renderAutoSummary();
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
    document.querySelectorAll('.chip').forEach((c) => {
      c.classList.toggle('active', c === chip);
      c.setAttribute('aria-pressed', String(c === chip));
    });
    renderLog();
  });
});

$('scan').addEventListener('click', async () => {
  showProgress({ done: 0, total: 0 });
  const r = await chrome.runtime.sendMessage({ type: 'scanAll' }).catch(() => null);
  if (r?.busy) return; // 既に整理中（進捗は progress メッセージで届く）
  if (!r || r.error) {
    showProgress(null);
    $('result').textContent = `整理できませんでした（${r?.error || '応答がありません'}）。拡張機能を再読み込みしてから、もう一度試してください。`;
  }
  refreshStatus();
});

$('reopenAll').addEventListener('click', () => reopen(visibleEntries(), false));

confirmTwice($('clear'), () => chrome.storage.local.set({ log: [] }));

init();
