import './common.js'; // globalThis.gofile と globalThis.tabCleaner を用意する

const { contentIdFromUrl, isLoadingTitle, isNotFoundTitle, parseGofileList } = globalThis.gofile;
const { DEFAULTS, DONE_MAX, RETRY_MAX, withinRetention } = globalThis.tabCleaner;

// 一括整理で数百タブを閉じても取り消せるよう多めに残す（古いものは保存期間で消える）
const LOG_MAX = 500;

const getSettings = () => chrome.storage.sync.get(DEFAULTS);
// タブの URL は 2 通りに使い分ける。
// - tabUrl(t)（読み込み中なら行き先の pendingUrl）: 重複の整理・件数・開き直し。これから表示される
//   コンテンツで判断したいので、読み込みが終わる前から数に入れる
// - t.url（今表示しているページ）: 不存在の判定（handleNotFound・scanAll・checkTab）。
//   判定はページの中身を見るので、実際に表示されているページの URL と合わせる
const tabUrl = (t) => t.pendingUrl || t.url || '';

// 処理を1本の列に並べて、同時実行による二重クローズを防ぐ
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn, fn).catch((e) => console.warn(e)));

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

// 手動整理の間にこの拡張機能が閉じたタブと、その理由（'notFound' | 'duplicate' | 'done'）。
// 整理中のタブを自動処理（content.js からの不存在報告や自動の重複整理）が先に閉じた時に、
// checkTab が「確認できなかった」ではなく本当の理由で数えるために使う。
const closedDuringScan = new Map();

async function closeTab(tab, reason) {
  // remove の完了を待つ間に checkTab がタブの消失に気づくことがあるので、先に記録する
  const mark = scanState && !closedDuringScan.has(tab.id);
  if (mark) closedDuringScan.set(tab.id, reason);
  try {
    await chrome.tabs.remove(tab.id);
    const url = tabUrl(tab);
    await addLog({ url, contentId: contentIdFromUrl(url), title: tab.title || '', reason, at: Date.now() });
    return true;
  } catch {
    if (mark) closedDuringScan.delete(tab.id);
    return false; // 既に閉じられていた等
  }
}

// ---- 重複整理 ----
// Gofile タブを contentId ごとにまとめる。onlyIds（Set）を渡すとその contentId だけ。
function groupByContent(tabs, onlyIds = null) {
  const groups = new Map();
  for (const t of tabs) {
    const id = contentIdFromUrl(tabUrl(t));
    if (!id || (onlyIds && !onlyIds.has(id))) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(t);
  }
  return groups;
}

// 同じ contentId のタブのうち「最初に開いたタブ」(= tab.id が最小) を残す。
// ピン留めタブは閉じない。ピン留めが含まれる場合はそれを優先して残す。
// 実際の整理（dedupe）とポップアップの件数（getStatus）は、この決まりを共通で使う。
function splitDuplicates(list) {
  const sorted = [...list].sort((a, b) => (b.pinned - a.pinned) || (a.id - b.id));
  return { keep: sorted[0], dups: sorted.slice(1).filter((t) => !t.pinned) };
}

async function dedupe(onlyIds = null) {
  const groups = groupByContent(await chrome.tabs.query({}), onlyIds);
  let closed = 0;
  for (const list of groups.values()) {
    const { keep, dups } = splitDuplicates(list);
    if (!dups.length) continue;
    const activeDup = dups.find((t) => t.active);
    if (activeDup) await switchToKept(keep, activeDup);
    for (const t of dups) if (await closeTab(t, 'duplicate')) closed++;
  }
  return closed;
}

// 選ばれていた重複タブを閉じる前に、残すタブへ切り替える。
// tab.active は「そのウィンドウで選ばれている」だけなので、別のウィンドウへ移るのは
// いま見ているウィンドウ（最後にフォーカスしたウィンドウ）のタブだった時だけにする。
async function switchToKept(keep, activeDup) {
  if (keep.windowId === activeDup.windowId) {
    await chrome.tabs.update(keep.id, { active: true }).catch(() => {});
    return;
  }
  const focused = await chrome.windows.getLastFocused().catch(() => null);
  if (focused?.id !== activeDup.windowId) return; // 後ろのウィンドウ：閉じるだけ（Chrome が隣のタブを選ぶ）
  await chrome.tabs.update(keep.id, { active: true }).catch(() => {});
  await chrome.windows.update(keep.windowId, { focused: true }).catch(() => {});
}

// ---- ダウンロード済み（gofile-jd2 で JD2 へ送ったコンテンツ）----
// storage.local の done に { contentId: 送った時刻 } で覚える。期限なし、DONE_MAX を超えたら古いものから消す。
// #file= 付き（フォルダの一部のファイルだけ送った）は覚えない。フォルダ全体を済みにすると、
// 残りのファイルを取りに戻れなくなるため。
const markDone = (urls, senderTabId) => withLog(async () => {
  const ids = urls.filter((u) => !/#file=/i.test(u)).map(contentIdFromUrl).filter(Boolean);
  if (!ids.length) return;
  // 送ったタブ自身は閉じない（そのまま残りの操作を続けられるように）
  // （送ってすぐ閉じたタブは覚えない）
  if (senderTabId != null && await chrome.tabs.get(senderTabId).catch(() => null)) await allowDone(senderTabId);
  const { done = {} } = await chrome.storage.local.get('done');
  const now = Date.now();
  for (const id of ids) done[id] = now;
  let entries = Object.entries(done);
  if (entries.length > DONE_MAX) {
    entries = entries.sort((a, b) => b[1] - a[1]).slice(0, DONE_MAX);
  }
  await chrome.storage.local.set({ done: Object.fromEntries(entries) });
});

// 済みでも閉じないタブ（履歴から開き直したタブ・送ったタブ）。そのタブが開いている間だけ有効。
// service worker が止まっても残るよう storage.session にも置き、すぐ効くようメモリにも持つ
const allowedTabs = new Set();
let allowedLoaded = false;
async function loadAllowed() {
  if (allowedLoaded) return;
  const { allowDone = [] } = await chrome.storage.session.get('allowDone');
  for (const id of allowDone) allowedTabs.add(id);
  allowedLoaded = true;
}
async function allowDone(tabId) {
  await loadAllowed();
  allowedTabs.add(tabId);
  await chrome.storage.session.set({ allowDone: [...allowedTabs] });
}
async function forgetAllowed(tabId) {
  await loadAllowed();
  if (!allowedTabs.delete(tabId)) return;
  await chrome.storage.session.set({ allowDone: [...allowedTabs] });
}

// 済みのコンテンツのタブを閉じる。URL だけで判断するので、未読み込み・休止中のタブも閉じる。
// onlyIds（Set）を渡すとその contentId だけ。ピン留めは閉じない。
async function closeDone(onlyIds = null) {
  const { done = {} } = await chrome.storage.local.get('done');
  await loadAllowed();
  let closed = 0;
  for (const t of await chrome.tabs.query({})) {
    const id = contentIdFromUrl(tabUrl(t));
    if (!id || !(id in done) || (onlyIds && !onlyIds.has(id))) continue;
    if (t.pinned || allowedTabs.has(t.id)) continue;
    if (await closeTab(t, 'done')) closed++;
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
  if (attempt > RETRY_MAX) {
    // あきらめる（タブは閉じない）。ポップアップで数えてまとめて再試行できるよう、印を付けておく。
    // 回数と時刻は変えないので、RETRY_RESET が過ぎるまでは手で再読み込みしても中止のまま
    retry[tabId] = { ...prev, gaveUp: true };
    await chrome.storage.session.set({ retry });
    return { delay: null, max: RETRY_MAX };
  }
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
// 開き直しの進み具合。ポップアップを開き直しても表示でき、二重実行の判定にも使う
let reopenState = null; // { done, total } | null

function reportReopen() {
  chrome.runtime.sendMessage({ type: 'reopenProgress', reopen: reopenState }).catch(() => {});
}

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
      await allowDone(existing.id);
      if (focus) {
        await chrome.tabs.update(existing.id, { active: true }).catch(() => {});
        await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
      }
    } else if (!done.has(key)) {
      if (opened++ > 0) await sleep(REOPEN_GAP);
      const tab = await chrome.tabs.create({ url: e.url, active: focus });
      await allowDone(tab.id);
    }
    done.add(key);
    // 開き直した分は履歴から外す（途中で止まっても、開いた分だけ消える）
    await removeFromLog(e);
    reopenState.done++;
    reportReopen();
  }
}

// ---- URL をまとめて開く（ポップアップに貼った一覧・右クリックで拾ったリンク）----
// 飛ばすもの: すでに開いている（一覧の中で同じ contentId が 2 回目以降のものも含む）・履歴で不存在・済み。
// 開くのは履歴の「すべて開く」と同じ列で、同じ間隔をあけて後ろで開く。開き始める前に件数を返す。
// 戻り値: { busy: true } | { opened, skipped: { open, notFound, done }, unreadable }
async function openList(text) {
  if (reopenState) return { busy: true };
  const { urls, skipped: unreadable } = parseGofileList(text);
  const [{ log = [], done = {} }, tabs] = await Promise.all([
    chrome.storage.local.get(['log', 'done']),
    chrome.tabs.query({}),
  ]);
  if (reopenState) return { busy: true }; // 待っている間に別の開き直しが始まった
  const notFound = new Set(log.filter((e) => e.reason === 'notFound').map((e) => e.contentId || contentIdFromUrl(e.url)));
  const open = new Set(tabs.map((t) => contentIdFromUrl(tabUrl(t))).filter(Boolean));
  const skipped = { open: 0, notFound: 0, done: 0 };
  const toOpen = [];
  for (const url of urls) {
    const id = contentIdFromUrl(url);
    if (open.has(id)) skipped.open++;
    else if (notFound.has(id)) skipped.notFound++;
    else if (id in done) skipped.done++;
    else { toOpen.push(url); open.add(id); }
  }
  if (toOpen.length) {
    reopenState = { done: 0, total: toOpen.length };
    reportReopen();
    (async () => {
      for (const [i, url] of toOpen.entries()) {
        if (i > 0) await sleep(REOPEN_GAP);
        await chrome.tabs.create({ url, active: false }).catch((e) => console.warn(e));
        reopenState.done++;
        reportReopen();
      }
    })().catch((e) => console.warn(e)).finally(() => { reopenState = null; reportReopen(); });
  }
  return { opened: toOpen.length, skipped, unreadable };
}

// ---- 右クリックメニュー「Gofile のリンクをまとめて開く」----
// リンクの上ならそのリンク 1 つ。それ以外は、選択範囲があればその中のリンクと文字、なければページ全体のリンクを拾う。
// ページの中を読むのは右クリックした時だけ（activeTab）。読めないページ（chrome:// など）では選択した文字だけを使う。
const MENU_ID = 'openGofileLinks';

// ページの中で動く。選択範囲（なければページ全体）のリンク先と、選択した文字を 1 行ずつ返す
function collectLinks() {
  const sel = getSelection();
  const lines = [];
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    for (let i = 0; i < sel.rangeCount; i++) {
      for (const a of sel.getRangeAt(i).cloneContents().querySelectorAll('a[href]')) lines.push(a.href);
    }
    // 範囲の中に部分的に入ったリンク（リンクの文字の途中から選んだ時）
    for (let i = 0; i < sel.rangeCount; i++) {
      const node = sel.getRangeAt(i).commonAncestorContainer;
      const a = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('a[href]');
      if (a) lines.push(a.href);
    }
    lines.push(sel.toString());
  } else {
    for (const a of document.querySelectorAll('a[href]')) lines.push(a.href);
  }
  return lines.join('\n');
}

// 前の開き直しが終わるのを待ってから開く（右クリックには結果を返す先がないので、断らずに待つ）
async function openListWhenFree(text) {
  for (let waited = 0; reopenState && waited < 30 * 60_000; waited += 1000) await sleep(1000);
  return openList(text);
}

async function handleMenuClick(info, tab) {
  if (info.menuItemId !== MENU_ID) return;
  let text = info.linkUrl || '';
  if (!text && tab?.id != null) {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [info.frameId ?? 0] }, func: collectLinks })
      .catch(() => null);
    text = res?.[0]?.result || '';
  }
  if (!text) text = info.selectionText || '';
  if (!text) return;
  return openListWhenFree(text);
}
self.handleMenuClick = handleMenuClick; // 確認用（service worker から直接呼べるように）

chrome.contextMenus.onClicked.addListener((info, tab) => { handleMenuClick(info, tab).catch((e) => console.warn(e)); });

// ---- 再試行を中止したタブをもう一度試す（ポップアップのボタン）----
// 中止の印を消して回数を数え直し、REOPEN_GAP ずつ間隔をあけて再読み込みする。
// 読み込んだ後は、また Too many requests なら content.js が 1 回目から再試行を問い合わせる。
let retryingGaveUp = false;

async function retryGaveUp() {
  const tabIds = (await enqueue(async () => {
    const { retry = {} } = await chrome.storage.session.get('retry');
    const ids = Object.keys(retry).filter((k) => retry[k].gaveUp).map(Number);
    for (const id of ids) delete retry[id];
    await chrome.storage.session.set({ retry });
    return ids;
  })) ?? []; // enqueue は失敗時に undefined を返す
  let reloaded = 0;
  for (const id of tabIds) {
    if (reloaded++ > 0) await sleep(REOPEN_GAP);
    await chrome.tabs.reload(id).catch(() => {});
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
// 拡張機能を入れる（読み込み直す）前から開いていたタブには content script がないので、
// 毎回 common.js を入れてから判定する（content script と同じ isolated world で動く）
const runProbe = async (tabId) => {
  const target = { tabId };
  await chrome.scripting.executeScript({ target, files: ['common.js'] });
  const [res] = await chrome.scripting.executeScript({ target, func: () => globalThis.gofile.probe() });
  return res?.result ?? null;
};

// 1タブを確認する。戻り値: 'notFound' | 'duplicate' | 'done' | 'exists' | 'unchecked'
async function checkTab(tab) {
  const id = contentIdFromUrl(tab.url);
  const wasSleeping = tab.discarded || tab.status === 'unloaded';
  // 確認中にタブが消えた時の扱い。自動処理が閉じたのならその理由、それ以外は確認できなかった扱い
  const gone = () => closedDuringScan.get(tab.id) ?? 'unchecked';
  try {
    if (wasSleeping) await chrome.tabs.reload(tab.id);
    let t = await waitComplete(tab.id, LOAD_TIMEOUT);
    if (!t) return gone();
    if (t.status !== 'complete' || contentIdFromUrl(t.url) !== id) return 'unchecked';

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
      if (!t) return gone();
      if (contentIdFromUrl(t.url) !== id) return 'unchecked';
      // タイトルが読み込み中の "Files · Gofile" 以外になったら描画済みとみなす
      if (!isLoadingTitle(t.title) && !isNotFoundTitle(t.title)) break;
      found = await runProbe(tab.id);
    }

    if (found === 'tooMany') return 'unchecked';
    // 閉じられなかった時は、自動処理が先に閉じていないかを確かめる
    if (found === 'notFound') return (await closeTab(t, 'notFound')) ? 'notFound' : gone();
    // 元々休止中で、今見ていないタブは休止状態に戻してメモリを節約する
    if (wasSleeping && !t.active) await chrome.tabs.discard(tab.id).catch(() => {});
    return 'exists';
  } catch {
    // タブが消えると executeScript などが失敗する
    return gone();
  }
}

// 整理の進み具合。ポップアップを開き直しても表示できるよう保持する。
let scanState = null; // { done, total } | null

function reportProgress() {
  chrome.runtime.sendMessage({ type: 'progress', scan: scanState }).catch(() => {});
}

async function scanAll() {
  scanState = { done: 0, total: 0 };
  closedDuringScan.clear();
  reportProgress();
  try {
    // 重複整理だけは自動の重複整理と同時に動かないよう queue に並べる。
    // 各タブの確認は時間がかかるので queue の外で行い、その間も自動処理（再試行・不存在・重複）を止めない
    const duplicates = (await enqueue(() => dedupe())) ?? 0; // enqueue は失敗時に undefined を返す
    // ダウンロード済みは自動処理のスイッチに関係なく閉じる（手動の整理は全部の判定を使う）
    const doneClosed = (await enqueue(() => closeDone())) ?? 0;
    const tabs = (await chrome.tabs.query({})).filter((t) => contentIdFromUrl(t.url) && !t.pinned);
    scanState.total = tabs.length;
    reportProgress();
    // duplicate: 確認中に自動の重複整理が閉じたタブ
    const counts = { notFound: 0, duplicate: 0, done: 0, exists: 0, unchecked: 0 };
    let i = 0;
    const worker = async () => {
      while (i < tabs.length) {
        counts[await checkTab(tabs[i++])]++;
        scanState.done++;
        reportProgress();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const result = {
      duplicates: duplicates + counts.duplicate,
      notFound: counts.notFound,
      done: doneClosed + counts.done,
      unchecked: counts.unchecked,
      at: Date.now(),
    };
    await chrome.storage.local.set({ lastScan: result });
    return result;
  } finally {
    scanState = null;
    closedDuringScan.clear();
    reportProgress();
  }
}

// 今開いている Gofile タブの状況
async function getStatus() {
  const tabs = (await chrome.tabs.query({})).filter((t) => contentIdFromUrl(tabUrl(t)));
  // 閉じられる重複タブの数（ピン留めは閉じないので数えない）
  let duplicates = 0;
  for (const list of groupByContent(tabs).values()) duplicates += splitDuplicates(list).dups.length;
  const sleeping = (t) => t.discarded || t.status === 'unloaded';
  // 再試行の記録は、今も開いている Gofile タブの分だけ数える
  const { retry = {} } = await chrome.storage.session.get('retry');
  const inRetry = tabs.filter((t) => retry[t.id]);
  return {
    total: tabs.length,
    duplicates,
    sleeping: tabs.filter(sleeping).length,
    // 休止したタブは待機の時計も止まっているので、再試行待ちには数えない
    retrying: inRetry.filter((t) => !retry[t.id].gaveUp && !sleeping(t)).length,
    gaveUp: inRetry.filter((t) => retry[t.id].gaveUp).length,
    doneCount: Object.keys((await chrome.storage.local.get('done')).done || {}).length,
    scan: scanState,
    reopen: reopenState,
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
    // 整理はタブが多いと数分かかる。応答を長く待たせると service worker が止められることがあるので、
    // すぐに応答し、結果（失敗時は error）は lastScan に保存する。ポップアップは storage の変化で表示する
    scanAll().catch((e) => {
      console.warn(e);
      return chrome.storage.local.set({ lastScan: { error: String(e?.message || e), at: Date.now() } });
    }).catch((e) => console.warn(e));
    sendResponse({ started: true });
    return;
  }
  if (msg?.type === 'sent' && Array.isArray(msg.urls)) {
    markDone(msg.urls.filter((u) => typeof u === 'string'), sender.tab?.id);
    return;
  }
  if (msg?.type === 'clearDone') {
    withLog(() => chrome.storage.local.remove('done')).then(() => sendResponse({}));
    return true;
  }
  if (msg?.type === 'loaded' && sender.tab) {
    enqueue(() => forgetRetry(sender.tab.id));
    return;
  }
  if (msg?.type === 'tooMany' && sender.tab) {
    enqueue(() => handleTooMany(sender.tab.id)).then(sendResponse);
    return true;
  }
  if (msg?.type === 'reopen') {
    if (reopenState) { sendResponse({ busy: true }); return; }
    const entries = msg.entries || [];
    reopenState = { done: 0, total: entries.length };
    reportReopen();
    reopen(entries, !!msg.focus)
      .catch((e) => console.warn(e))
      .finally(() => { reopenState = null; reportReopen(); sendResponse({}); });
    return true;
  }
  if (msg?.type === 'openList') {
    openList(String(msg.text || '')).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'retryGaveUp') {
    if (retryingGaveUp) { sendResponse({ busy: true }); return; }
    retryingGaveUp = true;
    retryGaveUp()
      .catch((e) => console.warn(e))
      .finally(() => { retryingGaveUp = false; sendResponse({}); });
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
chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  enqueue(pruneLog);
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Gofile のリンクをまとめて開く',
    contexts: ['page', 'selection', 'link'],
  }, () => void chrome.runtime.lastError); // 更新時に既にある時のエラーは無視
});
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); enqueue(pruneLog); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === PRUNE_ALARM) enqueue(pruneLog); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.retentionDays) enqueue(pruneLog);
});

// 自動の重複整理。ブラウザ起動時の復元などで URL の変化が一度にたくさん届くので、
// DEDUPE_DELAY の間に届いた contentId をまとめて、全タブの取得を 1 回で済ませる
const DEDUPE_DELAY = 200;
const pendingDedupe = new Set();
let dedupeTimer = null;

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const id = contentIdFromUrl(changeInfo.url);
  if (!id) return;
  pendingDedupe.add(id);
  clearTimeout(dedupeTimer);
  dedupeTimer = setTimeout(() => {
    const ids = new Set(pendingDedupe);
    pendingDedupe.clear();
    enqueue(async () => {
      const { autoDedupe, autoDone } = await getSettings();
      if (autoDedupe) await dedupe(ids);
      if (autoDone) await closeDone(ids);
    });
  }, DEDUPE_DELAY);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(() => forgetRetry(tabId));
  enqueue(() => forgetAllowed(tabId));
});
