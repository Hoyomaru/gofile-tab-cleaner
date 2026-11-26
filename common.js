// 共通の決まりごとを 2 つにまとめて置く。
// - globalThis.gofile: Gofile の URL と画面の見分け方。Gofile の文言が変わったら、ここだけを直す
// - globalThis.tabCleaner: 設定の既定値など、background.js と popup.js で共通の値
//
// import / export を使わずに globalThis へ置くので、同じファイルを次の 3 通りで使える。
// - content script（manifest の content_scripts で content.js より先に読み込む）
// - ES module（background.js と popup.js から import './common.js'）
// - 手動整理でタブに入れる時（chrome.scripting.executeScript の files）
// 同じタブに何度入れてもエラーにならないよう、トップレベルで const / let を宣言しない。
globalThis.gofile = (() => {
  // https://gofile.io/d/<contentId> から contentId を取り出す。対象外なら null。
  // クエリ (?...) やハッシュ (#...) は無視する。contentId は大文字小文字を区別する。
  function contentIdFromUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !/^(www\.)?gofile\.io$/.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/d\/([A-Za-z0-9]+)\/?$/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  // ---- タブのタイトル ----
  // 読み込み中は "Files · Gofile"、不存在は "Content not found · Gofile"、表示後は "<フォルダ名> · Gofile"
  const isLoadingTitle = (title) => /^Files\b/.test(title || '');
  const isNotFoundTitle = (title) => /^Content not found\b/.test(title || '');

  // 履歴に表示するための名前。フォルダ名がわからないタイトル（読み込み中・不存在）なら null
  function nameFromTitle(title) {
    const t = (title || '').replace(/\s*·\s*Gofile\s*$/, '').trim();
    if (!t || /^(Content not found|Files)$/.test(t)) return null;
    return t;
  }

  // ---- 貼り付けた文や拾ったリンクから Gofile の URL を取り出す ----
  // 文中の https://gofile.io/d/<id>（#file=<ファイルID> 付きも）と、行全体が ID だけ（5 文字以上。gofile-jd2 と同じ）の行を受け付ける。
  // クエリは捨て、#file= だけ残す。同じ URL は 1 つにまとめる。
  // 戻り値: { urls, skipped }。skipped = 空行以外で URL を 1 つも読み取れなかった行の数
  const URL_RE = /https?:\/\/(?:www\.)?gofile\.io\/d\/([A-Za-z0-9]+)(?:[/?][^\s#]*)?(#file=[A-Za-z0-9-]+)?/g;
  function parseGofileList(text) {
    const urls = [];
    let skipped = 0;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const found = [];
      if (/^[A-Za-z0-9]{5,}$/.test(line)) found.push(`https://gofile.io/d/${line}`);
      else for (const m of line.matchAll(URL_RE)) found.push(`https://gofile.io/d/${m[1]}${m[2] || ''}`);
      if (!found.length) skipped++;
      for (const u of found) if (!urls.includes(u)) urls.push(u);
    }
    return { urls, skipped };
  }

  // ---- ページの判定（ページ内で実行する）----
  // 戻り値: 'notFound' | 'tooMany' | 'password' | null
  // - notFound: タイトルと見出しの両方が一致した時だけ（どちらか片方だけでは閉じない）
  // - tooMany: アクセス集中時の「Too many requests」だけが書かれたページ
  // - password: パスワードの入力を待っている（gofile-jd2 と同じ目印）
  function probe() {
    if (/^too many requests\.?$/i.test((document.body?.innerText || '').trim())) return 'tooMany';
    const h1Ok = [...document.querySelectorAll('main h1')]
      .some((h) => h.textContent.trim() === 'This content does not exist');
    if (isNotFoundTitle(document.title) && h1Ok) return 'notFound';
    return document.querySelector('form[data-fm="password"]') ? 'password' : null;
  }

  return { contentIdFromUrl, isLoadingTitle, isNotFoundTitle, nameFromTitle, parseGofileList, probe };
})();

// background.js と popup.js で共通の設定と決まりごと（Gofile とは関係ない部分）。
// 既定値や回数を変える時はここだけを直す。
globalThis.tabCleaner = (() => {
  // retentionDays: 「最近閉じたタブ」を残す日数。0 = 期限なし（件数上限のみ）
  // autoDone: gofile-jd2 で JD2 へ送った（ダウンロード済みの）コンテンツのタブを閉じる
  const DEFAULTS = { autoNotFound: true, autoDedupe: true, autoRetry: true, autoDone: true, retentionDays: 7 };
  // 「ダウンロード済み」として覚えておく contentId の上限（期限なし。超えたら古いものから消す）
  const DONE_MAX = 20_000;
  const DAY = 86_400_000;
  // Too many requests を再試行する最大回数（ポップアップの説明文もこの値から作る）
  const RETRY_MAX = 5;

  // 保存期間を過ぎた履歴を取り除く
  const withinRetention = (log, days) =>
    days > 0 ? log.filter((e) => e.at >= Date.now() - days * DAY) : log;

  return { DEFAULTS, DONE_MAX, RETRY_MAX, withinRetention };
})();
