/*
 * AIネイティブチャットシステム「Kogack」設計ドキュメント サイドナビ共通スクリプト
 *
 * 各HTMLは <body> 直下に <script src="_sidenav.js"></script> を1行追加するだけ。
 * （サブフォルダ配下から読み込む場合は <script src="../_sidenav.js"></script>）
 *
 * このファイルが:
 *   - サイドナビのHTMLを各ページに注入
 *   - サイドナビ用CSSを <head> に注入
 *   - 現在開いているページを location.pathname から判定して自動ハイライト
 *   - 本文の左マージンをサイドナビ分だけ確保
 *   - 印刷時はサイドナビを非表示にして本文を中央寄せに戻す
 *
 * 新しいドキュメントを追加するとき:
 *   下の DOCS 配列に { href, title } を追加するだけ。
 *   ※画面モックアップ本体（S-0x）は画面自体が固定サイドバーを持つため、
 *     サイドナビは読み込まない（リンクのみ張る）。
 *   ※グループに newWindow: true を付けると、その中のリンクは別ウィンドウで開く。
 *
 * 画面モックアップは一覧ページ（画面モックアップ/00_一覧.html）のみを
 * DOCS 配列に掲載する。個々の画面モック（S-0x）は上記のとおりサイドナビを
 * 持たないためリンク先として掲載しない（一覧ページから辿る）。
 * 基本設計書以降、ドキュメントが完成した時点でこの DOCS 配列に追記すること。
 */
(function () {
  const DOCS = [
    {
      group: '全体',
      docs: [
        { href: 'index.html', title: '成果物一覧' },
      ],
    },
    {
      group: '要求',
      docs: [
        { href: '01_要求仕様書.html', title: '01 要求仕様書' },
        { href: '02_要件定義書.html', title: '02 要件定義書' },
      ],
    },
    {
      group: '画面モックアップ',
      docs: [
        { href: '画面モックアップ/00_一覧.html', title: '画面モックアップ 一覧' },
      ],
    },
    {
      group: '設計',
      docs: [
        { href: '04_基本設計書.html', title: '04 基本設計書' },
        { href: '05_詳細設計書.html', title: '05 詳細設計書（総論）' },
        { href: '05-1_詳細設計書_DB設計.html', title: '05-1 詳細設計書 DB設計' },
        { href: '05-2_詳細設計書_API設計.html', title: '05-2 詳細設計書 API設計' },
        { href: '05-3_詳細設計書_画面設計.html', title: '05-3 詳細設計書 画面設計' },
        { href: '05-4_詳細設計書_AIサポート.html', title: '05-4 詳細設計書 AIサポート' },
      ],
    },
  ];

  // ---- 現在位置の判定（docs/ 直下かサブフォルダ配下か） ----
  const path = decodeURIComponent(location.pathname);
  const inSubdir = path.indexOf('画面モックアップ') !== -1;
  const prefix = inSubdir ? '../' : '';
  const currentFile = (path.split('/').pop() || '').toLowerCase();

  // ---- CSS 注入 ----
  const css = `
.sidenav {
  position: fixed; top: 0; left: 0;
  width: 220px; height: 100vh;
  background: #fafbfc;
  border-right: 1px solid #e7eaee;
  padding: 16px 14px;
  overflow-y: auto;
  z-index: 100;
  font-size: 12px;
  font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", "Meiryo", sans-serif;
  box-sizing: border-box;
}
.sidenav-title {
  font-size: 13px; font-weight: 700; color: #1e3a8a;
  border-bottom: 2px solid #1e40af;
  padding-bottom: 6px; margin-bottom: 12px;
  line-height: 1.4;
}
.sidenav-group { margin-bottom: 14px; }
.sidenav-group-title {
  font-size: 10.5px; font-weight: 600; color: #8a8f98;
  letter-spacing: 0.04em;
  margin-bottom: 4px; padding-left: 4px;
}
.sidenav ul { list-style: none; margin: 0; padding: 0 0 0 4px; }
.sidenav li { margin: 1px 0; }
.sidenav a {
  color: #1a1d21; text-decoration: none;
  display: block; padding: 4px 8px; border-radius: 6px;
  line-height: 1.5;
}
.sidenav a:hover { background: #eff6ff; color: #1e3a8a; text-decoration: none; }
.sidenav li.current a { background: #1e40af; color: #fff; font-weight: 600; }
.sidenav a.external { display: flex; align-items: baseline; gap: 4px; }
.sidenav-ext { font-size: 9px; color: #9aa0a8; flex: none; }
.sidenav a:hover .sidenav-ext { color: #1e3a8a; }
.sidenav li.current a .sidenav-ext { color: #c7d2fe; }

/* 本文左マージン（サイドナビ幅 + 余白） */
body { margin-left: 240px; }
@media print {
  body { margin-left: auto; }
  .sidenav { display: none; }
}
`;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ---- nav HTML 構築 ----
  const escape = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  let html = '<nav class="sidenav">';
  html += '<div class="sidenav-title">Kogack<br>設計ドキュメント</div>';
  for (const g of DOCS) {
    html += '<div class="sidenav-group">';
    html += '<div class="sidenav-group-title">' + escape(g.group) + '</div>';
    html += '<ul>';
    for (const d of g.docs) {
      const file = (d.href.split('/').pop() || '').toLowerCase();
      const isCurrent = file === currentFile;
      const cls = isCurrent ? ' class="current"' : '';
      const attrs = g.newWindow
        ? ' target="_blank" rel="noopener" class="external"'
        : '';
      const mark = g.newWindow ? '<span class="sidenav-ext">↗</span>' : '';
      html +=
        '<li' + cls + '><a href="' + escape(prefix + d.href) + '"' + attrs + '>' +
        escape(d.title) + mark + '</a></li>';
    }
    html += '</ul></div>';
  }
  html += '</nav>';

  // ---- DOM 挿入（script タグの直後） ----
  const inject = () => {
    const target = document.currentScript || document.body.firstElementChild;
    if (target && target.insertAdjacentHTML) {
      target.insertAdjacentHTML('afterend', html);
    } else {
      document.body.insertAdjacentHTML('afterbegin', html);
    }
  };

  if (document.currentScript) {
    inject();
  } else {
    document.addEventListener('DOMContentLoaded', inject);
  }
})();
