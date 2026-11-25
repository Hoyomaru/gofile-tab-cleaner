# 改善点の調査結果

## 1. 概要

**プロジェクトの把握内容**

- Gofile の `/d/<contentId>` タブを整理する Chrome 拡張機能（Manifest V3）。外部パッケージはなく、素の JavaScript・HTML・CSS で約 1,100 行
- `background.js`（324 行、service worker、ES module）：自動の重複整理、不存在タブを閉じる処理、Too many requests の再試行スケジュール、手動の一括整理、履歴の管理
- `content.js`（66 行）：Gofile ページ内で「不存在」と「Too many requests」を見つけて background に知らせる。再試行の待機と再読み込みもここで行う
- `common.js`（25 行）：`contentIdFromUrl` と `probePage`（手動整理で `executeScript` に渡す判定関数）。`popup.html/js/css` はポップアップ UI
- `tools/` には PowerShell のアイコン生成スクリプトとリリース ZIP 作成スクリプトがある（指示どおり実行していない）

**調査範囲**：`manifest.json`、`background.js`、`content.js`、`common.js`、`popup.html`、`popup.js`、`popup.css`、`README.md`、`.gitignore`、`.gitattributes`、`tools/*.ps1`（読んだだけ）。画像（`icons/`、`docs/popup.jpg`）は対象外。

**実行したコマンド**（すべて読み取り専用）：`ls -la`、`cat` / `cat -n`（各ファイルの表示）、`wc -l`、`grep -n`（行番号の確認）。git の履歴を見る操作は、指示に従ってしていない。拡張機能は実行していないので、確認レベルは最も高くても「コード確認」。

## 2. 一覧表

| ID | 観点 | 概要（1行） | 該当箇所 | 効果 | 作業量 | 確認レベル |
| --- | --- | --- | --- | --- | --- | --- |
| A-1 | バグ | 手動整理で閉じた不存在タブが「確認できなかった」と数えられる | background.js `checkTab` / content.js `check` | 高 | 小 | コード確認 |
| A-2 | バグ | 長い手動整理で応答待ちが長引き、service worker が止まるおそれ | background.js `onMessage`(scanAll) / popup.js scan | 中 | 小 | 推測 |
| A-3 | バグ | 別ウィンドウで表示中だった重複を閉じると、関係のないウィンドウが前面に出る | background.js `dedupe` | 低 | 小 | コード確認 |
| A-4 | バグ | ポップアップの「重複」の数に、閉じないピン留めタブも入る | background.js `getStatus` | 低 | 小 | コード確認 |
| B-1 | 設計 | Gofile の判定ロジックと文言が 4 ファイルに重複している | common.js / content.js / background.js / popup.js | 中 | 中 | コード確認 |
| B-2 | 設計 | 既定値・定数・保存期間の判定が popup と background に重複 | popup.js / background.js / popup.html | 低 | 小 | コード確認 |
| B-3 | 設計 | タブ URL の取り方が `tabUrl()` と `t.url` で混在している | background.js 各所 | 低 | 小 | コード確認 |
| C-1 | 性能 | URL が変わるたびに全タブを取得するので、起動直後の復元が O(N²) になる | background.js `onUpdated` / `dedupe` | 低 | 小 | 推測 |
| C-2 | 性能 | content.js の MutationObserver が判定を終えた後も動き続ける | content.js | 低 | 小 | コード確認 |
| C-3 | 性能 | 再試行を待っているタブが毎秒タイトルを書き換え、service worker を起こし続ける | content.js tooMany 部 | 低 | 小 | 推測 |
| D-1 | UI/UX | 再試行を中止したタブがタブのタイトルでしかわからない | content.js / popup | 中 | 中 | コード確認 |
| D-2 | UI/UX | 履歴の上限 50 件が想定規模より少なく、取り消し候補が知らないうちに消える | background.js `LOG_MAX` / `addLog` | 中 | 小 | コード確認 |
| D-3 | UI/UX | 開き直している間は ↻ や「すべて開く」を押しても何も起きない | popup.js `reopen` / background.js | 低 | 小 | コード確認 |
| D-4 | UI/UX | トグルスイッチに `role="switch"` がない | popup.html | 低 | 小 | コード確認 |
| E-1 | ドキュメント | README「安全のための決まり」が実際の動作と食い違う | README.md | 低 | 小 | コード確認 |
| F-1 | 依存・環境 | `tabs` 権限は host_permissions で代わりが効くので不要の可能性 | manifest.json | 低 | 小 | コード確認 |
| F-2 | 依存・環境 | `minimum_chrome_version` の指定と、lint・整形の設定がない | manifest.json / リポジトリ直下 | 低 | 小 | コード確認 |

## 3. 詳細

### A. バグ・不具合

#### A-1 手動整理で閉じた不存在タブが「確認できなかった」と数えられる

- **内容**：手動整理では、未読み込み・休止中のタブを再読み込みして確認する。再読み込みしたタブでは `content.js` も動くので、自動の不存在クローズ（初期設定でオン）が先にタブを閉じることが多い。そうなると `checkTab` は次の `chrome.tabs.get` か `executeScript` で失敗し、`'unchecked'` を返す。結果として、実際は閉じた不存在タブが「確認できなかった ○ 件はそのままです」と表示され、「不存在 ○ 件を閉じました」はほぼ 0 件になる。読み込み済みの不存在タブは自動処理で先に閉じられているので、手動整理が不存在を見つけるのは休止中のタブの分だけで、まさにそこでこの競合が起きる。
- **該当箇所**：`background.js` `checkTab`（188–220 行、特に 205–206・217–218 行）、`handleNotFound`（83–90 行）。`content.js` `check`（45–52 行）
- **根拠コード**：
  ```js
  // background.js checkTab
  while (found !== 'notFound' && Date.now() < end) {
    ...
    await sleep(1000);
    t = await chrome.tabs.get(tab.id).catch(() => null);
    if (!t || contentIdFromUrl(t.url) !== id) return 'unchecked';   // 自動クローズで消えた → unchecked
    ...
    found = await runProbe(tab.id);   // タブが消えていれば例外 → catch で 'unchecked'
  }
  ```
  ```js
  // content.js check（再読み込みされたタブでも動く。300ms 待ってから判定）
  if (isNotFound()) {
    reportedFor = id;
    chrome.runtime.sendMessage({ type: 'notFound', contentId: id }).catch(() => {});
  }
  ```
- **修正案**：`closeTab` が成功したら `recentlyClosed`（`Map<tabId, reason>`）に記録しておく。`checkTab` でタブが消えていたら、記録に `'notFound'` があればそれを `'notFound'` として数える。別の案として、整理中のタブ ID の Set を持ち、`handleNotFound` はその中のタブを無視して `checkTab` に任せる方法もある。
- **効果の理由**：手動整理の結果文は、整理がうまくいったかを判断できる唯一の手がかり。いまは正しく動いていても「確認できなかった」と出るので、失敗と区別できない。
- **修正後の確認方法**：存在しない ID の Gofile タブをいくつか開いてから休止状態にする（`chrome://discards` の Urgent Discard）。「今すぐ全タブを整理」を押し、結果が「不存在 N 件を閉じました」になり、unchecked に数えられていないことを確かめる。
- **依存関係**：A-2 と同じ `scanAll` 周りを直すので、まとめて作業すると楽。

#### A-2 長い手動整理で応答待ちが長引き、service worker が止まるおそれ

- **内容**：`scanAll` が終わるまで `sendResponse` を返さず、メッセージの応答待ちが整理の間ずっと続く。休止中のタブが数百あると、1 タブ最大約 45 秒・同時 3 タブなので、5 分を超えることがある。Chrome は「1 つのイベントや API 呼び出しの処理に 5 分以上かかった」service worker を止めることがある。止まると整理が途中で終わり、ポップアップには「応答がありません」と出る。応答待ちがこの 5 分制限に数えられるかは確かめていない。
- **該当箇所**：`background.js` `onMessage` の `scanAll` 分岐（276–281 行）、`popup.js` の `#scan` クリック処理（223–232 行）
- **根拠コード**：
  ```js
  if (msg?.type === 'scanAll') {
    if (scanState) { sendResponse({ busy: true }); return; }
    scanState = { done: 0, total: 0 };
    scanAll().then(sendResponse, (e) => { ... sendResponse({ error: ... }); });
    return true; // 非同期で応答する
  }
  ```
- **修正案**：`{ started: true }` をすぐに返し、結果は今ある `lastScan` の保存（ポップアップは `storage.onChanged` で表示を更新済み）と `progress` メッセージで伝える。エラーは `lastScan` に `error` を入れて伝える。
- **効果の理由**：想定規模（数百タブ）で手動整理が途中で止まると、どこまで処理したかわからなくなる。直すのは数行で済む。
- **修正後の確認方法**：ポップアップで整理を始めてすぐ閉じ、開き直しても進捗と最終結果が出ることを確かめる。`chrome://serviceworker-internals` で整理中に worker が止まっていないことも見る。
- **依存関係**：A-1 と同じ箇所。

#### A-3 別ウィンドウで表示中だった重複を閉じると、関係のないウィンドウが前面に出る

- **内容**：`t.active` は「そのウィンドウで選ばれているタブ」という意味で、いま見ているタブとは限らない。後ろにあるウィンドウ W2 で選ばれている重複を閉じるとき、残すタブがあるウィンドウ W1 のタブも切り替わり、W1 にフォーカスが移る。起動直後のセッション復元など、複数ウィンドウで一度に重複が整理されると、ウィンドウやタブが勝手に切り替わる。
- **該当箇所**：`background.js` `dedupe`（69–76 行）
- **根拠コード**：
  ```js
  const activeDup = dups.find((t) => t.active);
  if (activeDup) {
    await chrome.tabs.update(keep.id, { active: true }).catch(() => {});
    if (keep.windowId !== activeDup.windowId) {
      await chrome.windows.update(keep.windowId, { focused: true }).catch(() => {});
    }
  }
  ```
- **修正案**：`chrome.windows.getLastFocused()` で前面のウィンドウを取り、`activeDup.windowId` がそれと同じときだけ切り替えとフォーカス移動をする。それ以外は閉じるだけにする（W2 では Chrome が隣のタブを選ぶ）。
- **効果の理由**：ふだんの使い方ではまれだが、起きると操作中の画面が勝手に変わる。
- **修正後の確認方法**：W1 に `/d/X`、W2 に `/d/X` を新しく開いて W2 で選んだ状態にし、W1 を前面に戻してから W2 のタブを再読み込みする。W1 の表示が変わらないことを確かめる。

#### A-4 ポップアップの「重複」の数に、閉じないピン留めタブも入る

- **内容**：`getStatus` は「Gofile タブの数 − contentId の種類の数」で重複を数える。ピン留めタブは閉じないので、ピン留めの重複があると「重複 1」が残り続け、整理しても数が減らない。
- **該当箇所**：`background.js` `getStatus`（259–268 行）
- **根拠コード**：
  ```js
  const ids = new Set(tabs.map((t) => contentIdFromUrl(tabUrl(t))));
  return {
    total: tabs.length,
    duplicates: tabs.length - ids.size, // 閉じられる重複タブの数
  ```
- **修正案**：`dedupe` と同じ決まりで数える。contentId ごとにまとめ、「残すタブ以外で、ピン留めでないタブ」の数を合計する。グループ分けを関数にして `dedupe` と共通にするとよい。
- **効果の理由**：数字の注意色（`warn`）が消えないので、整理が効いていないように見える。
- **修正後の確認方法**：同じ ID のタブを 2 つピン留めし、ポップアップの「重複」が 0 になることを確かめる。

### B. 設計・可読性

#### B-1 Gofile の判定ロジックと文言が 4 ファイルに重複している

- **内容**：不存在と Too many requests の判定が `common.js` の `probePage` と `content.js` に二重に書かれていて、README でも「両方そろえて直す」ように求めている。さらに Gofile の文言（`Content not found`、`Files`）と contentId の正規表現が、`background.js` の `checkTab`、`popup.js` の `displayName`、`content.js` の `currentId` にも散らばっている。Gofile の画面が変わったときに直し漏れが出やすい。
- **該当箇所**：`common.js` `contentIdFromUrl`・`probePage`（3–25 行）、`content.js` `isTooMany`・`isNotFound`・`currentId`（5–15 行）、`background.js` `checkTab`（208 行）、`popup.js` `displayName`（74–78 行）
- **根拠コード**：
  ```js
  // common.js
  if (/^too many requests\.?$/i.test((document.body?.innerText || '').trim())) return 'tooMany';
  const titleOk = /^Content not found\b/.test(document.title);
  // content.js（同じ内容）
  const isTooMany = () => /^too many requests\.?$/i.test((document.body?.innerText || '').trim());
  const isNotFound = () => /^Content not found\b/.test(document.title) && ...
  // background.js checkTab
  if (!/^Files\b/.test(t.title || '') && !/^Content not found\b/.test(t.title || '')) break;
  ```
- **修正案**：判定をクラシックスクリプト `probe.js`（`globalThis.gtcProbe = () => ...` と文言の定数）にまとめる。manifest の `content_scripts.js` を `["probe.js", "content.js"]` にし、`content.js` は `gtcProbe()` を使う。手動整理は `executeScript({ files: ['probe.js'] })` の後に `func: () => gtcProbe()` を実行する（同じ isolated world で動く）。タイトルの文言の正規表現も `probe.js` の定数を使う形にそろえる。
- **効果の理由**：この拡張機能でいちばん壊れやすいのは Gofile 側の文言変更で、そのときに直す場所が 1 か所になる。
- **修正後の確認方法**：存在しない ID のタブが自動で閉じること、休止中の存在しない ID のタブが手動整理で閉じることの 2 つを確かめる。
- **依存関係**：manifest の変更が必要。A-1 の後に作業すると、手動整理の確認をまとめて行える。

#### B-2 既定値・定数・保存期間の判定が popup と background に重複

- **内容**：`DEFAULTS`、`DAY`、保存期間の絞り込み（`e.at >= Date.now() - days * DAY`）が両方のファイルにある。再試行の最大回数 5 も、`RETRY_MAX` とは別に popup.html と README に直接書かれている。
- **該当箇所**：`background.js` 4・6・16–17 行、`popup.js` 3・5・18–20 行、`popup.html` 54 行（「最大5回まで」）
- **根拠コード**：
  ```js
  // background.js
  const DEFAULTS = { autoNotFound: true, autoDedupe: true, autoRetry: true, retentionDays: 7 };
  const withinRetention = (log, days) => days > 0 ? log.filter((e) => e.at >= Date.now() - days * DAY) : log;
  // popup.js
  const DEFAULTS = { autoNotFound: true, autoDedupe: true, autoRetry: true, retentionDays: 7 };
  log = retentionDays > 0 ? entries.filter((e) => e.at >= Date.now() - retentionDays * DAY) : entries;
  ```
- **修正案**：`DEFAULTS`、`DAY`、`withinRetention`、`RETRY_MAX` を `common.js` から export する（popup.js はもう `common.js` を import している）。popup.html の「最大5回」は、popup.js で `RETRY_MAX` から書き込む。
- **効果の理由**：既定値を変えるときに片方だけ直すと、表示と動作がずれる。
- **修正後の確認方法**：設定を消した状態（拡張機能を入れ直す）でポップアップを開き、スイッチと保存期間が既定値のとおりに表示されることを確かめる。

#### B-3 タブ URL の取り方が `tabUrl()` と `t.url` で混在している

- **内容**：`dedupe`・`getStatus`・`reopen` は `tabUrl(t)`（`pendingUrl` が優先）を使うが、`scanAll`・`checkTab`・`handleNotFound` は `t.url` を使う。読み込み中のタブが処理によって数に入ったり入らなかったりし、読む人は違いに意味があるのか判断しにくい。
- **該当箇所**：`background.js` 9 行（`tabUrl`）、236 行（`scanAll` の filter）、189 行（`checkTab`）、88 行（`handleNotFound`）
- **根拠コード**：
  ```js
  const tabUrl = (t) => t.pendingUrl || t.url || '';
  ...
  const tabs = (await chrome.tabs.query({})).filter((t) => contentIdFromUrl(t.url) && !t.pinned);
  ```
- **修正案**：「読み込み済みの URL で判断したい」箇所（不存在の判定）は `t.url`、「これから表示される URL で判断したい」箇所（重複、件数）は `tabUrl` と決めて、それぞれに理由を 1 行のコメントで書く。理由がなければどちらかにそろえる。
- **効果の理由**：保守のときに迷う原因を減らす。動作上の問題は小さい。
- **修正後の確認方法**：直した後に、重複の自動整理と手動整理がこれまでどおり動くことを確かめる。

### C. パフォーマンス

#### C-1 URL が変わるたびに全タブを取得するので、起動直後の復元が O(N²) になる

- **内容**：Gofile タブの URL が変わるたびに、`storage.sync.get` と `chrome.tabs.query({})`（全タブ）が動く。ブラウザ起動時に数百タブが復元されると、全タブの取得がタブ数ぶん繰り返される。これらは `queue` に 1 本で並ぶので、同じ列にある Too many requests への応答（`handleTooMany`）もその分だけ遅れる。
- **該当箇所**：`background.js` `onUpdated`（314–322 行）、`dedupe`（53–62 行）
- **根拠コード**：
  ```js
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url) return;
    const id = contentIdFromUrl(changeInfo.url);
    if (!id) return;
    enqueue(async () => {
      const { autoDedupe } = await getSettings();
      if (autoDedupe) await dedupe(id);   // 毎回 chrome.tabs.query({})
    });
  });
  ```
- **修正案**：変わった ID を `Set` に集め、200ms ほどまとめてから 1 回の `tabs.query` で整理する。`tabs.query({ url: ['https://gofile.io/d/*', 'https://www.gofile.io/d/*'] })` で Gofile タブだけを取ることもできる。ただし `pendingUrl` だけのタブは拾えないので、使う場合は注意する。
- **効果の理由**：数百タブでも 1 回の取得は数 ms なので、体感できる差は小さいと考えられる（計測はしていない）。数千タブを開くなら（将来）効いてくる。
- **修正後の確認方法**：数十の Gofile タブがあるウィンドウを閉じてから「最近閉じたウィンドウ」で開き直し、重複がこれまでどおり整理されることを確かめる。

#### C-2 content.js の MutationObserver が判定を終えた後も動き続ける

- **内容**：存在するコンテンツだと分かった後も、ページ全体（subtree・characterData）の監視が残る。DOM が変わるたびに 300ms 後の `check()` が予約される。数百タブを開いていると、それぞれのタブで監視が続く。
- **該当箇所**：`content.js` `schedule`・`MutationObserver`（55–65 行）
- **根拠コード**：
  ```js
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
  });
  ```
- **修正案**：タイトルがフォルダ名になる（`Files` でも `Content not found` でもない）か、一定時間（例：30 秒）経ったら `disconnect()` する。SPA の中で別の `/d/` に移ったときは、`navigation.addEventListener('navigate', ...)`（Chrome 102 以降）か `popstate` で監視を再開する。
- **効果の理由**：1 回の判定は軽いので、目に見える差はおそらく小さい。開いているタブが多いほど、少しずつ CPU を節約できる。
- **修正後の確認方法**：存在するフォルダの中で別のフォルダに移り、移った先が存在しない ID なら閉じることを確かめる。
- **依存関係**：B-1 で `content.js` を作り直すなら、そのときに一緒に入れる。

#### C-3 再試行を待っているタブが毎秒タイトルを書き換え、service worker を起こし続ける

- **内容**：再試行を待っている間、`document.title` を 1 秒ごとに書き換える。タイトルが変わると `tabs.onUpdated` が background に届くので、待っているタブが 1 つでもあると、service worker が休まずに毎秒起こされる（listener はすぐ return する）。
- **該当箇所**：`content.js` tooMany 部（26–33 行）、`background.js` `onUpdated`（314 行）
- **根拠コード**：
  ```js
  showTitle();
  setInterval(showTitle, 1000);
  ```
- **修正案**：残り秒数ではなく再試行の時刻（例：`⏳ 12:34:56 に再試行 (2/5)`）を 1 回だけ表示する。または、更新を 5〜10 秒ごとにする。
- **効果の理由**：負荷はわずか。待っているタブが数十あるときに、無駄に起こされる回数が減る程度。
- **修正後の確認方法**：Too many requests のページで、タイトルに再試行の時刻が表示され、その時刻に再読み込みされることを確かめる。

### D. 使い勝手（UI/UX）

※ このセクションはすべて、実際に操作せずコードから判断した。

#### D-1 再試行を中止したタブがタブのタイトルでしかわからない

- **内容**：5 回再試行しても開けなかったタブは、タイトルが `✕ 再試行を中止 (5回) · <id>` になるだけで、ポップアップには何も出ない。数百タブの中から見つけるにはタブを 1 つずつ見るしかない。もう一度試す方法も手動の再読み込みしかなく、10 分以内に再読み込みすると、試さずにすぐ「中止」に戻る（`RETRY_RESET`）。
- **該当箇所**：`content.js` 21–24 行、`background.js` `handleTooMany`（103–116 行）、`popup.html` の stats（13–17 行）
- **根拠コード**：
  ```js
  if (r.delay == null) {
    document.title = `✕ 再試行を中止 (${r.max}回) · ${id}`;
    return;
  }
  ```
  ```js
  const attempt = prev && now - prev.at < RETRY_RESET ? prev.attempt + 1 : 1;
  if (attempt > RETRY_MAX) return { delay: null, max: RETRY_MAX };
  ```
- **修正案**：`storage.session` の `retry` から「再試行待ち」と「中止」の数を `getStatus` で返し、stats に 4 つ目の数として表示する。中止がある時だけ「中止したタブを再試行」ボタンを出し、そのタブの `retry` を消して、間隔をあけて（`REOPEN_GAP`）再読み込みする。
- **効果の理由**：Too many requests は想定規模でいちばん起きやすい状態で、開けずに残ったタブを見落とすと整理が終わらない。
- **修正後の確認方法**：`RETRY_MAX` を一時的に 1 にし、Too many requests になったタブがポップアップで「中止 1」と数えられ、ボタンで再試行されることを確かめる。

#### D-2 履歴の上限 50 件が想定規模より少なく、取り消し候補が知らないうちに消える

- **内容**：「最近閉じたタブ」は誤って閉じたときに取り消すためのもの。数百タブを一括整理して 50 件を超えて閉じると、古い分はお知らせもなく履歴から消え、開き直せない。重複を閉じた分も同じ contentId で何件も入るので、枠がさらに早く埋まる。
- **該当箇所**：`background.js` `LOG_MAX`（5 行）、`addLog`（27–31 行）
- **根拠コード**：
  ```js
  const LOG_MAX = 50;
  ...
  await chrome.storage.local.set({ log: withinRetention(log, retentionDays).slice(0, LOG_MAX) });
  ```
- **修正案**：`LOG_MAX` を 500 程度に上げる（`storage.local` は 10MB まで使えるので十分）。保存期間による削除は今のままでよい。一覧が長くなる分は、ポップアップの `ul` がすでにスクロールするので対応できる。必要なら、重複で閉じた分を contentId ごとに 1 件にまとめる。README の「50件まで」も合わせて直す。
- **効果の理由**：作業量は数分で、一括整理の取り消しがきちんとできるようになる。
- **修正後の確認方法**：60 件以上閉じた後も、最初に閉じたものが履歴に残っていることを確かめる。

#### D-3 開き直している間は ↻ や「すべて開く」を押しても何も起きない

- **内容**：「すべて開く」は 1.5 秒間隔で開くので、50 件なら 1 分以上かかる。その間に ↻ や「すべて開く」を押すと、background は `{ busy: true }` を返すが、ポップアップは応答を見ていないので何も表示されない。ボタンも押せる状態のまま。
- **該当箇所**：`popup.js` `reopen`（138–139 行）と 234 行、`background.js` `onMessage` の reopen 分岐（290–297 行）
- **根拠コード**：
  ```js
  const reopen = (entries, focus) =>
    chrome.runtime.sendMessage({ type: 'reopen', entries, focus }).catch(() => {});
  ```
- **修正案**：開き直している間は「すべて開く」を押せなくし、文字を「開いています… n / m」にする（`progress` と同じように background から進み具合を送る）。`busy` が返ったら、結果の欄に「開き直しが終わってからもう一度押してください」と出す。
- **効果の理由**：押しても反応しないと、故障したように見える。
- **修正後の確認方法**：履歴が 10 件以上ある状態で「すべて開く」を押し、すぐに ↻ を押して、案内が出ることを確かめる。

#### D-4 トグルスイッチに `role="switch"` がない

- **内容**：見た目はトグルスイッチだが、スクリーンリーダーには「チェックボックス」と読まれる。label で囲んであり、キーボード操作とフォーカスの表示は問題ない。それ以外のアクセシビリティ（ボタンの `aria-label`、`aria-pressed`、`role="progressbar"`、`prefers-reduced-motion`、色だけに頼らない表示）は確認した範囲で問題なかった。
- **該当箇所**：`popup.html` 42・49・56 行
- **根拠コード**：
  ```html
  <input type="checkbox" class="switch" id="autoNotFound">
  ```
- **修正案**：3 つの `input` に `role="switch"` を付ける。
- **効果の理由**：自分ひとりで使う分には影響は小さい。手間がほとんどかからないので挙げた。
- **修正後の確認方法**：DevTools の Accessibility パネルで、role が switch になっていることを確かめる。

### E. ドキュメント

#### E-1 README「安全のための決まり」が実際の動作と食い違う

- **内容**：README には「未読み込み・休止中のタブは、自動処理では触りません」とある。しかし自動の重複整理は、休止中のタブでも重複なら閉じる（`dedupe` は休止中かどうかを見ていない）。また、手動整理は「不存在タブを閉じる」スイッチがオフでも不存在タブを閉じるが、README にもポップアップにも書かれていない。それ以外のセットアップ手順（Releases の ZIP を展開してフォルダを読み込む）は、`make-release.ps1` が作る ZIP の構成（`gofile-tab-cleaner/` フォルダ）と合っている。待ち時間・件数・権限の説明もコードと合っている。
- **該当箇所**：`README.md` 65–72 行、`background.js` `dedupe`（53–80 行）、`checkTab`（213 行）
- **根拠コード**：
  ```md
  - 未読み込み・休止中のタブは、自動処理では触りません。手動整理の時だけ再読み込みして確認します
  ```
  ```js
  // dedupe：discarded / unloaded を除外していない
  for (const t of all) {
    const id = contentIdFromUrl(tabUrl(t));
    if (!id || (onlyId && id !== onlyId)) continue;
  ```
- **修正案**：「不存在の判定では、未読み込み・休止中のタブを再読み込みしない（重複の整理は休止中のタブも対象）」と書き分ける。「手動整理は自動処理のスイッチに関係なく、重複と不存在を閉じます」を「使い方」に足す。
- **効果の理由**：あとで読み返したときに、仕様なのか不具合なのかで迷わずに済む。
- **修正後の確認方法**：README を読み、各項目がコードの動作と合っているかを照らし合わせる。
- **依存関係**：F-1 で権限を変えた場合は「必要な権限」の表も直す。D-2 で上限を変えた場合は「50件まで」も直す。

### F. 依存関係・開発環境

#### F-1 `tabs` 権限は host_permissions で代わりが効くので不要の可能性

- **内容**：この拡張機能が URL やタイトルを読むのは Gofile のタブだけ。Chrome では、`host_permissions` に当てはまるタブなら `tabs` 権限がなくても `url`・`pendingUrl`・`title` を読める。`tabs.onUpdated` の `changeInfo.url` も同じように受け取れる。`tabs.remove`・`update`・`create`・`reload`・`discard`・`query` 自体には、そもそも `tabs` 権限はいらない。`tabs` 権限があるとインストール時に「閲覧履歴の読み取り」の警告が出る。その他の権限（`storage`・`scripting`・`alarms`）は使われていて必要。Manifest V3 で非推奨・廃止予定の API（`chrome.extension.*`、`webRequestBlocking`、`tabs.executeScript` など）は使っていない。
- **該当箇所**：`manifest.json` 6 行
- **根拠コード**：
  ```json
  "permissions": ["tabs", "storage", "scripting", "alarms"],
  "host_permissions": ["https://gofile.io/*", "https://www.gofile.io/*"],
  ```
- **修正案**：`"tabs"` を外し、README の権限の表から `tabs` の行を消す（タブの URL を読む用途は「gofile.io へのアクセス」に含める）。
- **効果の理由**：権限が最小限になる。自分用なので実際に得られるものは小さい。
- **修正後の確認方法**：外した後に、自動の重複整理、不存在の自動クローズ、手動整理、ポップアップの件数、履歴からの開き直しがすべて動くことを確かめる（権限が足りないと、URL が `undefined` になって何も起きなくなる）。
- **依存関係**：E-1（README の権限の表）。

#### F-2 `minimum_chrome_version` の指定と、lint・整形の設定がない

- **内容**：`chrome.storage.session`（Chrome 102 以降）や Promise を返す拡張 API を使っているが、`minimum_chrome_version` がない。lint・formatter・`.editorconfig` もない。`.gitignore`（`dist/`・`*.zip`・`*.pem`・`.claude/` など）と `.gitattributes`（LF にそろえる、画像は binary）は適切で、余計なファイルもコミットされていない。
- **該当箇所**：`manifest.json`（キーがない）、リポジトリ直下
- **根拠コード**：
  ```js
  const { retry = {}, nextSlot = 0 } = await chrome.storage.session.get(['retry', 'nextSlot']);
  ```
- **修正案**：`"minimum_chrome_version": "102"` を足す。外部パッケージを入れない方針を守るなら、`.editorconfig`（インデント 2・LF・UTF-8）だけを入れる。型のチェックがほしければ、各ファイルの先頭に `// @ts-check` を書いて VS Code で確かめる（パッケージは不要）。
- **効果の理由**：ひとりで使う小さなリポジトリなので、効果は小さい。古い Chromium 系ブラウザで読み込んだときに、原因のわかりにくいエラーになるのを防げる程度。
- **修正後の確認方法**：`chrome://extensions` で読み込み直し、エラーが出ないことを確かめる。

## 4. おすすめの着手順（5件）

1. **A-1**：効果「高」の唯一の項目で作業量も小さい。手動整理の結果を信用できるようにする。
2. **A-2**：A-1 と同じ `scanAll` 周りなので続けて直せる。数百タブで整理が途中で止まる危険をなくす。
3. **D-2**：効果「中」の中で最も小さい作業（定数 1 つと README）。一括整理の取り消しができるようになる。
4. **B-1**：Gofile の画面が変わったときに直す場所が 1 か所になる。D-1 や C-2 で `content.js` を触る前にやっておくと手戻りがない。
5. **D-1**：開けずに残ったタブを見落とさなくなる。B-1 で判定をまとめた後なら作業しやすい。

## 5. 対象外だが要注意

特になし（作業ツリーの全テキストファイルを読んだ範囲で、API キー・パスワード・個人情報は見当たらなかった。git の履歴は確認していない）。
