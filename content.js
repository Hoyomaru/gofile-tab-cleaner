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
      const due = Date.now() + r.delay;
      const showTitle = () => {
        const s = Math.max(0, Math.ceil((due - Date.now()) / 1000));
        document.title = `⏳ ${s}秒後に再試行 (${r.attempt}/${r.max}) · ${id}`;
      };
      showTitle();
      setInterval(showTitle, 1000);
      setTimeout(() => location.reload(), r.delay);
    }).catch(() => {});
    return;
  }

  // 普通に開けたので、このタブの再試行回数を数え直してもらう
  chrome.runtime.sendMessage({ type: 'loaded' }).catch(() => {});

  // ---- 不存在の検出 ----
  let reportedFor = null; // 報告済みの contentId（同じ id で二重送信しない）
  let timer = null;

  function check() {
    const id = currentId();
    if (!id || reportedFor === id) return;
    if (probe() === 'notFound') {
      reportedFor = id;
      chrome.runtime.sendMessage({ type: 'notFound', contentId: id }).catch(() => {});
    }
  }

  // Gofile は SPA なので、表示が書き換わるたびに少し待ってから判定する
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(check, 300);
  };

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  check();
})();
