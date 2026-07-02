/* ===== 判別エンジン =====
 * 仕様: docs_practice_counter_spec_2026-06-28.md 第4章
 *  - metric.source: "counter:<key>" | "expr:<式>"   （生カウント/派生）
 *  - metric.denominator: "total_spins" | "valid_g" | "counter:<key>" | 数値
 *  - metric.mode: "fraction"(1/X) | "percent"(振り分け%)
 *  - metric.settings: {1..6}  fraction→分母X / percent→%
 * 総合期待度: 各metricの観測尤度を設定別に掛け合わせ→softmaxで事後確率
 */
const Engine = (() => {
  const SETTINGS = ['1', '2', '3', '4', '5', '6'];
  const clampP = (p) => Math.min(1 - 1e-9, Math.max(1e-9, p));

  // counter:key / hit:field=値 / expr:式 を評価して「発生回数 k」を得る
  // 第2引数は session（counts と history の両方を参照する）
  function evalSource(source, session) {
    if (!source) return null;
    const counts = (session && session.counts) || {};
    if (source.startsWith('counter:')) {
      const k = source.slice(8).trim();
      return Number(counts[k] || 0);
    }
    if (source.startsWith('hit:')) {
      // hit:<field>=<値>  大当たり履歴から該当する当たりの件数を数える
      //   trigger=契機key / triggerGroup=契機グループ / type=種別
      const body = source.slice(4);
      const eq = body.indexOf('=');
      if (eq < 0) return null;
      const field = body.slice(0, eq).trim();
      const val = body.slice(eq + 1).trim();
      const hist = (session && session.history) || [];
      let n = 0;
      for (const h of hist) {
        if (!h) continue;
        if (String(h[field] != null ? h[field] : '') === val) n++;
      }
      return n;
    }
    if (source.startsWith('expr:')) {
      const expr = source.slice(5);
      // 安全のため許可文字のみ。counterキーを値に置換して評価
      let s = expr;
      for (const key of Object.keys(counts)) {
        s = s.replace(new RegExp('\\b' + key.replace(/[^a-zA-Z0-9_]/g, '') + '\\b', 'g'), '(' + Number(counts[key] || 0) + ')');
      }
      if (!/^[-+*/().0-9\s]*$/.test(s)) return null; // 未解決キーや不正文字
      try { const v = Function('"use strict";return (' + s + ')')(); return isFinite(v) ? v : null; }
      catch { return null; }
    }
    return null;
  }

  // 分母（試行数 N）を解決
  function resolveDenom(denominator, session) {
    // 実践G = 総回転数 − スタートG（途中から打った分のみを分母にする）
    if (denominator === 'total_spins') return Math.max(0, Number(session.total_spins || 0) - Number(session.start_spins || 0));
    if (denominator === 'valid_g')     return Number(session.valid_g || 0);
    if (denominator === 'hits')        return (session.history || []).length; // 大当たり回数（振り分け%の分母）
    if (typeof denominator === 'string' && denominator.startsWith('counter:'))
      return Number(session.counts[denominator.slice(8).trim()] || 0);
    const n = Number(denominator);
    return isFinite(n) ? n : 0;
  }

  /* ===== 計算式（formula）評価器 =====
   * tokens: 配列。各要素は下記いずれか
   *   {op:'+'|'-'|'*'|'/'|'('|')'}    演算子・括弧
   *   {num: <数値>}                    数値リテラル
   *   {var:'total_g'|'played_g'|'valid_g'|'hits'}                 セッション値
   *   {var:'counter'|'type'|'trig'|'group'|'metric', ref:'<キー/名前>'}  参照値
   * 計算順序: ×÷ を +− より先に、括弧最優先（shunting-yard で厳密評価）。
   * 未確定変数・0除算・式の破綻時は null（→メトリックは非アクティブ扱い）。
   */
  function countHits(session, field, val) {
    const hist = (session && session.history) || [];
    let n = 0;
    for (const h of hist) { if (!h) continue; if (String(h[field] != null ? h[field] : '') === String(val)) n++; }
    return n;
  }
  // 判別メトリック参照 → その実測比率(k/N)。循環参照は null。
  function metricRatio(key, session, ctx) {
    if (!ctx || !ctx.metrics || !ctx.stack || ctx.stack.has(key)) return null;
    const m = ctx.metrics.find(x => x.key === key);
    if (!m) return null;
    ctx.stack.add(key);
    const res = computeMetric(m, session, ctx);
    ctx.stack.delete(key);
    return res.active ? res.measuredP : null;
  }
  function tokenValue(tok, session, ctx) {
    if (!tok || tok.op) return null;
    if (tok.num != null) return Number(tok.num);
    switch (tok.var) {
      case 'total_g':  return Math.max(0, Number(session.total_spins || 0));
      case 'played_g': return Math.max(0, Number(session.total_spins || 0) - Number(session.start_spins || 0));
      case 'valid_g':  return Number(session.valid_g || 0);
      case 'hits':     return (session.history || []).length;
      case 'counter':  return Number(((session.counts) || {})[tok.ref] || 0);
      case 'type':     return countHits(session, 'type', tok.ref);
      case 'trig':     return countHits(session, 'trigger', tok.ref);
      case 'group':    return countHits(session, 'triggerGroup', tok.ref);
      case 'metric':   return metricRatio(tok.ref, session, ctx);
      default:         return null;
    }
  }
  function evalFormulaTokens(tokens, session, ctx) {
    if (!tokens || !tokens.length) return null;
    ctx = ctx || { metrics: [], stack: new Set() };
    const prec = { '+': 1, '-': 1, '*': 2, '/': 2, 'u-': 3 };
    const out = [], ops = [];
    let prev = 'start'; // start | operand | op | lparen | rparen
    for (const t of tokens) {
      if (t.op === '(') { ops.push('('); prev = 'lparen'; }
      else if (t.op === ')') {
        while (ops.length && ops[ops.length - 1] !== '(') out.push({ op: ops.pop() });
        if (!ops.length) return null; // 括弧の対応崩れ
        ops.pop(); prev = 'rparen';
      } else if (t.op === '+' || t.op === '-' || t.op === '*' || t.op === '/') {
        let op = t.op;
        const unaryCtx = (prev === 'start' || prev === 'op' || prev === 'lparen');
        if (op === '+' && unaryCtx) { prev = 'op'; continue; } // 単項プラスは無視
        if (op === '-' && unaryCtx) op = 'u-';                 // 単項マイナス
        if ((op === '*' || op === '/') && unaryCtx) return null; // ×÷ が先頭に来るのは不正
        while (ops.length) {
          const top = ops[ops.length - 1];
          if (top === '(') break;
          if ((op === 'u-' && prec[top] > prec[op]) || (op !== 'u-' && prec[top] >= prec[op])) out.push({ op: ops.pop() });
          else break;
        }
        ops.push(op); prev = 'op';
      } else {
        const v = tokenValue(t, session, ctx);
        if (v == null || !isFinite(v)) return null;
        out.push({ num: v }); prev = 'operand';
      }
    }
    while (ops.length) { const o = ops.pop(); if (o === '(') return null; out.push({ op: o }); }
    const st = [];
    for (const it of out) {
      if (it.num != null) { st.push(it.num); continue; }
      if (it.op === 'u-') { if (!st.length) return null; st.push(-st.pop()); continue; }
      if (st.length < 2) return null;
      const b = st.pop(), a = st.pop();
      let r;
      if (it.op === '+') r = a + b;
      else if (it.op === '-') r = a - b;
      else if (it.op === '*') r = a * b;
      else if (it.op === '/') { if (b === 0) return null; r = a / b; }
      else return null;
      st.push(r);
    }
    return (st.length === 1 && isFinite(st[0])) ? st[0] : null;
  }

  // 1メトリックの計算
  function computeMetric(metric, session, ctx) {
    ctx = ctx || { metrics: [], stack: new Set() };
    const k = metric.sourceTokens ? evalFormulaTokens(metric.sourceTokens, session, ctx) : evalSource(metric.source, session);
    const N = metric.denomTokens ? evalFormulaTokens(metric.denomTokens, session, ctx) : resolveDenom(metric.denominator, session);
    const include = metric.include !== false; // 総合判別に統合（既定on）
    const base = { key: metric.key, label: metric.label, mode: metric.mode, settings: metric.settings, include, k, N };
    if (k == null || !(N > 0) || k < 0 || k > N) return { ...base, active: false };

    const isFrac = metric.mode === 'fraction';
    const measuredP = k / N;                       // 実測確率
    const measured = isFrac
      ? (k > 0 ? N / k : null)                      // 1/X の X
      : measuredP * 100;                            // %

    // 設定別: 理論確率 p_s と 対数尤度（組合せ項は設定間で一定→省略）
    const logL = {}, theo = {};
    for (const s of SETTINGS) {
      const raw = Number(metric.settings && metric.settings[s]);
      if (!isFinite(raw) || raw <= 0) { logL[s] = null; theo[s] = null; continue; }
      const p = clampP(isFrac ? 1 / raw : raw / 100);
      theo[s] = p;
      logL[s] = k * Math.log(p) + (N - k) * Math.log(1 - p);
    }
    // 実測に最も近い設定（確率空間の差）
    let near = null, best = Infinity;
    for (const s of SETTINGS) {
      if (theo[s] == null) continue;
      const d = Math.abs(theo[s] - measuredP);
      if (d < best) { best = d; near = s; }
    }
    return { ...base, active: true, measuredP, measured, logL, theo, near };
  }

  // 総合期待度（事後確率%）
  function totalExpectation(metrics, session) {
    const ctx = { metrics: metrics || [], stack: new Set() };
    const computed = (metrics || []).map(m => computeMetric(m, session, ctx));
    const active = computed.filter(m => m.active && m.include && Object.values(m.logL).some(v => v != null));
    if (!active.length) return { computed, posterior: null, best: null, anyData: false, usedCount: 0 };

    const sum = {};
    for (const s of SETTINGS) {
      let acc = 0, ok = false;
      for (const m of active) { if (m.logL[s] != null) { acc += m.logL[s]; ok = true; } }
      sum[s] = ok ? acc : null;
    }
    const vals = SETTINGS.filter(s => sum[s] != null);
    if (!vals.length) return { computed, posterior: null, best: null, anyData: false, usedCount: 0 };
    const mx = Math.max(...vals.map(s => sum[s]));
    let denom = 0; const exp = {};
    for (const s of vals) { exp[s] = Math.exp(sum[s] - mx); denom += exp[s]; }
    const posterior = {};
    for (const s of SETTINGS) posterior[s] = sum[s] == null ? null : (exp[s] / denom) * 100;
    let best = null, bv = -1;
    for (const s of vals) if (posterior[s] > bv) { bv = posterior[s]; best = s; }
    return { computed, posterior, best, anyData: true, usedCount: active.length };
  }

  return { SETTINGS, computeMetric, totalExpectation, evalSource, resolveDenom, evalFormulaTokens };
})();
