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

// ページ内で実行する「不存在」判定。
// タイトルと見出しの両方が一致した時だけ true を返す（どちらか片方だけでは閉じない）。
// content.js にも同じ判定があるので、変更する時は両方そろえること。
export function probeNotFound() {
  const titleOk = /^Content not found\b/.test(document.title);
  const h1Ok = [...document.querySelectorAll('main h1')]
    .some((h) => h.textContent.trim() === 'This content does not exist');
  return titleOk && h1Ok;
}
