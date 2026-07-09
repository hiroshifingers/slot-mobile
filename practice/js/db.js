/* ===== IndexedDB ラッパ（実践カウンター） =====
 * stores:
 *   profiles : 機種プロファイル（ライブラリ） keyPath=id
 *   sessions : 終了済みセッション（履歴/統計）   keyPath=id
 *   stores_m : 店舗マスタ（換金率など）          keyPath=id
 *   days     : 1日の収支（日付＋店舗で1件）        keyPath=id
 *   state    : 現在の進行中セッションなど        keyPath=key  ('active' に1件)
 */
const DB = (() => {
  const NAME = 'practice_counter';
  const VERSION = 2; // v2: stores_m（店舗マスタ）/ days（収支）を追加
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('stores_m')) db.createObjectStore('stores_m', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('days'))     db.createObjectStore('days',     { keyPath: 'id' });
        if (!db.objectStoreNames.contains('state'))    db.createObjectStore('state',    { keyPath: 'key' });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return open().then(db => db.transaction(store, mode).objectStore(store));
  }
  function reqP(r) {
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }

  return {
    // --- profiles ---
    async getProfiles()      { return reqP((await tx('profiles', 'readonly')).getAll()); },
    async getProfile(id)     { return reqP((await tx('profiles', 'readonly')).get(id)); },
    async putProfile(p)      { p.updatedAt = Date.now(); return reqP((await tx('profiles', 'readwrite')).put(p)); },
    // 同期マージ用: updatedAt を書き換えずそのまま保存（LWWの時刻を保つ）
    async putProfileRaw(p)   { return reqP((await tx('profiles', 'readwrite')).put(p)); },
    async delProfile(id)     { return reqP((await tx('profiles', 'readwrite')).delete(id)); },

    // --- sessions (archived) ---
    async getSessions()      { return reqP((await tx('sessions', 'readonly')).getAll()); },
    async putSession(s)      { return reqP((await tx('sessions', 'readwrite')).put(s)); },
    async delSession(id)     { return reqP((await tx('sessions', 'readwrite')).delete(id)); },

    // --- stores (店舗マスタ：換金率など) ---
    async getStores()        { return reqP((await tx('stores_m', 'readonly')).getAll()); },
    async putStore(s)        { s.updatedAt = Date.now(); return reqP((await tx('stores_m', 'readwrite')).put(s)); },
    async putStoreRaw(s)     { return reqP((await tx('stores_m', 'readwrite')).put(s)); },
    async delStore(id)       { return reqP((await tx('stores_m', 'readwrite')).delete(id)); },

    // --- days (1日の収支) ---
    async getDays()          { return reqP((await tx('days', 'readonly')).getAll()); },
    async putDay(d)          { d.updatedAt = Date.now(); return reqP((await tx('days', 'readwrite')).put(d)); },
    async putDayRaw(d)       { return reqP((await tx('days', 'readwrite')).put(d)); },
    async delDay(id)         { return reqP((await tx('days', 'readwrite')).delete(id)); },

    // --- active state ---
    async getActive()        { const r = await reqP((await tx('state', 'readonly')).get('active')); return r ? r.value : null; },
    async setActive(v)       { return reqP((await tx('state', 'readwrite')).put({ key: 'active', value: v })); },
    async clearActive()      { return reqP((await tx('state', 'readwrite')).delete('active')); },
  };
})();
