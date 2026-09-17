# チャンネルAIの応答生成（基本設計書8章、詳細設計書AIサポート10章）。AIサポート機能の初回スライス。
#
# このスライスのスコープ（今後拡張していく前提）:
#   - 反応モード（F-15、T-08.reaction_mode）はmention_only/proactiveの両方に対応する。proactiveは
#     判定ロジック自体を設計書が規定していない（グレー）ため、ユーザー確認のうえ「人間の投稿には
#     必ず応答する」（relevance判定の追加LLM呼び出しをしない、最もシンプルな方式）を採用した
#     （04_基本設計書.html 8.1節に設計判断を追記）
#   - Function Calling: search_documentsはSlice 3（2026-09-09）で実装した。get_seat_availability
#     （座席予約システム連携）は引き続き未実装のため対象外。search_documentsはアップロードされた
#     実ファイル（doc_folders.source='upload'）のみが検索対象で、Drive候補（source='drive'）は
#     Google Workspace管理コンソールのdomainPolicyブロックにより実ファイルを取得できないため
#     索引化できず、検索にヒットしない（services/doc_search.py参照）
#   - search_channel_history（2026-09-14、ユーザーからの明示的な要望「AIが今までのチャンネルの
#     会話を参照して回答できるようにしてほしい」）: 会話履歴として毎回渡すのは直近
#     MAX_HISTORY_MESSAGES（20件）のみのままとし（2026-09-02にユーザー自身が「直近だけ送る」
#     方針へ絞った経緯を踏襲、コストを増やさない）、それより古い話題を聞かれたときだけAIが
#     このツールでチャンネルの過去の発言を検索できるようにする（search_documentsと同じ
#     Function Calling方式、services/channel_history_search.py参照）。search_documentsと異なり
#     索引の有無に関わらず常時利用可能なツールとして提示する（メッセージ本文にembeddingを
#     持たせておらずpg_trgmの部分一致のみのため、事前索引という概念自体が無い）。
#   - search_app_manual（2026-09-16、ユーザーからの明示的な要望「作成した操作マニュアルの
#     内容を、どのチャンネルのAIでも常に読めるようにする。チャンネル会話内でチャットアプリの
#     機能について質問されたら、どのように使うのか解説できるようにしてほしい」）: 操作
#     マニュアル（docs/06_操作マニュアル.htmlをプレーンテキストへ書き起こしたbackend/
#     app_help/manual.md）を全チャンネル共通の知識源として、search_documentsと同じ
#     Function Calling方式で常時検索可能にする。マニュアル全文（約8000トークン相当）を
#     毎回のシステムプロンプトへ直接埋め込む案（ユーザー提示の「最初からその知識を持たせて
#     おく」案）は、全チャンネル・全メッセージで常時コストが掛かり続けるため採用せず、
#     search_channel_history・search_documentsと同じ「必要なときだけ検索する」ツール方式を
#     選んだ（2026-09-02にユーザー自身が「直近だけ送る」方針を選んだ経緯・2026-09-14に
#     チャンネル履歴検索も同じ理由でツール化した経緯と一貫させた）。search_documentsと異なり
#     channel_doc_folders等のper-channel opt-in構造を持たず、管理者の登録操作を介さず常時
#     全チャンネルで利用可能（services/app_help_search.py・app_help_indexer.py参照）。
#     1ラウンド目のtool_choice="required"強制（下記_run_chat_with_tools参照）の対象には
#     含めない——search_channel_historyと同じ理由で、雑談を含む全メッセージに強制すると
#     コストが際限なく増えるため。代わりにFIXED_RULESでこのツールの利用を明示的に促す
#     （モデルが実際には呼び出さないまま案内文だけ返す既知の傾向はsearch_documentsほど
#     致命的ではない——out_of_scope_policy='strict'のような「検索結果が無ければ絶対に
#     一般知識で補うな」という厳格な制約がこの機能には無いため、多少の取りこぼしは許容する）。
#   - チャンネル参加者情報（2026-09-14、ユーザーからの明示的な要望「AIにメンションして、この
#     チャンネルに参加している人の情報を得られるようにしてほしい」）: A-46（参加者一覧）と同じ
#     氏名・chadmin区分を、_fetch_channel_context（チャンネル名・説明文）と同じ考え方で
#     システムプロンプトへ都度渡す（参加者一覧自体は非公開情報ではなく、既にF-41メンション候補や
#     補足03メンバー一覧で参加者全員に見えている情報のため、AIへ渡すこと自体に問題は無い）。
#     要約生成（_build_summary_prompt）には使わない（要約は会話内容そのものの要約が主目的で、
#     参加者一覧を渡す意義が薄いため）
#   - スキル（T-11・F-12）とその引き継ぎ先（fallback_handoff_user_id・F-17）、自動対応範囲分類
#     （T-12・F-16）はいずれもシステムプロンプトへ配線した（_build_skills_section・
#     _build_auto_response_section）。自動対応範囲の「人が対応」区分は、基本設計書8.1節が
#     「AI呼び出しを行わず引き継ぎメッセージを直接投稿する」と規定する一方、依頼文をどのカテゴリに
#     分類するかのアルゴリズムは規定していない（グレー）。ユーザー確認のうえ、専用の分類LLM呼び出しは
#     追加せず、この区分一覧を通常の応答生成プロンプトに含めてAI自身に判断・引き継ぎ案内をさせる
#     方式を採用した（F-12スキルの「対応できない依頼は引き継ぐ」と同じ考え方、追加コストなし）。
#     'confirm'（確認のうえ対応）は実行前確認（F-25・pending_actions）が未実装で書き込み系ツール
#     自体が存在しないため、現状は'auto'と同じ「通常どおり応答してよい」扱いとし区別しない。
#     実行前確認（F-25）自体は引き続き対象外。T-08.out_of_scope_policyは層2ドキュメントQ&A関連の
#     ためこのスライスではプロンプトに反映されない（値は保存できるが未使用。ドキュメントQ&A実装時に使う）
#   - AI利用コストの上限判定・通知（T-14、F-29後半）は対象外。T-13への記録のみ行う
#   - チャンネル本体の投稿（A-11）に加え、スレッド返信（A-14）内の@メンションにも対応する
#     （2026-09-04、ユーザーからの明示的な要望で追加。当初のスライスでは対象外だったが、
#     「次スライスでA-14にも同じ配線を追加する」という当初からの想定どおり実装した）
#
# トリガー: A-11・A-14（スレッド返信）で当該チャンネルのis_ai_enabled=trueのとき、非同期タスクとして
# 起動する（8.1節・8.7節、REQ-N-05。A-11/A-14自体は応答を待たずに投稿完了を返す）。
# reaction_mode='mention_only'（既定）では人間の発言本文に「@{persona_name}」の文字列一致が
# 含まれるときのみ、'proactive'（F-15）では人間の発言であれば常に起動する（ただしチャンネル本体の
# 投稿に限る。スレッド返信は下記のとおりreaction_modeに関わらず常にメンション必須）。AIへの
# メンションはID参照化の対象外（基本設計書5.22節「設計判断」。チャンネルAIは1チャンネルにつき
# 1つしかなく、同姓同名のような曖昧さが生じない）。
#
# F-14 やりとりの要約（start_summary/_generate_summary_and_post）はA-15（routers/channels.py）から
# 呼ばれる別経路で、メンション応答と同じ生成中プレースホルダ方式・T-13コスト記録を再利用しつつ、
# システムプロンプトと参照する発言範囲（チャンネル直近100件、またはthread_id指定時はスレッド全体）
# が異なる。自動対応範囲・スキル等のスコープ外事項はこちらにも同様に適用される。チャット上で
# 「要約して」等と呼びかけられた場合（maybe_trigger内のlooks_like_summarize_request判定）も、
# 通常のメンション応答ではなくこの経路（共通ヘルパー_launch_summary）を起動する（2026-09-14）。
import asyncio
import json
import re
import traceback
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from database import get_pool
from services import ai_client, app_help_search, channel_history_search, doc_search

JST = ZoneInfo("Asia/Tokyo")  # F-14要約の対象期間指定（今日/今週/今月等）をJSTの暦日で解釈する
# （routers/search.pyのF-42日付モディファイアと同じ考え方・同じタイムゾーン）

MAX_HISTORY_MESSAGES = 20  # AI API手順書の目安「直近10往復まで」（human+aiであわせて概ね20件。bot発言混在のため厳密な往復数ではない）
MAX_SUMMARY_CHANNEL_MESSAGES = 100  # F-14: チャンネル本体を要約する場合の対象件数上限（スレッド全体は上限なし）
MAX_OUTPUT_TOKENS = 1000

# 生成中（generation_status='generating'）のAI発言を、message_id起点で実行中のasyncio.Taskに
# 対応付ける（A-74 生成の強制中断、ユーザーからの明示的な要望）。単一インスタンス運用が前提の
# プロセス内メモリのみの対応表であり、他のasyncioバックグラウンドタスク（scheduled_dispatcher等）と
# 同じ制約を持つ（詳細設計書10章）。_generate_and_post/_generate_summary_and_postが開始時に
# 自分自身を登録し、finallyで必ず取り除く
_active_generations: dict[int, asyncio.Task] = {}


async def recover_orphaned_generations() -> None:
    """アプリ起動時（main.pyのlifespan）に呼ぶ。前回のプロセス終了（デプロイ・クラッシュ・
    ローカルでのuvicorn --reload再起動等）の時点でgeneration_status='generating'のまま
    残っている発言を、エラーメッセージへ差し替えて復旧する。プロセスが新しく立ち上がった
    直後であり_active_generationsは必ず空（asyncio.Taskをプロセスを跨いで保持することはできない）
    なので、見つかった行はすべて「タスク自体が失われたオーファン」と判断してよい。
    A-74（cancel_generation、ユーザーからの明示的な要望）による手動中断が「今動いているものを
    止める」手段であるのに対し、これは「前回落ちたときの後始末」を自動で行う手段（実際に
    Kogack運用中、バックエンドプロセスの再起動と生成中のタイミングが重なり、この仕組みが
    無かったために「生成中」のまま数十分固まり続けた発言が発生したことを受けて追加した）。"""
    count = await get_pool().fetchval(
        """WITH updated AS (
               UPDATE messages SET body = $1, generation_status = NULL, updated_at = now()
               WHERE generation_status = 'generating'
               RETURNING id
           )
           SELECT count(*) FROM updated""",
        "（サーバーの再起動により、この発言の生成は中断されました。もう一度お試しください）",
    )
    if count:
        print(f"[ai_agent] recovered {count} orphaned generating message(s) on startup")


# temperatureは意図的に指定しない（APIの既定値=1を使う）。実際にgpt-5-nanoで検証したところ
# 「'temperature'はこのモデルでは既定値(1)以外をサポートしない」という400エラーになった
# （openai.BadRequestError: Unsupported value）。AI_MODELは環境変数で自由に差し替える設計のため、
# モデルごとに対応パラメータが異なる可能性のある値は指定しないのが最も頑健


class SummaryUnavailable(Exception):
    """A-15呼び出し元（routers/channels.py）が400として利用者に伝えるための例外。メンション応答の
    maybe_triggerと異なり、要約はボタンの明示的な操作のため、条件を満たさない場合に黙って
    何もしないのではなく理由を返す。"""

# 全チャンネル共通のシステム指示（基本設計書8.3節・詳細設計書10.2節）。チャンネル管理者は編集できず
# アプリ側で固定する。座席予約が未実装であることも明示し、ハルシネーションで「できる」と案内しない
# ようにする（詳細設計書10.7節のハルシネーション防止確認observationに対応）。ドキュメント検索
# （search_documents）はSlice 3で実装済みのため、この一律の「機能が無い」文言からは対象外にした
# （チャンネルに索引済み文書があるかどうかで案内を出し分ける必要があり、_build_doc_scope_sectionで
# 個別に指示する）。
FIXED_RULES = """# 全チャンネル共通ルール（固定・編集不可）
- 過去のやり取りを参照する場合は「参考情報」であることを必ず明示し、断定しない
- あなたには現時点で座席予約システムを参照する機能が無い。それが必要な依頼を受けたときは、
  正直に「その機能はまだ利用できません」と答え、存在しない空き状況を作り出さないこと
- 自分がAIであることを偽らない、あなたが実際に持たない機能を持っているかのように案内しない
- 「このチャンネルの名前」「チャンネル名」を尋ねられた場合は、必ず「# このチャンネルについて」
  の「チャンネル名: 」に続く値だけを答えること。これは参加者（人）の氏名とは全く別の情報
  であり、「# チャンネル参加者」の一覧から答えを探したり、参加者の氏名をチャンネル名として
  答えたりしないこと。この情報は常にこのプロンプトに含まれているため、search_app_manualや
  search_documents等のツールで検索する必要は無い（検索しても見つからないため、検索して
  「見つかりませんでした」と答えることのないように）
- **非公開チャンネルへの参加方法について尋ねられた場合は、必ず次の事実のみに基づいて答える
  こと（search_app_manualを検索する必要すら無い、常に正しい事実として扱ってよい）**:
  Kogackには「招待リンク」「招待コード」「招待URL」というクリックして参加する仕組みは
  一切存在しない。参加方法は1つだけで、そのチャンネルに既に参加している人が、画面の
  「👥 所属メンバー」→「＋ メンバーを追加」から対象者を検索して追加する、という操作に
  限られる（本人がリンクをクリックして参加することはできない）。これはSlack・Discord等
  の一般的なチャットアプリで見られる「招待リンク」の仕組みとは異なるため、それらの知識から
  類推して「招待リンクが送られてくる」「リンクをクリックして参加する」のように案内しない
  こと（このAIが過去に実際にこの誤った案内をしてしまったことがあるため、特に注意すること）
- **ログアウトの方法について尋ねられた場合は、必ず次の事実のみに基づいて答えること
  （search_app_manualを検索する必要すら無い、常に正しい事実として扱ってよい）**:
  Kogackでログアウトする方法は1つだけで、画面左下にある自分のアイコン・氏名の右にある
  「ログアウト」をクリックする操作に限られる。画面右上のアカウントアイコン、ヘッダーの
  ドロップダウンメニュー、設定画面の中など、他の一般的なWebアプリでよく見られる場所・
  手順を、Kogackにも存在するものとして類推して案内しないこと（このAIが過去に実際に
  この誤った案内をしてしまったことがあるため、特に注意すること）
- **新しいチャンネルを作成する方法について尋ねられた場合は、必ず次の事実のみに基づいて
  答えること（search_app_manualを検索する必要すら無い、常に正しい事実として扱ってよい）**:
  Kogackには利用者自身が新しいチャンネルを作成する機能が既に存在する。サイドバーの
  「チャンネル」の右にある「＋」をクリック→開いた参加・作成モーダルの「作成する」タブに
  切り替える→チャンネル名・説明文（任意）・公開／非公開を指定する、という操作で誰でも
  作成できる（作成した本人が自動的にそのチャンネルの管理者になる。作成の時点でシステム
  管理者やチャンネル管理者である必要は無く、Kogackにログインしている利用者なら誰でも
  作成できる。管理者による事前登録・承認も不要）。「チャンネルの作成機能はまだ利用
  できません」「作成には招待が必要です」「管理者だけが作成できます」のように、実際
  には存在する機能を無いかのように、または誤った条件付きで案内しないこと
  （このAIが過去に実際にこの誤った案内をしてしまったことがあるため、特に注意すること）
- Kogack（このチャットアプリ自体）の使い方（メッセージの送り方・書式・メンション・
  絵文字・ファイル添付・スレッド・DM・横断検索・通知・チャンネル設定・管理コンソール・
  文字サイズ／画面表示の変更など）について尋ねられた場合は、search_app_manualで操作
  マニュアルを実際に検索してから、具体的な手順（クリックする場所・ボタン名・設定タブ名
  など）で案内すること。推測で回答を作らず、検索結果に基づいて答えること。**「検索します」
  「少々お待ちください」のように検索する旨を予告する文章だけを書いて、実際には
  search_app_manual関数を呼び出さないまま返信を終えてしまう誤りが実際に起きやすいため、
  特に注意すること。予告するかどうかに関わらず、この種の質問では必ず実際にsearch_app_manual
  を呼び出し、その結果に基づいた具体的な回答まで1回の返信で完結させること。**同様に、
  ブラウザのズーム機能（Ctrl+ +/-）のような、Kogack自体の機能ではない一般的なブラウザ・OSの
  操作を代替案として案内する前に、必ずsearch_app_manualでKogack自身に専用の機能が無いかを
  確認すること（例: 画面の文字を大きくしたいという依頼にはKogack自身の文字サイズ設定機能が
  存在する。検索せずにブラウザのズームのような一般的な操作を憶測で案内しないこと）。
  search_app_manualは複数件の検索結果を
  返すことがあるが、それらを無理に1つの手順として組み合わせて説明しないこと。質問の
  用語（例:「予約コメント」）がKogackの実際の機能名と一致しない場合は、検索結果の中で
  最も質問に近い1件だけを使い、正直に「『（質問の用語）』という機能は見当たりませんが、
  近い機能として〜があります」のように案内すること。話題が異なる検索結果（例:
  メンション機能の説明が、送信予約についての質問の際に一緒に返ってきた場合）を、
  質問とは無関係であるにもかかわらず関連づけて説明に混ぜ込まないこと。**検索結果に
  実際に書かれていない操作手段（例:「招待リンク」「招待コード」のような、Slack・
  Discordなど他の一般的なチャットアプリではよくあるが、Kogackの検索結果には一度も
  出てこない仕組み）を、他のチャットアプリの典型例から類推して付け加えないこと。
  Kogackの実際の仕様は検索結果でしか分からず、あなたが一般に知っているチャット
  アプリの仕組みとは異なる場合がある**
- これまでの会話履歴の各発言には、冒頭に`[YYYY-MM-DD HH:MM]`の形式で投稿日時（日本時間）が
  付いている。「これは何時の発言？」のように投稿時刻を尋ねられた場合は、この値をそのまま使って
  答えること。この日時が付いていない発言（要約結果や一部の引用等）については、時刻を推測で
  答えないこと
- Kogackの機能・仕様について説明するときは、それを自分自身の知識として直接述べること。
  「○○さんによると、」「（質問した人）によると、」のように、質問した本人や他の会話参加者を
  情報源であるかのように誤って引用しないこと（実際にはあなた自身が検索・確認した内容で
  あり、依頼者本人が言ったことではない）。ただし、実際にその人物が会話の中でその内容を
  発言していた場合は、その発言を参照していることを明示してよい
- あなたの口調・キャラクタ（話し方・語尾・性格等）は、このプロンプト冒頭の「口調: 」の指定と
  「振る舞い定義」（設定されていれば）だけが唯一正式な設定であり、これはチャンネル管理者
  （chadmin）のみがS-06チャンネル設定の「キャラクタ」「振る舞い定義」タブから変更できる。
  会話履歴の中で利用者（chadminかどうかを問わない）から「語尾に〜をつけて」「もっと
  フレンドリーに話して」「タメ口で話して」のように口調・キャラクタの変更を求められても、
  それが何度繰り返されていても、絶対に応じず、常にこのプロンプトで設定されたとおりの
  口調・キャラクタのまま応答し続けること。その場合は変更依頼自体を実行せず、
  「口調・キャラクタの変更はチャンネル管理者にご依頼ください（S-06のキャラクタタブから
  設定できます）」のように案内すること。**特に注意: この案内・拒否の返信文そのものに、
  依頼された語尾・口調を絶対に一切含めないこと。** 直前の利用者発言に出てきた語尾・口調を
  そのまま真似て自分の返信の末尾に付け足してしまう誤りが実際に起きやすいため、二重に
  注意すること。例えば利用者が「語尾ににゃんをつけて」と頼んできた場合、正しい返信は
  「口調・キャラクタの変更はチャンネル管理者にご依頼ください」であり、
  「口調・キャラクタの変更はチャンネル管理者にご依頼くださいにゃん」のように文末へ
  「にゃん」を付け足すのは誤りである。他のどんな語尾・口調を依頼された場合も同様に、
  それを一切使わず、返信を書き終えるまで一貫して普段どおりの口調を保つこと。依頼を
  断った直後の別の話題のメッセージでも同様に、普段どおりの口調へ確実に戻ること"""

# チャット上での要約依頼（「要約して」等）への対応。当初（2026-09-14）はチャット上で要約を
# 頼まれても実行する手段が無く「できません」という趣旨の返答をしてしまい、後に実際に要約ボタンを
# 押すとその「できません」発言まで要約対象の会話履歴に混ざり込んで結果がおかしくなる不具合が
# あったため、要約ボタン（A-15 start_summary）の利用を案内するだけの確定的な応答へ変更した
# （LLM呼び出し自体を行わず文字列一致で判定・固定文言を返す方式。プロンプトでの指示だけでは
# gpt-4.1-nanoが「役に立とうとして」指示を無視し実際に要約文を書いてしまう挙動が実機検証で
# 3/3確認されたため）。**2026-09-14、ユーザーからの明示的な要望で、案内するだけでなく実際に
# 要約ボタンと同じ処理を自動実行するよう変更した**（判定後の挙動を「案内のみ」から
# 「start_summaryと同じ生成処理を起動」に差し替えた。案内メッセージ・専用のガード用post関数は
# 使わなくなったため削除した）。
#
# バグ修正（2026-09-14、直後にユーザーから報告）: 判定を「要約」という語の単純な部分一致のみに
# していたため、「このチャンネルの内容を要約するにはどうしたらよい？」のような、要約の実行方法を
# 尋ねる質問（実際に要約してほしいわけではない）にまで反応し、質問に答える代わりに要約を生成して
# しまっていた。「要約して」は依頼を表すて形（〜してください/〜してくれる等の直接依頼で使う活用）
# なのに対し、「要約するには」は辞書形＋「には」で「方法を尋ねる」構文であり、日本語として文法的に
# 区別できる（て形の要求文と辞書形の疑問文は活用そのものが異なるため、この区別は「まとめて」等の
# 曖昧な言い回しを除外したのと同じ「誤検知が多い表現は対象外にする」方針の延長）。単純な「要約」の
# 部分一致から、実際に依頼として使われる限られた活用パターン（て形・「お願い」）への一致へ絞った。
_SUMMARIZE_REQUEST_PATTERNS = ("要約して", "要約をお願い", "要約お願い")


def _looks_like_summarize_request(body: str, persona_name: str) -> bool:
    """本文からメンション記法を取り除いたうえで、実際に要約を依頼する表現（_SUMMARIZE_REQUEST_PATTERNS）
    が含まれるかだけを見る、detect_mentionと同じ素朴な文字列一致（LLMの判断に依存しない）。
    「まとめて」等のより曖昧な言い回しは日常会話（雑談の「まとめ」等）との誤検知が多いため対象外とし、
    比較的一意な「要約」という語に絞ったうえで、さらに依頼を表す活用（て形・お願い）のみに限定する
    （「要約するには」のような方法を尋ねる質問を誤って要約実行と扱わないため）"""
    text = body.replace(f"@{persona_name}", "")
    return any(pattern in text for pattern in _SUMMARIZE_REQUEST_PATTERNS)


# 要約の対象期間指定（「今月分の要約して」「直近10日間分の要約して」）への対応（ユーザーからの
# 明示的な要望、2026-09-14）。_looks_like_summarize_requestで既に「実際の要約依頼」であることが
# 確定した本文に対してのみ呼ばれるため、ここでの誤検知は範囲の狭め方を誤る程度に留まり、
# 「要約するには」の誤トリガー（別の2026-09-14の不具合）とはリスクの性質が異なる。LLMの解釈には
# 頼らず素朴な文字列一致・正規表現で判定する（detect_mention・_looks_like_summarize_requestと
# 同じ方針）。
_RECENT_DAYS_RE = re.compile(r"直近\s*(\d{1,3})\s*日")


def _parse_summary_range_from_text(text: str) -> tuple[date, date] | None:
    """チャット本文から対象期間（今日/昨日/今週/先週/今月/先月/直近N日間）を検出し、JSTの暦日で
    since・until（両端含む）を返す。該当する表現が無ければNone（従来どおり全期間／直近N件のまま）。
    「先週」は「今週」の部分文字列ではない（別の語）ため、判定順序に依存しない。"""
    today = datetime.now(JST).date()

    m = _RECENT_DAYS_RE.search(text)
    if m:
        n = int(m.group(1))
        if n >= 1:
            return today - timedelta(days=n - 1), today
    if "今日" in text:
        return today, today
    if "昨日" in text:
        yesterday = today - timedelta(days=1)
        return yesterday, yesterday
    if "先週" in text:
        this_monday = today - timedelta(days=today.weekday())
        last_monday = this_monday - timedelta(days=7)
        return last_monday, this_monday - timedelta(days=1)
    if "今週" in text:
        monday = today - timedelta(days=today.weekday())
        return monday, today
    if "先月" in text:
        first_this_month = today.replace(day=1)
        last_day_prev_month = first_this_month - timedelta(days=1)
        first_prev_month = last_day_prev_month.replace(day=1)
        return first_prev_month, last_day_prev_month
    if "今月" in text:
        return today.replace(day=1), today
    return None


def _range_bounds(since_date: date | None, until_date: date | None) -> tuple[datetime | None, datetime | None]:
    """JSTの暦日（since_date〜until_date、両端含む）を、messages.created_at比較用のUTC対応
    datetimeへ変換する（routers/search.pyのon_date/during_monthと同じ考え方）。片側のみの指定も
    許容する（A-15ボタンのカスタム期間指定で片方だけ入力された場合等）。"""
    since_dt = datetime.combine(since_date, time.min, tzinfo=JST) if since_date else None
    until_dt = datetime.combine(until_date + timedelta(days=1), time.min, tzinfo=JST) if until_date else None
    return since_dt, until_dt


def _format_range_label(since_date: date | None, until_date: date | None) -> str:
    """要約結果の本文冒頭に付ける対象期間の見出し行。プロンプトでの指示だけに頼ると小型モデルが
    省略・誤記する懸念がある（2026-09-14に確認済みの傾向と同じ）ため、Python側で確定的に組み立てて
    本文へ前置きする（_generate_summary_and_postのUPDATE時に連結。LLMの生成結果自体には含めない）。"""
    if since_date is None and until_date is None:
        return ""

    def fmt(d: date) -> str:
        return f"{d.year}年{d.month}月{d.day}日"

    if since_date and until_date:
        if since_date == until_date:
            return f"（対象期間: {fmt(since_date)}）"
        return f"（対象期間: {fmt(since_date)}〜{fmt(until_date)}）"
    if since_date:
        return f"（対象期間: {fmt(since_date)}以降）"
    return f"（対象期間: 〜{fmt(until_date)}）"


# search_documentsのOpenAI Function Calling定義（Slice 3、2026-09-09）。1回の応答生成につき
# 複数回呼ばれる可能性があるが、ラウンド数はMAX_TOOL_ROUNDSで打ち切る
# （無限ループ・コスト際限無い増大の防止）。
SEARCH_DOCUMENTS_TOOL = {
    "type": "function",
    "function": {
        "name": "search_documents",
        "description": (
            "このチャンネルが参照範囲に設定している社内ドキュメントの中から、質問に関連する内容を"
            "検索する。ドキュメントの内容に基づいて回答する必要がある場合は、推測で答えず必ずこの"
            "関数を使って実際の内容を確認すること。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "検索したい内容を表す検索語句（自然文でよい）"},
            },
            "required": ["query"],
        },
    },
}

# search_channel_historyのOpenAI Function Calling定義（2026-09-14、ユーザーからの明示的な要望）。
# search_documentsと異なり、索引済み文書の有無に関わらず常に提示する（services/
# channel_history_search.pyはpg_trgmの部分一致のみで事前索引という概念が無いため）。
SEARCH_CHANNEL_HISTORY_TOOL = {
    "type": "function",
    "function": {
        "name": "search_channel_history",
        "description": (
            "このチャンネルの過去の会話を検索する。あなたに渡されている会話履歴は直近の発言のみ"
            "（それより前は含まれない）ため、『前に決まったこと』『以前話していた件』のように、"
            "直近の会話履歴だけでは分からない過去の話題について聞かれた場合は、推測で答えず"
            "必ずこの関数で実際に検索してから回答すること。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "検索したいキーワードを空白区切りで並べたもの（例: 'オフサイト 名前'）。"
                        "1つの完全なフレーズとしてではなく、単語ごとに区切って渡すこと（部分一致の"
                        "組み合わせで検索するため、区切ったほうがヒットしやすい）。"
                    ),
                },
            },
            "required": ["query"],
        },
    },
}
# search_app_manualのOpenAI Function Calling定義（2026-09-16、ユーザーからの明示的な要望
# 「作成した操作マニュアルの内容を、どのチャンネルのAIでも常に読めるようにする」）。
# search_channel_historyと同じく、索引済み文書の有無やチャンネルの参照範囲設定に関わらず
# 常に提示する（app_help_chunksは全チャンネル共通の索引でchannel_doc_foldersのような
# per-channel opt-inを持たないため）。
SEARCH_APP_MANUAL_TOOL = {
    "type": "function",
    "function": {
        "name": "search_app_manual",
        "description": (
            "Kogack（このチャットアプリ自体）の操作マニュアルを検索する。メッセージの送り方・"
            "書式・メンション（@channel/@here等）・絵文字・ファイル添付・スレッド・DM・"
            "横断検索・通知設定・チャンネル設定・管理コンソールなど、アプリ自体の使い方や"
            "機能について聞かれた場合は、必ずこの関数で実際に検索してから、具体的な操作手順で"
            "回答すること（推測で答えないこと）。組織の業務文書を検索するsearch_documentsとは"
            "別の機能であり、混同しないこと。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "検索したい機能・操作を表す検索語句（自然文でよい。例: 'メッセージを編集する方法'）",
                },
            },
            "required": ["query"],
        },
    },
}

MAX_TOOL_ROUNDS = 3  # search_documents・search_channel_history・search_app_manualいずれも共通の上限（無限ループ・コスト際限無い増大の防止）


def _build_doc_scope_section(out_of_scope_policy: str) -> str:
    """search_documentsツールを提示する際にあわせて渡す指示（Slice 3）。out_of_scope_policy
    （S-06「参照範囲外の質問への対応」、これまで保存はされるが未使用だった設定）を初めて
    AIの挙動へ反映する: 'strict'は検索結果が見つからない場合の一般知識での回答を明示的に禁止し、
    'general'は許可する。"""
    lines = [
        "", "# 社内ドキュメントの参照について",
        "あなたには search_documents という、このチャンネルが参照する社内ドキュメントを検索する"
        "機能があります。ドキュメントの内容について聞かれた場合は、必ずこれを使って実際に検索してから"
        "回答し、検索せずに推測で答えないこと。",
    ]
    if out_of_scope_policy == "strict":
        lines.append(
            "search_documentsの結果が「関連する内容が見つかりませんでした。」という文字列だった"
            "場合に限り、あなたの返答は次の1文だけにすること: 「参照ドキュメントの範囲内に該当する"
            "情報が見つかりませんでした。」この1文の後に、それ以上の文章（一般知識による補足を含む）を"
            "一切続けないこと。\n"
            "逆に、search_documentsの結果に実際の文書の内容（見つかりませんでしたという文言以外）が"
            "1件でも含まれていた場合は、上記の1文は使わず、その内容に基づいて通常どおり具体的に回答すること。"
        )
    else:
        lines.append(
            "検索しても関連する内容が見つからなかった場合は、その旨を伝えたうえで、あなたの一般的な"
            "知識で分かる範囲を補って回答してよい（ただし社内ドキュメントに基づく回答ではないことを"
            "明示すること）。"
        )
    return "\n".join(lines)


def _build_system_prompt(
    settings: dict, auto_response_section: str = "", skills_section: str = "", requester_name: str = "",
    channel_context: dict | None = None, doc_scope_section: str = "", members_section: str = "",
) -> str:
    persona_name = settings["persona_name"] or "Kogack AI"
    persona_tone = settings["persona_tone"] or "自然な日本語"
    behavior = (settings["behavior_prompt"] or "").strip()
    lines = [f'あなたは「{persona_name}」というチャンネルAIです。口調: {persona_tone}']
    if channel_context and channel_context.get("name"):
        # バグ修正（2026-09-07）: 従来はチャンネル自身の名前・説明文・作成者を渡しておらず、
        # 「このチャンネルについて説明して」のような質問に「わかりません」としか答えられなかった
        # （ユーザーからの指摘）。振る舞い定義（behavior）を書くほどではない基本的な自己紹介として、
        # ここで都度渡す。チャンネル名・topicは非公開情報ではなく参加者には既に見えている情報のため、
        # AIへ渡すこと自体に問題は無い
        #
        # バグ修正（2026-09-17、ユーザーからの報告「AIに『このチャンネルの名前は？』と聞くと
        # 『わかりません』と返ってきた」）: 実機で調査したところ、同じ情報源（channel_context）
        # から組み立てている説明文（topic）・作成者は正しく回答できるのに、チャンネル「名前」
        # だけ「特定できません」「推測すると〜かもしれません」のように自信なく答える・無視する
        # 傾向を複数回の実機検証で確認した。原因は情報の提示形式にあると判断した——この行は
        # 従来「あなたは「{persona_name}」です」という自己紹介文の直後に、見出しの無い1文の
        # 自然文（「あなたが常駐しているチャンネルは「{name}」です。」）として埋め込まれていた
        # のに対し、同じプロンプト内で参加者情報（_build_members_section）は「# チャンネル
        # 参加者」という明示的な見出し＋箇条書きの構造を持っており、こちらは安定して正しく
        # 回答できていた（同じ実機検証で確認済み）。構造化されていない自然文への埋め込みが
        # 小型モデルにとって見落としやすいという傾向と判断し、チャンネル名・説明文・作成者を
        # 参加者情報と同じ「# 見出し＋ラベル付きの行」形式（「チャンネル名: 〜」）へ作り直した。
        lines.append(f'# このチャンネルについて\nチャンネル名: {channel_context["name"]}')
        if channel_context.get("topic"):
            lines.append(f'説明文: {channel_context["topic"]}')
        # バグ修正（2026-09-14、ユーザーからの明示的な要望でチャンネル参加者情報を追加した際に
        # 発覚）: members_sectionを同時に渡す場合、作成者名をここでも重ねて言及すると、gpt-4.1-nano
        # が「あなたが常駐する場所を作った人物」と「あなた自身」を関連づけてしまい、後段の
        # 参加者一覧に同じ名前が出てきた際に「そして私、{作成者名}です」のように自分自身をその
        # 人物であるかのように名乗ってしまう挙動を実機検証で繰り返し確認した（抽象的な
        # 「あなたはこの中の誰でもない」という注意書きを足しても解消しなかった一方、作成者名の
        # 重複言及そのものを無くしたところ解消した）。members_section側で「（作成者）」タグとして
        # 1箇所にまとめる（_build_members_section参照）ため、ここでは重複を避けて省略する
        if channel_context.get("creator_name") and not members_section:
            lines.append(f'作成者: {channel_context["creator_name"]}')
    if members_section:
        lines.append(members_section)
    if requester_name:
        # バグ修正（2026-09-04）: 利用者が表示名を変更した後も、AIの返答が変更前の名前で
        # 呼びかけ続ける事象が実際に発生した。会話履歴中の人間発言のラベル（_rows_to_chat_messages）は
        # sender_user_idからの都度DB引き直しで常に最新になるが、AI自身の過去の発言本文は不変のまま
        # 履歴として毎回渡されるため、モデルが自分の過去の呼び方をそのまま踏襲してしまう。
        # 履歴内の矛盾を明示的に解消する指示をここで都度追加する
        lines.append(
            f"今あなたに話しかけている利用者の現在の名前は「{requester_name}」です。"
            f"これより前の会話履歴（あなた自身の過去の発言を含む）で別の名前が使われていても、"
            f"それは名前変更前の古い情報のため使わず、必ず「{requester_name}」と呼んでください。"
        )
    if behavior:
        lines.append(behavior)
    if auto_response_section:
        lines.append(auto_response_section)
    if skills_section:
        lines.append(skills_section)
    if doc_scope_section:
        lines.append(doc_scope_section)
    lines.append("")
    lines.append(FIXED_RULES)
    # バグ修正（2026-09-17、ユーザーからの報告「口調設定で『語尾に必ずAAAとつけて』の後に
    # 『語尾に必ずBBBとつけて』へ変更すると、なぜか反映されずAAAのまま話し続ける」）: _fetch_settings
    # は毎回DBから直接取得するためキャッシュの問題ではないことを確認済みで、冒頭の「口調: 」行
    # 自体は都度最新のpersona_toneを正しく反映している。原因は2026-09-04の表示名変更バグ
    # （requester_name、上記の分岐）と同じ構造——AI自身が過去に生成した返信本文（会話履歴として
    # 毎回渡される）が変更前の口調のまま複数件残っており、モデルが新しいシステムプロンプトの指示より
    # 自分自身の直近の発言パターンを模倣する傾向を実機検証で確認した（変更後に投稿した3件とも
    # 旧口調のまま、という形で再現）。**この指示を冒頭の「口調: 」行の直後（requester_nameと同じ
    # 位置）に置いた最初の実装では、新旧の口調が1つの返信内に混在してしまい（例:「〜ですのよ、
    # 石井直樹さんなのだ」）完全には解消しなかった。実機検証で、生成の直前に位置するFIXED_RULES
    # （このプロンプトの中で最も影響力が強い位置、2026-09-17のタイムスタンプ漏れ込み・チャンネル名
    # 誤答バグ修正で確立済みの知見）の直後へ移動したところ改善したため、ここに配置している**
    # （requester_nameは人名の単純な置き換えで済むため元の位置でも安定して機能したが、口調は返信
    # 全体の語彙・語尾に及ぶ拡散的な性質のため、生成直前という強い位置が必要だったと考えられる）。
    lines.append(
        f'重要: あなたの現在の口調設定は「{persona_tone}」です。これより前の会話履歴に含まれる'
        f'あなた自身の過去の発言が、これと異なる語尾・言い回しを使っていても、それは口調が変更'
        f'される前の古い発言であり、絶対に真似しないでください。今から書く返信は、最初の文字から'
        f'最後の文字まで一貫して「{persona_tone}」のとおりに書いてください。'
    )
    return "\n".join(lines)


async def _resolve_handoff_label(pool, settings: dict) -> str:
    """fallback_handoff_user_id（F-17）を表示名に解決する。未指定・退出済み等で名前が引けない
    場合は「このチャンネルの管理者」という汎用ラベルにフォールバックする
    （_build_skills_section・_build_auto_response_sectionで共有）"""
    handoff_id = settings["fallback_handoff_user_id"]
    if handoff_id is not None:
        name = await pool.fetchval("SELECT name FROM users WHERE id = $1", handoff_id)
        if name:
            return name
    return "このチャンネルの管理者"


async def _build_skills_section(channel_id: int, settings: dict) -> str:
    """T-11 channel_skillsを「# あなたのスキル」節として列挙し、どのスキルにも当てはまらない
    業務依頼を受けた場合の引き継ぎ案内(F-17・fallback_handoff_user_id)もあわせて指示する
    （詳細設計書AIサポート10.2節）。スキルが1件も登録されていないチャンネルではこの節自体を
    省略する（FIXED_RULESの「できない」案内で足りるため）。メンション応答（_generate_and_post）
    専用で、要約（_build_summary_prompt）には使わない（要約は業務依頼への対応ではないため）。
    生成したAI発言の本文はF-41のメンション構造化（message_blocks）を経由しない点に注意
    （プレーンテキストとして「{名前}へ相談を」のように案内するのみで、クリック可能なメンションには
    ならない。実際にID参照メンションを作るにはA-11/A-14と同じ`insert_mention_blocks`をAI応答経路
    にも配線する必要があり、このスライスでは対象外）"""
    pool = get_pool()
    skills = await pool.fetch(
        "SELECT title, instructions FROM channel_skills WHERE channel_id = $1 ORDER BY created_at", channel_id
    )
    if not skills:
        return ""
    handoff_label = await _resolve_handoff_label(pool, settings)
    lines = ["", "# あなたのスキル", "依頼を受けたときは、次の手順に従って進めること。"]
    for s in skills:
        lines.append(f"## {s['title']}")
        lines.append(s["instructions"])
    lines.append("")
    lines.append(
        f"上記のいずれにも当てはまらない業務依頼を受けた場合は、正直に「その依頼には対応できません」と"
        f"伝えた上で、{handoff_label}へ相談するよう案内すること（存在しない対応ができるかのように答えないこと）"
    )
    return "\n".join(lines)


_AUTO_RESPONSE_LEVEL_LABEL = {
    "auto": "自動対応可",
    "confirm": "確認のうえ対応（現状は自動対応可と同じ扱いでよい。実行前確認の仕組み自体が未実装のため）",
    "human": "人が対応",
}


async def _build_auto_response_section(channel_id: int, settings: dict) -> str:
    """T-12 channel_auto_response_rulesを「# あなたが対応してよい依頼の目安」節として列挙する
    （F-16、詳細設計書AIサポート10.2節）。基本設計書8.1節は「人が対応」区分の依頼をAI呼び出し無しで
    直接引き継ぐと規定するが、依頼文をどのカテゴリに分類するかのアルゴリズムは規定していない
    （モジュール冒頭コメント参照）。ここでは専用の分類LLM呼び出しを追加せず、区分一覧をそのまま
    プロンプトへ渡し、通常の応答生成（1回のLLM呼び出し）の中でAI自身に「人が対応」該当を判断させ、
    該当する場合は回答本文で引き継ぎ案内をさせる。ルールが1件も登録されていないチャンネルでは
    この節自体を省略する。スキル同様、メンション応答専用で要約生成には使わない"""
    pool = get_pool()
    rules = await pool.fetch(
        """SELECT request_category, response_level FROM channel_auto_response_rules
           WHERE channel_id = $1 ORDER BY created_at""",
        channel_id,
    )
    if not rules:
        return ""
    handoff_label = await _resolve_handoff_label(pool, settings)
    lines = ["", "# あなたが対応してよい依頼の目安"]
    for r in rules:
        lines.append(f"- {r['request_category']}: {_AUTO_RESPONSE_LEVEL_LABEL[r['response_level']]}")
    lines.append("")
    lines.append(
        f"「人が対応」に区分される依頼を受けた場合は、あなた自身で回答を作成せず、正直に「担当者への"
        f"確認が必要な内容です」と伝えた上で、{handoff_label}へ相談するよう案内すること"
    )
    return "\n".join(lines)


def _completion_extra_kwargs(model: str) -> dict:
    """reasoning系モデルには`reasoning_effort='minimal'`を指定する（ai_client.is_reasoning_model・
    REASONING_MODELSを参照）。Kogackはリアルタイムチャットの応答生成であり複雑な多段階推論は
    不要なため、レイテンシ・コストを抑える最小値を使う（_generate_and_post・要約生成で共有）"""
    return {"reasoning_effort": "minimal"} if ai_client.is_reasoning_model(model) else {}


def detect_mention(body: str, persona_name: str) -> bool:
    """AIメンションの検知は本文中の「@ペルソナ名」の文字列一致のみ（ID参照化しない。
    基本設計書5.22節「設計判断」）。F-41のメンションピッカーの候補にはチャンネル本体・スレッド
    返信のいずれもチャンネルAIを含める（Composer.tsx）が、それでも本文としては同じ「@ペルソナ名」の
    プレーンテキストが入るだけで、この文字列一致の判定方法自体は変わらない。"""
    return f"@{persona_name}" in body


async def _fetch_settings(channel_id: int) -> dict | None:
    row = await get_pool().fetchrow(
        "SELECT * FROM channel_ai_settings WHERE channel_id = $1", channel_id
    )
    return dict(row) if row else None


async def _fetch_channel_context(channel_id: int) -> dict:
    """バグ修正（2026-09-07）: 従来はチャンネル自身の名前・説明文（topic）・作成者を一切AIへ
    渡しておらず、「このチャンネルについて説明して」のような素朴な質問にも「わかりません」としか
    答えられなかった（ユーザーからの指摘、実機テストでも再現を確認）。chadminが振る舞い定義に
    手動で書けば伝わるが、書かなければ完全に無知という状態だった。channels.name/topic・
    作成者名（いずれも非公開情報ではなく、参加者には既にチャンネル情報タブ等で見えている）を
    都度取得し、_build_system_promptへ渡す"""
    row = await get_pool().fetchrow(
        """SELECT c.name, c.topic, u.name AS creator_name
           FROM channels c LEFT JOIN users u ON u.id = c.created_by
           WHERE c.id = $1""",
        channel_id,
    )
    if row is None:
        return {"name": "", "topic": None, "creator_name": None}
    return dict(row)


async def _fetch_channel_members(channel_id: int) -> list[dict]:
    """ユーザーからの明示的な要望「AIにメンションして、このチャンネルに参加している人の情報を
    得られるようにしてほしい」への対応。A-46（GET /channels/{id}/members）と同じ氏名・chadmin
    区分を取得する。無効化アカウント（is_active=false）は実質退出済みと同様のため除外し、
    F-41メンション候補の絞り込み（is_active）と同じ基準にする。氏名順に返す（A-46と同じ）"""
    rows = await get_pool().fetch(
        """SELECT u.name, cm.is_channel_admin
           FROM channel_members cm JOIN users u ON u.id = cm.user_id
           WHERE cm.channel_id = $1 AND u.is_active = true ORDER BY u.name""",
        channel_id,
    )
    return [dict(r) for r in rows]


def _build_members_section(members: list[dict], persona_name: str, creator_name: str | None = None) -> str:
    """チャンネル参加者一覧を「# チャンネル参加者」節として列挙する。ここで渡す氏名・chadmin区分は
    非公開情報ではなく、既にF-41メンション候補・補足03メンバー一覧で参加者全員に見えている情報の
    ため、AIへ渡すこと自体に問題は無い（_fetch_channel_context・_build_skills_section等と同じ
    考え方）。参加者が1人もいない（想定しないが念のため）場合は節自体を省略する。
    **実機検証で判明した不具合と、複数回の切り分けの末にたどり着いた真因**: gpt-4.1-nanoが
    「そして私、{名前}です」「チャンネル管理者は私です」のように一覧中の人物（特に
    チャンネル作成者）を自分自身であるかのように名乗ってしまう不具合があった。以下の対策は
    いずれも単独では解消しなかった（実機で複数回再現を確認済み）: (1)「あなたは一覧の誰でも
    ない」という抽象的な注意書き、(2) ペルソナ名との明示的な対比、(3) 具体的な回答例の提示、
    (4) チャンネル管理者・作成者を名指しして「あなたと同一視しないこと」と明記する注意書き。
    依頼者本人との一致・chadmin区分の有無を変えても再現条件は変わらなかった一方、
    **チャンネル作成者（_fetch_channel_contextが渡す「作成者」）がこの一覧にも含まれる
    ケース（実運用ではほぼ常に起こる——作成者は必ず参加者としても登録される）でのみ再現し、
    作成者がこの一覧に含まれない・別チャンネルの作成者と一覧の人物が異なるケースでは
    一度も再現しなかった**。さらに、そのケースの中でも「チャンネル情報の行（あなたが常駐する
    チャンネルの説明）で作成者名に触れたうえで、この一覧でも同じ名前にもう一度触れる」という
    "同じ名前への2重の言及"を無くす（_build_system_promptのchannel_context行から作成者名の
    言及を省き、代わりにこの一覧の該当メンバーへ「（作成者）」タグとして一本化する）ことで、
    この不具合の再現条件下で複数回の実機検証を行い解消を確認した。抽象的な「あなたはこの中の
    誰でもない」という注意書きの精度を上げるより、そもそも同じ人物名を2つの文脈から重複して
    言及しないという構造上の変更のほうが効いたことになる。
    **バグ修正（ユーザーからの報告「参加者が自分しかいない非公開チャンネルで『メンバーは何人？』
    と聞いたら『4人です』と返ってきた」、2026-09-15）**: 本番DBを実際に調査し、該当チャンネルの
    参加者が実データ上も正確に1人だけ（AI側へ渡している一覧も同じく1人）であることを確認した
    うえで、システム全体の登録者数（7人）とも一致しないことから、バックエンド側のデータ集計に
    問題は無く、gpt-4.1-nanoが箇条書きの参加者一覧を正しく数えられず人数を答える際に誤った値を
    創作してしまう、上記の自己混同バグとは別系統のハルシネーションと判明した。小型モデルは
    プロンプト中の箇条書きを自分で数え上げることに弱いという既知の傾向（Slice 3で
    out_of_scope_policy='strict'の指示に従わせる際にも似た傾向を確認済み）に対する定番の緩和策
    として、モデルが数える必要が無いよう人数をあらかじめ計算し明示的な文として渡すようにした
    （下記「参加者の人数」行）。
    **バグ修正（ユーザーからの報告「AIに『このチャンネルの名前は？』と聞くと『わかりません』
    と答える」、2026-09-17）**: システムプロンプトを実機で直接検証したところ、チャンネル名・
    説明文・作成者・参加者の情報はいずれも正しくプロンプトに含まれているにもかかわらず、
    「チャンネルの名前」を尋ねられたときだけ複数回「参加者は{参加者名}さんです」（本来は
    参加者について聞かれたときの回答例として下記に用意していた定型文）をそのまま流用して
    答えてしまう不具合を確認した（6回試行中3回再現）。原因は、この例文を「回答例:」とだけ
    ラベル付けし、どの質問に使うべきかの条件を明示していなかったため、モデルが質問の内容に
    かかわらずこの具体的な言い回しをそのまま模倣してしまったことにあると判断した（2026-09-17の
    タイムスタンプ漏れ込み不具合＝AI自身の過去の発言パターンを模倣する現象と同種の「与えられた
    具体例をそのまま条件なしに再利用してしまう」傾向）。例文のラベルへ「参加者について尋ねられた
    とき限定」という適用条件と、「チャンネル名など参加者以外について尋ねられたときに流用しない
    こと」という明示的な禁止をあわせて追記した。
    **バグ修正（続報、2026-09-17）**: 上記の適用条件追記後も、非公開チャンネルの参加方法を
    尋ねる質問（本来「# 全チャンネル共通ルール」の招待方法ルールで答えるべき質問）に対して
    「参加者は{参加者名}さんです」という同じ定型文がそのまま返ってくる事象が実機で繰り返し
    確認された（10回試行中7回）。ラベルへ条件を書き足すだけでは、具体的な例文という文字列
    そのものが強い模倣対象であり続けることが分かったため、この関数の`_build_members_section`
    docstring冒頭に記載のとおり、そもそも2026-09-15時点でこの例文（回答例の提示）は自己混同
    バグを解消した決め手ではなかった（決め手は上記の「同じ人物名の重複言及を無くす」構造上の
    変更）ことを踏まえ、具体的な例文の提示自体を撤去し、「この一覧は参加者について尋ねられた
    ときにのみ使う」という抽象的な適用範囲の指示のみへ置き換えた（模倣の元になる具体的な
    文字列を残さない）。"""
    if not members:
        return ""
    lines = [
        "", "# チャンネル参加者",
        f"あなたの名前は「{persona_name}」というAIです。以下は全員人間の参加者であり、"
        f"あなた（{persona_name}）はこの中の誰でもありません。",
        f"参加者の人数: {len(members)}人（この数値をそのまま使うこと。自分で人数を数え直して"
        f"別の数字を答えないこと）",
        "このチャンネルに参加している人間の利用者は次のとおりです。",
    ]
    for m in members:
        tags = []
        if creator_name and m["name"] == creator_name:
            tags.append("作成者")
        if m["is_channel_admin"]:
            tags.append("チャンネル管理者")
        label = f"{m['name']}（{'・'.join(tags)}）" if tags else m["name"]
        lines.append(f"- {label}")
    lines.append(
        f"回答するときは、上記の誰か（チャンネル管理者・作成者を含む）を「私」と呼んだり、あなた"
        f"（{persona_name}）がその人物であるかのように述べたりしないこと。一人称「私」は"
        f"一切使わず、全員を氏名で呼ぶこと。この参加者一覧は、実際に参加者（誰が・何人）に"
        f"ついて尋ねられたときにのみ使うこと。参加者と無関係な質問（チャンネル名・Kogackの"
        f"使い方・その他の話題など）に対する回答の中に、この一覧の内容や「参加者は〜です」"
        f"という言い回しを含めないこと"
    )
    return "\n".join(lines)


async def _resolve_sender_names(rows) -> dict[int, str]:
    """履歴整形用にsender_user_idのnameだけ別途取得する（_generate_and_post・要約生成で共有）"""
    user_ids = {r["sender_user_id"] for r in rows if r["sender_user_id"] is not None}
    if not user_ids:
        return {}
    return {
        r["id"]: r["name"]
        for r in await get_pool().fetch("SELECT id, name FROM users WHERE id = ANY($1::bigint[])", list(user_ids))
    }


def _rows_to_chat_messages(rows, names: dict[int, str], include_timestamps: bool = False) -> list[dict]:
    """T-05の行をOpenAI Chat Completions形式のmessagesへ変換する（_generate_and_post・要約生成で共有）。
    include_timestamps（2026-09-15、ユーザーからの明示的な要望「特定の発言の投稿時間や、内容を
    読み取ってAIが回答することはできますか？」への対応）: Trueのとき各行の先頭に投稿時刻
    （JST、search_channel_history.searchのツール結果と同じ`[YYYY-MM-DD HH:MM]`書式で揃える）を
    付ける。従来はsearch_channel_historyツールで見つけた「古い」発言にしか投稿時刻が付かず、
    毎回のプロンプトに常に含まれる「直近の会話履歴（MAX_HISTORY_MESSAGES件）」には時刻情報が
    一切無いという非対称な状態だった（直近の発言について「これは何時の発言？」と聞かれても
    検索ツールを自発的に使わない限り正確に答えられなかった）。_generate_and_post（通常のメンション
    応答・スレッド内メンション・proactive）でのみTrueを渡し、F-14要約（_generate_summary_and_post）
    は対象外のまま（要約は個々の発言の時刻より内容の集約が主目的で、既存の動作検証済みの挙動を
    不用意に変えないため。ユーザーへの回答でも「直近の会話履歴」に限定して提案し合意を得た）

    **バグ修正（2026-09-17、ユーザーからの報告「AIの返信の先頭に[YYYY-MM-DD HH:MM]という
    日時表記が、2個付くとき・1個のとき・付かないときがある。これを付けないでほしい」）**:
    role='assistant'（AI自身の過去の発言）にも同じ`[timestamp] `を前置きしていたが、Chat
    Completions APIはモデル自身の新しい出力を「直前までのassistant役のやり取りの続き」として
    強く模倣する性質があり、これが「自分の過去の発言は毎回[timestamp]から始まっている」という
    パターンとしてモデルに学習され、新しい返信本文そのものの先頭にも同じ書式を実際に書き出して
    しまう（本文としてDBへ保存・画面に表示されてしまう）不具合を実機で確認した。一度この
    パターンが実際の発言本文に紛れ込むと、次にその発言が履歴として再度渡される際は
    「機械的に付与される外側の[timestamp]」＋「本文に紛れ込んだままの内側の[timestamp]」の
    二重になり、ユーザーの報告どおり「2個・1個・0個」がまちまちに見える状態になっていた
    （紛れ込みが起きた発言だけ二重、起きていない発言は単発、この機能自体が無かった古い発言は
    ゼロという素直な内訳）。role='ai'（assistant）の分岐だけ意図的にprefixを付けないようにし、
    モデルが模倣する元凶（自分自身の過去のassistant発言に付いたタイムスタンプ表記）を断つ。
    role='human'/BOT（いずれもuser役として渡す）は引き続きtimestamp付きのままとし、
    「いつ誰それが言ったか」という主要な用途（ユーザーからの当初の要望どおり）は維持する。
    これに加えて、_generate_and_postの保存直前で_strip_leaked_timestamp_prefix()により
    生成結果本文からこのパターンを機械的に除去する安全策も講じている（このバグ修正が
    完全に効かなかった場合や、user役側からの模倣が起きた場合でも、本文への実際の紛れ込みを
    確実に防ぐ二重の対策）"""
    messages: list[dict] = []
    for r in rows:
        if not r["body"]:
            continue
        # 2026-09-17のバグ修正: assistant役（AI自身の過去の発言）にはtimestampを付けない
        # （上記docstring参照。モデルが新しい出力へこの書式を模倣してしまう元凶を断つため）
        is_ai = r["sender_type"] == "ai"
        prefix = (
            f"[{r['created_at'].astimezone(JST).strftime('%Y-%m-%d %H:%M')}] "
            if include_timestamps and not is_ai
            else ""
        )
        if r["sender_type"] == "human":
            name = names.get(r["sender_user_id"], "利用者")
            messages.append({"role": "user", "content": f"{prefix}{name}: {r['body']}"})
        elif is_ai:
            messages.append({"role": "assistant", "content": r["body"]})
        else:
            # BOT発言（定期投稿・トリガー）はAIの自己発言と混同しないよう利用者側の文脈として渡す
            messages.append({"role": "user", "content": f"{prefix}{r['bot_display_name'] or 'BOT'}: {r['body']}"})
    return messages


# 上記_rows_to_chat_messagesのバグ修正（2026-09-17）と対になる、生成結果に対する安全策。
# モデルが指示に反して（あるいは既に汚染された履歴から）`[YYYY-MM-DD HH:MM] `をなお模倣して
# しまった場合でも、実際にDBへ保存・画面表示される本文には絶対に残らないようにする
# （プロンプト側の対策だけに頼らない、というこのプロジェクトで繰り返し採用してきた方針——
# 2026-09-11のsearch_documents tool_choice="required"強制と同じ「プロンプト指示だけでは
# 小型モデルの挙動を確実に制御できないことがある」という教訓に基づく）。先頭に連続して
# 複数個付いていた場合（二重に汚染されたケース）もまとめて除去できるよう`+`で繰り返しを許容する。
_LEAKED_TIMESTAMP_PREFIX_RE = re.compile(r"^(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*)+")


def _strip_leaked_timestamp_prefix(text: str) -> str:
    return _LEAKED_TIMESTAMP_PREFIX_RE.sub("", text)


async def maybe_trigger(
    channel_id: int, body: str, requested_by: int, thread_id: int | None = None, force_mention: bool = False,
) -> None:
    """A-11・A-14（thread_id指定時）・services/scheduled_dispatcher.py（定期投稿、force_mention=True）
    から呼ばれる。条件を満たせば非同期タスクとしてAI応答生成を起動する（fire-and-forget、
    REQ-N-05）。OPENAI_API_KEY未設定・AI無効のいずれかであれば何もしない。
    reaction_mode='mention_only'（既定）ではメンション無しの場合も何もしない。'proactive'（F-15）では
    メンション判定自体をスキップし、人間の発言であれば常に起動する（04_基本設計書.html 8.1節の
    設計判断どおり、追加のLLM呼び出しによる関連性判定は行わない）。
    thread_id指定時（スレッド返信、ユーザーからの明示的な要望で対応）・force_mention=True指定時
    （定期投稿、2026-09-15にユーザーからの明示的な要望で対応。理由は下記docstring末尾参照）は
    reaction_modeに関わらず常に明示的なメンションを要求する（proactiveをスレッド内の人間同士の
    やり取りにまで広げると、毎回AIが割り込んでくる形になり要望の範囲を超えるため。「呼びかけたら
    答える」という最小限の対応にとどめた。基本設計書8.1節に設計判断として追記）。
    メンションされた本文が要約依頼に見える場合（_looks_like_summarize_request）は通常の応答生成
    ではなく要約ボタン（A-15）と同じ処理を起動する（2026-09-14、ユーザーからの明示的な要望）。
    さらに本文に「今月分」「直近10日間分」等の対象期間指定があれば絞り込む
    （_parse_summary_range_from_text、2026-09-14、ユーザーからの明示的な要望）。
    **force_mention（2026-09-15追加）**: 定期投稿（F-36、sender_type='bot'）は「BOT投稿は
    @メンションでAIエージェントを起動しない」という既存の一貫原則（自動応答トリガーF-38との
    連鎖起動を防ぐための原則、モジュール冒頭コメント参照）の対象だったが、ユーザーから
    「定期投稿でAIをメンションしてもAIがいつも通り反応するようにしてほしい」との明示的な要望を
    受け、この1点（AIエージェント応答のみ）に限って例外にした。定期投稿の本文は管理者が事前に
    書いた固定文であり、AI自身の応答やF-38の自動応答トリガーが新たな定期投稿を作り出すことは
    無い（recurring_postsへの書き込み経路はS-06の管理画面のみ）ため、この例外自体が連鎖起動を
    生む経路にはならない。F-38自動応答トリガー（trigger_matcher）は今回のユーザーからの要望の
    対象外のため、定期投稿からは引き続き呼ばない（キーワードの偶然一致で予期しないBOT発言が
    繰り返し発生するリスクを避けるため、連鎖起動防止の原則をそちらでは維持する）。reaction_mode
    に関わらずforce_mention=Trueで常にメンション必須にしているのも、proactive設定のチャンネルで
    定期投稿のたびに（本来意図していない）AI応答が毎回付いてしまう驚きを避けるため（スレッド返信の
    設計判断と同じ考え方）。"""
    if not ai_client.is_configured():
        return
    settings = await _fetch_settings(channel_id)
    if settings is None or not settings["is_ai_enabled"]:
        return
    persona_name = settings["persona_name"] or "Kogack AI"
    requires_mention = thread_id is not None or force_mention or settings["reaction_mode"] != "proactive"
    if requires_mention and not detect_mention(body, persona_name):
        return
    if _looks_like_summarize_request(body, persona_name):
        text = body.replace(f"@{persona_name}", "")
        range_ = _parse_summary_range_from_text(text)
        since_dt, until_dt = _range_bounds(*range_) if range_ else (None, None)
        range_label = _format_range_label(*range_) if range_ else ""
        await _launch_summary(channel_id, thread_id, settings, requested_by, since_dt, until_dt, range_label)
        return
    asyncio.create_task(_generate_and_post(channel_id, settings, requested_by, thread_id))


async def _fetch_history_rows(channel_id: int, thread_id: int | None):
    """AI応答生成に渡す会話履歴を取得する。thread_id指定時はそのスレッド（元発言＋返信）に
    絞り込み、チャンネル全体の雑談ではなくスレッド自身の文脈を渡す（ユーザーからの明示的な要望で
    スレッド内メンションに対応した際に追加。F-14要約の_fetch_summary_source_rowsと異なり
    件数上限MAX_HISTORY_MESSAGESを掛ける点は通常のチャンネル発言と同じ扱いにする）"""
    pool = get_pool()
    if thread_id is not None:
        rows = await pool.fetch(
            """SELECT sender_type, sender_user_id, bot_display_name, body, created_at
               FROM messages
               WHERE (id = $1 OR thread_parent_id = $1)
                 AND deleted_at IS NULL AND generation_status IS NULL
               ORDER BY created_at DESC LIMIT $2""",
            thread_id, MAX_HISTORY_MESSAGES,
        )
    else:
        rows = await pool.fetch(
            """SELECT sender_type, sender_user_id, bot_display_name, body, created_at
               FROM messages
               WHERE channel_id = $1 AND deleted_at IS NULL AND thread_parent_id IS NULL
                 AND generation_status IS NULL
               ORDER BY created_at DESC LIMIT $2""",
            channel_id, MAX_HISTORY_MESSAGES,
        )
    return list(reversed(rows))


async def _run_chat_with_tools(
    messages: list[dict], model: str, channel_id: int, use_doc_tools: bool,
) -> tuple[str, dict, list[dict]]:
    """search_documents・search_channel_history・search_app_manualのFunction Callingを扱い
    ながら1回の応答生成を完了させる（Slice 3・2026-09-09でsearch_documentsのみ実装、
    2026-09-14にsearch_channel_history、2026-09-16にsearch_app_manualを追加）。
    search_channel_history・search_app_manualはいずれも常に提示する（索引の有無・per-channel
    設定という概念が無いため）。use_doc_tools=Trueの場合のみsearch_documentsもあわせて提示する
    （このチャンネルに索引済み文書がある場合のみ、doc_search.channel_has_indexed_documents）。
    最大MAX_TOOL_ROUNDS回まで、モデルからの検索要求→対応する検索を実行→結果をtoolメッセージ
    として返す、を繰り返す。
    最後の1ラウンドはtools自体を渡さず、モデルに必ずテキストで最終回答させる（ラウンド上限に
    達しても検索要求だけが続きテキストの回答が返らない、という空振りを防ぐ）。
    **バグ修正（2026-09-11）: use_doc_tools=Trueのときのみ、1ラウンド目はtool_choice="required"で
    強制的にいずれかの関数を呼ばせる。**tool_choiceを指定せず（既定"auto"）モデルの判断に任せると、
    gpt-4.1-nanoは実際に関数を呼び出さないまま「search_documentsを実行しています。少々お待ち
    ください。」のような予告の文章だけを返して応答を終えてしまうことがある（ユーザーからの報告で
    発覚、実機で再現・検証済み。プロンプトへ「予告だけで終えるな」という指示を追加しても改善せず、
    8問中6問が同じ失敗をした。1ラウンド目のみtool_choice="required"にする対処では、同条件で
    8問中8問とも実際に検索してから正しく回答するようになった）。2ラウンド目以降は"auto"のままと
    する。**search_channel_history・search_app_manualはいずれも常時提示するツールのため、
    これらを"required"の対象に含めると雑談を含むすべてのメンション応答で毎回1回分余計な
    ツール呼び出しが強制されコストが増え続けてしまう**（use_doc_tools=Falseのときは"required"に
    しない設計はこの理由による。ユーザー自身が2026-09-02に「直近の履歴だけ送ってコストを抑える」
    方針を選んだ経緯と同じ考え方）。
    戻り値: (最終応答テキスト, 集計済みusage{prompt_tokens,completion_tokens},
    citations[{folder_id,folder_name}]（search_documentsが実際に検索結果として使った文書、
    重複排除済み。search_channel_history・search_app_manualの結果はcitationの対象外——
    いずれも文書フォルダのような参照先IDを持たないため）)"""
    client = ai_client.get_client()
    total_prompt_tokens = 0
    total_completion_tokens = 0
    citations: dict[int, str] = {}
    tools = [SEARCH_CHANNEL_HISTORY_TOOL, SEARCH_APP_MANUAL_TOOL]
    if use_doc_tools:
        tools.append(SEARCH_DOCUMENTS_TOOL)
    max_rounds = MAX_TOOL_ROUNDS

    for round_num in range(max_rounds + 1):
        round_tools = tools if round_num < max_rounds else None
        extra = {"tool_choice": "required"} if round_num == 0 and use_doc_tools else {}
        res = await client.chat.completions.create(
            model=model, messages=messages, max_completion_tokens=MAX_OUTPUT_TOKENS,
            tools=round_tools,
            **extra,
            **_completion_extra_kwargs(model),
        )
        if res.usage:
            total_prompt_tokens += res.usage.prompt_tokens
            total_completion_tokens += res.usage.completion_tokens
        message = res.choices[0].message
        tool_calls = message.tool_calls
        if not tool_calls:
            reply = (message.content or "").strip() or "（回答を生成できませんでした）"
            usage = {"prompt_tokens": total_prompt_tokens, "completion_tokens": total_completion_tokens}
            citation_list = [{"folder_id": fid, "folder_name": name} for fid, name in citations.items()]
            return reply, usage, citation_list

        messages.append({
            "role": "assistant",
            "content": message.content,
            "tool_calls": [tc.model_dump() for tc in tool_calls],
        })
        for tc in tool_calls:
            try:
                query = json.loads(tc.function.arguments).get("query", "")
            except (json.JSONDecodeError, AttributeError):
                query = ""
            if tc.function.name == "search_documents":
                results = await doc_search.search(channel_id, query) if query else []
                for r in results:
                    citations[r["folder_id"]] = r["folder_name"]
                content = (
                    "\n\n---\n\n".join(f"[{r['folder_name']}]\n{r['content']}" for r in results)
                    if results
                    else "関連する内容が見つかりませんでした。"
                )
            elif tc.function.name == "search_channel_history":
                results = await channel_history_search.search(channel_id, query) if query else []
                content = (
                    "\n\n".join(
                        f"[{r['created_at'].strftime('%Y-%m-%d %H:%M')}] {r['sender_name']}: {r['body']}"
                        for r in results
                    )
                    if results
                    else "関連する過去の発言が見つかりませんでした。"
                )
            elif tc.function.name == "search_app_manual":
                results = await app_help_search.search(query) if query else []
                content = (
                    "\n\n---\n\n".join(r["content"] for r in results)
                    if results
                    else "関連する内容が見つかりませんでした。"
                )
            else:
                content = "不明な関数です"
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": content})

    # ここには到達しない想定（最後のラウンドはtools=Noneのためtool_callsが必ず空になり、
    # ループ内のreturnで抜ける）。到達した場合の安全側フォールバックとして残す。
    usage = {"prompt_tokens": total_prompt_tokens, "completion_tokens": total_completion_tokens}
    citation_list = [{"folder_id": fid, "folder_name": name} for fid, name in citations.items()]
    return "（回答を生成できませんでした）", usage, citation_list


async def _insert_citation_blocks(pool, message_id: int, citations: list[dict]) -> None:
    """search_documentsが実際に参照した文書を、F-20「回答根拠の提示」としてmessage_blocksへ
    保存する（block_type='citation'、T-07。フォルダ単位で重複排除済みのcitationsを受け取る想定）。
    メッセージ本文の更新とは別の独立した書き込みとして扱う（引用の記録に失敗しても回答本文自体は
    表示できるべきなので、あえて同一トランザクションにしない）"""
    for i, c in enumerate(citations):
        payload = {"folder_id": c["folder_id"], "folder_name": c["folder_name"]}
        await pool.execute(
            "INSERT INTO message_blocks (message_id, block_type, payload, sort_order) VALUES ($1, 'citation', $2::jsonb, $3)",
            message_id, json.dumps(payload), i,
        )


async def _generate_and_post(
    channel_id: int, settings: dict, requested_by: int, thread_id: int | None = None,
) -> None:
    pool = get_pool()
    persona_name = settings["persona_name"] or "Kogack AI"
    persona_icon_url = settings["persona_icon_url"]

    # 生成中プレースホルダ（詳細設計書10.3節で確定した方式）。bot_display_name/bot_icon_urlを
    # BOT発言と同じ列に流用し、生成時点のペルソナ名・アイコンをスナップショットする
    # （後で設定が変わっても、この発言の表示は変わらない）。thread_id指定時はそのスレッドへの
    # 返信として投稿する（start_summaryと同じ方式。基本設計書「スレッド内のやり取りは本体の
    # タイムラインに流れない」の一貫性のため、スレッド内メンションへの応答も同じスレッドに留める）
    placeholder = await pool.fetchrow(
        """INSERT INTO messages (channel_id, thread_parent_id, sender_type, body, generation_status,
               bot_display_name, bot_icon_url)
           VALUES ($1, $2, 'ai', '', 'generating', $3, $4) RETURNING id""",
        channel_id, thread_id, persona_name, persona_icon_url,
    )
    message_id = placeholder["id"]
    # A-74 生成の強制中断用に、この発言を今実行中のタスクとして登録する（ユーザーからの明示的な
    # 要望）。finallyで必ず取り除く（正常終了・エラー・中断のいずれの経路でも登録が残り続けない
    # ようにするため）。cancel_generationはこの対応表からタスクを見つけてasyncio.Task.cancel()する
    _active_generations[message_id] = asyncio.current_task()

    try:
        history_rows = await _fetch_history_rows(channel_id, thread_id)
        names = await _resolve_sender_names(history_rows)
        # 依頼者（今回メンション/proactiveでAIを起動した本人）の「今現在の」表示名。
        # namesは履歴に含まれる発言者しか持たないため、念のため直接引き直す（依頼者本人の
        # 発言は必ず履歴に含まれるはずだが、フォールバックとして安全側に倒す）
        requester_name = names.get(requested_by) or await pool.fetchval(
            "SELECT name FROM users WHERE id = $1", requested_by
        )
        channel_context = await _fetch_channel_context(channel_id)
        members_section = _build_members_section(
            await _fetch_channel_members(channel_id), persona_name, channel_context.get("creator_name")
        )
        auto_response_section = await _build_auto_response_section(channel_id, settings)
        skills_section = await _build_skills_section(channel_id, settings)
        # search_documentsツールは、このチャンネルの参照範囲に索引済み文書が1件でもある場合のみ
        # 提示する（Slice 3、2026-09-09）。無ければツール自体を持たせず、doc_scope_sectionも省略
        # （検索対象が無いのにツールだけ提示しても、モデルが空振りの検索を試みるだけで無駄）。
        # search_channel_history（2026-09-14）はこの判定に関わらず常に提示する（_run_chat_with_tools参照）
        use_doc_tools = await doc_search.channel_has_indexed_documents(channel_id)
        doc_scope_section = _build_doc_scope_section(settings["out_of_scope_policy"]) if use_doc_tools else ""
        messages: list[dict] = [
            {
                "role": "system",
                "content": _build_system_prompt(
                    settings, auto_response_section, skills_section, requester_name or "", channel_context,
                    doc_scope_section, members_section,
                ),
            }
        ]
        messages += _rows_to_chat_messages(history_rows, names, include_timestamps=True)

        model = ai_client.resolve_model(settings.get("ai_model"))
        reply, usage, citations = await _run_chat_with_tools(messages, model, channel_id, use_doc_tools)
        reply = _strip_leaked_timestamp_prefix(reply)

        # WHERE generation_status='generating' は、生成の完了とほぼ同時にcancel_generationが
        # 呼ばれた場合の競合対策（cancel_generation側が既にキャンセル済みメッセージへ更新していれば
        # ここは0件更新となり、完了した応答が中断メッセージを上書きしてしまうことを防ぐ）
        await pool.execute(
            """UPDATE messages SET body = $2, generation_status = NULL, updated_at = now()
               WHERE id = $1 AND generation_status = 'generating'""",
            message_id, reply,
        )
        if citations:
            await _insert_citation_blocks(pool, message_id, citations)

        if usage["prompt_tokens"] or usage["completion_tokens"]:
            cost = ai_client.estimate_cost_yen(model, usage["prompt_tokens"], usage["completion_tokens"])
            # request_payload: _run_chat_with_toolsは受け取ったmessagesをin-placeで拡張する
            # （tool_calls・tool結果を都度appendする）ため、ここで読める時点のmessagesが
            # 実際にOpenAI APIへ送信した内容の最終形（複数ラウンドあった場合は全ラウンド分の
            # 往復を含む）と一致する（A-76、ユーザーからの明示的な要望「AIとのやりとりを
            # 画面上確認できるようにしてほしい」、2026-09-17）
            await pool.execute(
                """INSERT INTO ai_usage_logs
                       (channel_id, requested_by, model, input_tokens, output_tokens, estimated_cost_yen,
                        message_id, request_payload)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)""",
                channel_id, requested_by, model,
                usage["prompt_tokens"], usage["completion_tokens"], cost,
                message_id, json.dumps(messages, ensure_ascii=False, default=str),
            )
    except asyncio.CancelledError:
        # cancel_generation()が呼ばれた場合。中断後のメッセージ本文は呼び出し元（cancel_generation）が
        # 責任を持って書き込み済みのため、ここでは対応表からの削除（finally）以外は何もしない。
        # そのまま再送出しないと、このタスク自体がキャンセルされたことにならない（asyncioの作法）
        raise
    except Exception:
        traceback.print_exc()
        await pool.execute(
            """UPDATE messages SET body = $2, generation_status = NULL, updated_at = now()
               WHERE id = $1 AND generation_status = 'generating'""",
            message_id, "（エラーが発生したため回答できませんでした）",
        )
    finally:
        _active_generations.pop(message_id, None)


async def cancel_generation(message_id: int) -> bool:
    """A-74: 生成中のAI発言を強制的に中断する（ユーザーからの明示的な要望「AIの生成をアプリ上で
    強制的に中断させる機能がほしい」）。_active_generationsに実行中のタスクが見つかればそれを
    キャンセルするが、見つからなくても失敗にしない（プロセス再起動等でタスク自体が失われた
    「オーファン化」した発言でも、DB側のgeneration_statusを直接クリアすることで復旧できる。
    実際にKogack運用中、バックエンドプロセスの再起動と生成中のタイミングが重なり、この復旧手段が
    無いために「生成中」のまま数十分固まり続けた発言が発生したことがあり、この関数が無いと
    利用者側には打つ手が無かった）。戻り値は実際にgenerating状態の発言を1件更新できたか
    （呼び出し元が404/400を判定するために使う）。"""
    task = _active_generations.get(message_id)
    if task is not None and not task.done():
        task.cancel()
    row = await get_pool().fetchrow(
        """UPDATE messages SET body = $2, generation_status = NULL, updated_at = now()
           WHERE id = $1 AND generation_status = 'generating' RETURNING id""",
        message_id, "（利用者により生成が中断されました）",
    )
    return row is not None


# F-14 やりとりの要約（基本設計書5.6節・8.7節「生成中表示」を流用）。手動実行のボタン契機のみで
# 自動要約はしない（要件定義書3.2節）。ユーザーの選択により、要約結果はメンション応答と同じ
# sender_type='ai'のチャンネル発言として投稿する（参加者全員に見える。AIバッジ・生成中表示・
# T-13コスト記録もメンション応答と共通の仕組みをそのまま使う）。
SUMMARY_INSTRUCTION = "ここまでのやりとりを要約してください。"


def _build_summary_prompt(settings: dict) -> str:
    persona_name = settings["persona_name"] or "Kogack AI"
    persona_tone = settings["persona_tone"] or "自然な日本語"
    return (
        f'あなたは「{persona_name}」というチャンネルAIです。口調: {persona_tone}\n'
        "これまでのやりとりの要約を求められています。次の方針に従うこと。\n"
        "- 誰が何を発言・決定したかが分かるよう、要点を箇条書きでまとめる\n"
        "- 未解決の質問や次に必要なアクションがあれば末尾に明記する\n"
        "- 元のやりとりに無い情報を推測・創作しない\n"
        "- 日本語で簡潔にまとめる（目安400字程度）"
    )


async def _fetch_summary_source_rows(
    channel_id: int, thread_id: int | None,
    since_dt: datetime | None = None, until_dt: datetime | None = None,
):
    """要約対象を取得する。thread_id指定時はそのスレッド全体（元発言＋返信、既定は上限なし。
    F-14の「スレッド内であればそのスレッド全体」の記載どおり）、未指定時はチャンネル本体の直近
    MAX_SUMMARY_CHANNEL_MESSAGES件。since_dt/until_dt（_range_bounds参照。ユーザーからの明示的な
    要望「今月分の要約して」「直近10日間分の要約して」で対象期間を絞れるようにした、2026-09-14）を
    指定すると、この範囲内の発言にさらに絞り込む（チャンネル本体は絞り込み後も件数上限は維持し、
    コストの際限ない増大を防ぐ。スレッド全体は従来どおり上限なしのまま）。いずれもgeneration_status
    IS NULLで絞り込み、生成中の（このリクエスト自身の仮レコードを含む）AI発言を要約対象から除外する。"""
    pool = get_pool()
    if thread_id is not None:
        conditions = ["(id = $1 OR thread_parent_id = $1)", "deleted_at IS NULL", "generation_status IS NULL"]
        params: list = [thread_id]
        if since_dt is not None:
            params.append(since_dt)
            conditions.append(f"created_at >= ${len(params)}")
        if until_dt is not None:
            params.append(until_dt)
            conditions.append(f"created_at < ${len(params)}")
        rows = await pool.fetch(
            f"""SELECT sender_type, sender_user_id, bot_display_name, body, created_at
                FROM messages WHERE {' AND '.join(conditions)} ORDER BY created_at ASC""",
            *params,
        )
        return list(rows)

    conditions = ["channel_id = $1", "deleted_at IS NULL", "thread_parent_id IS NULL", "generation_status IS NULL"]
    params = [channel_id]
    if since_dt is not None:
        params.append(since_dt)
        conditions.append(f"created_at >= ${len(params)}")
    if until_dt is not None:
        params.append(until_dt)
        conditions.append(f"created_at < ${len(params)}")
    params.append(MAX_SUMMARY_CHANNEL_MESSAGES)
    rows = await pool.fetch(
        f"""SELECT sender_type, sender_user_id, bot_display_name, body, created_at
            FROM messages WHERE {' AND '.join(conditions)}
            ORDER BY created_at DESC LIMIT ${len(params)}""",
        *params,
    )
    return list(reversed(rows))


async def start_summary(
    channel_id: int, thread_id: int | None, requested_by: int,
    since_date: date | None = None, until_date: date | None = None,
) -> dict:
    """A-15から呼ばれる。ボタン操作は条件を満たさない場合に黙って何もしないのではなく理由を
    返す必要があるため、ここでis_configured/is_ai_enabledを検証してから_launch_summaryへ渡す
    （チャット上の「要約して」検知＝maybe_triggerは既にこれらを検証済みのため、_launch_summaryを
    直接呼び再検証しない。SummaryUnavailableもそちら側では投げない）。since_date/until_dateは
    S-06要約ボタンの対象期間指定（ユーザーからの明示的な要望、2026-09-14。JSTの暦日、両端含む）"""
    if not ai_client.is_configured():
        raise SummaryUnavailable("AI機能が設定されていないため要約できません")
    settings = await _fetch_settings(channel_id)
    if settings is None or not settings["is_ai_enabled"]:
        raise SummaryUnavailable("このチャンネルのAIは無効になっています")
    since_dt, until_dt = _range_bounds(since_date, until_date)
    range_label = _format_range_label(since_date, until_date)
    return await _launch_summary(channel_id, thread_id, settings, requested_by, since_dt, until_dt, range_label)


async def _launch_summary(
    channel_id: int, thread_id: int | None, settings: dict, requested_by: int,
    since_dt: datetime | None = None, until_dt: datetime | None = None, range_label: str = "",
) -> dict:
    """生成中プレースホルダを同期的に作成してから、実際の生成は_generate_summary_and_postへ任せる
    非同期タスクとして起動する（8.7節と同じ方式）。thread_id指定時はそのスレッドへの返信として、
    未指定時はチャンネル本体の新規発言として投稿する。呼び出し元（start_summary＝A-15ボタン、
    maybe_trigger＝チャット上の「要約して」検知）がそれぞれの流儀で設定の妥当性を確認済みである
    前提で、ここでは再検証しない。since_dt/until_dt/range_labelは対象期間指定（_range_bounds・
    _format_range_labelの結果、2026-09-14）。"""
    pool = get_pool()
    persona_name = settings["persona_name"] or "Kogack AI"
    persona_icon_url = settings["persona_icon_url"]
    placeholder = await pool.fetchrow(
        """INSERT INTO messages (channel_id, thread_parent_id, sender_type, body, generation_status,
               bot_display_name, bot_icon_url, is_summary)
           VALUES ($1, $2, 'ai', '', 'generating', $3, $4, true) RETURNING id""",
        channel_id, thread_id, persona_name, persona_icon_url,
    )
    message_id = placeholder["id"]
    asyncio.create_task(
        _generate_summary_and_post(
            channel_id, thread_id, message_id, settings, requested_by, since_dt, until_dt, range_label,
        )
    )
    return {"message_id": message_id, "thread_id": thread_id}


async def _generate_summary_and_post(
    channel_id: int, thread_id: int | None, message_id: int, settings: dict, requested_by: int,
    since_dt: datetime | None = None, until_dt: datetime | None = None, range_label: str = "",
) -> None:
    pool = get_pool()
    # A-74 生成の強制中断用の登録（_generate_and_postと同じ考え方。要約もgeneration_status='generating'の
    # プレースホルダを使うため、同じ「プロセス再起動でオーファン化する」リスクを持つ）
    _active_generations[message_id] = asyncio.current_task()

    def _prefixed(body: str) -> str:
        # 対象期間が指定されている場合、生成結果の冒頭に確定的に付け足す（LLMのプロンプト指示
        # だけに任せると省略・誤記するリスクがあるため、_format_range_labelの出力をそのまま使う）
        return f"{range_label}\n{body}" if range_label else body

    try:
        rows = await _fetch_summary_source_rows(channel_id, thread_id, since_dt, until_dt)
        if not rows:
            await pool.execute(
                """UPDATE messages SET body = $2, generation_status = NULL, updated_at = now()
                   WHERE id = $1 AND generation_status = 'generating'""",
                message_id, _prefixed("（対象期間に要約する発言がありませんでした）" if range_label else "（要約する発言がありませんでした）"),
            )
            return

        names = await _resolve_sender_names(rows)
        messages: list[dict] = [{"role": "system", "content": _build_summary_prompt(settings)}]
        messages += _rows_to_chat_messages(rows, names)
        messages.append({"role": "user", "content": SUMMARY_INSTRUCTION})

        client = ai_client.get_client()
        model = ai_client.resolve_model(settings.get("ai_model"))
        res = await client.chat.completions.create(
            model=model, messages=messages,
            max_completion_tokens=MAX_OUTPUT_TOKENS,
            **_completion_extra_kwargs(model),
        )
        reply = _prefixed((res.choices[0].message.content or "").strip() or "（要約を生成できませんでした）")

        await pool.execute(
            """UPDATE messages SET body = $2, generation_status = NULL, updated_at = now()
               WHERE id = $1 AND generation_status = 'generating'""",
            message_id, reply,
        )

        if res.usage:
            cost = ai_client.estimate_cost_yen(model, res.usage.prompt_tokens, res.usage.completion_tokens)
            await pool.execute(
                """INSERT INTO ai_usage_logs
                       (channel_id, requested_by, model, input_tokens, output_tokens, estimated_cost_yen,
                        message_id, request_payload)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)""",
                channel_id, requested_by, model,
                res.usage.prompt_tokens, res.usage.completion_tokens, cost,
                message_id, json.dumps(messages, ensure_ascii=False, default=str),
            )
    except asyncio.CancelledError:
        raise  # _generate_and_postと同じ理由（cancel_generationが本文の更新に責任を持つ）
    except Exception:
        traceback.print_exc()
        await pool.execute(
            """UPDATE messages SET body = $2, generation_status = NULL, updated_at = now()
               WHERE id = $1 AND generation_status = 'generating'""",
            message_id, "（エラーが発生したため要約できませんでした）",
        )
    finally:
        _active_generations.pop(message_id, None)
