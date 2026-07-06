/* ===== Supabase クラウド同期クライアント（実践カウンター） =====
 * 追加ライブラリ無し・素のfetchでSupabase(PostgREST + GoTrue)を叩く。
 *  - 認証: 単一アカウントでログイン。access_token/refresh_tokenをlocalStorageに保持し、
 *          401時に自動リフレッシュ。一度ログインすればオフラインでもアプリは動く
 *          （同期だけがオンライン時に走る）。
 *  - データ: pc_profiles / pc_sessions（id, data(jsonb), updated_at(bigint), deleted(bool)）。
 *            user_idはRLSのdefault auth.uid()でサーバー側が自動付与するので送らない。
 * anonキーは公開前提のキー（RLSで保護）なのでここに埋め込んでよい。
 */
const Cloud = (() => {
  const URL_BASE = 'https://nuzoujiezlvnkdzprpzb.supabase.co';
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im51em91amllemx2bmtkenBycHpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzMzg3NjIsImV4cCI6MjA5ODkxNDc2Mn0._t2MiRX-iZnOReaRe0AK_JH-AHM6U0qczUsKWVasRyU';
  const LS_SESSION = 'pc_supabase_session';

  let session = null;
  try { session = JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); } catch (e) { session = null; }

  const saveSession = (s) => { session = s; localStorage.setItem(LS_SESSION, JSON.stringify(s)); };
  const clearSession = () => { session = null; localStorage.removeItem(LS_SESSION); };

  function hasSession() { return !!(session && session.access_token); }
  function email() { return session && session.user && session.user.email || ''; }

  async function signIn(mail, password) {
    const r = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: mail, password }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error_description || body.msg || body.error || ('ログイン失敗 (' + r.status + ')'));
    saveSession(body);
    return body;
  }

  async function refresh() {
    if (!session || !session.refresh_token) throw new Error('no session');
    const r = await fetch(`${URL_BASE}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!r.ok) { clearSession(); throw new Error('セッション切れ（再ログインが必要）'); }
    saveSession(await r.json());
  }

  function signOut() { clearSession(); }

  // 認証付きREST呼び出し。401なら1度だけリフレッシュして再試行。
  async function api(path, opts) {
    opts = opts || {};
    const build = () => ({
      ...opts,
      headers: {
        apikey: ANON,
        Authorization: 'Bearer ' + (session ? session.access_token : ANON),
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    let r = await fetch(URL_BASE + path, build());
    if (r.status === 401 && session && session.refresh_token) {
      await refresh();
      r = await fetch(URL_BASE + path, build());
    }
    return r;
  }

  // upsert（id重複はマージ）。rows=[{id,data,updated_at,deleted}]
  async function upsert(table, rows) {
    if (!rows || !rows.length) return;
    const r = await api(`/rest/v1/${table}`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
    if (!r.ok) throw new Error(`${table} 保存失敗 ${r.status}: ${await r.text()}`);
  }

  // 全行取得（updated_at昇順）。件数が少ない前提でフル取得。
  async function selectAll(table) {
    const r = await api(`/rest/v1/${table}?select=id,data,updated_at,deleted&order=updated_at.asc`, { method: 'GET' });
    if (!r.ok) throw new Error(`${table} 取得失敗 ${r.status}`);
    return r.json();
  }

  return { hasSession, email, signIn, refresh, signOut, upsert, selectAll };
})();
