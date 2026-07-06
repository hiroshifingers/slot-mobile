# 実践カウンター（F1: スマホ単体）

店内実践用の設定判別カウンターアプリ（PWA）。仕様: `../docs_practice_counter_spec_2026-06-28.md`

## できること（F1）
- **機種プロファイル・ライブラリ**: 機種ごとに専用カウンターを自作（「VVV2用」「東京グール用」…）。カウンター項目・判別メトリックは全て編集可。
- **判別エンジン**:
  - 項目別に「実測 vs 設定別理論値」を表示（**分数1/X** / **％振り分け** をモード選択）
  - **合算・派生指標**（`expr:` 例 `kyodo_bell + oshi_bell`）
  - **分母の柔軟化**（総回転数 / 有効G数 / 他カウンタ）
  - **総合期待度**: 全項目を尤度統合し「設定1〜6の事後確率%」を算出（回転数が少ないうちは確信度が自動で低く出る）
- **大当たり履歴入力**: ＋履歴登録 → G数自動フォーカス＋数値キーボード → 種別を大タップ → 保存。累計G・初当たり率を自動再計算。行タップで編集/削除。
- **オフライン動作**: IndexedDB に即保存、Service Worker でアプリシェルをキャッシュ。ホーム画面に追加可（PWA）。

初回起動時、DBが空なら「デモ機（動作確認用）」を1機種だけ自動生成します。

## 同期＝Supabase クラウド（F2）
データの唯一の保管場所は **Supabase（PostgreSQL・無料枠）**。スマホPWAとPC(Streamlit)が同じクラウドを見る。

- **スマホ**: 初回のみ Supabase アカウントでログイン（以降セッション保持で自動）。機種・記録は起動時／前面復帰時／削除時に**自動でクラウドへ同期**。記録タブ右上の **🔄同期** で手動同期も可。オフライン時はIndexedDBに保存し、オンライン復帰時に同期。
- **PC**: slot-analyzer の Streamlit メニュー「**実践カウンター**」で同じデータを閲覧・操作（記録一覧／機種別サマリー／機種名変更／削除）。詳細なカウンター・判別メトリック編集はスマホ側で行う。
- テーブル: `pc_profiles` / `pc_sessions`（`id, data(jsonb), updated_at, deleted`）。マージは `updated_at` のLWW。**削除は tombstone(`deleted=true`) で双方向に伝播**（「消しても復活」問題は解消）。進行中セッション(active)は同期しない。
- 認証: 単一アカウント＋RLS（`auth.uid() = user_id`）。スマホは anon キー＋ログイン、PCは service_role キー（`config/secrets.local.json`・gitignore）。
- スキーマ: `supabase_schema.sql`（Supabase SQL Editorで実行済み）。
- クライアント: スマホ=`js/cloud.js`（素のfetchでGoTrue+PostgREST・追加ライブラリ無し）、PC=`backend/practice_counter/cloud.py`。

## アプリ本体の配信（PWAファイルの置き場）
同期はクラウドだが、PWAの静的ファイル自体はどこかから配信する必要がある。当面は `sync_server.py`（または `python3 -m http.server`）でPC LANから配信し、スマホは自宅Wi-Fiで一度読み込む（以降はSWキャッシュでオフライン起動、同期はクラウド経由でどこでも）。

```bash
cd "practice_counter"
python3 sync_server.py     # 静的配信。/api/sync は旧LAN方式の名残で未使用
```

- スマホの完全なPC非依存化（外出先でのアプリ更新も可）にしたい場合は、`GitHub Pages / Netlify` 等のHTTPS公開ホスティングに置くのが最終形（HTTPSはService Workerにも最適）。→ 次段の任意タスク。

## まだやらないこと
- 本体ML投入（やらない・撤回済み）
- PWAのHTTPS公開ホスティング（任意・PC完全非依存化のため）
