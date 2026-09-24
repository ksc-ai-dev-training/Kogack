# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

社内向けAIネイティブチャットシステム「Kogack」の設計ドキュメント一式と実装（新人社員向けAI開発研修の成果物）。既存Slackと併存しつつ、チャンネルにAIエージェントが常駐して質問回答・依頼対応・社内システム操作を行う社内Webシステム。設計フェーズ（`docs/`）は完成しており、2026-08-26より実装フェーズに着手した（`backend/` `frontend/`）。姉妹プロジェクトの社員経歴書管理システム「Keireki」（`c:\Users\pc-000688\Documents\keireki`、リポジトリ外）を技術構成・実装パターンのテンプレートとして踏襲する（意図的な相違点は本ファイル末尾）。`docs/index.html` をブラウザで開くと全設計ドキュメントにアクセスできる。

技術構成（既存システム LCC CRM を踏襲、REQ-N-07）: React 19 + TypeScript + Vite + Tailwind CSS 4 + react-router + SWR / FastAPI (Python) + Uvicorn + asyncpg / PostgreSQL (Supabase・全テーブルRLS有効) / Google OAuth 2.0 + セッションJWT（HttpOnly Cookie、許可ドメイン: kogasoftware.com） / OpenAI API（Chat Completions + Function Calling） / リアルタイム配信は3秒前後のポーリング（WebSocketは不採用。project memory参照） / Supabase Storage・Fly Volume / ホスティングはFly.io（`kogack`=本番 / `kogack-staging`=ステージング）。ローカル開発は Docker の Postgres（`kogack-db`、pgvector同梱）＋開発用ログイン（`DEV_AUTH=1`、`/api/auth/dev-login`）で代替する。起動手順は `README.md` を参照。

### ロール（3ロール制の実装表現）

グローバルなロールは **member / admin の2値のみ**。「チャンネル管理者（chadmin）」はチャンネル単位で付与されるため `channel_members.is_channel_admin` で表現する2階層構成（設計判断は基本設計書6.2節）。認可判定はサーバー側（`backend/auth_helpers.py` の `require_auth`/`require_roles`/`require_channel_admin`）で行い、フロントの表示制御は補助に留める（REQ-N-02）。

### 想定規模・リリース計画

想定利用者200名、2026年9月末に初期リリース。第0層（チャンネル・スレッド・DM・検索・ファイル共有）・第1層（AIのキャラクタ・スキル・振る舞い・反応設定）はほぼ全実装、第2層（ドキュメントQ&A・閲覧権限フィルタリング）もコアを実装、第3層（社内システムへの書き込み連携）は座席予約の参照のみで対象外（要件定義書3.2節）。千田氏との別途協議事項（要件定義書8.2節）: AI利用コスト上限到達時の挙動、初期リリースの先行運用対象部署・人数。

## ドキュメント構成（変更前に該当ドキュメントを参照すること）

| # | 内容 | ファイル | 状態 |
|---|---|---|---|
| 1 | 要求仕様書 | `docs/01_要求仕様書.html` | 完成 |
| 2 | 要件定義書 | `docs/02_要件定義書.html` | 完成（一部は千田氏との別途協議事項） |
| 3 | 画面モックアップ | `docs/画面モックアップ/00_一覧.html` | 完成 |
| 4 | 基本設計書 | `docs/04_基本設計書.html` | 完成 |
| 5 | 詳細設計書（総論＋4分冊） | `docs/05_詳細設計書.html`（総論）+ `05-1_…_DB設計.html` + `05-2_…_API設計.html` + `05-3_…_画面設計.html` + `05-4_…_AIサポート.html` | 完成 |
| 6 | 操作マニュアル（実画面キャプチャ付き） | `docs/06_操作マニュアル.html` | 完成 |

`README.md` の成果物一覧・`docs/index.html` の改訂履歴は、設計書自体を改訂したときに同時に更新する（実装追従だけの変更では版数は上げない）。

## ID体系（ドキュメント間の相互参照）

REQ-xx（要求）/ F-xx（機能）/ S-xx（画面）/ T-xx（テーブル）/ A-xx（API）。上流の要求IDが下流の設計まで追跡できることを確認しながら読む・書くこと。見送った機能のID（F-xx/T-xx/A-xx）は欠番のまま再利用しない（復活時に同じIDを再利用する）。

## 規約

- **共通スタイル**: 設計書は `docs/assets/style.css`、画面モックアップは `docs/画面モックアップ/mock.css` を使用。ページ個別のスタイルは作らない。
- **サイドナビ**: 各設計書は `_sidenav.js` を読み込む。完成したら `docs/_sidenav.js` の `DOCS` 配列へ追加する（画面モックアップ本体は固定サイドバーのため対象外、一覧ページのみ掲載）。
- **検討資料は `検討資料/`**: AIが作成する提案・検討・判断根拠は正式な成果物（`docs/`）に混ぜず `検討資料/YYYYMMDD_タイトル.html` に置き、`検討資料/README.md` に登録する（`docs/index.html`・サイドナビには載せない）。承認・却下後も削除せず記録として残す。
- **設計判断は基本設計書に callout として残す**: 「なぜその設計にしたか」を本文の表に埋め込まず `<div class="callout">` に「設計判断（〜理由）:」の形式でまとめる。
- **改訂は関連ドキュメントを同じコミットで一貫更新する**: 要求仕様書・要件定義書・基本設計書・画面モックアップのうち影響する全てを同時に改訂し `class="diff-new"` で明示、`docs/index.html` の改訂履歴に1行追記する。
- 実装は詳細設計書（テーブルは05-1、API詳細は05-2、画面項目・フロントエンド設計は05-3、AIプロンプト設計は05-4、権限制御は総論）に準拠する。
- **実装は姉妹プロジェクトKeirekiのパターンをそのまま流用する**（`database.py`/`auth_helpers.py`/`google_auth.py`/`lib/api.ts`/`hooks/`/`components/ui/` 等）。ただし本ファイル末尾の「Keirekiからの意図的な相違点」は必ず踏襲し、無条件にコピーしない。
- **実装を進めたら関連ドキュメントを同じコミットで更新する**: 画面・API・テーブルの新規実装は詳細設計書・（設計変更を伴うなら）基本設計書・画面モックアップへ反映する。要件定義書に無い自由な機能追加は設計書改訂を伴わないことが多い（実装のみで完結してよい）。起動方法・ポート・依存関係を変えたら `README.md` も更新する。UI・機能を変更したら `docs/06_操作マニュアル.html` と、AIの案内根拠になる `backend/app_help/manual.md`（後述）も追従させる。

## 現状のドキュメントから読み取れる主要な設計判断

- **DM（F-05）はグループDM対応**。参加者は `direct_message_members`（T-17）で管理し開始時に固定。自分専用DM（Slackの「Myself」相当）にも対応。
- **非公開チャンネル（F-34）は新規テーブルを追加せず**、`channels.is_public` と `channel_members`、API層の認可分岐とRLSで実現する（非公開の存在は非参加者に一切露出させない）。
- **送信予約（F-35）・定期投稿（F-36）・自動応答トリガー（F-38）は専用ジョブキューを使わず**、FastAPI内蔵のasyncioタスク（`services/scheduled_dispatcher.py`、`trigger_matcher.py`）で実現する。単一インスタンス運用が前提。
- **BOT投稿（`sender_type='bot'`）は本文中の@メンションでAIエージェントを起動しない**（連鎖起動防止の一貫原則）。唯一の例外は定期投稿・自動応答トリガーがAIへ明示メンションした場合のみ（`force_mention=True`）。
- **アイコン画像は汎用アップロードAPI（A-61）に集約**し、権限チェックは反映先（プロフィール・チャンネルAI・定期投稿等）に委ねる。全認証済み利用者に公開する。
- **AI発言の根拠カード（citation等）は `message_blocks` テーブル1本にJSONBペイロードでまとめる**（種類ごとにテーブルを分けない）。
- 画面「S-06」は当初「チャンネルAI設定」だったが項目増加により「チャンネル設定」に改称（DB/APIの識別子は変更していない）。

## 実装状況

Keirekiと同じ流儀（1画面につきDB・API・画面をひととおり作って動かす。単体・結合テストは省略し `start.bat` でローカル起動して手動確認する）で、縦切りに実装を進めてきた。

- **実装済み**: 第0層（認証、チャンネル・DM・スレッド・横断検索・ファイル添付・絵文字リアクション・カスタム絵文字・簡易書式・下書き保存・発言編集）、第1層（AIキャラクタ・スキル・反応モード・自動対応範囲分類・送信予約・定期投稿・自動応答トリガー）はほぼ全機能。第2層は参照ドキュメントのアップロード・限定公開ACL・索引化・ベクトル検索・引用表示・アプリ自体の使い方案内（`search_app_manual`）までコア機能を実装。管理コンソール（利用者管理・参照ドキュメント範囲・AI利用状況/コスト・監査ログ）、デスクトップ通知（ブラウザ通知＋Web Push、チャンネル/DM単位のミュート）、アンケート機能なども実装済み。要件定義書に対応IDを持たない自由な機能追加が多数あり、経緯は `git log` を参照。
- **未実装・対象外**: Google Drive連携本体（下記の理由でブロック中、現状はDrive同期ではなく実ファイルの直接アップロード方式で代替）、実行前確認（F-25、書き込み系の社内システム連携が増えるまで対象外）、AI利用コスト上限到達時の応答停止・通知メール送信（千田氏との協議待ち）、第3層の座席予約以外の書き込み連携。

### 実装・運用上の重要な留意点

- **DBスキーマは常時 `AUTO_MIGRATE`（`database.py` の `SCHEMA` を起動のたびに適用）**。過去に「本番のみ無効」で列追加が反映されず障害になった経緯から、ローカル・本番とも常時有効にした。SCHEMAの追記は必ず冪等にする（`ADD COLUMN IF NOT EXISTS`、既存CHECK制約を広げる変更は `DROP CONSTRAINT IF EXISTS` してから同名で `ADD`、バックフィルUPDATEは対象0件になれば以後何もしない形にする）。**制約・列を変更したら、ローカルで「起動→データ投入→再起動」の2周期テストを必ず行う**（1回目の起動だけでは気づけない不具合を過去に作り込みかけている）。
- **AIエージェント（`services/ai_agent.py`）は投稿APIをブロックしない**: 応答生成は `asyncio.create_task` のfire-and-forgetで起動し、生成中は `messages.generation_status='generating'` のプレースホルダを作る。プロセス再起動をまたいで残った生成中発言は起動時に `recover_orphaned_generations()` が自動復旧し、A-74で手動中断もできる。
- **Function Calling は3ツール**: `search_documents`（参照ドキュメント、`services/doc_permissions.py` のチャンネル単位ACLに従う）・`search_channel_history`（このチャンネルの過去の会話）・`search_app_manual`（Kogack自体の使い方、全チャンネル常時提供・`backend/app_help/` が担当）。**小型モデルは「予告だけしてツールを呼ばない」「検索結果を無視して一般論を作文する」失敗が多い**ため、1ラウンド目は `tool_choice="required"` を強制し、それでも失敗パターンを検知したら1回だけ強制再試行する自己修復ロジックが `_run_chat_with_tools` にある。
- **既定モデルは `gpt-5-mini`**（実機A/Bテストでgpt-4.1-nano・gpt-5-nanoよりハルシネーションが少ないと確認済み。`services/ai_client.py` の `MODEL_COSTS`/`MODEL_DESCRIPTIONS` に選択肢を追加するだけでS-06の選択肢に反映される）。チャンネルごとに `channel_ai_settings.ai_model` で上書き可能。**`gpt-5-*` 系（reasoning）には `temperature` を渡さず、`reasoning_effort='minimal'` を付けること**（付けないと `max_completion_tokens` を思考に使い切り空応答になる）。
- **AIの案内内容を制御する事実は検索結果に頼らず `FIXED_RULES`（`ai_agent.py`）へ直接明記する**方式を採る（ログアウト方法・チャンネル作成方法など、検索頼みだとモデルが呼ばなかったり内容を無視したりして繰り返しハルシネーションを起こした）。操作マニュアル本文を変えたら、AIの参照元である `backend/app_help/manual.md`（`docs/06_操作マニュアル.html` とは別ファイル、`services/app_help_indexer.py` が内容ハッシュで起動時に自動再索引する）も同じ内容に追従させること。
- **リアルタイム配信はポーリングのみ**（メッセージ一覧2秒・その他一覧5秒間隔）。**差分ポーリングは `updated_at` 基準**（`created_at` ではない）。AI応答確定・絵文字リアクション・投票・発言編集など本文以外の更新でも `updated_at` を進めないと他利用者の画面に反映されないバグを複数回踏んだ。
- **Google認証**: 許可ドメインはkogasoftware.comのみ。IDトークン検証に60秒のclock skew許容（`leeway`）が必須（無いと稀に全ログインが失敗する）。ローカルは `frontend/vite.config.ts` のproxyに `changeOrigin: false` が必須（既定trueだとHostヘッダーが書き換わり `redirect_uri_mismatch` になる）。再ログイン時に既存ユーザーの氏名・アイコンは上書きしない。
- **ホスティングはFly.io**。mainへのpushで自動デプロイ（GitHub Actions）。**デプロイ前に `git status` がクリーンであることを必ず確認する**（`fly deploy` は作業ディレクトリの実ファイルをそのままビルドするため、未コミットの検証用変更が本番に載った事故がある）。プロフィール画像・添付ファイルはSupabase Storage、参照ドキュメントの実ファイルはFly Volume（`/data`、要 `fly volumes create`。コンテナはroot起動→chown→非root降格する `backend/entrypoint.sh` を経由）に保存し、`backend/uploads/` はローカル開発時のディスクフォールバック専用。
- **Google Drive連携（層2）はブロック中**: Google Workspace管理コンソールの設定でサードパーティ製アプリのDrive API利用がドメイン全体で禁止されており、解除権限を持つ人物が社内で未特定（project memory参照）。このため参照ドキュメント機能はDrive同期ではなく実ファイルの直接アップロード方式で実装している。
- **動作確認はDocker Postgres＋`DEV_AUTH=1`のバックエンド＋Playwrightで行う**。検証用に作ったチャンネル・利用者設定（`notif_mode`等）は必ず削除・復元すること。過去に消し忘れた検証用データが原因で別の検証結果を誤読した事例が複数回ある。
- **フロントの配色・余白等は `frontend/src/index.css` の `@theme` トークンに集約**する。Tailwindはソースに実在するクラス文字列しかCSSへ出力しないため、動的に組み立てた任意値クラス名（テンプレートリテラルでのpx指定等）は機能しない。UI全体の文字サイズ拡大は `documentElement.style.zoom` を使っており、`100vh`/`100vw` 前提のレイアウトは `calc(.../var(--ui-zoom))` での補正が要る。
- ローカル既定ポートはKeirekiと衝突しないようずらしてある: DB 55433 / backend 8011 / frontend 5174。

## Keirekiからの意図的な相違点（実装時に必ず踏襲すること。Keirekiのコードを安易にコピーしない）

- ロールは `member`/`admin` の2値のみ（Keirekiは3値）。chadminは `channel_members.is_channel_admin` で別管理する。
- Google再ログイン時、既存ユーザーの `name`/`picture_url` は上書きしない（Keirekiの `callback()` は毎回上書きするが、この実装はコピーしない）。
- ログインエラーのコードは `domain_not_allowed`/`account_disabled`/`oauth_failed`/`consent_denied` の4種（詳細設計書 総論7.2節）。Keirekiとは名称が異なる。
- ポート既定値をKeirekiとずらしている（上記参照）。
- AIモデルは環境変数`AI_MODEL`ではなく**チャンネルごと**（`channel_ai_settings.ai_model`）に選択できる（Keirekiはアプリ全体1設定）。コスト単価表も円/1000トークン単位（Keirekiの`ai_client.py`はUSD/1Mトークン単位）。
- **ホスティング先はFly.io**（Keireki・LCC CRM踏襲の既定はKoyeb）。KoyebのGitブランチ連動デプロイに相当する仕組みが無いため `fly deploy`／GitHub Actions運用にし、本番/ステージングも `kogack`/`kogack-staging` の2アプリに分けている。

開発用ログイン（`/api/auth/dev-login`・`/api/auth/dev-users`）はKogackの正式な設計書には存在しない、ローカル開発専用の便宜機能（Keirekiの規約を踏襲）。本番では `APP_ENV=production` で常に無効。

## 開発研修としての位置づけ

新人社員向けAI開発研修の成果物であり、`docs/index.html` の「読み進め方」に研修用の読み順ガイドがある: 要求仕様書 → 要件定義書 → 画面モックアップ → 基本設計書 → 詳細設計書（総論＋4分冊） → 操作マニュアル（完成）。各ドキュメントはID体系での上流〜下流のトレーサビリティを確認しながら読むことを意図している。
