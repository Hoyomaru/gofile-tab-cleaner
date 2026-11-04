import { contentIdFromUrl, probePage } from './common.js';

// retentionDays: 「最近閉じたタブ」を残す日数。0 = 期限なし（件数上限のみ）
const DEFAULTS = { autoNotFound: true, autoDedupe: true, autoRetry: true, retentionDays: 7 };
const LOG_MAX = 50;
const DAY = 86_400_000;

const getSettings = () => chrome.storage.sync.get(DEFAULTS);
const tabUrl = (t) => t.pendingUrl || t.url || '';

// 処理を1本の列に並べて、同時実行による二重クローズを防ぐ
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn, fn).catch((e) => console.warn(e)));

// 保存期間を過ぎた履歴を取り除く
const withinRetention = (log, days) =>
  days > 0 ? log.filter((e) => e.at >= Date.now() - days * DAY) : log;

// 履歴の読み書きは専用の列に並べる（一括整理は queue の外で動くため、queue とは別にする）
let logQueue = Promise.resolve();
const withLog = (fn) => {
  const next = logQueue.then(fn, fn);
  logQueue = next.catch((e) => console.warn(e));
  return next;
};

const addLog = (entry) => withLog(async () => {
  const [{ log = [] }, { retentionDays }] = await Promise.all([chrome.storage.local.get('log'), getSettings()]);
  log.unshift(entry);
  await chrome.storage.local.set({ log: withinRetention(log, retentionDays).slice(0, LOG_MAX) });
});

const pruneLog = () => withLog(async () => {
  const [{ log = [] }, { retentionDays }] = await Promise.all([chrome.storage.local.get('log'), getSettings()]);
  const kept = withinRetention(log, retentionDays);
  if (kept.length !== log.length) await chrome.storage.local.set({ log: kept });
});

async function closeTab(tab, reason) {
  try {
    await chrome.tabs.remove(tab.id);
    const url = tabUrl(tab);
    await addLog({ url, contentId: contentIdFromUrl(url), title: tab.title || '', reason, at: Date.now() });
    return true;
  } catch {
    return false; // 既に閉じられていた等
  }
}

// ---- 重複整理 ----
// 同じ contentId のタブのうち「最初に開いたタブ」(= tab.id が最小) を残す。
// ピン留めタブは閉じない。ピン留めが含まれる場合はそれを優先して残す。
async function dedupe(onlyId = null) {
  const all = await chrome.tabs.query({});
  const groups = new Map();
  for (const t of all) {
    const id = contentIdFromUrl(tabUrl(t));
    if (!id || (onlyId && id !== onlyId)) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(t);
  }

  let closed = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => (b.pinned - a.pinned) || (a.id - b.id));
    const keep = list[0];
    const dups = list.slice(1).filter((t) => !t.pinned);
    const activeDup = dups.find((t) => t.active);
    if (activeDup) {
      // 見ていたタブを閉じる場合は、残すタブへ切り替える
      await chrome.tabs.update(keep.id, { active: true }).catch(() => {});
      if (keep.windowId !== activeDup.windowId) {
        await chrome.windows.update(keep.windowId, { focused: true }).catch(() => {});
      }
    }
    for (const t of dups) if (await closeTab(t, 'duplicate')) closed++;
  }
  return closed;
}

// ---- 不存在タブ（content.js からの報告）----
async function handleNotFound(tabId, contentId) {
  const { autoNotFound } = await getSettings();
  if (!autoNotFound) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  // 報告後に別ページへ移動していたら閉じない
  if (!tab || tab.pinned || contentIdFromUrl(tab.url) !== contentId) return;
  await closeTab(tab, 'notFound');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Too many requests の再試行（content.js からの問い合わせ）----
// 待ち時間は 10秒 → 20秒 → 40秒… と倍にしていく（±20% ばらつかせる）。
// さらに全タブで再読み込みの時刻を RETRY_GAP ずつずらし、一斉に再アクセスしないようにする。
// 実際の待機と再読み込みはタブ側（content.js）で行う（service worker は止まることがあるため）。
const RETRY_MAX = 5;
const RETRY_BASE = 10_000;
const RETRY_GAP = 2_000;
const RETRY_RESET = 10 * 60_000; // 最後の再試行からこれだけ経ったら回数を数え直す

async function handleTooMany(tabId) {
  const { autoRetry } = await getSettings();
  if (!autoRetry) return { off: true };
  const { retry = {}, nextSlot = 0 } = await chrome.storage.session.get(['retry', 'nextSlot']);
  const now = Date.now();
  const prev = retry[tabId];
  const attempt = prev && now - prev.at < RETRY_RESET ? prev.attempt + 1 : 1;
  if (attempt > RETRY_MAX) return { delay: null, max: RETRY_MAX }; // あきらめる（タブは閉じない）
  const backoff = RETRY_BASE * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
  const at = Math.max(now + backoff, nextSlot);
  retry[tabId] = { attempt, at };
  await chrome.storage.session.set({ retry, nextSlot: at + RETRY_GAP });
  return { delay: Math.round(at - now), attempt, max: RETRY_MAX };
}

async function forgetRetry(tabId) {
  const { retry = {} } = await chrome.storage.session.get('retry');
  if (!(tabId in retry)) return;
  delete retry[tabId];
  await chrome.storage.session.set({ retry });
}

// ---- 履歴から開き直す ----
// 同じ contentId のタブが既に開いていれば新しく開かずそこを使う。
// まとめて開く時は REOPEN_GAP ずつ間隔をあけて、Too many requests を起こしにくくする。
const REOPEN_GAP = 1_500;
let reopening = false;

const removeFromLog = (entry) => withLog(async () => {
  const { log = [] } = await chrome.storage.local.get('log');
  await chrome.storage.local.set({ log: log.filter((e) => !(e.at === entry.at && e.url === entry.url)) });
});

async function reopen(entries, focus) {
  const tabs = await chrome.tabs.query({});
  const openIds = new Map();
  for (const t of tabs) {
    const id = contentIdFromUrl(tabUrl(t));
    if (id && !openIds.has(id)) openIds.set(id, t);
  }
  const done = new Set();
  let opened = 0;
  for (const e of entries) {
    const id = e.contentId || contentIdFromUrl(e.url);
    const key = id || e.url;
    const existing = id && openIds.get(id);
    if (existing) {
      if (focus) {
        await chrome.tabs.update(existing.id, { active: true }).catch(() => {});
        await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
      }
    } else if (!done.has(key)) {
      if (opened++ > 0) await sleep(REOPEN_GAP);
      await chrome.tabs.create({ url: e.url, active: focus });
    }
    done.add(key);
    // 開き直した分は履歴から外す（途中で止まっても、開いた分だけ消える）
    await removeFromLog(e);
  }
}

// ---- 手動一括処理 ----
const LOAD_TIMEOUT = 30_000;  // ページ読み込み完了を待つ上限
const PROBE_TIMEOUT = 15_000; // 読み込み後、Gofile の表示が出るのを待つ上限
const CONCURRENCY = 3;        // 同時に再読み込みするタブ数

// タブの読み込み完了を待つ。タブが消えたら null。
async function waitComplete(tabId, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === 'complete' && !t.discarded) return t;
    await sleep(500);
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

// 戻り値: 'notFound' | 'tooMany' | null
const runProbe = async (tabId) => {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: probePage });
  return res?.result ?? null;
};

// 1タブを確認する。戻り値: 'notFound' | 'exists' | 'unchecked'
async function checkTab(tab) {
  const id = contentIdFromUrl(tab.url);
  const wasSleeping = tab.discarded || tab.status === 'unloaded';
  try {
    if (wasSleeping) await chrome.tabs.reload(tab.id);
    let t = await waitComplete(tab.id, LOAD_TIMEOUT);
    if (!t || t.status !== 'complete' || contentIdFromUrl(t.url) !== id) return 'unchecked';

    // Gofile は読み込み完了後に中身を描画するので、不存在表示が出るまで少し待つ。
    // 表示が出なければ「存在する（または判断できない）」として閉じない。
    const justLoaded = wasSleeping || tab.status !== 'complete';
    const end = Date.now() + (justLoaded ? PROBE_TIMEOUT : 0);
    let found = await runProbe(tab.id);
    while (found !== 'notFound' && Date.now() < end) {
      // Too many requests なら確認できない。再読み込みは content.js に任せ、休止状態にも戻さない
      if (found === 'tooMany') return 'unchecked';
      await sleep(1000);
      t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t || contentIdFromUrl(t.url) !== id) return 'unchecked';
      // タイトルが読み込み中の "Files · Gofile" 以外になったら描画済みとみなす
      if (!/^Files\b/.test(t.title || '') && !/^Content not found\b/.test(t.title || '')) break;
      found = await runProbe(tab.id);
    }

    if (found === 'tooMany') return 'unchecked';
    if (found === 'notFound') return (await closeTab(t, 'notFound')) ? 'notFound' : 'unchecked';
    // 元々休止中で、今見ていないタブは休止状態に戻してメモリを節約する
    if (wasSleeping && !t.active) await chrome.tabs.discard(tab.id).catch(() => {});
    return 'exists';
  } catch {
    return 'unchecked';
  }
}

// 整理の進み具合。ポップアップを開き直しても表示できるよう保持する。
let scanState = null; // { done, total } | null

function reportProgress() {
  chrome.runtime.sendMessage({ type: 'progress', scan: scanState }).catch(() => {});
}

async function scanAll() {
  scanState = { done: 0, total: 0 };
  reportProgress();
  try {
    // 重複整理だけは自動の重複整理と同時に動かないよう queue に並べる。
    // 各タブの確認は時間がかかるので queue の外で行い、その間も自動処理（再試行・不存在・重複）を止めない
    const duplicates = (await enqueue(() => dedupe())) ?? 0; // enqueue は失敗時に undefined を返す
    const tabs = (await chrome.tabs.query({})).filter((t) => contentIdFromUrl(t.url) && !t.pinned);
    scanState.total = tabs.length;
    reportProgress();
    const counts = { notFound: 0, exists: 0, unchecked: 0 };
    let i = 0;
    const worker = async () => {
      while (i < tabs.length) {
        counts[await checkTab(tabs[i++])]++;
        scanState.done++;
        reportProgress();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const result = { duplicates, notFound: counts.notFound, unchecked: counts.unchecked, at: Date.now() };
    await chrome.storage.local.set({ lastScan: result });
    return result;
  } finally {
    scanState = null;
    reportProgress();
  }
}

// 今開いている Gofile タブの状況
async function getStatus() {
  const tabs = (await chrome.tabs.query({})).filter((t) => contentIdFromUrl(tabUrl(t)));
  const ids = new Set(tabs.map((t) => contentIdFromUrl(tabUrl(t))));
  return {
    total: tabs.length,
    duplicates: tabs.length - ids.size, // 閉じられる重複タブの数
    sleeping: tabs.filter((t) => t.discarded || t.status === 'unloaded').length,
    scan: scanState,
  };
}

// ---- イベント ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'notFound' && sender.tab) {
    enqueue(() => handleNotFound(sender.tab.id, msg.contentId));
    return;
  }
  if (msg?.type === 'scanAll') {
    if (scanState) { sendResponse({ busy: true }); return; }
    scanState = { done: 0, total: 0 }; // すぐに「整理中」にして二重実行を防ぐ
    scanAll().then(sendResponse, (e) => { console.warn(e); sendResponse({ error: String(e?.message || e) }); });
    return true; // 非同期で応答する
  }
  if (msg?.type === 'tooMany' && sender.tab) {
    enqueue(() => handleTooMany(sender.tab.id)).then(sendResponse);
    return true;
  }
  if (msg?.type === 'reopen') {
    if (reopening) { sendResponse({ busy: true }); return; }
    reopening = true;
    reopen(msg.entries || [], !!msg.focus)
      .catch((e) => console.warn(e))
      .finally(() => { reopening = false; sendResponse({}); });
    return true;
  }
  if (msg?.type === 'status') {
    getStatus().then(sendResponse);
    return true;
  }
});

// 期限切れ履歴の削除：1時間ごと、ブラウザ起動時、保存期間を変えた時
const PRUNE_ALARM = 'pruneLog';
const ensureAlarm = () => chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 60 });
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); enqueue(pruneLog); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); enqueue(pruneLog); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === PRUNE_ALARM) enqueue(pruneLog); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.retentionDays) enqueue(pruneLog);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const id = contentIdFromUrl(changeInfo.url);
  if (!id) return;
  enqueue(async () => {
    const { autoDedupe } = await getSettings();
    if (autoDedupe) await dedupe(id);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => enqueue(() => forgetRetry(tabId)));
