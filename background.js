import { contentIdFromUrl, probeNotFound } from './common.js';

const DEFAULTS = { autoNotFound: true, autoDedupe: true };
const LOG_MAX = 50;

const getSettings = () => chrome.storage.sync.get(DEFAULTS);
const tabUrl = (t) => t.pendingUrl || t.url || '';

// 処理を1本の列に並べて、同時実行による二重クローズを防ぐ
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn, fn).catch((e) => console.warn(e)));

async function addLog(entry) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift(entry);
  await chrome.storage.local.set({ log: log.slice(0, LOG_MAX) });
}

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

// ---- 手動一括処理 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const runProbe = async (tabId) => {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: probeNotFound });
  return res?.result === true;
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
    while (!found && Date.now() < end) {
      await sleep(1000);
      t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t || contentIdFromUrl(t.url) !== id) return 'unchecked';
      // タイトルが読み込み中の "Files · Gofile" 以外になったら描画済みとみなす
      if (!/^Files\b/.test(t.title || '') && !/^Content not found\b/.test(t.title || '')) break;
      found = await runProbe(tab.id);
    }

    if (found) return (await closeTab(t, 'notFound')) ? 'notFound' : 'unchecked';
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
    const duplicates = await dedupe();
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
    scanState = { done: 0, total: 0 }; // 待ち行列に入った時点で「整理中」にする
    enqueue(scanAll).then(sendResponse);
    return true; // 非同期で応答する
  }
  if (msg?.type === 'status') {
    getStatus().then(sendResponse);
    return true;
  }
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
