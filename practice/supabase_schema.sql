-- ============================================================
-- 実践カウンター 同期用スキーマ（Supabase / PostgreSQL）
-- Supabase Dashboard → SQL Editor に貼り付けて「Run」で実行する。
-- 認証方式: 単一アカウントでログイン（RLS=ログイン済みユーザーは自分の行だけ）
-- 既存の slot_data.sqlite とは無関係（クラウド側だけに置く）
-- ============================================================

-- 機種プロファイル（ライブラリ）。data に現行IndexedDBの profile オブジェクトをそのまま格納
create table if not exists pc_profiles (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at bigint not null,            -- クライアントの updatedAt(ms)。LWWの比較キー
  deleted    boolean not null default false
);

-- 終了済みセッション（記録）。data に session オブジェクトをそのまま格納
create table if not exists pc_sessions (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at bigint not null,
  deleted    boolean not null default false
);

-- 差分取得を速くする（user_id + updated_at）
create index if not exists pc_profiles_user_updated on pc_profiles (user_id, updated_at);
create index if not exists pc_sessions_user_updated on pc_sessions (user_id, updated_at);

-- RLS: ログイン済みユーザーは「自分の行」だけ読み書きできる
alter table pc_profiles enable row level security;
alter table pc_sessions enable row level security;

drop policy if exists own_profiles on pc_profiles;
drop policy if exists own_sessions on pc_sessions;

create policy own_profiles on pc_profiles
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy own_sessions on pc_sessions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
