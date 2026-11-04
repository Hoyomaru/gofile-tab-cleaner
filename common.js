// https://gofile.io/d/<contentId> から contentId を取り出す。対象外なら null。
// クエリ (?...) やハッシュ (#...) は無視する。contentId は大文字小文字を区別する。
export function contentIdFromUrl(url) {
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

// ページ内で実行する判定。戻り値: 'notFound' | 'tooMany' | null
// - notFound: タイトルと見出しの両方が一致した時だけ（どちらか片方だけでは閉じない）
// - tooMany: アクセス集中時の「Too many requests」だけが書かれたページ
// content.js にも同じ判定があるので、変更する時は両方そろえること。
export function probePage() {
  if (/^too many requests\.?$/i.test((document.body?.innerText || '').trim())) return 'tooMany';
  const titleOk = /^Content not found\b/.test(document.title);
  const h1Ok = [...document.querySelectorAll('main h1')]
    .some((h) => h.textContent.trim() === 'This content does not exist');
  return titleOk && h1Ok ? 'notFound' : null;
}
