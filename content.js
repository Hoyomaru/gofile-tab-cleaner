// Gofile の /d/<id> ページで「不存在」表示を検出し、background に知らせる。
// 判定条件は common.js の probeNotFound と同じ。
(() => {
  const isNotFound = () =>
    /^Content not found\b/.test(document.title) &&
    [...document.querySelectorAll('main h1')]
      .some((h) => h.textContent.trim() === 'This content does not exist');

  const currentId = () => {
    const m = location.pathname.match(/^\/d\/([A-Za-z0-9]+)\/?$/);
    return m ? m[1] : null;
  };

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
