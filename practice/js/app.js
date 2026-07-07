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
    if (!c) return '';
    const toks = counterDenomTokens(c);
    if (!toks || !toks.length) return '';
    const denom = Engine.evalFormulaTokens(toks, state.active, { metrics: prof.metrics || [], stack: new Set() });
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
    const t = ((prof && prof.hit_triggers) || []).find(x => x.key === key);
    return t ? t.label : key;
  }
  // 大当たり履歴の1行（G数・種別・契機チップ・メモ・右端に時間）。実践タブと記録編集で共用
  function hitRowHtml(prof, h, dataAttr) {
    const trg = triggerLabel(prof, h.trigger);
    const memo = [h.extra, h.memo].filter(Boolean).join(' · ');
    return `<div class="hist-row" ${dataAttr}>
      <span class="g">${esc(h.g)}G</span>
      <span class="ty">${esc(h.type)}</span>
      ${trg ? `<span class="trg-chip">${esc(trg)}</span>` : ''}
      ${memo ? `<span class="ex">${esc(memo)}</span>` : ''}
      ${h.savedAt ? `<span class="time">${esc(h.savedAt)}</span>` : ''}
    </div>`;
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
  // カウンターの母数（分母）tokens（新形式優先・旧 denominator 文字列から変換）
  function counterDenomTokens(c) {
    if (c.denomTokens) return c.denomTokens;
    return legacyToTokens(c.denominator, true);
  }
  const emptySession = () => ({ total_spins: 0, start_spins: 0, valid_g: 0, counts: {}, history: [] });

  // tab: アプリ階層（session/profiles/edit/history）, sessionTab: セッション内タブ（pageId | 'hits' | 'judge' | 'settings'）
  let state = { tab: 'session', sessionTab: null, profiles: [], active: null, editing: null };
  // 機種編集：開いているアコーディオン（再描画をまたいで開閉状態を保持）
  let openAccs = new Set();

  /* ---------- ユーティリティ ---------- */
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 1600);
  }
  const fmtRate = (spins, hits) => hits ? '1/' + Math.round(spins / hits) : '—';
  const playedG = (s) => Math.max(0, (Number(s.total_spins) || 0) - (Number(s.start_spins) || 0));
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // 総Gを大当たり履歴のG数合計から自動計算（機種設定が auto のとき）
  const autoTotalG = (s) => (s.history || []).reduce((a, h) => a + (Number(h.g) || 0), 0);
  function applyAutoTotal(prof, s) {
    if (prof && prof.totalGMode === 'auto' && s) { s.total_spins = autoTotalG(s); s.start_spins = 0; }
  }

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
    if (!p.totalGMode) p.totalGMode = 'manual'; // 総Gカウント方法（manual|auto）
    return p;
  }

  /* ---------- セッション ---------- */
  function newSession(profile) {
    return {
      id: uid('s'), profileId: profile.id, machine: profile.machine,
      startedAt: Date.now(), total_spins: 0, start_spins: 0, valid_g: 0,
      counts: {}, history: [], note: '',
      store: '', date: todayStr(), machineNo: ''
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
    const autoG = prof.totalGMode === 'auto';
    applyAutoTotal(prof, s);
    const exp = Engine.totalExpectation(prof.metrics, s);

    // --- ヘッダー（常時表示・コンパクト） ---
    const roAttr = autoG ? 'readonly class="auto-ro"' : '';
    const header = `
      <div class="sess-header">
        <div class="sh-top">
          <div class="sh-name">${esc(prof.machine)}</div>
          <div class="sh-best" id="hdr-best">${bestChipHtml(exp)}</div>
        </div>
        <div class="sh-spins">
          <label><span>総G${autoG ? '（自動）' : ''}</span>
            <input id="total-spins" inputmode="numeric" value="${s.total_spins || ''}" placeholder="0" ${roAttr} /></label>
          ${autoG ? '' : `<label><span>スタートG</span>
            <input id="start-spins" inputmode="numeric" value="${s.start_spins || ''}" placeholder="0" /></label>`}
          <div class="played">実践<br><b id="played-g">${playedG(s)}</b>G</div>
        </div>
        ${autoG ? '<div class="muted small" style="margin-top:4px">総Gは大当たり履歴のG数合計から自動計算されます</div>' : ''}
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
    if (ts && !autoG) ts.oninput = () => { s.total_spins = parseInt(ts.value || '0', 10) || 0; onSpins(); };
    const ss = document.getElementById('start-spins');
    if (ss) ss.oninput = () => { s.start_spins = parseInt(ss.value || '0', 10) || 0; onSpins(); };
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
      ${hits ? `<div class="hist-list">${s.history.map((h, i) => ({ h, i })).reverse().map(({ h, i }) => hitRowHtml(prof, h, `data-edit-hit="${i}"`)).join('')}</div>`
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
        <h2>実践情報</h2>
        <div class="edit-grid">
          <label class="field" style="margin:0"><span>店舗</span>
            <input id="set-store" value="${esc(s.store || '')}" placeholder="店名" /></label>
          <label class="field" style="margin:0"><span>台番</span>
            <input id="set-machineno" inputmode="numeric" value="${esc(s.machineNo || '')}" placeholder="台番号" /></label>
        </div>
        <label class="field" style="margin:8px 0 0"><span>日付</span>
          <input id="set-date" type="date" value="${esc(s.date || '')}" /></label>
      </div>
      <div class="card">
        <h2>このセッション</h2>
        <label class="field"><span>有効G数（任意・分母に使う場合）</span>
          <input id="set-validg" inputmode="numeric" value="${s.valid_g || ''}" placeholder="0" /></label>
        <label class="field"><span>メモ</span>
          <textarea id="set-note" rows="2" placeholder="所感など">${esc(s.note)}</textarea></label>
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
    const st = document.getElementById('set-store');
    if (st) st.oninput = () => { s.store = st.value; saveActive(); };
    const mno = document.getElementById('set-machineno');
    if (mno) mno.oninput = () => { s.machineNo = mno.value; saveActive(); };
    const dt = document.getElementById('set-date');
    if (dt) dt.oninput = () => { s.date = dt.value; saveActive(); };
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
    syncNow(false);
  }

  /* ---------- 履歴登録モーダル ---------- */
  // 実践中のセッション履歴を編集する薄いラッパー
  function openHitModal(prof, index) {
    hitEditor({ prof, history: state.active.history, index, onDone: async () => { await saveActive(); renderSession(); } });
  }
  // 大当たり履歴の追加/編集モーダル本体（履歴配列を渡して使い回す：実践中／保存済み記録の両方）
  function hitEditor({ prof, history, index, onDone }) {
    prof = prof || {};
    const editing = index >= 0;
    let types = (prof.bonus_types && prof.bonus_types.length) ? prof.bonus_types
      : [...new Set(history.map(h => h.type).filter(Boolean))];
    if (!types.length) types = ['当たり'];
    const extras = prof.hit_extra_fields || [];
    const triggers = prof.hit_triggers || [];
    const cur = editing ? history[index] : { g: '', type: types[0] || '', trigger: '', extra: '', memo: '' };

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
        const trig = triggers.find(t => t.key === selTrigger);
        const now = new Date();
        // 編集時は元の記録時刻を保持（後から直しても打った時間がずれない）
        const savedAt = (editing && cur.savedAt) ? cur.savedAt
          : now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
        const rec = { g, type: selType, trigger: selTrigger, triggerGroup: trig ? (trig.group || '') : '', extra: extraStr, extraVals, memo, savedAt };
        if (editing) history[index] = rec; else history.push(rec);
        closeModal(); await onDone();
      };
      if (editing) root.querySelector('#hit-del').onclick = async () => {
        history.splice(index, 1); closeModal(); await onDone();
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
    document.querySelectorAll('[data-open]').forEach(el =>
      el.onclick = () => editProfile(state.profiles.find(p => p.id === el.getAttribute('data-open'))));
  }

  function editProfile(profile) {
    state.editing = profile
      ? ensurePages(JSON.parse(JSON.stringify(profile)))
      : ensurePages({ id: uid('p'), machine: '', totalGMode: 'manual', bonus_types: ['BB', 'RB'], hit_triggers: [], hit_extra_fields: [], counters: [], metrics: [], createdAt: Date.now() });
    openAccs = new Set(); // 機種を開くたびに全セクションを畳んだ状態から始める
    state.tab = 'edit'; renderEditor();
  }

  function renderEditor() {
    const e = state.editing;
    // カウンターの母数サマリー文言
    const denomSummary = (c) => { const dt = counterDenomTokens(c); return (dt && dt.length) ? '母数: ' + formulaText(dt, e) : 'カウントのみ'; };

    $app.innerHTML = `
      <div class="screen-head">
        <button class="btn ghost small" id="ed-back">‹ 戻る</button>
        <h1 style="text-align:center">${e.machine ? esc(e.machine) : '新規機種'}</h1>
        <button class="btn primary small" id="ed-save">保存</button>
      </div>

      <div class="card">
        <label class="field"><span>機種名</span>
          <input id="ed-machine" value="${esc(e.machine)}" placeholder="例 ヴヴヴ2 / 東京グール" /></label>
        <label class="field" style="margin-bottom:0"><span>総Gのカウント方法</span>
          <select id="ed-totalg">
            <option value="manual" ${e.totalGMode !== 'auto' ? 'selected' : ''}>手動で入力</option>
            <option value="auto" ${e.totalGMode === 'auto' ? 'selected' : ''}>大当たり履歴のG数を合計して自動計算</option>
          </select></label>
      </div>

      ${accCard('pages', 'カウント画面（タブ）', e.pages.length, `
        <div class="muted small" style="margin-bottom:8px">実践中の「カウント画面」タブになります。行をタップで編集。</div>
        <div id="ed-pages">
          ${e.pages.map((pg, i) => `
            <div class="ed-sort-row tap-row" data-editpg="${i}">
              <span class="drag-handle" title="ドラッグで並べ替え">⠿</span>
              <div class="tr-main"><div class="tr-name">${esc(pg.name) || '(無名)'}</div></div>
              <button class="btn ghost small" data-delpg="${i}" ${e.pages.length <= 1 ? 'disabled' : ''}>✕</button>
            </div>`).join('')}
        </div>
        <button class="btn small block" id="add-page" style="margin-top:8px">＋ カウント画面を追加</button>`)}

      ${accCard('types', '大当たり種別（履歴のタップ選択肢）', e.bonus_types.length, `
        <div class="muted small" style="margin-bottom:8px">並び順＝履歴タブの率カード順。行をタップで編集。</div>
        <div id="ed-types">
          ${e.bonus_types.length ? e.bonus_types.map((t, i) => `
            <div class="ed-sort-row tap-row" data-edittype="${i}">
              <span class="drag-handle" title="ドラッグで並べ替え">⠿</span>
              <div class="tr-main"><div class="tr-name">${esc(t) || '(無名)'}</div></div>
              <button class="btn ghost small" data-deltype="${i}">✕</button>
            </div>`).join('') : '<div class="muted small">まだありません。「＋追加」から。</div>'}
        </div>
        <button class="btn small block" id="add-type" style="margin-top:8px">＋ 大当たり種別を追加</button>`)}

      ${accCard('triggers', '大当たり契機（履歴のタップ選択肢）', e.hit_triggers.length, `
        <div class="muted small" style="margin-bottom:8px">液晶ゾーン・レア役・状態を1リストに。1大当たり＝1契機（手動選択）。判別メトリックのソースに使えます。行をタップで編集。</div>
        <div id="ed-triggers">
          ${e.hit_triggers.length ? e.hit_triggers.map((t, i) => `
            <div class="ed-sort-row tap-row" data-edittrg="${i}">
              <span class="drag-handle" title="ドラッグで並べ替え">⠿</span>
              <div class="tr-main"><div class="tr-name">${esc(t.label) || '(無名)'}</div>
                <div class="tr-sub">${esc(groupLabel(t.group))}</div></div>
              <button class="btn ghost small" data-deltrg="${i}">✕</button>
            </div>`).join('') : '<div class="muted small">まだありません。「＋追加」から。</div>'}
        </div>
        <button class="btn small block" id="add-trigger" style="margin-top:8px">＋ 大当たり契機を追加</button>`)}

      ${accCard('counters', 'カウンター', e.counters.length, `
        <div class="muted small" style="margin-bottom:8px">設定判別に効くものだけ絞って登録。行をタップで編集。</div>
        <div id="ed-counters">
          ${e.counters.length ? e.counters.map((c, i) => `
            <div class="ed-sort-row tap-row" data-editc="${i}">
              <span class="drag-handle" title="ドラッグで並べ替え">⠿</span>
              <div class="tr-main"><div class="tr-name">${esc(c.label) || '(無名)'}</div>
                <div class="tr-sub">${esc((e.pages.find(p => p.id === c.pageId) || {}).name || '—')} · ${esc(denomSummary(c))}</div></div>
              <button class="btn ghost small" data-delc="${i}">✕</button>
            </div>`).join('') : '<div class="muted small">まだありません。「＋追加」から。</div>'}
        </div>
        <button class="btn small block" id="add-counter" style="margin-top:8px">＋ カウンターを追加</button>`)}

      ${accCard('metrics', '判別メトリック', e.metrics.length, `
        <div class="muted small" style="margin-bottom:8px">ソース(分子)と分母を計算式で作成→設定別の理論値を登録。行をタップで編集。</div>
        <div id="ed-metrics">
          ${e.metrics.length ? e.metrics.map((m, i) => `
            <div class="ed-sort-row tap-row" data-editm="${i}">
              <span class="drag-handle" title="ドラッグで並べ替え">⠿</span>
              <div class="tr-main"><div class="tr-name">${esc(m.label) || '(無名メトリック)'}</div>
                <div class="tr-sub">${m.mode === 'percent' ? '％振り分け' : '分数 1/X'}${m.include === false ? ' · 統合しない' : ' · 統合'}</div></div>
              <button class="btn ghost small" data-delm="${i}">✕</button>
            </div>`).join('') : '<div class="muted small">まだありません。「＋追加」から。</div>'}
        </div>
        <button class="btn small block" id="add-metric" style="margin-top:8px">＋ 判別メトリックを追加</button>`)}

      <button class="btn danger block" id="ed-delete" ${state.profiles.find(p => p.id === e.id) ? '' : 'style="display:none"'}>この機種を削除</button>
    `;

    // アコーディオン開閉
    document.querySelectorAll('[data-acc-toggle]').forEach(h => h.onclick = () => {
      const key = h.getAttribute('data-acc-toggle');
      const card = h.closest('.acc');
      if (openAccs.has(key)) { openAccs.delete(key); card.classList.remove('open'); }
      else { openAccs.add(key); card.classList.add('open'); }
    });

    document.getElementById('ed-machine').oninput = (ev) => e.machine = ev.target.value;
    document.getElementById('ed-totalg').onchange = (ev) => { e.totalGMode = ev.target.value; };

    // pages
    // カウント画面（pages）＝ ポップアップで追加/編集
    document.getElementById('add-page').onclick = () => { openAccs.add('pages'); openPageModal(-1); };
    document.querySelectorAll('[data-editpg]').forEach(row => row.onclick = (ev) => {
      if (ev.target.closest('.drag-handle') || ev.target.closest('[data-delpg]')) return;
      openPageModal(+row.getAttribute('data-editpg'));
    });
    document.querySelectorAll('[data-delpg]').forEach(b =>
      b.onclick = (ev) => {
        ev.stopPropagation();
        if (e.pages.length <= 1) return;
        const i = +b.getAttribute('data-delpg'); const removed = e.pages[i].id;
        e.pages.splice(i, 1);
        e.counters.forEach(c => { if (c.pageId === removed) c.pageId = e.pages[0].id; });
        renderEditor();
      });
    bindDragReorder(document.getElementById('ed-pages'), '.ed-sort-row', e.pages, renderEditor);

    // 大当たり種別（types）＝ ポップアップで追加/編集
    document.getElementById('add-type').onclick = () => { openAccs.add('types'); openTypeModal(-1); };
    document.querySelectorAll('[data-edittype]').forEach(row => row.onclick = (ev) => {
      if (ev.target.closest('.drag-handle') || ev.target.closest('[data-deltype]')) return;
      openTypeModal(+row.getAttribute('data-edittype'));
    });
    document.querySelectorAll('[data-deltype]').forEach(x =>
      x.onclick = (ev) => { ev.stopPropagation(); e.bonus_types.splice(+x.getAttribute('data-deltype'), 1); renderEditor(); });
    bindDragReorder(document.getElementById('ed-types'), '.ed-sort-row', e.bonus_types, renderEditor);

    // hit_triggers（大当たり契機）＝ ポップアップで追加/編集
    document.getElementById('add-trigger').onclick = () => { openAccs.add('triggers'); openTriggerModal(-1); };
    document.querySelectorAll('[data-edittrg]').forEach(row => row.onclick = (ev) => {
      if (ev.target.closest('.drag-handle') || ev.target.closest('[data-deltrg]')) return;
      openTriggerModal(+row.getAttribute('data-edittrg'));
    });
    document.querySelectorAll('[data-deltrg]').forEach(b =>
      b.onclick = (ev) => { ev.stopPropagation(); e.hit_triggers.splice(+b.getAttribute('data-deltrg'), 1); renderEditor(); });
    bindDragReorder(document.getElementById('ed-triggers'), '.ed-sort-row', e.hit_triggers, renderEditor);

    // counters ＝ ポップアップで追加/編集
    document.getElementById('add-counter').onclick = () => { openAccs.add('counters'); openCounterModal(-1); };
    document.querySelectorAll('[data-editc]').forEach(row => row.onclick = (ev) => {
      if (ev.target.closest('.drag-handle') || ev.target.closest('[data-delc]')) return;
      openCounterModal(+row.getAttribute('data-editc'));
    });
    document.querySelectorAll('[data-delc]').forEach(b =>
      b.onclick = (ev) => { ev.stopPropagation(); e.counters.splice(+b.getAttribute('data-delc'), 1); renderEditor(); });
    bindDragReorder(document.getElementById('ed-counters'), '.ed-sort-row', e.counters, renderEditor);

    // metrics ＝ ポップアップで追加/編集
    document.getElementById('add-metric').onclick = () => { openAccs.add('metrics'); openMetricModal(-1); };
    document.querySelectorAll('[data-editm]').forEach(row => row.onclick = (ev) => {
      if (ev.target.closest('.drag-handle') || ev.target.closest('[data-delm]')) return;
      openMetricModal(+row.getAttribute('data-editm'));
    });
    document.querySelectorAll('[data-delm]').forEach(b =>
      b.onclick = (ev) => { ev.stopPropagation(); e.metrics.splice(+b.getAttribute('data-delm'), 1); renderEditor(); });
    bindDragReorder(document.getElementById('ed-metrics'), '.ed-sort-row', e.metrics, renderEditor);

    document.getElementById('ed-back').onclick = () => { state.editing = null; state.tab = 'profiles'; render(); };
    document.getElementById('ed-save').onclick = saveEditor;
    const delBtn = document.getElementById('ed-delete');
    if (delBtn) delBtn.onclick = async () => {
      if (!confirm('この機種を削除しますか？')) return;
      await DB.delProfile(e.id); addTombstone('pc_profiles', e.id);
      if (state.active && state.active.profileId === e.id) { state.active = null; await DB.clearActive(); }
      await reload(); state.editing = null; state.tab = 'profiles'; render(); toast('削除しました'); syncNow(false);
    };
  }

  function fbtn(tokens, prof, dataAttr, i) {
    const txt = formulaText(tokens, prof);
    return `<button class="formula-btn" ${dataAttr}="${i}">
      <span class="ftxt ${txt ? '' : 'ph'}">${txt ? esc(txt) : '（タップして式を作成）'}</span>
      <span class="fedit">式</span></button>`;
  }
  // アコーディオン・カード（見出しタップで開閉・件数バッジ付き）
  function accCard(key, title, count, bodyHtml) {
    const open = openAccs.has(key);
    return `<div class="acc card ${open ? 'open' : ''}">
      <button class="acc-head" data-acc-toggle="${key}">
        <span class="acc-title">${esc(title)}<span class="acc-count">${count}</span></span>
        <span class="acc-chev">▾</span>
      </button>
      <div class="acc-body">${bodyHtml}</div>
    </div>`;
  }
  // 計算式ボタンの表示テキストをその場更新（モーダル内・再描画なし）
  function updateFbtn(root, attr, toks, prof) {
    const b = root.querySelector('[' + attr + '] .ftxt');
    if (!b) return;
    const txt = formulaText(toks, prof);
    b.textContent = txt || '（タップして式を作成）';
    b.classList.toggle('ph', !txt);
  }

  /* ---------- カウント画面（タブ）：追加/編集モーダル ---------- */
  function openPageModal(idx) {
    const e = state.editing;
    const isNew = idx < 0;
    const w = isNew ? { id: uid('pg'), name: '' } : { ...e.pages[idx] };
    openModal(`
      <h3>${isNew ? 'カウント画面を追加' : 'カウント画面を編集'}</h3>
      <label class="field"><span>タブ名</span>
        <input id="pm-name" value="${esc(w.name)}" placeholder="例 通常時 / 小役 / AT中" /></label>
      <div class="mfoot">
        ${(!isNew && e.pages.length > 1) ? '<button class="btn danger" id="pm-del">削除</button>' : ''}
        <button class="btn primary" id="pm-save">保存</button>
      </div>
    `, (root) => {
      setTimeout(() => root.querySelector('#pm-name').focus(), 60);
      root.querySelector('#pm-save').onclick = () => {
        w.name = root.querySelector('#pm-name').value.trim();
        if (!w.name) { toast('タブ名を入力してください'); return; }
        if (isNew) e.pages.push(w); else e.pages[idx] = w;
        closeModal(); renderEditor();
      };
      const del = root.querySelector('#pm-del');
      if (del) del.onclick = () => {
        const removed = e.pages[idx].id;
        e.pages.splice(idx, 1);
        e.counters.forEach(c => { if (c.pageId === removed) c.pageId = e.pages[0].id; });
        closeModal(); renderEditor();
      };
    });
  }

  /* ---------- 大当たり種別：追加/編集モーダル ---------- */
  function openTypeModal(idx) {
    const e = state.editing;
    const isNew = idx < 0;
    const cur = isNew ? '' : e.bonus_types[idx];
    openModal(`
      <h3>${isNew ? '大当たり種別を追加' : '大当たり種別を編集'}</h3>
      <label class="field"><span>種別名（例 BB / RB / ART / AT / CZ）</span>
        <input id="tym-name" value="${esc(cur)}" placeholder="種別名" /></label>
      <div class="mfoot">
        ${isNew ? '' : '<button class="btn danger" id="tym-del">削除</button>'}
        <button class="btn primary" id="tym-save">保存</button>
      </div>
    `, (root) => {
      const inp = root.querySelector('#tym-name');
      setTimeout(() => inp.focus(), 60);
      const save = () => {
        const v = inp.value.trim();
        if (!v) { toast('種別名を入力してください'); return; }
        if (isNew) e.bonus_types.push(v); else e.bonus_types[idx] = v;
        closeModal(); renderEditor();
      };
      root.querySelector('#tym-save').onclick = save;
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
      if (!isNew) root.querySelector('#tym-del').onclick = () => { e.bonus_types.splice(idx, 1); closeModal(); renderEditor(); };
    });
  }

  /* ---------- 大当たり契機：追加/編集モーダル ---------- */
  function openTriggerModal(idx) {
    const e = state.editing;
    const isNew = idx < 0;
    const w = isNew ? { key: uid('t'), label: '', group: 'zone' } : { ...e.hit_triggers[idx] };
    openModal(`
      <h3>${isNew ? '大当たり契機を追加' : '大当たり契機を編集'}</h3>
      <label class="field"><span>名前</span>
        <input id="tm-label" value="${esc(w.label)}" placeholder="例 100ゾーン / 強チェ / 直撃" /></label>
      <label class="field"><span>グループ</span>
        <select id="tm-group">
          ${TRIGGER_GROUPS.map(g => `<option value="${g.value}" ${(w.group || '') === g.value ? 'selected' : ''}>${esc(g.label)}</option>`).join('')}
        </select></label>
      <div class="mfoot">
        ${isNew ? '' : '<button class="btn danger" id="tm-del">削除</button>'}
        <button class="btn primary" id="tm-save">保存</button>
      </div>
    `, (root) => {
      setTimeout(() => root.querySelector('#tm-label').focus(), 60);
      root.querySelector('#tm-save').onclick = () => {
        w.label = root.querySelector('#tm-label').value.trim();
        w.group = root.querySelector('#tm-group').value;
        if (!w.label) { toast('名前を入力してください'); return; }
        if (isNew) e.hit_triggers.push(w); else e.hit_triggers[idx] = w;
        closeModal(); renderEditor();
      };
      if (!isNew) root.querySelector('#tm-del').onclick = () => { e.hit_triggers.splice(idx, 1); closeModal(); renderEditor(); };
    });
  }

  /* ---------- カウンター：追加/編集モーダル ---------- */
  function openCounterModal(idx) {
    const e = state.editing;
    const isNew = idx < 0;
    const w = isNew
      ? { key: uid('c'), label: '', input: 'tap', pageId: e.pages[0].id }
      : JSON.parse(JSON.stringify(e.counters[idx]));
    const pageOpts = e.pages.map(pg => `<option value="${esc(pg.id)}" ${w.pageId === pg.id ? 'selected' : ''}>${esc(pg.name)}</option>`).join('');
    openModal(`
      <h3>${isNew ? 'カウンターを追加' : 'カウンターを編集'}</h3>
      <label class="field"><span>ラベル</span>
        <input id="cm-label" value="${esc(w.label)}" placeholder="例 強チェリー / 共通ベル" /></label>
      <label class="field"><span>画面（タブ）</span>
        <select id="cm-page">${pageOpts}</select></label>
      <div class="field"><span>母数（表示の分母）＝計算式</span>
        ${fbtn(counterDenomTokens(w), e, 'data-cm-fden', 0)}
        <div class="muted small" style="margin-top:4px">空のままなら分母なし（カウントのみ表示）</div></div>
      <label class="field"><span>表示</span>
        <select id="cm-disp">
          <option value="both" ${(w.display_mode || 'both') === 'both' ? 'selected' : ''}>分数と％両方</option>
          <option value="frac" ${w.display_mode === 'frac' ? 'selected' : ''}>分数のみ（1/X）</option>
          <option value="percent" ${w.display_mode === 'percent' ? 'selected' : ''}>％のみ</option>
        </select></label>
      <div class="mfoot">
        ${isNew ? '' : '<button class="btn danger" id="cm-del">削除</button>'}
        <button class="btn primary" id="cm-save">保存</button>
      </div>
    `, (root) => {
      root.querySelector('[data-cm-fden]').onclick = () =>
        openFormulaBuilder('母数（分母）の計算式', counterDenomTokens(w), e, null, (toks) => {
          w.denomTokens = toks; delete w.denominator; updateFbtn(root, 'data-cm-fden', toks, e);
        });
      root.querySelector('#cm-save').onclick = () => {
        w.label = root.querySelector('#cm-label').value.trim();
        w.pageId = root.querySelector('#cm-page').value;
        w.display_mode = root.querySelector('#cm-disp').value;
        if (!w.label) { toast('ラベルを入力してください'); return; }
        if (isNew) e.counters.push(w); else e.counters[idx] = w;
        closeModal(); renderEditor();
      };
      if (!isNew) root.querySelector('#cm-del').onclick = () => { e.counters.splice(idx, 1); closeModal(); renderEditor(); };
    });
  }

  /* ---------- 判別メトリック：追加/編集モーダル ---------- */
  function openMetricModal(idx) {
    const e = state.editing;
    const isNew = idx < 0;
    let w;
    if (isNew) {
      const srcTok = e.counters[0] ? [{ var: 'counter', ref: e.counters[0].key }]
        : (e.hit_triggers[0] ? [{ var: 'trig', ref: e.hit_triggers[0].key }] : []);
      const isHit = !e.counters[0] && !!e.hit_triggers[0];
      w = { key: uid('m'), label: '', sourceTokens: srcTok, denomTokens: [{ var: isHit ? 'hits' : 'played_g' }], mode: isHit ? 'percent' : 'fraction', include: true, settings: {} };
    } else {
      w = JSON.parse(JSON.stringify(e.metrics[idx]));
      w.sourceTokens = metricTokens(w, 'source').map(t => ({ ...t }));
      w.denomTokens = metricTokens(w, 'denom').map(t => ({ ...t }));
      delete w.source; delete w.denominator;
    }
    openModal(`
      <h3>${isNew ? '判別メトリックを追加' : '判別メトリックを編集'}</h3>
      <label class="field"><span>ラベル</span>
        <input id="mm-label" value="${esc(w.label)}" placeholder="例 強チェリー / ベル合算" /></label>
      <div class="field"><span>ソース（分子）＝計算式</span>
        ${fbtn(w.sourceTokens, e, 'data-mm-fsrc', 0)}</div>
      <div class="field"><span>分母＝計算式</span>
        ${fbtn(w.denomTokens, e, 'data-mm-fden', 0)}</div>
      <div class="edit-grid">
        <label class="field" style="margin:0"><span>モード</span>
          <select id="mm-mode">
            <option value="fraction" ${w.mode === 'fraction' ? 'selected' : ''}>分数 1/X</option>
            <option value="percent" ${w.mode === 'percent' ? 'selected' : ''}>％振り分け</option>
          </select></label>
        <label class="field" style="margin:0"><span>総合判別に統合</span>
          <select id="mm-incl">
            <option value="1" ${w.include !== false ? 'selected' : ''}>統合する</option>
            <option value="0" ${w.include === false ? 'selected' : ''}>統合しない</option>
          </select></label>
      </div>
      <label class="field" style="margin:10px 0 0"><span id="mm-set-h">設定別 理論値（${w.mode === 'percent' ? '%' : '分数の X'}）</span></label>
      <div class="settings6">
        ${Engine.SETTINGS.map(sv => `<div class="sc"><span>${sv}</span>
          <input data-mm-set="${sv}" inputmode="decimal" value="${esc(w.settings && w.settings[sv] != null ? w.settings[sv] : '')}" /></div>`).join('')}
      </div>
      <div class="mfoot">
        ${isNew ? '' : '<button class="btn danger" id="mm-del">削除</button>'}
        <button class="btn primary" id="mm-save">保存</button>
      </div>
    `, (root) => {
      root.querySelector('[data-mm-fsrc]').onclick = () =>
        openFormulaBuilder('ソース（分子）の計算式', w.sourceTokens, e, w.key, (toks) => { w.sourceTokens = toks; updateFbtn(root, 'data-mm-fsrc', toks, e); });
      root.querySelector('[data-mm-fden]').onclick = () =>
        openFormulaBuilder('分母の計算式', w.denomTokens, e, w.key, (toks) => { w.denomTokens = toks; updateFbtn(root, 'data-mm-fden', toks, e); });
      root.querySelector('#mm-mode').onchange = (ev) => {
        w.mode = ev.target.value;
        root.querySelector('#mm-set-h').textContent = '設定別 理論値（' + (w.mode === 'percent' ? '%' : '分数の X') + '）';
      };
      root.querySelector('#mm-save').onclick = () => {
        w.label = root.querySelector('#mm-label').value.trim();
        w.mode = root.querySelector('#mm-mode').value;
        w.include = root.querySelector('#mm-incl').value === '1';
        const settings = {};
        root.querySelectorAll('[data-mm-set]').forEach(inp => { if (inp.value !== '') settings[inp.getAttribute('data-mm-set')] = parseFloat(inp.value); });
        w.settings = settings;
        if (!w.label) { toast('ラベルを入力してください'); return; }
        if (isNew) e.metrics.push(w); else e.metrics[idx] = w;
        closeModal(); renderEditor();
      };
      if (!isNew) root.querySelector('#mm-del').onclick = () => { e.metrics.splice(idx, 1); closeModal(); renderEditor(); };
    });
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

  async function saveEditor() {
    const e = state.editing;
    if (!e.machine || !e.machine.trim()) { toast('機種名を入力してください'); return; }
    e.pages.forEach((pg, i) => { if (!pg.name) pg.name = 'カウント' + (i + 1); });
    e.counters.forEach(c => { if (!c.label) c.label = c.key; if (!c.key) c.key = slug(c.label); });
    (e.hit_triggers || []).forEach(t => { if (!t.key) t.key = uid('t'); if (!t.label) t.label = t.key; });
    await DB.putProfile(e);
    await reload();
    state.editing = null; state.tab = 'profiles'; render(); toast('保存しました');
    syncNow(false);
  }

  /* ============================================================
     同期（Supabaseクラウド）
     ローカル(IndexedDB)の profiles/sessions を Supabase に upsert し、
     クラウドの全行を取得して双方向マージ（updated_atのLWW）。
     削除は tombstone（deleted=true）で伝播させる。ネット必須の処理で、
     圏外/未ログインなら静かに何もしない（アプリ本体はオフラインで動く）。
  ============================================================ */
  const SYNC = {
    profTime: (p) => p.updatedAt || p.createdAt || 0,
    sessTime: (s) => s.updatedAt || s.closedAt || s.startedAt || 0,
    TOMB: 'pc_tombstones', // [{table:'pc_profiles'|'pc_sessions', id, at}]
    busy: false,
    lastMsg: '',
  };
  const getTombstones = () => { try { return JSON.parse(localStorage.getItem(SYNC.TOMB) || '[]'); } catch (e) { return []; } };
  function addTombstone(table, id) {
    const list = getTombstones().filter(t => !(t.table === table && t.id === id));
    list.push({ table, id, at: Date.now() });
    localStorage.setItem(SYNC.TOMB, JSON.stringify(list));
  }
  function clearTombstones(done) {
    const doneKeys = new Set(done.map(t => t.table + '/' + t.id));
    localStorage.setItem(SYNC.TOMB, JSON.stringify(getTombstones().filter(t => !doneKeys.has(t.table + '/' + t.id))));
  }

  async function syncNow(manual) {
    if (SYNC.busy) return { ok: false, msg: '同期中' };
    if (!Cloud.hasSession()) { SYNC.lastMsg = 'ログインしていません'; if (manual) toast('ログインが必要です'); return { ok: false, msg: SYNC.lastMsg }; }
    SYNC.busy = true;
    try {
      // --- pull: クラウド全行を先に取得しローカルへマージ（PC等の他端末の変更を最初に取り込む） ---
      const [cloudP, cloudS] = await Promise.all([Cloud.selectAll('pc_profiles'), Cloud.selectAll('pc_sessions')]);
      const cloudPMap = new Map(cloudP.map(r => [r.id, r]));
      const cloudSMap = new Map(cloudS.map(r => [r.id, r]));
      let changed = 0;
      const localP = new Map((await DB.getProfiles()).map(p => [p.id, p]));
      for (const row of cloudP) {
        const cur = localP.get(row.id);
        if (row.deleted) { if (cur) { await DB.delProfile(row.id); changed++; } }
        else if (!cur || row.updated_at > SYNC.profTime(cur)) { await DB.putProfileRaw(row.data); changed++; }
      }
      const localS = new Map((await DB.getSessions()).map(s => [s.id, s]));
      for (const row of cloudS) {
        const cur = localS.get(row.id);
        if (row.deleted) { if (cur) { await DB.delSession(row.id); changed++; } }
        else if (!cur || row.updated_at > SYNC.sessTime(cur)) { await DB.putSession(row.data); changed++; }
      }

      // --- push: マージ後のローカルのうち「クラウドより新しい行だけ」を送る
      //     （ここで無条件push すると、他端末の新しい変更を手元の古いコピーで上書きしてしまう） ---
      const [profiles, sessions] = await Promise.all([DB.getProfiles(), DB.getSessions()]);
      const pushP = profiles
        .filter(p => { const c = cloudPMap.get(p.id); return !c || SYNC.profTime(p) > c.updated_at; })
        .map(p => ({ id: p.id, data: p, updated_at: SYNC.profTime(p), deleted: false }));
      const pushS = sessions
        .filter(s => { const c = cloudSMap.get(s.id); return !c || SYNC.sessTime(s) > c.updated_at; })
        .map(s => ({ id: s.id, data: s, updated_at: SYNC.sessTime(s), deleted: false }));
      await Cloud.upsert('pc_profiles', pushP);
      await Cloud.upsert('pc_sessions', pushS);
      const tombs = getTombstones();
      for (const grp of ['pc_profiles', 'pc_sessions']) {
        const rows = tombs.filter(t => t.table === grp).map(t => ({ id: t.id, data: {}, updated_at: t.at, deleted: true }));
        await Cloud.upsert(grp, rows);
      }

      clearTombstones(tombs);
      await reload();
      SYNC.lastMsg = changed ? `同期しました（更新 ${changed} 件）` : '同期しました（最新）';
      if (manual) { toast(SYNC.lastMsg); render(); }
      return { ok: true, msg: SYNC.lastMsg, added: changed };
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/セッション切れ|再ログイン/.test(msg)) { SYNC.lastMsg = 'ログインが切れました'; if (manual) { toast('ログインが切れました。再ログインしてください'); renderLogin(); } }
      else { SYNC.lastMsg = 'クラウドに接続できませんでした'; if (manual) toast('同期できません：ネット接続を確認してください'); }
      return { ok: false, msg: SYNC.lastMsg, error: msg };
    } finally {
      SYNC.busy = false;
    }
  }

  /* ============================================================
     画面: 記録（過去セッション）
  ============================================================ */
  async function renderHistory() {
    const sessions = (await DB.getSessions()).sort((a, b) => b.startedAt - a.startedAt);
    $app.innerHTML = `
      <div class="screen-head">
        <h1>記録</h1>
        <button class="btn" id="sync-btn" style="margin-left:auto">🔄 同期</button>
      </div>
      <div id="sync-note" class="muted" style="font-size:12px;margin:-4px 2px 10px">${esc(SYNC.lastMsg || 'クラウド同期：ネット接続時に自動で同期されます（🔄で手動同期）')}</div>
      ${sessions.length ? sessions.map(s => {
        let date = s.date || '';
        if (!date) { const d = new Date(s.startedAt); date = `${d.getMonth() + 1}/${d.getDate()}`; }
        const head = [date, s.store, s.machineNo ? ('台' + s.machineNo) : ''].filter(Boolean).join('・');
        return `<div class="list-item tap-row" data-sess="${s.id}">
          <span class="ti">📊</span>
          <div class="body"><div class="t">${esc(s.machine)}</div>
            <div class="sub">${esc(head)}${head ? '・' : ''}総${s.total_spins || 0}G・初当${fmtRate(s.cumG || 0, s.hits || 0)}・当たり${s.hits || 0}回</div></div>
          <button class="del" data-delsess="${s.id}" style="color:var(--bad);background:none;border:none">削除</button>
        </div>`;
      }).join('')
        : `<div class="empty"><div class="big">📊</div><p>保存したセッションがここに並びます。<br>実践→設定タブの「保存して終了」で残せます。<br>行をタップで編集できます。</p></div>`}
      <div class="muted" style="font-size:12px;margin:18px 2px 8px;display:flex;align-items:center;gap:10px">
        <span>👤 ${esc(Cloud.email() || '未ログイン')}</span>
        <button class="btn" id="logout-btn" style="margin-left:auto;font-size:12px;padding:4px 10px">ログアウト</button>
      </div>
    `;
    document.querySelectorAll('[data-delsess]').forEach(b =>
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const id = b.getAttribute('data-delsess');
        await DB.delSession(id); addTombstone('pc_sessions', id);
        renderHistory(); syncNow(false);
      });
    document.querySelectorAll('[data-sess]').forEach(row =>
      row.onclick = (ev) => {
        if (ev.target.closest('[data-delsess]')) return;
        const s = sessions.find(x => x.id === row.getAttribute('data-sess'));
        if (s) openSessionEditModal(s);
      });
    const syncBtn = document.getElementById('sync-btn');
    if (syncBtn) syncBtn.onclick = async () => {
      const note = document.getElementById('sync-note');
      syncBtn.disabled = true; if (note) note.textContent = '同期中…';
      await syncNow(true);
    };
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.onclick = () => {
      if (!confirm('ログアウトしますか？（この端末のデータは残りますが、同期が止まります）')) return;
      Cloud.signOut(); renderLogin();
    };
  }

  /* ---------- 保存済み記録：編集モーダル（全項目 閲覧・編集可） ---------- */
  function openSessionEditModal(s) {
    // 作業用ディープコピー。保存を押すまで元データには触れない（履歴を編集しても他の入力欄が消えない）
    const w = JSON.parse(JSON.stringify(s));
    if (!Array.isArray(w.history)) w.history = [];
    if (!w.counts || typeof w.counts !== 'object') w.counts = {};
    const prof = state.profiles.find(p => p.id === w.profileId) || null;

    // 履歴があれば当たり回数・累計Gは履歴から自動計算（手入力と食い違わないように）
    const hasHist = () => w.history.length > 0;
    const recalc = () => {
      if (hasHist()) {
        w.hits = w.history.length;
        w.cumG = w.history.reduce((a, h) => a + (Number(h.g) || 0), 0);
      }
    };
    recalc();

    let date = w.date || '';
    if (!date) { const d = new Date(w.startedAt); date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

    const bodyHtml = () => {
      const counters = (prof && prof.counters) ? prof.counters : [];
      const ro = hasHist() ? 'readonly class="auto-ro"' : 'inputmode="numeric"';
      return `
      <h3>記録を編集</h3>
      <label class="field"><span>機種名</span>
        <input id="se-machine" value="${esc(w.machine || '')}" /></label>
      <div class="edit-grid">
        <label class="field" style="margin:0"><span>店舗</span>
          <input id="se-store" value="${esc(w.store || '')}" placeholder="店名" /></label>
        <label class="field" style="margin:0"><span>台番</span>
          <input id="se-no" inputmode="numeric" value="${esc(w.machineNo || '')}" placeholder="台番号" /></label>
      </div>
      <label class="field"><span>日付</span>
        <input id="se-date" type="date" value="${esc(date)}" /></label>
      <div class="edit-grid">
        <label class="field" style="margin:0"><span>総G</span>
          <input id="se-total" inputmode="numeric" value="${w.total_spins || 0}" /></label>
        <label class="field" style="margin:0"><span>スタートG</span>
          <input id="se-start" inputmode="numeric" value="${w.start_spins || 0}" /></label>
      </div>
      <div class="edit-grid">
        <label class="field" style="margin:0"><span>有効G数</span>
          <input id="se-validg" inputmode="numeric" value="${w.valid_g || 0}" /></label>
        <label class="field" style="margin:0"><span>当たり回数${hasHist() ? '（自動）' : ''}</span>
          <input id="se-hits" value="${w.hits || 0}" ${ro} /></label>
      </div>
      <label class="field"><span>累計G（初当計算）${hasHist() ? '（自動）' : ''}</span>
        <input id="se-cumg" value="${w.cumG || 0}" ${ro} /></label>
      <label class="field"><span>メモ</span>
        <textarea id="se-note" rows="2">${esc(w.note || '')}</textarea></label>

      <div class="se-sec">
        <div class="se-sec-h">大当たり履歴 <span class="acc-count">${w.history.length}</span></div>
        <button class="btn small block" id="se-add-hit">＋ 履歴を追加</button>
        ${w.history.length
          ? `<div class="hist-list" style="margin-top:8px">${w.history.map((h, i) => ({ h, i })).reverse().map(({ h, i }) => hitRowHtml(prof, h, `data-se-hit="${i}"`)).join('')}</div>`
          : '<div class="muted small" style="margin-top:6px">まだ登録がありません。</div>'}
      </div>

      ${counters.length ? `
      <div class="se-sec">
        <div class="se-sec-h">カウント</div>
        <div class="edit-grid">
          ${counters.map(c => `<label class="field" style="margin:0"><span>${esc(c.label)}</span>
            <input data-se-cnt="${esc(c.key)}" inputmode="numeric" value="${w.counts[c.key] || 0}" /></label>`).join('')}
        </div>
      </div>` : ''}

      <div class="mfoot">
        <button class="btn danger" id="se-del">削除</button>
        <button class="btn primary" id="se-save">保存</button>
      </div>`;
    };

    // 入力欄の現在値を作業コピーへ取り込む（再描画で失わないため）
    const syncFields = (root) => {
      const v = (id) => (root.querySelector('#' + id) || {}).value;
      w.machine = (v('se-machine') || '').trim();
      w.store = v('se-store') || '';
      w.machineNo = v('se-no') || '';
      w.date = v('se-date') || '';
      w.total_spins = parseInt(v('se-total') || '0', 10) || 0;
      w.start_spins = parseInt(v('se-start') || '0', 10) || 0;
      w.valid_g = parseInt(v('se-validg') || '0', 10) || 0;
      w.note = v('se-note') || '';
      if (!hasHist()) {
        w.hits = parseInt(v('se-hits') || '0', 10) || 0;
        w.cumG = parseInt(v('se-cumg') || '0', 10) || 0;
      }
      root.querySelectorAll('[data-se-cnt]').forEach(inp => {
        w.counts[inp.getAttribute('data-se-cnt')] = parseInt(inp.value || '0', 10) || 0;
      });
    };

    openModal(bodyHtml(), function bind(root) {
      const modal = root.querySelector('.modal');
      const rerender = () => { recalc(); modal.innerHTML = bodyHtml(); bind(root); };

      root.querySelector('#se-add-hit').onclick = () => {
        syncFields(root);
        hitEditor({ prof, history: w.history, index: -1, onDone: rerender });
      };
      root.querySelectorAll('[data-se-hit]').forEach(rowEl => rowEl.onclick = () => {
        syncFields(root);
        hitEditor({ prof, history: w.history, index: parseInt(rowEl.getAttribute('data-se-hit'), 10), onDone: rerender });
      });

      root.querySelector('#se-save').onclick = async () => {
        syncFields(root); recalc();
        w.updatedAt = Date.now();
        Object.assign(s, w);
        await DB.putSession(w); closeModal(); renderHistory(); toast('保存しました'); syncNow(false);
      };
      root.querySelector('#se-del').onclick = async () => {
        if (!confirm('この記録を削除しますか？')) return;
        await DB.delSession(s.id); addTombstone('pc_sessions', s.id); closeModal(); renderHistory(); syncNow(false);
      };
    });
  }

  /* ---------- モーダル（スタック対応：計算式ビルダーを他モーダルの上に重ねられる） ---------- */
  function openModal(html, onMount) {
    const layer = document.createElement('div');
    layer.className = 'modal-back';
    layer.innerHTML = `<div class="modal">${html}</div>`;
    $modalRoot.appendChild(layer);
    layer.onclick = (e) => { if (e.target === layer) closeModal(); };
    layer.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeModal());
    if (onMount) onMount(layer);
  }
  function closeModal() {
    const layers = $modalRoot.querySelectorAll('.modal-back');
    if (layers.length) layers[layers.length - 1].remove();
  }

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

  /* ---------- ログイン画面（初回のみ） ---------- */
  function renderLogin() {
    document.getElementById('tabbar').style.display = 'none';
    $app.innerHTML = `
      <div style="max-width:360px;margin:12vh auto 0;padding:0 20px;text-align:center">
        <div style="font-size:44px">🎰</div>
        <h1 style="margin:8px 0 4px">実践カウンター</h1>
        <p class="muted" style="font-size:13px;margin-bottom:20px">クラウド同期のためログインしてください（初回のみ・以降は自動）</p>
        <label class="field" style="text-align:left"><span>メールアドレス</span>
          <input id="login-email" type="email" inputmode="email" autocomplete="username" /></label>
        <label class="field" style="text-align:left"><span>パスワード</span>
          <input id="login-pass" type="password" autocomplete="current-password" /></label>
        <button class="btn primary" id="login-btn" style="width:100%;margin-top:8px">ログイン</button>
        <div id="login-err" style="color:var(--bad);font-size:13px;margin-top:10px"></div>
      </div>`;
    const btn = document.getElementById('login-btn');
    const err = document.getElementById('login-err');
    btn.onclick = async () => {
      const mail = (document.getElementById('login-email').value || '').trim();
      const pass = document.getElementById('login-pass').value || '';
      if (!mail || !pass) { err.textContent = 'メールとパスワードを入力してください'; return; }
      btn.disabled = true; err.textContent = 'ログイン中…';
      try { await Cloud.signIn(mail, pass); err.textContent = ''; await startApp(); }
      catch (e) { btn.disabled = false; err.textContent = String(e && e.message || e); }
    };
  }

  // 同期結果が出たら、今リストを見ている画面だけ再描画する（編集中の画面は割り込まない）
  const REFRESHABLE_TABS = ['history', 'profiles'];
  function refreshIfChanged(r) {
    if (r && r.ok && r.added && REFRESHABLE_TABS.includes(state.tab)) render();
  }

  /* ---------- アプリ本体の起動（ログイン済み） ---------- */
  async function startApp() {
    document.getElementById('tabbar').style.display = '';
    state.tab = 'session';
    await reload();
    await syncNow(false).catch(() => {}); // デモ機播種より前に：クラウドにデータがあれば優先
    if (!state.profiles.length) { await seedDemo(); await reload(); }
    state.active = await DB.getActive();
    render();
    // アプリを開いている間、PC側の変更等を自動で取り込む定期同期（オンライン・前面表示中のみ）
    setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) syncNow(false).then(refreshIfChanged);
    }, 20000);
  }

  /* ---------- 起動 ---------- */
  (async function init() {
    // オンライン復帰時・前面復帰時に自動で同期（失敗は無視）
    window.addEventListener('online', () => syncNow(false).then(refreshIfChanged));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncNow(false).then(refreshIfChanged);
    });
    // セッションが無ければログイン画面。あればオフラインでも本体を起動（同期はオンライン時のみ）。
    if (!Cloud.hasSession()) renderLogin();
    else await startApp();
  })();

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
