/* ===== 実践カウンター アプリ本体 ===== */
(() => {
  const $app = document.getElementById('app');
  const $modalRoot = document.getElementById('modal-root');
  const uid = (pre) => pre + '_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '') || ('c' + Date.now().toString(36).slice(-4));
  // ドラッグ&ドロップで並べ替え（handle経由のみdraggable化=入力欄の誤爆防止）
  function bindDragReorder(container, itemSelector, arr, onChange) {
    if (!container) return;
    let dragIdx = null;
    container.querySelectorAll(itemSelector).forEach((el, idx) => {
      el.draggable = false;
      const handle = el.querySelector('.drag-handle');
      if (handle) {
        handle.addEventListener('mousedown', () => { el.draggable = true; });
        handle.addEventListener('touchstart', () => { el.draggable = true; }, { passive: true });
      }
      el.addEventListener('mouseup', () => { el.draggable = false; });
      el.addEventListener('dragstart', (ev) => {
        dragIdx = idx;
        el.classList.add('dragging');
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', String(idx));
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        el.draggable = false;
        container.querySelectorAll(itemSelector).forEach(x => x.classList.remove('drag-over'));
      });
      el.addEventListener('dragover', (ev) => { ev.preventDefault(); el.classList.add('drag-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', (ev) => {
        ev.preventDefault();
        el.classList.remove('drag-over');
        if (dragIdx === null || dragIdx === idx) return;
        const [item] = arr.splice(dragIdx, 1);
        arr.splice(idx, 0, item);
        dragIdx = null;
        onChange();
      });
    });
  }
  function fmtCounterFrac(prof, key, cnt) {
    const c = (prof.counters || []).find(x => x.key === key);
    if (!c || !c.denominator) return '';
    const denom = Engine.resolveDenom(c.denominator, state.active);
    if (!(denom > 0)) return '';
    const mode = c.display_mode || 'both';
    const fracStr = `${cnt}/${denom}`;
    const pctStr = `<span class="pct-val">${(cnt / denom * 100).toFixed(1)}%</span>`;
    if (mode === 'frac') return fracStr;
    if (mode === 'percent') return pctStr;
    return `${fracStr} ${pctStr}`;
  }

  // 大当たり契機（液晶ゾーン/レア役/状態）のグループ定義。1大当たり＝1契機で手動選択
  const TRIGGER_GROUPS = [
    { value: 'zone',  label: 'ゾーン' },
    { value: 'rare',  label: 'レア役' },
    { value: 'state', label: '状態/特化' },
    { value: '',      label: 'その他' },
  ];
  const groupLabel = (g) => (TRIGGER_GROUPS.find(x => x.value === (g || '')) || { label: 'その他' }).label;
  function triggerLabel(prof, key) {
    if (!key) return '';
    const t = (prof.hit_triggers || []).find(x => x.key === key);
    return t ? t.label : key;
  }

  /* ---------- 計算式（formula）ヘルパー ---------- */
  const OP_DISP = { '+': '＋', '-': '−', '*': '×', '/': '÷', '(': '（', ')': '）' };
  const BASE_VARS = [
    { var: 'total_g', label: '総G' },
    { var: 'played_g', label: '実践G' },
    { var: 'valid_g', label: '有効G数' },
    { var: 'hits', label: '大当り回数' },
  ];
  function tokLabel(tok, prof) {
    if (tok.op) return OP_DISP[tok.op] || tok.op;
    if (tok.num != null) return String(tok.num);
    const bv = BASE_VARS.find(b => b.var === tok.var);
    if (bv) return bv.label;
    if (tok.var === 'counter') { const c = (prof.counters || []).find(x => x.key === tok.ref); return c ? c.label : '?'; }
    if (tok.var === 'type') return '種別:' + tok.ref;
    if (tok.var === 'trig') return '契機:' + triggerLabel(prof, tok.ref);
    if (tok.var === 'group') return '契機群:' + groupLabel(tok.ref);
    if (tok.var === 'metric') { const m = (prof.metrics || []).find(x => x.key === tok.ref); return '判別:' + (m ? m.label : '?'); }
    return '?';
  }
  function tokClass(tok) { return tok.op ? 'ftok op' : (tok.num != null ? 'ftok num' : 'ftok var'); }
  function formulaText(tokens, prof) { return (tokens && tokens.length) ? tokens.map(t => tokLabel(t, prof)).join(' ') : ''; }

  // 旧 source/denominator 文字列 → tokens 配列（編集時に読み込むため）
  function parseExprToTokens(expr) {
    const toks = []; const re = /\s*([A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*|[-+*/()])/g; let m;
    while ((m = re.exec(expr))) {
      const tk = m[1];
      if (/^[-+*/()]$/.test(tk)) toks.push({ op: tk });
      else if (/^\d/.test(tk)) toks.push({ num: Number(tk) });
      else toks.push({ var: 'counter', ref: tk });
    }
    return toks;
  }
  function legacyToTokens(str, isDenom) {
    if (str == null || str === '') return [];
    if (isDenom) {
      if (str === 'total_spins') return [{ var: 'played_g' }];
      if (str === 'valid_g') return [{ var: 'valid_g' }];
      if (str === 'hits') return [{ var: 'hits' }];
      if (str.startsWith('counter:')) return [{ var: 'counter', ref: str.slice(8) }];
      const n = Number(str); return isFinite(n) ? [{ num: n }] : [];
    }
    if (str.startsWith('counter:')) return [{ var: 'counter', ref: str.slice(8) }];
    if (str.startsWith('hit:')) {
      const body = str.slice(4), eq = body.indexOf('='); if (eq < 0) return [];
      const f = body.slice(0, eq), v = body.slice(eq + 1);
      if (f === 'type') return [{ var: 'type', ref: v }];
      if (f === 'trigger') return [{ var: 'trig', ref: v }];
      if (f === 'triggerGroup') return [{ var: 'group', ref: v }];
      return [];
    }
    if (str.startsWith('expr:')) return parseExprToTokens(str.slice(5));
    return [];
  }
  // メトリックの現在の式tokens（新形式tokens優先・無ければ旧形式から変換）
  function metricTokens(m, which) {
    if (which === 'source') return m.sourceTokens ? m.sourceTokens : legacyToTokens(m.source, false);
    return m.denomTokens ? m.denomTokens : legacyToTokens(m.denominator, true);
  }
  const emptySession = () => ({ total_spins: 0, start_spins: 0, valid_g: 0, counts: {}, history: [] });

  // tab: アプリ階層（session/profiles/edit/history）, sessionTab: セッション内タブ（pageId | 'hits' | 'judge' | 'settings'）
  let state = { tab: 'session', sessionTab: null, profiles: [], active: null, editing: null };

  /* ---------- ユーティリティ ---------- */
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 1600);
  }
  const fmtRate = (spins, hits) => hits ? '1/' + Math.round(spins / hits) : '—';
  const playedG = (s) => Math.max(0, (Number(s.total_spins) || 0) - (Number(s.start_spins) || 0));

  // 旧データ/新規プロファイルに pages を保証し、counterのpageId補完
  function ensurePages(p) {
    if (!p.pages || !p.pages.length) {
      p.pages = [
        { id: uid('pg'), name: 'カウント1' },
        { id: uid('pg'), name: 'カウント2' },
        { id: uid('pg'), name: 'カウント3' },
      ];
    }
    (p.counters || []).forEach(c => { if (!c.pageId || !p.pages.find(pg => pg.id === c.pageId)) c.pageId = p.pages[0].id; });
    // 旧「差枚」追加項目は廃止（履歴は組込みメモに統一）
    if (p.hit_extra_fields) p.hit_extra_fields = p.hit_extra_fields.filter(f => !(f.key === 'diff' || f.label === '差枚'));
    if (!p.hit_triggers) p.hit_triggers = []; // 大当たり契機（旧プロファイル互換）
    return p;
  }

  /* ---------- セッション ---------- */
  function newSession(profile) {
    return {
      id: uid('s'), profileId: profile.id, machine: profile.machine,
      startedAt: Date.now(), total_spins: 0, start_spins: 0, valid_g: 0,
      counts: {}, history: [], note: ''
    };
  }
  async function saveActive() { if (state.active) await DB.setActive(state.active); }

  /* ============================================================
     画面: 実践（セッション）= 2段タブ構成
  ============================================================ */
  function renderSession() {
    const prof = state.active ? state.profiles.find(p => p.id === state.active.profileId) : null;

    if (!state.active || !prof) {
      $app.innerHTML = `
        <div class="screen-head"><h1>実践</h1></div>
        <div class="empty">
          <div class="big">🎰</div>
          <p>セッションが未開始です。<br>機種を選んで開始してください。</p>
          <div class="btn-row" style="justify-content:center">
            <button class="btn primary" id="pick-machine">機種を選んで開始</button>
          </div>
        </div>`;
      document.getElementById('pick-machine').onclick = pickMachineToStart;
      return;
    }

    ensurePages(prof);
    const pages = prof.pages;
    // sessionTab 妥当性
    const validTabs = pages.map(p => p.id).concat(['hits', 'judge', 'settings']);
    if (!state.sessionTab || !validTabs.includes(state.sessionTab)) state.sessionTab = pages[0].id;

    const s = state.active;
    const exp = Engine.totalExpectation(prof.metrics, s);

    // --- ヘッダー（常時表示・コンパクト） ---
    const header = `
      <div class="sess-header">
        <div class="sh-top">
          <div class="sh-name">${esc(prof.machine)}</div>
          <div class="sh-best" id="hdr-best">${bestChipHtml(exp)}</div>
        </div>
        <div class="sh-spins">
          <label><span>総G</span>
            <input id="total-spins" inputmode="numeric" value="${s.total_spins || ''}" placeholder="0" /></label>
          <label><span>スタートG</span>
            <input id="start-spins" inputmode="numeric" value="${s.start_spins || ''}" placeholder="0" /></label>
          <div class="played">実践<br><b id="played-g">${playedG(s)}</b>G</div>
        </div>
      </div>`;

    // --- 2段タブ ---
    const tabbar = `
      <div class="sess-tabs">
        <div class="sess-tabrow pages">
          ${pages.map(pg => `<button class="stab ${state.sessionTab === pg.id ? 'on' : ''}" data-stab="${pg.id}">${esc(pg.name)}</button>`).join('')}
        </div>
        <div class="sess-tabrow sys">
          <button class="stab ${state.sessionTab === 'hits' ? 'on' : ''}" data-stab="hits">履歴</button>
          <button class="stab ${state.sessionTab === 'judge' ? 'on' : ''}" data-stab="judge">判別</button>
          <button class="stab ${state.sessionTab === 'settings' ? 'on' : ''}" data-stab="settings">設定</button>
        </div>
      </div>`;

    // --- 中身 ---
    let content = '';
    if (state.sessionTab === 'hits') content = renderHitsTab(prof);
    else if (state.sessionTab === 'judge') content = renderJudgeTab(exp, prof);
    else if (state.sessionTab === 'settings') content = renderSettingsTab(prof);
    else content = renderCounterPage(prof, state.sessionTab);

    $app.innerHTML = header + tabbar + `<div id="sess-content">${content}</div>`;

    // events: 総G / スタートG（フォーカス維持のため部分更新）
    const onSpins = () => {
      saveActive();
      const pgEl = document.getElementById('played-g'); if (pgEl) pgEl.textContent = playedG(s);
      refreshHeaderBest(prof);
      if (state.sessionTab === 'judge') refreshJudge(prof);
      else if (state.sessionTab === 'hits') refreshRates(prof);
    };
    const ts = document.getElementById('total-spins');
    ts.oninput = () => { s.total_spins = parseInt(ts.value || '0', 10) || 0; onSpins(); };
    const ss = document.getElementById('start-spins');
    ss.oninput = () => { s.start_spins = parseInt(ss.value || '0', 10) || 0; onSpins(); };
    // tabs
    document.querySelectorAll('[data-stab]').forEach(b =>
      b.onclick = () => { state.sessionTab = b.getAttribute('data-stab'); renderSession(); });

    bindContentEvents(prof);
  }

  function bestChipHtml(exp) {
    if (exp && exp.anyData && exp.posterior) {
      return `最有力 <b>設定${exp.best}</b> <span class="pct">${exp.posterior[exp.best].toFixed(0)}%</span>`;
    }
    return `<span class="muted small">データ待ち</span>`;
  }
  function refreshHeaderBest(prof) {
    const el = document.getElementById('hdr-best');
    if (el) el.innerHTML = bestChipHtml(Engine.totalExpectation(prof.metrics, state.active));
  }

  /* ---- カウント画面 ---- */
  function renderCounterPage(prof, pageId) {
    const counters = (prof.counters || []).filter(c => c.pageId === pageId);
    if (!counters.length) {
      return `<div class="empty"><div class="big">👆</div><p>このページにカウンターがありません。<br>「機種」タブで追加・割り当てできます。</p></div>`;
    }
    const s = state.active;
    return `<div class="counter-grid">
      ${counters.map(c => {
        const cnt = s.counts[c.key] || 0;
        const fracStr = fmtCounterFrac(prof, c.key, cnt);
        const fracHtml = fracStr ? `<div class="cnt-frac">${fracStr}</div>` : '';
        return `
          <div class="counter" data-inc="${esc(c.key)}">
            <div class="lbl">${esc(c.label)}</div>
            <div class="cnt">${cnt}</div>
            ${fracHtml}
            <div class="cnt-bottom">
              <button class="dec" data-dec="${esc(c.key)}">−</button>
            </div>
          </div>`;
      }).join('')}
    </div>`;
  }

  /* ---- 履歴タブ ---- */
  function renderHitsTab(prof) {
    const s = state.active;
    const hits = s.history.length;
    return `
      <div id="rate-cards">${renderRateCards(prof)}</div>
      <button class="btn primary block" id="add-hit" style="margin:12px 0">＋ 履歴登録</button>
      ${hits ? `<div class="hist-list">${s.history.map((h, i) => ({ h, i })).reverse().map(({ h, i }) => {
          const note = [h.savedAt || '', triggerLabel(prof, h.trigger), h.extra, h.memo].filter(Boolean).join(' · ');
          return `<div class="hist-row" data-edit-hit="${i}">
            <span class="g">${esc(h.g)}G</span>
            <span class="ty">${esc(h.type)}</span>
            ${note ? `<span class="ex">${esc(note)}</span>` : ''}
          </div>`; }).join('')}</div>`
        : `<div class="muted small center">まだ登録がありません。打ち始めたら ＋履歴登録 から。</div>`}
    `;
  }

  // RB率/BB率/ART率…（機種の種別ごと）＋ 合算率。分母=実践G。各率の下に回数。
  function renderRateCards(prof) {
    const s = state.active;
    const pg = playedG(s);
    const types = (prof.bonus_types && prof.bonus_types.length) ? prof.bonus_types : [];
    const cards = types.map(t => {
      const cnt = s.history.filter(h => h.type === t).length;
      return { label: t + '率', rate: fmtRate(pg, cnt), cnt };
    });
    const total = s.history.length;
    cards.push({ label: '合算率', rate: fmtRate(pg, total), cnt: total });
    return `<div class="stat-grid">${cards.map(c => `
      <div class="stat"><div class="k">${esc(c.label)}</div>
        <div class="v">${c.rate}</div>
        <div class="rcnt">${c.cnt}回</div></div>`).join('')}</div>`;
  }
  function refreshRates(prof) {
    const el = document.getElementById('rate-cards');
    if (el) el.innerHTML = renderRateCards(prof);
  }

  /* ---- 判別タブ ---- */
  function renderJudgeTab(exp, prof) {
    if (!prof.metrics || !prof.metrics.length) {
      return `<div class="muted small center" style="padding:24px 0">判別メトリックが未設定です。「機種」タブで追加できます。</div>`;
    }
    let body = '';
    if (exp.anyData && exp.posterior) {
      body += `<div class="exp-best">最有力 <b>設定${exp.best}</b> <span class="muted small">(${exp.usedCount}項目を統合)</span></div>`;
      body += `<div class="exp-bars">` + Engine.SETTINGS.map(sv => {
        const p = exp.posterior[sv]; if (p == null) return '';
        return `<div class="exp-row"><div class="s">${sv}</div>
          <div class="exp-track"><div class="exp-fill ${sv === exp.best ? 'best' : ''}" style="width:${p.toFixed(1)}%"></div></div>
          <div class="p">${p.toFixed(1)}%</div></div>`;
      }).join('') + `</div>`;
    } else {
      body += `<div class="muted small">データ待ち（総回転数やカウントを入れると算出されます）</div>`;
    }
    const metricsHtml = exp.computed.map(m => {
      const measTxt = !m.active ? '<span class="muted">—</span>'
        : (m.mode === 'fraction'
            ? `<span class="now">${m.measured ? '1/' + Math.round(m.measured) : '—'}</span> <span class="muted small">(${m.k}/${m.N})</span>`
            : `<span class="now">${m.measured != null ? m.measured.toFixed(1) + '%' : '—'}</span> <span class="muted small">(${m.k}/${m.N})</span>`);
      const chips = Engine.SETTINGS.map(sv => {
        const raw = m.settings && m.settings[sv];
        const has = raw != null && raw !== '' && isFinite(Number(raw)) && Number(raw) > 0;
        const disp = !has ? '—' : (m.mode === 'fraction' ? '1/' + raw : raw + '%');
        return `<div class="schip ${m.active && m.include && m.near === sv ? 'near' : ''}"><div class="ss">${sv}</div><div class="sv">${disp}</div></div>`;
      }).join('');
      return `<div class="metric ${m.include ? '' : 'excluded'}">
        <div class="mhead">
          <button class="mtoggle ${m.include ? 'on' : ''}" data-mtoggle="${esc(m.key)}" title="総合判別に統合">${m.include ? '✓' : ''}</button>
          <span class="mname">${esc(m.label)}</span><span class="meas">${measTxt}</span>
        </div>
        <div class="setting-chips">${chips}</div>
      </div>`;
    }).join('');
    return `<div class="card" id="judge-card"><div id="judge-body">${body}</div>
      <div style="margin-top:12px">${metricsHtml}</div></div>`;
  }
  function refreshJudge(prof) {
    const c = document.getElementById('sess-content');
    if (c) c.innerHTML = renderJudgeTab(Engine.totalExpectation(prof.metrics, state.active), prof);
    bindContentEvents(prof);
  }

  /* ---- 設定タブ ---- */
  function renderSettingsTab(prof) {
    const s = state.active;
    return `
      <div class="card">
        <h2>このセッション</h2>
        <label class="field"><span>有効G数（任意・分母に使う場合）</span>
          <input id="set-validg" inputmode="numeric" value="${s.valid_g || ''}" placeholder="0" /></label>
        <label class="field"><span>メモ</span>
          <textarea id="set-note" rows="2" placeholder="台番・所感など">${esc(s.note)}</textarea></label>
      </div>
      <div class="card">
        <h2>セッション操作</h2>
        <button class="btn block" id="sm-archive">保存して終了（履歴に残す）</button>
        <div style="height:8px"></div>
        <button class="btn block" id="sm-switch">別の機種に切替（保存して終了）</button>
        <div style="height:8px"></div>
        <button class="btn block danger" id="sm-discard">破棄してリセット</button>
      </div>
      <div class="card">
        <h2>機種設定</h2>
        <button class="btn block ghost" id="go-edit">この機種のカウンター/判別を編集</button>
      </div>
    `;
  }

  /* ---- セッション内コンテンツのイベント束ね ---- */
  function bindContentEvents(prof) {
    const s = state.active;
    // カウンター
    document.querySelectorAll('[data-inc]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-dec]')) return;
        const k = el.getAttribute('data-inc');
        s.counts[k] = (s.counts[k] || 0) + 1;
        el.querySelector('.cnt').textContent = s.counts[k];
        const fracEl = el.querySelector('.cnt-frac');
        if (fracEl) fracEl.innerHTML = fmtCounterFrac(prof, k, s.counts[k]);
        saveActive(); refreshHeaderBest(prof);
      });
    });
    document.querySelectorAll('[data-dec]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const k = el.getAttribute('data-dec');
        s.counts[k] = Math.max(0, (s.counts[k] || 0) - 1);
        const card = el.closest('.counter');
        card.querySelector('.cnt').textContent = s.counts[k];
        const fracEl = card.querySelector('.cnt-frac');
        if (fracEl) fracEl.innerHTML = fmtCounterFrac(prof, k, s.counts[k]);
        saveActive(); refreshHeaderBest(prof);
      });
    });
    // 履歴
    const addHit = document.getElementById('add-hit');
    if (addHit) addHit.onclick = () => openHitModal(prof, -1);
    document.querySelectorAll('[data-edit-hit]').forEach(el =>
      el.onclick = () => openHitModal(prof, parseInt(el.getAttribute('data-edit-hit'), 10)));
    // 判別: 統合トグル
    document.querySelectorAll('[data-mtoggle]').forEach(b =>
      b.onclick = async () => {
        const key = b.getAttribute('data-mtoggle');
        const m = prof.metrics.find(x => x.key === key);
        m.include = m.include === false ? true : false;
        await DB.putProfile(prof); await reload();
        const np = state.profiles.find(p => p.id === prof.id);
        refreshJudge(np); refreshHeaderBest(np);
      });
    // 設定タブ
    const vg = document.getElementById('set-validg');
    if (vg) vg.oninput = () => { s.valid_g = parseInt(vg.value || '0', 10) || 0; saveActive(); };
    const note = document.getElementById('set-note');
    if (note) note.oninput = () => { s.note = note.value; saveActive(); };
    const arch = document.getElementById('sm-archive');
    if (arch) arch.onclick = async () => { await archiveSession(); render(); toast('履歴に保存しました'); };
    const sw = document.getElementById('sm-switch');
    if (sw) sw.onclick = async () => { await archiveSession(); pickMachineToStart(); };
    const disc = document.getElementById('sm-discard');
    if (disc) disc.onclick = async () => { if (confirm('このセッションを破棄しますか？')) { state.active = null; await DB.clearActive(); render(); } };
    const ge = document.getElementById('go-edit');
    if (ge) ge.onclick = () => editProfile(state.profiles.find(p => p.id === prof.id));
  }

  async function pickMachineToStart() {
    if (!state.profiles.length) { toast('先に「機種」タブで機種を作成してください'); state.tab = 'profiles'; render(); return; }
    openModal(`
      <h3>機種を選んで開始</h3>
      <div>${state.profiles.map(p => `
        <div class="list-item" data-start="${p.id}">
          <span class="ti">🎰</span>
          <div class="body"><div class="t">${esc(p.machine)}</div>
            <div class="sub">カウンター${(p.counters||[]).length}・判別${(p.metrics||[]).length}</div></div>
          <span class="chev">▶</span>
        </div>`).join('')}</div>
      <div class="mfoot"><button class="btn ghost" data-close>閉じる</button></div>
    `, (root) => {
      root.querySelectorAll('[data-start]').forEach(el => el.onclick = async () => {
        const prof = state.profiles.find(p => p.id === el.getAttribute('data-start'));
        ensurePages(prof);
        state.active = newSession(prof); state.sessionTab = prof.pages[0].id;
        await saveActive(); closeModal(); render();
      });
    });
  }

  async function archiveSession() {
    const s = state.active; if (!s) return;
    s.closedAt = Date.now();
    s.cumG = s.history.reduce((a, h) => a + (Number(h.g) || 0), 0);
    s.hits = s.history.length;
    await DB.putSession(s);
    state.active = null; await DB.clearActive();
  }

  /* ---------- 履歴登録モーダル ---------- */
  function openHitModal(prof, index) {
    const editing = index >= 0;
    const cur = editing ? state.active.history[index] : { g: '', type: (prof.bonus_types || [])[0] || '', trigger: '', extra: '', memo: '' };
    const types = prof.bonus_types && prof.bonus_types.length ? prof.bonus_types : ['当たり'];
    const extras = prof.hit_extra_fields || [];
    const triggers = prof.hit_triggers || [];

    openModal(`
      <h3>${editing ? '履歴を編集' : '大当たり履歴'}</h3>
      <label class="field">
        <span>G数（スタート＝前回からの回転数）</span>
        <input id="hit-g" inputmode="numeric" value="${esc(cur.g)}" placeholder="例 280" style="font-size:22px;font-weight:800" />
      </label>
      <label class="field"><span>種別</span></label>
      <div class="type-grid" id="hit-types">
        ${types.map(t => `<button class="type-btn ${t === cur.type ? 'sel' : ''}" data-type="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>
      ${triggers.length ? `
        <label class="field" style="margin-top:12px"><span>契機（液晶ゾーン・レア役・状態 / 1つ選択・もう一度タップで解除）</span></label>
        <div id="hit-triggers">
          ${TRIGGER_GROUPS.filter(g => triggers.some(t => (t.group || '') === g.value)).map(g => `
            <div class="trg-group">
              <div class="trg-glabel">${esc(g.label)}</div>
              <div class="type-grid">
                ${triggers.filter(t => (t.group || '') === g.value).map(t =>
                  `<button class="type-btn ${t.key === cur.trigger ? 'sel' : ''}" data-trigger="${esc(t.key)}">${esc(t.label)}</button>`).join('')}
              </div>
            </div>`).join('')}
        </div>` : ''}
      ${extras.map(f => `
        <label class="field" style="margin-top:12px"><span>${esc(f.label)}</span>
          <input data-extra="${esc(f.key)}" inputmode="${f.input === 'number' ? 'numeric' : 'text'}" value="${esc((cur.extraVals && cur.extraVals[f.key]) || '')}" /></label>
      `).join('')}
      <label class="field" style="margin-top:12px"><span>メモ</span>
        <input id="hit-memo" value="${esc(cur.memo || '')}" placeholder="台番・所感など" /></label>
      <div class="mfoot">
        ${editing ? '<button class="btn danger" id="hit-del">削除</button>' : ''}
        <button class="btn primary" id="hit-save">保存</button>
      </div>
    `, (root) => {
      const gEl = root.querySelector('#hit-g');
      setTimeout(() => { gEl.focus(); gEl.setSelectionRange(gEl.value.length, gEl.value.length); }, 60);
      let selType = cur.type;
      root.querySelectorAll('[data-type]').forEach(b => b.onclick = () => {
        selType = b.getAttribute('data-type');
        root.querySelectorAll('[data-type]').forEach(x => x.classList.toggle('sel', x === b));
      });
      let selTrigger = cur.trigger || '';
      root.querySelectorAll('[data-trigger]').forEach(b => b.onclick = () => {
        const k = b.getAttribute('data-trigger');
        selTrigger = (selTrigger === k) ? '' : k; // もう一度タップで解除
        root.querySelectorAll('[data-trigger]').forEach(x => x.classList.toggle('sel', x.getAttribute('data-trigger') === selTrigger));
      });
      root.querySelector('#hit-save').onclick = async () => {
        const g = parseInt(gEl.value || '0', 10) || 0;
        if (!selType) { toast('種別を選んでください'); return; }
        const extraVals = {};
        root.querySelectorAll('[data-extra]').forEach(i => extraVals[i.getAttribute('data-extra')] = i.value);
        const extraStr = extras.map(f => extraVals[f.key] ? `${f.label}:${extraVals[f.key]}` : '').filter(Boolean).join(' ');
        const memo = (root.querySelector('#hit-memo') || {}).value || '';
        const trig = (prof.hit_triggers || []).find(t => t.key === selTrigger);
        const now = new Date();
        const savedAt = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
        const rec = { g, type: selType, trigger: selTrigger, triggerGroup: trig ? (trig.group || '') : '', extra: extraStr, extraVals, memo, savedAt };
        if (editing) state.active.history[index] = rec; else state.active.history.push(rec);
        await saveActive(); closeModal(); renderSession();
      };
      if (editing) root.querySelector('#hit-del').onclick = async () => {
        state.active.history.splice(index, 1); await saveActive(); closeModal(); renderSession();
      };
    });
  }

  /* ============================================================
     画面: 機種（プロファイル・ライブラリ）
  ============================================================ */
  function renderProfiles() {
    $app.innerHTML = `
      <div class="screen-head"><h1>機種</h1>
        <div class="btn-row" style="margin:0;gap:8px">
          <button class="btn" id="add-ghoul">＋ L東京喰種</button>
          <button class="btn primary" id="new-prof">＋ 新規</button>
        </div></div>
      ${state.profiles.length ? state.profiles.map(p => `
        <div class="list-item" data-open="${p.id}">
          <span class="ti">🛠</span>
          <div class="body"><div class="t">${esc(p.machine)}</div>
            <div class="sub">画面${(p.pages||[]).length}・カウンター${(p.counters||[]).length}・判別${(p.metrics||[]).length}</div></div>
          <span class="chev">›</span>
        </div>`).join('')
        : `<div class="empty"><div class="big">🛠</div><p>機種カウンターがまだありません。<br>「VVV2用」「東京グール用」など、機種ごとに作っていきます。</p></div>`}
    `;
    document.getElementById('new-prof').onclick = () => editProfile(null);
    document.getElementById('add-ghoul').onclick = async () => {
      const dup = state.profiles.some(p => p.machine === 'L東京喰種（スマスロ）');
      if (dup && !confirm('すでに「L東京喰種（スマスロ）」があります。もう1つ追加しますか？')) return;
      const p = buildTokyoGhoulPreset();
      await DB.putProfile(p);
      await reload();
      editProfile(state.profiles.find(x => x.id === p.id)); // 追加した機種の中身を確認できるよう編集画面へ
    };
    document.querySelectorAll('[data-open]').forEach(el =>
      el.onclick = () => editProfile(state.profiles.find(p => p.id === el.getAttribute('data-open'))));
  }

  function editProfile(profile) {
    state.editing = profile
      ? ensurePages(JSON.parse(JSON.stringify(profile)))
      : ensurePages({ id: uid('p'), machine: '', bonus_types: ['BB', 'RB'], hit_triggers: [], hit_extra_fields: [], counters: [], metrics: [], createdAt: Date.now() });
    state.tab = 'edit'; renderEditor();
  }

  function renderEditor() {
    const e = state.editing;
    const counterOpts = (sel) => e.counters.map(c => `<option value="counter:${esc(c.key)}" ${sel === 'counter:' + c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
    const pageOpts = (sel) => e.pages.map(pg => `<option value="${esc(pg.id)}" ${sel === pg.id ? 'selected' : ''}>${esc(pg.name)}</option>`).join('');
    // 大当たり契機・グループ・種別を判別メトリックのソースに使えるようにする
    const hitOpts = (sel) => {
      let html = '';
      (e.hit_triggers || []).forEach(t => {
        const v = 'hit:trigger=' + t.key;
        html += `<option value="${esc(v)}" ${sel === v ? 'selected' : ''}>契機: ${esc(t.label || t.key)}</option>`;
      });
      [...new Set((e.hit_triggers || []).map(t => t.group || ''))].forEach(g => {
        const v = 'hit:triggerGroup=' + g;
        html += `<option value="${esc(v)}" ${sel === v ? 'selected' : ''}>契機グループ: ${esc(groupLabel(g))}</option>`;
      });
      (e.bonus_types || []).forEach(t => {
        const v = 'hit:type=' + t;
        html += `<option value="${esc(v)}" ${sel === v ? 'selected' : ''}>種別: ${esc(t)}</option>`;
      });
      return html;
    };
    const srcOpts = (sel) => counterOpts(sel) + hitOpts(sel);

    $app.innerHTML = `
      <div class="screen-head">
        <button class="btn ghost small" id="ed-back">‹ 戻る</button>
        <h1 style="text-align:center">${e.machine ? esc(e.machine) : '新規機種'}</h1>
        <button class="btn primary small" id="ed-save">保存</button>
      </div>

      <div class="card">
        <label class="field"><span>機種名</span>
          <input id="ed-machine" value="${esc(e.machine)}" placeholder="例 ヴヴヴ2 / 東京グール" /></label>
      </div>

      <div class="card">
        <div class="row spread" style="margin-bottom:8px"><h2 style="margin:0">カウント画面（タブ）</h2>
          <button class="btn small" id="add-page">＋ 追加</button></div>
        <div class="muted small" style="margin-bottom:8px">タブ名は編集できます。各カウンターをどの画面に置くか割り当て。</div>
        <div id="ed-pages">
          ${e.pages.map((pg, i) => `
            <div class="ed-sort-row">
              <span class="drag-handle" title="ドラッグで並べ替え">⠿</span>
              <input data-pg-name="${i}" value="${esc(pg.name)}" />
              <button class="btn ghost small" data-delpg="${i}" ${e.pages.length <= 1 ? 'disabled' : ''}>削除</button>
            </div>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="row spread" style="margin-bottom:8px"><h2 style="margin:0">大当たり種別（履歴のタップ選択肢）</h2>
          <button class="btn small" id="add-type">＋ 追加</button></div>
        <div class="muted small" style="margin-bottom:8px">名前を編集できます。並び順＝履歴タブの率カード順。</div>
        <div id="ed-types">
          ${e.bonus_types.map((t, i) => `
            <div class="ed-sort-row">
              <span class="drag-handle" title="ドラッグで並べ替え">⠿</span>
              <input data-type-name="${i}" value="${esc(t)}" />
              <button class="btn ghost small" data-deltype="${i}">✕</button>
            </div>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="row spread" style="margin-bottom:8px"><h2 style="margin:0">大当たり契機（履歴のタップ選択肢）</h2>
          <button class="btn small" id="add-trigger">＋ 追加</button></div>
        <div class="muted small" style="margin-bottom:8px">液晶ゾーン・レア役・状態を1リストに。1大当たり＝1契機（手動選択）。判別メトリックのソースに使えます（振り分け%・分母＝大当たり回数）。</div>
        <div id="ed-triggers">
          ${e.hit_triggers.map((t, i) => `
            <div class="ed-sort-row">
              <span class="drag-handle" title="ドラッグで並べ替え">⠿</span>
              <input data-trg-label="${i}" value="${esc(t.label)}" placeholder="例 100ゾーン / 強チェ / 直撃" />
              <select data-trg-group="${i}" class="trg-gsel">
                ${TRIGGER_GROUPS.map(g => `<option value="${g.value}" ${(t.group || '') === g.value ? 'selected' : ''}>${esc(g.label)}</option>`).join('')}
              </select>
              <button class="btn ghost small" data-deltrg="${i}">✕</button>
            </div>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="row spread" style="margin-bottom:8px"><h2 style="margin:0">カウンター</h2>
          <button class="btn small" id="add-counter">＋ 追加</button></div>
        <div class="muted small" style="margin-bottom:8px">設定判別に効くものだけ絞って登録</div>
        <div id="ed-counters">
          ${e.counters.map((c, i) => `
            <div class="edit-item">
              <div class="eh">
                <span class="drag-handle" title="ドラッグで並べ替え">⠿</span>
                <span class="nm">${esc(c.label) || '(無名)'}</span>
                <button class="del" data-delc="${i}">削除</button>
              </div>
              <div class="edit-grid">
                <label class="field" style="margin:0"><span>ラベル</span>
                  <input data-c-label="${i}" value="${esc(c.label)}" /></label>
                <label class="field" style="margin:0"><span>画面</span>
                  <select data-c-page="${i}">${pageOpts(c.pageId)}</select></label>
              </div>
              <div class="edit-grid">
                <label class="field" style="margin:8px 0 0"><span>母数（表示の分母）</span>
                  <select data-c-denom="${i}">
                    <option value="" ${!c.denominator ? 'selected' : ''}>なし（カウントのみ）</option>
                    <option value="total_spins" ${c.denominator === 'total_spins' ? 'selected' : ''}>実践G（総−スタート）</option>
                    <option value="valid_g" ${c.denominator === 'valid_g' ? 'selected' : ''}>有効G数</option>
                    ${counterOpts(c.denominator)}
                  </select></label>
                <label class="field" style="margin:8px 0 0"><span>表示</span>
                  <select data-c-dispmode="${i}">
                    <option value="both" ${(c.display_mode || 'both') === 'both' ? 'selected' : ''}>分数と％両方</option>
                    <option value="frac" ${c.display_mode === 'frac' ? 'selected' : ''}>分数のみ（1/X）</option>
                    <option value="percent" ${c.display_mode === 'percent' ? 'selected' : ''}>％のみ</option>
                  </select></label>
              </div>
            </div>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="row spread" style="margin-bottom:8px"><h2 style="margin:0">判別メトリック</h2>
          <button class="btn small" id="add-metric">＋ 追加</button></div>
        <div class="muted small" style="margin-bottom:8px">ソース(分子)と分母を計算式で作成→設定別の理論値を登録（分数1/X か %振り分け）。空欄の設定は判別に使いません。</div>
        <div id="ed-metrics">
          ${e.metrics.map((m, i) => renderMetricEditor(m, i, e)).join('')}
        </div>
      </div>

      <button class="btn danger block" id="ed-delete" ${state.profiles.find(p => p.id === e.id) ? '' : 'style="display:none"'}>この機種を削除</button>
    `;

    document.getElementById('ed-machine').oninput = (ev) => e.machine = ev.target.value;

    // pages
    document.getElementById('add-page').onclick = () => { e.pages.push({ id: uid('pg'), name: 'カウント' + (e.pages.length + 1) }); renderEditor(); };
    document.querySelectorAll('[data-pg-name]').forEach(inp =>
      inp.oninput = () => { e.pages[+inp.getAttribute('data-pg-name')].name = inp.value; });
    document.querySelectorAll('[data-delpg]').forEach(b =>
      b.onclick = () => {
        const i = +b.getAttribute('data-delpg'); const removed = e.pages[i].id;
        e.pages.splice(i, 1);
        e.counters.forEach(c => { if (c.pageId === removed) c.pageId = e.pages[0].id; });
        renderEditor();
      });
    bindDragReorder(document.getElementById('ed-pages'), '.ed-sort-row', e.pages, renderEditor);

    // 種別（prompt はPWAで不安定なため自前モーダル）
    document.getElementById('add-type').onclick = () => {
      openModal(`
        <h3>大当たり種別を追加</h3>
        <label class="field"><span>種別名（例 BB / RB / ART / AT / CZ）</span>
          <input id="bt-input" placeholder="種別名" /></label>
        <div class="mfoot">
          <button class="btn ghost" data-close>キャンセル</button>
          <button class="btn primary" id="bt-add">追加</button>
        </div>
      `, (root) => {
        const inp = root.querySelector('#bt-input');
        setTimeout(() => inp.focus(), 60);
        const add = () => { const v = inp.value.trim(); if (v) { e.bonus_types.push(v); closeModal(); renderEditor(); } };
        root.querySelector('#bt-add').onclick = add;
        inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') add(); });
      });
    };
    document.querySelectorAll('[data-type-name]').forEach(inp =>
      inp.oninput = () => { e.bonus_types[+inp.getAttribute('data-type-name')] = inp.value; });
    document.querySelectorAll('[data-deltype]').forEach(x =>
      x.onclick = () => { e.bonus_types.splice(+x.getAttribute('data-deltype'), 1); renderEditor(); });
    bindDragReorder(document.getElementById('ed-types'), '.ed-sort-row', e.bonus_types, renderEditor);

    // hit_triggers（大当たり契機）
    document.getElementById('add-trigger').onclick = () => { e.hit_triggers.push({ key: uid('t'), label: '', group: 'zone' }); renderEditor(); };
    document.querySelectorAll('[data-trg-label]').forEach(inp =>
      inp.oninput = () => { e.hit_triggers[+inp.getAttribute('data-trg-label')].label = inp.value; });
    document.querySelectorAll('[data-trg-group]').forEach(sel =>
      sel.onchange = () => { e.hit_triggers[+sel.getAttribute('data-trg-group')].group = sel.value; });
    document.querySelectorAll('[data-deltrg]').forEach(b =>
      b.onclick = () => { e.hit_triggers.splice(+b.getAttribute('data-deltrg'), 1); renderEditor(); });
    bindDragReorder(document.getElementById('ed-triggers'), '.ed-sort-row', e.hit_triggers, renderEditor);

    // counters
    document.getElementById('add-counter').onclick = () => { e.counters.push({ key: uid('c'), label: '', input: 'tap', pageId: e.pages[0].id }); renderEditor(); };
    document.querySelectorAll('[data-delc]').forEach(b =>
      b.onclick = () => { e.counters.splice(+b.getAttribute('data-delc'), 1); renderEditor(); });
    document.querySelectorAll('[data-c-label]').forEach(inp =>
      inp.oninput = () => { e.counters[+inp.getAttribute('data-c-label')].label = inp.value; });
    document.querySelectorAll('[data-c-page]').forEach(sel =>
      sel.onchange = () => { e.counters[+sel.getAttribute('data-c-page')].pageId = sel.value; });
    document.querySelectorAll('[data-c-denom]').forEach(sel =>
      sel.onchange = () => {
        e.counters[+sel.getAttribute('data-c-denom')].denominator = sel.value;
      });
    document.querySelectorAll('[data-c-dispmode]').forEach(sel =>
      sel.onchange = () => {
        e.counters[+sel.getAttribute('data-c-dispmode')].display_mode = sel.value;
      });
    bindDragReorder(document.getElementById('ed-counters'), '.edit-item', e.counters, renderEditor);

    // metrics
    document.getElementById('add-metric').onclick = () => {
      const srcTok = e.counters[0] ? [{ var: 'counter', ref: e.counters[0].key }]
        : (e.hit_triggers[0] ? [{ var: 'trig', ref: e.hit_triggers[0].key }] : []);
      const isHit = !e.counters[0] && !!e.hit_triggers[0];
      e.metrics.push({
        key: uid('m'), label: '',
        sourceTokens: srcTok, denomTokens: [{ var: isHit ? 'hits' : 'played_g' }],
        mode: isHit ? 'percent' : 'fraction', include: true, settings: {}
      });
      renderEditor();
    };
    bindMetricEvents();

    document.getElementById('ed-back').onclick = () => { state.editing = null; state.tab = 'profiles'; render(); };
    document.getElementById('ed-save').onclick = saveEditor;
    const delBtn = document.getElementById('ed-delete');
    if (delBtn) delBtn.onclick = async () => {
      if (!confirm('この機種を削除しますか？')) return;
      await DB.delProfile(e.id);
      if (state.active && state.active.profileId === e.id) { state.active = null; await DB.clearActive(); }
      await reload(); state.editing = null; state.tab = 'profiles'; render(); toast('削除しました');
    };
  }

  function fbtn(tokens, prof, dataAttr, i) {
    const txt = formulaText(tokens, prof);
    return `<button class="formula-btn" ${dataAttr}="${i}">
      <span class="ftxt ${txt ? '' : 'ph'}">${txt ? esc(txt) : '（タップして式を作成）'}</span>
      <span class="fedit">式</span></button>`;
  }
  function renderMetricEditor(m, i, prof) {
    return `<div class="edit-item">
      <div class="eh">
        <span class="drag-handle" title="ドラッグで並べ替え">⠿</span>
        <span class="nm">${esc(m.label) || '(無名メトリック)'}</span>
        <button class="del" data-delm="${i}">削除</button>
      </div>
      <label class="field" style="margin:8px 0 0"><span>ラベル</span>
        <input data-m-label="${i}" value="${esc(m.label)}" placeholder="例 強チェリー / ベル合算" /></label>
      <div class="field" style="margin:8px 0 0"><span>ソース（分子）＝計算式</span>
        ${fbtn(metricTokens(m, 'source'), prof, 'data-m-fsrc', i)}</div>
      <div class="field" style="margin:8px 0 0"><span>分母＝計算式</span>
        ${fbtn(metricTokens(m, 'denom'), prof, 'data-m-fden', i)}</div>
      <div class="edit-grid">
        <label class="field" style="margin:8px 0 0"><span>モード</span>
          <select data-m-mode="${i}">
            <option value="fraction" ${m.mode === 'fraction' ? 'selected' : ''}>分数 1/X</option>
            <option value="percent" ${m.mode === 'percent' ? 'selected' : ''}>％振り分け</option>
          </select></label>
        <label class="field" style="margin:8px 0 0"><span>総合判別に統合</span>
          <select data-m-incl="${i}">
            <option value="1" ${m.include !== false ? 'selected' : ''}>統合する</option>
            <option value="0" ${m.include === false ? 'selected' : ''}>統合しない</option>
          </select></label>
      </div>
      <label class="field" style="margin:8px 0 0"><span>設定別 理論値（${m.mode === 'percent' ? '%' : '分数の X'}）</span></label>
      <div class="settings6">
        ${Engine.SETTINGS.map(sv => `<div class="sc"><span>${sv}</span>
          <input data-m-set="${i}:${sv}" inputmode="decimal" value="${esc(m.settings && m.settings[sv] != null ? m.settings[sv] : '')}" /></div>`).join('')}
      </div>
    </div>`;
  }

  /* ---------- 計算式ビルダー（モーダル） ---------- */
  function openFormulaBuilder(title, initTokens, prof, excludeKey, onSave) {
    let toks = (initTokens || []).map(t => ({ ...t }));
    const chip = (label, attrs, cls) => `<button class="fb-chip ${cls || ''}" ${attrs}>${esc(label)}</button>`;
    const varChip = (label, v, ref) => chip(label, `data-var="${v}"${ref != null ? ` data-ref="${esc(ref)}"` : ''}`, 'v');
    const none = '<span class="muted small">なし</span>';

    const baseChips = BASE_VARS.map(b => varChip(b.label, b.var)).join('');
    const opChips = ['(', ')', '/', '*', '-', '+'].map(o => chip(OP_DISP[o], `data-op="${o}"`, 'o')).join('');
    const cntChips = (prof.counters || []).length ? prof.counters.map(c => varChip(c.label || c.key, 'counter', c.key)).join('') : none;
    const typeChips = (prof.bonus_types || []).length ? prof.bonus_types.map(t => varChip(t, 'type', t)).join('') : none;
    const trigList = prof.hit_triggers || [];
    const grpList = [...new Set(trigList.map(t => t.group || ''))];
    const trigChips = trigList.length
      ? trigList.map(t => varChip(t.label || t.key, 'trig', t.key)).join('') + grpList.map(g => varChip('群:' + groupLabel(g), 'group', g)).join('')
      : none;
    const metricList = (prof.metrics || []).filter(m => m.key !== excludeKey && (m.label || '').trim());
    const metricChips = metricList.length ? metricList.map(m => varChip(m.label, 'metric', m.key)).join('') : '<span class="muted small">他の判別メトリックなし</span>';

    openModal(`<h3>${esc(title)}</h3>
      <div class="fb-display" id="fb-disp"></div>
      <div class="fb-preview" id="fb-prev"></div>
      <div class="fb-tools">
        <button class="btn ghost small" id="fb-del">⌫ 1つ戻す</button>
        <button class="btn ghost small" id="fb-clr">クリア</button>
      </div>
      <div class="fb-ops">${opChips}</div>
      <div class="fb-numrow">
        <input id="fb-num" inputmode="decimal" placeholder="数値を入力" />
        <button class="btn small" id="fb-numadd">数値を追加</button>
      </div>
      <div class="fb-sec"><div class="fb-h">ゲーム数</div><div class="fb-chips">${baseChips}</div></div>
      <div class="fb-sec"><div class="fb-h">カウンター</div><div class="fb-chips">${cntChips}</div></div>
      <div class="fb-sec"><div class="fb-h">大当たり種別（履歴の該当件数）</div><div class="fb-chips">${typeChips}</div></div>
      <div class="fb-sec"><div class="fb-h">大当たり契機（履歴の該当件数）</div><div class="fb-chips">${trigChips}</div></div>
      <div class="fb-sec"><div class="fb-h">判別メトリック（その実測比率）</div><div class="fb-chips">${metricChips}</div></div>
      <div class="muted small" style="margin-top:8px">計算順序は ×÷ が ＋− より先、（ ）が最優先で自動計算されます。</div>
      <div class="mfoot"><button class="btn ghost" data-close>キャンセル</button><button class="btn primary" id="fb-save">保存</button></div>
    `, (root) => {
      const disp = root.querySelector('#fb-disp');
      const prev = root.querySelector('#fb-prev');
      const refresh = () => {
        disp.innerHTML = toks.length
          ? toks.map(t => `<span class="${tokClass(t)}">${esc(tokLabel(t, prof))}</span>`).join('')
          : '<span class="muted small">式が空です。下のボタンで組み立ててください。</span>';
        const v = Engine.evalFormulaTokens(toks, state.active || emptySession(), { metrics: prof.metrics || [], stack: new Set() });
        if (!toks.length) prev.innerHTML = '';
        else if (v == null) prev.innerHTML = '<span class="fb-bad">現在の入力では計算できません（式の途中・0除算・データ不足）</span>';
        else prev.innerHTML = `いまのデータでの値 = <b>${Math.round(v * 1000) / 1000}</b>`;
      };
      const append = (t) => { toks.push(t); refresh(); };
      root.querySelectorAll('[data-op]').forEach(b => b.onclick = () => append({ op: b.getAttribute('data-op') }));
      root.querySelectorAll('[data-var]').forEach(b => b.onclick = () => {
        const v = b.getAttribute('data-var'); const ref = b.getAttribute('data-ref');
        append(ref != null ? { var: v, ref } : { var: v });
      });
      const numInp = root.querySelector('#fb-num');
      const addNum = () => { const n = Number(numInp.value); if (numInp.value.trim() !== '' && isFinite(n)) { append({ num: n }); numInp.value = ''; numInp.focus(); } };
      root.querySelector('#fb-numadd').onclick = addNum;
      numInp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') addNum(); });
      root.querySelector('#fb-del').onclick = () => { toks.pop(); refresh(); };
      root.querySelector('#fb-clr').onclick = () => { toks = []; refresh(); };
      root.querySelector('#fb-save').onclick = () => { onSave(toks); closeModal(); };
      refresh();
    });
  }

  function bindMetricEvents() {
    const e = state.editing;
    document.querySelectorAll('[data-delm]').forEach(b =>
      b.onclick = () => { e.metrics.splice(+b.getAttribute('data-delm'), 1); renderEditor(); });
    bindDragReorder(document.getElementById('ed-metrics'), '.edit-item', e.metrics, renderEditor);
    document.querySelectorAll('[data-m-label]').forEach(inp =>
      inp.oninput = () => { e.metrics[+inp.getAttribute('data-m-label')].label = inp.value; });
    document.querySelectorAll('[data-m-fsrc]').forEach(b =>
      b.onclick = () => {
        const i = +b.getAttribute('data-m-fsrc'); const m = e.metrics[i];
        openFormulaBuilder('ソース（分子）の計算式', metricTokens(m, 'source'), e, m.key,
          (toks) => { m.sourceTokens = toks; delete m.source; renderEditor(); });
      });
    document.querySelectorAll('[data-m-fden]').forEach(b =>
      b.onclick = () => {
        const i = +b.getAttribute('data-m-fden'); const m = e.metrics[i];
        openFormulaBuilder('分母の計算式', metricTokens(m, 'denom'), e, m.key,
          (toks) => { m.denomTokens = toks; delete m.denominator; renderEditor(); });
      });
    document.querySelectorAll('[data-m-mode]').forEach(sel =>
      sel.onchange = () => { e.metrics[+sel.getAttribute('data-m-mode')].mode = sel.value; renderEditor(); });
    document.querySelectorAll('[data-m-incl]').forEach(sel =>
      sel.onchange = () => { e.metrics[+sel.getAttribute('data-m-incl')].include = sel.value === '1'; });
    document.querySelectorAll('[data-m-set]').forEach(inp =>
      inp.oninput = () => {
        const [i, sv] = inp.getAttribute('data-m-set').split(':');
        const m = e.metrics[+i];
        if (inp.value === '') delete m.settings[sv]; else m.settings[sv] = parseFloat(inp.value);
      });
  }

  async function saveEditor() {
    const e = state.editing;
    if (!e.machine || !e.machine.trim()) { toast('機種名を入力してください'); return; }
    e.pages.forEach((pg, i) => { if (!pg.name) pg.name = 'カウント' + (i + 1); });
    e.counters.forEach(c => { if (!c.label) c.label = c.key; if (!c.key) c.key = slug(c.label); });
    (e.hit_triggers || []).forEach(t => { if (!t.key) t.key = uid('t'); if (!t.label) t.label = t.key; });
    await DB.putProfile(e);
    await reload();
    state.editing = null; state.tab = 'profiles'; render(); toast('保存しました');
  }

  /* ============================================================
     画面: 記録（過去セッション）
  ============================================================ */
  async function renderHistory() {
    const sessions = (await DB.getSessions()).sort((a, b) => b.startedAt - a.startedAt);
    $app.innerHTML = `
      <div class="screen-head"><h1>記録</h1></div>
      ${sessions.length ? sessions.map(s => {
        const d = new Date(s.startedAt);
        const date = `${d.getMonth() + 1}/${d.getDate()}`;
        return `<div class="list-item" data-sess="${s.id}">
          <span class="ti">📊</span>
          <div class="body"><div class="t">${esc(s.machine)}</div>
            <div class="sub">${date}・総${s.total_spins || 0}G・初当${fmtRate(s.cumG || 0, s.hits || 0)}・当たり${s.hits || 0}回</div></div>
          <button class="del" data-delsess="${s.id}" style="color:var(--bad);background:none;border:none">削除</button>
        </div>`;
      }).join('')
        : `<div class="empty"><div class="big">📊</div><p>保存したセッションがここに並びます。<br>実践→設定タブの「保存して終了」で残せます。</p></div>`}
    `;
    document.querySelectorAll('[data-delsess]').forEach(b =>
      b.onclick = async (ev) => { ev.stopPropagation(); await DB.delSession(b.getAttribute('data-delsess')); renderHistory(); });
  }

  /* ---------- モーダル ---------- */
  function openModal(html, onMount) {
    $modalRoot.innerHTML = `<div class="modal-back"><div class="modal">${html}</div></div>`;
    const back = $modalRoot.querySelector('.modal-back');
    back.onclick = (e) => { if (e.target === back) closeModal(); };
    $modalRoot.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
    if (onMount) onMount($modalRoot);
  }
  function closeModal() { $modalRoot.innerHTML = ''; }

  /* ---------- ルーティング ---------- */
  function render() {
    document.querySelectorAll('#tabbar .tab').forEach(t =>
      t.classList.toggle('active', t.getAttribute('data-tab') === (state.tab === 'edit' ? 'profiles' : state.tab)));
    if (state.tab === 'session') renderSession();
    else if (state.tab === 'profiles') renderProfiles();
    else if (state.tab === 'edit') renderEditor();
    else if (state.tab === 'history') renderHistory();
  }

  async function reload() { state.profiles = (await DB.getProfiles()).map(ensurePages); }

  document.querySelectorAll('#tabbar .tab').forEach(t =>
    t.onclick = () => { state.editing = null; state.tab = t.getAttribute('data-tab'); render(); });

  /* ---------- 起動 ---------- */
  (async function init() {
    await reload();
    if (!state.profiles.length) { await seedDemo(); await reload(); }
    state.active = await DB.getActive();
    render();
  })();

  /* プリセット機種: L東京喰種（スマスロ）
     既存データは一切消さず、常に新規IDで「追加」する（消えた機種の復元用）。
     判別値の出典: なな徹 / slopachi-quest / altema の公開解析値（2026-07 時点）。
     設定差のある項目だけをメトリック化。設定差なし小役（弱チェ1/70.3・強チェ1/356.2・
     スイカ1/100.5・斜めベル1/131.1）は判別に効かないため参考カウンターのみ。 */
  function buildTokyoGhoulPreset() {
    const pgN = uid('pg'), pgS = uid('pg');
    return {
      id: uid('p'),
      machine: 'L東京喰種（スマスロ）',
      pages: [{ id: pgN, name: '通常時' }, { id: pgS, name: '終了画面/示唆' }],
      bonus_types: ['AT', 'CZ', 'エピソードB'],
      hit_triggers: [
        { key: 'choku',       label: '直撃',       group: 'state' },
        { key: 'cz_kei',      label: 'CZ経由',     group: 'state' },
        { key: 'r_kyocherry', label: '強チェ',     group: 'rare'  },
        { key: 'r_chance',    label: 'チャンス目', group: 'rare'  },
        { key: 'r_weakcherry',label: '弱チェ',     group: 'rare'  },
        { key: 'z_zone',      label: 'ゾーン',     group: 'zone'  },
        { key: 'z_tensho',    label: '天井',       group: 'zone'  },
      ],
      hit_extra_fields: [],
      counters: [
        // 通常時：判別に効くのは下段リプレイ(赫眼)のみ。他は打感確認の参考
        { key: 'kakugan_rep',   label: '下段リプ(赫眼)', input: 'tap', pageId: pgN },
        { key: 'weak_cherry',   label: '弱チェリー',     input: 'tap', pageId: pgN },
        { key: 'strong_cherry', label: '強チェリー',     input: 'tap', pageId: pgN },
        { key: 'suika',         label: 'スイカ',         input: 'tap', pageId: pgN },
        { key: 'naname_bell',   label: '斜めベル',       input: 'tap', pageId: pgN },
        // AT終了画面（キャラ示唆）
        { key: 'es_amon',     label: '終:亜門&真戸(奇数)',           input: 'tap', pageId: pgS },
        { key: 'es_suzuya',   label: '終:鈴屋&篠原(偶数)',           input: 'tap', pageId: pgS },
        { key: 'es_rize',     label: '終:神代利世(設定1否定)',       input: 'tap', pageId: pgS },
        { key: 'es_fueguchi', label: '終:笛口姉妹(高設定[弱])',      input: 'tap', pageId: pgS },
        { key: 'es_yomo',     label: '終:四方&イトリ&ウタ(高設定[強])', input: 'tap', pageId: pgS },
        { key: 'es_gold',     label: '終:金木&董香/金(設定4↑濃厚)',  input: 'tap', pageId: pgS },
        { key: 'es_rainbow',  label: '終:全員集合/虹(設定6濃厚)',    input: 'tap', pageId: pgS },
        // エンドカード / CZ終了画面
        { key: 'ec_kaneki_s', label: 'ｶｰﾄﾞ:金木/銀(設定3↑)',        input: 'tap', pageId: pgS },
        { key: 'ec_rize_g',   label: 'ｶｰﾄﾞ:神代利世/金(設定4↑)',     input: 'tap', pageId: pgS },
        { key: 'ec_fukurou',  label: 'ｶｰﾄﾞ:梟(設定4↑/金は5↑)',       input: 'tap', pageId: pgS },
        { key: 'ec_arima',    label: 'ｶｰﾄﾞ:有馬/虹(設定6濃厚)',       input: 'tap', pageId: pgS },
        // トロフィー
        { key: 'tr_gold',     label: '金トロフィー(設定4↑)',         input: 'tap', pageId: pgS },
        { key: 'tr_kishu',    label: '喰種トロフィー(設定5↑)',       input: 'tap', pageId: pgS },
        { key: 'tr_rainbow',  label: '虹トロフィー(設定6)',          input: 'tap', pageId: pgS },
        // 招待状
        { key: 'inv_4',       label: '招待状「存分に」(設定4↑)',     input: 'tap', pageId: pgS },
        { key: 'inv_6',       label: '招待状「特別な夜」(設定6濃厚)', input: 'tap', pageId: pgS },
      ],
      metrics: [
        // 大当たり履歴の種別/契機を分母=実践Gで割って 1/X を算出（履歴登録から自動集計）
        { key: 'm_at', label: 'AT初当たり確率', source: 'hit:type=AT', denominator: 'total_spins', mode: 'fraction', include: true,
          settings: { '1': 394.4, '2': 380.5, '3': 357.0, '4': 325.9, '5': 291.2, '6': 261.3 } },
        { key: 'm_cz', label: 'CZ確率', source: 'hit:type=CZ', denominator: 'total_spins', mode: 'fraction', include: true,
          settings: { '1': 262.6, '2': 255.6, '3': 246.5, '4': 233.1, '5': 216.4, '6': 203.7 } },
        { key: 'm_episode', label: 'エピソードボーナス確率', source: 'hit:type=エピソードB', denominator: 'total_spins', mode: 'fraction', include: true,
          settings: { '1': 6620.2, '2': 5879.7, '3': 5114.5, '4': 4062.5, '5': 3166.7, '6': 2639.5 } },
        { key: 'm_choku', label: 'AT直撃確率', source: 'hit:trigger=choku', denominator: 'total_spins', mode: 'fraction', include: true,
          settings: { '1': 28460.6, '2': 24453.5, '3': 18093.0, '4': 12019.5, '5': 8615.4, '6': 7036.8 } },
        // 通常時タップから：下段リプレイ(赫眼)の出現率
        { key: 'm_kakugan', label: '下段リプ(赫眼)確率', source: 'counter:kakugan_rep', denominator: 'total_spins', mode: 'fraction', include: true,
          settings: { '1': 1260.3, '2': 1213.6, '3': 1170.3, '4': 1129.9, '5': 1092.3, '6': 1024.0 } },
      ],
      createdAt: Date.now(),
    };
  }

  /* 動作確認用デモ機種（DBが空のときのみ） */
  async function seedDemo() {
    const pg1 = uid('pg'), pg2 = uid('pg');
    const demo = {
      id: uid('p'), machine: 'デモ機（動作確認用）',
      pages: [{ id: pg1, name: '通常時' }, { id: pg2, name: '小役' }, { id: uid('pg'), name: 'AT中' }],
      bonus_types: ['AT', 'CZ', 'RB'],
      hit_triggers: [
        { key: 'z_100', label: '100ゾーン', group: 'zone' },
        { key: 'z_600', label: '600ゾーン', group: 'zone' },
        { key: 'z_tensho', label: '天井', group: 'zone' },
        { key: 'r_cherry', label: '強チェ', group: 'rare' },
        { key: 'r_chance', label: 'チャンス目', group: 'rare' },
        { key: 's_choku', label: '直撃', group: 'state' },
        { key: 's_choukou', label: '超高確', group: 'state' },
      ],
      hit_extra_fields: [],
      counters: [
        { key: 'kyo_cherry', label: '強チェリー', input: 'tap', pageId: pg1 },
        { key: 'kakugan', label: '赫眼リプレイ', input: 'tap', pageId: pg1 },
        { key: 'kyodo_bell', label: '共通ベル', input: 'tap', pageId: pg2 },
        { key: 'oshi_bell', label: '押し順ベル', input: 'tap', pageId: pg2 },
      ],
      metrics: [
        { key: 'm_cherry', label: '強チェリー', source: 'counter:kyo_cherry', denominator: 'total_spins', mode: 'fraction', include: true,
          settings: { '1': 400, '2': 380, '3': 350, '4': 320, '5': 290, '6': 250 } },
        { key: 'm_kakugan', label: '赫眼リプレイ', source: 'counter:kakugan', denominator: 'total_spins', mode: 'fraction', include: true,
          settings: { '1': 250, '2': 245, '3': 235, '4': 220, '5': 210, '6': 199 } },
        { key: 'm_bell', label: 'ベル合算', source: 'expr:kyodo_bell + oshi_bell', denominator: 'total_spins', mode: 'fraction', include: true,
          settings: { '1': 7.3, '2': 7.2, '3': 7.1, '4': 7.0, '5': 6.9, '6': 6.7 } },
        { key: 'm_choku', label: '直撃率（当たり中の割合）', source: 'hit:trigger=s_choku', denominator: 'hits', mode: 'percent', include: true,
          settings: { '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 8 } },
      ],
      createdAt: Date.now()
    };
    await DB.putProfile(demo);
  }
})();
