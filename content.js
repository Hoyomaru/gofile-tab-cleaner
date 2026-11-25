// Gofile の /d/<id> ページで「不存在」表示を検出し、background に知らせる。
// 「Too many requests」ページなら、background が決めた時間だけ待って再読み込みする。
// 判定の決まりは common.js（manifest でこのファイルより先に読み込む）の globalThis.gofile にある。
(() => {
  const { contentIdFromUrl, probe } = globalThis.gofile;
  const currentId = () => contentIdFromUrl(location.href);

  // ---- Too many requests：時間をおいて再読み込み ----
  if (probe() === 'tooMany') {
    const id = currentId();
    chrome.runtime.sendMessage({ type: 'tooMany', contentId: id }).then((r) => {
      if (!r || r.off) return;
      if (r.delay == null) {
        document.title = `✕ 再試行を中止 (${r.max}回) · ${id}`;
        return;
      }
      // タイトルを変えるたびに background が起こされるので、残り秒数を毎秒書き換えずに
      // 再試行の時刻を 1 回だけ出す
      const due = new Date(Date.now() + r.delay)
        .toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      document.title = `⏳ ${due} に再試行 (${r.attempt}/${r.max}) · ${id}`;
      setTimeout(() => location.reload(), r.delay);
    }).catch(() => {});
    return;
  }

  // 普通に開けたので、このタブの再試行回数を数え直してもらう
  chrome.runtime.sendMessage({ type: 'loaded' }).catch(() => {});

  // ---- 不存在の検出 ----
  // Gofile は SPA なので、表示が書き換わるたびに少し待ってから判定する。
  // 監視はページを開いてから WATCH_LIMIT の間だけにし（判定のあとも監視し続けると、開いているタブの数だけ
  // 無駄に動く）、SPA の中で別の /d/ へ移った時に監視をやり直す。
  const WATCH_LIMIT = 60_000;
  let reportedFor = null; // 報告済みの contentId（同じ id で二重送信しない）
  let timer = null;
  let limit = null;

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(check, 300);
  });

  function check() {
    const id = currentId();
    if (!id || reportedFor === id) return;
    if (probe() === 'notFound') {
      reportedFor = id;
      chrome.runtime.sendMessage({ type: 'notFound', contentId: id }).catch(() => {});
      stop();
    }
  }

  function stop() {
    observer.disconnect();
    clearTimeout(timer);
    clearTimeout(limit);
  }

  function watch() {
    stop();
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    limit = setTimeout(stop, WATCH_LIMIT);
    check();
  }

  // pushState・戻る・進むなど、同じページの中で URL が変わった時（Navigation API、Chrome 102 以降）
  window.navigation?.addEventListener('currententrychange', watch);
  watch();
})();
