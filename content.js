// Gofile の /d/<id> ページで「不存在」表示を検出し、background に知らせる。
// 「Too many requests」ページなら、background が決めた時間だけ待って再読み込みする。
// 判定条件は common.js の probePage と同じ。
(() => {
  const isTooMany = () => /^too many requests\.?$/i.test((document.body?.innerText || '').trim());

  const isNotFound = () =>
    /^Content not found\b/.test(document.title) &&
    [...document.querySelectorAll('main h1')]
      .some((h) => h.textContent.trim() === 'This content does not exist');

  const currentId = () => {
    const m = location.pathname.match(/^\/d\/([A-Za-z0-9]+)\/?$/);
    return m ? m[1] : null;
  };

  // ---- Too many requests：時間をおいて再読み込み ----
  if (isTooMany()) {
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
    if (isNotFound()) {
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
