// 從 window.PLAN 畫出記憶體地圖、表格、速度圖和試算器。
// 所有來自資料的文字都用 textContent 放進 DOM。
(function () {
  'use strict';

  const P = window.PLAN;
  const GiB = 2 ** 30;
  const SCALE = P.hardware.ramGiB;
  const BENCH_CTX = 262144;

  // ---------- 小工具 ----------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'style') {
          for (const [sk, sv] of Object.entries(v)) {
            if (sk.startsWith('--')) node.style.setProperty(sk, sv);
            else node.style[sk] = sv;
          }
        }
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of [].concat(children || [])) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const nf0 = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  function fmt(n) { return nf0.format(n); }
  function fmtGiB(n) { return n >= 10 ? nf0.format(n) : nf1.format(n); }
  function gbToGiB(gb) { return (gb * 1e9) / GiB; }
  function range(lo, hi, f) { f = f || fmt; return lo === hi ? f(lo) : f(lo) + '–' + f(hi); }
  function ctxText(tokens) {
    return tokens >= 1048576 ? tokens / 1048576 + 'M' : Math.round(tokens / 1024) + 'K';
  }
  function duration(lo, hi) {
    if (hi < 120) return range(Math.round(lo), Math.round(hi)) + ' 秒';
    if (lo >= 120) return range(lo / 60, hi / 60, (v) => nf1.format(v)) + ' 分鐘';
    return fmt(lo) + ' 秒–' + nf1.format(hi / 60) + ' 分鐘';
  }
  const CONF = { c: '已確認', m: '實測', r: '社群回報', e: '推估' };
  function confChip(c) { return el('span', { class: 'conf', 'data-c': c, text: CONF[c] }); }

  function model(id) { return P.models.find((m) => m.id === id); }
  function quant(m, id) { return m.quants.find((q) => q.id === id); }

  // ---------- 記憶體計算 ----------

  function kvGiB(m, ctx, kv) { return (ctx * m.kvBytes[kv]) / GiB + m.fixedGiB; }

  function budget(m, q, ctx, kv, cacheGiB) {
    const parts = [
      { key: 'weights', gib: gbToGiB(q.weightsGB) },
      { key: 'kv', gib: kvGiB(m, ctx, kv) },
      { key: 'cache', gib: cacheGiB },
      { key: 'act', gib: m.actGiB },
    ];
    return { parts, total: parts.reduce((s, p) => s + p.gib, 0), ssdGiB: gbToGiB(q.ssdGB) };
  }

  function fitStatus(total, wired) {
    if (total > wired) return { s: 'over', icon: '✕', text: '放不下', why: '超出 GPU 上限 ' + fmtGiB(total - wired) + ' GiB' };
    const left = wired - total;
    if (left < P.hardware.tightMarginGiB) return { s: 'tight', icon: '!', text: '很緊', why: '只剩 ' + fmtGiB(left) + ' GiB，長 prompt 的 prefill 可能被 macOS 砍掉' };
    return { s: 'ok', icon: '✓', text: '放得下', why: '離 GPU 上限還有 ' + fmtGiB(left) + ' GiB' };
  }

  function segLabel(key) { return P.segments.find((s) => s.key === key).label; }

  // ---------- Tooltip ----------

  const tip = document.getElementById('tooltip');
  function showTip(evt, value, label) {
    tip.replaceChildren(el('b', { text: value }), el('span', { text: label }));
    tip.hidden = false;
    let x, y;
    if (evt.type === 'focus') {
      const r = evt.currentTarget.getBoundingClientRect();
      x = r.left + r.width / 2; y = r.top;
    } else { x = evt.clientX; y = evt.clientY; }
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2)) + 'px';
    tip.style.top = Math.max(8, y - h - 12) + 'px';
  }
  function hideTip() { tip.hidden = true; }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
  function bindTip(node, value, label) {
    node.tabIndex = 0;
    node.setAttribute('aria-label', label + ' ' + value);
    node.addEventListener('pointermove', (e) => showTip(e, value, label));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', (e) => showTip(e, value, label));
    node.addEventListener('blur', hideTip);
  }

  // ---------- 記憶體地圖 ----------

  function pct(gib) { return (Math.min(gib, SCALE) / SCALE) * 100; }

  function renderMap(b, opts) {
    const size = opts.size || 'lg';
    const wired = opts.wired;
    const root = el('div', { class: 'mmap ' + size + (opts.animate ? ' animate' : '') });
    const track = el('div', { class: 'mmap-track', role: 'img', 'aria-label': opts.aria || '' });

    track.append(el('div', {
      class: 'mmap-reserve',
      style: { width: pct(SCALE - wired) + '%' },
      text: 'macOS ' + fmt(SCALE - wired),
    }));

    let cum = 0;
    const visible = b.parts.filter((p) => p.gib > 0);
    visible.forEach((p, i) => {
      const left = pct(cum);
      const width = pct(cum + p.gib) - left;
      cum += p.gib;
      if (width <= 0) return;
      const isLast = i === visible.length - 1 || cum >= SCALE;
      const seg = el('div', {
        class: 'mmap-seg' + (isLast ? ' last' : ''),
        'data-k': p.key,
        style: { left: left + '%', width: isLast ? width + '%' : 'calc(' + width + '% - 2px)', '--i': i },
      }, size === 'lg' ? el('span', { class: 'in', text: segLabel(p.key).replace('（推估）', '').replace('（RAM 內）', '') + ' ' + fmtGiB(p.gib) }) : null);
      bindTip(seg, fmtGiB(p.gib) + ' GiB', segLabel(p.key));
      track.append(seg);
    });
    if (b.total > SCALE) track.append(el('div', { class: 'mmap-over', title: '超出實體記憶體' }));

    const marker = el('div', { class: 'mmap-marker right', style: { left: pct(wired) + '%' } },
      el('span', { text: 'GPU 可用上限 ' + fmt(wired) + ' GiB' }));
    track.append(marker);
    root.append(track);

    if (opts.ruler !== false) root.append(ruler());
    if (opts.legend) root.append(legend(b, wired));
    return root;
  }

  function ruler() {
    const r = el('div', { class: 'mmap-ruler', 'aria-hidden': 'true' });
    for (let g = 0; g <= SCALE; g += 128) {
      r.append(el('span', { style: { left: pct(g) + '%' }, text: g === SCALE ? g + ' GiB' : String(g) }));
    }
    return r;
  }

  function legend(b, wired) {
    const ul = el('ul', { class: 'mmap-legend' });
    b.parts.forEach((p) => {
      ul.append(el('li', null, [el('span', { class: 'sw', 'data-k': p.key }), segLabel(p.key), el('b', { text: fmtGiB(p.gib) }), 'GiB']));
    });
    ul.append(el('li', null, [el('span', { class: 'sw', 'data-k': 'reserve' }), '留給 macOS', el('b', { text: fmt(SCALE - wired) }), 'GiB']));
    if (b.ssdGiB > 0) {
      ul.append(el('li', { class: 'ssd' }, [el('span', { class: 'sw', 'data-k': 'ssd' }), '另放 SSD', el('b', { text: fmtGiB(b.ssdGiB) }), 'GiB']));
    }
    return ul;
  }

  // 區段內的文字放不下就藏起來，靠圖例和 tooltip 補
  function fitLabels(scope) {
    (scope || document).querySelectorAll('.mmap-seg .in').forEach((s) => {
      s.style.visibility = '';
      if (s.offsetWidth > s.parentNode.clientWidth - 18) s.style.visibility = 'hidden';
    });
    (scope || document).querySelectorAll('.mmap.lg .mmap-reserve').forEach((r) => {
      r.style.color = r.scrollWidth > r.clientWidth ? 'transparent' : '';
    });
  }

  function recBudget(m) {
    const q = quant(m, m.rec.quant);
    return { q, b: budget(m, q, m.rec.ctx, m.rec.kv, m.rec.cacheGiB) };
  }

  // ---------- Hero ----------

  function renderHero() {
    const m = model(P.primary);
    const { q, b } = recBudget(m);
    const wired = P.hardware.wiredRaisedGiB;
    document.getElementById('hero-map').append(renderMap(b, {
      wired, size: 'lg', legend: true, animate: true,
      aria: m.name + ' 主力配置共用 ' + fmtGiB(b.total) + ' GiB，GPU 上限 ' + wired + ' GiB',
    }));
    document.getElementById('hero-map-sub').textContent =
      q.label + '，' + ctxText(m.rec.ctx) + ' context。RAM 內合計 ' + fmtGiB(b.total) + ' GiB，GPU 上限 ' + wired + ' GiB';
  }

  // ---------- 模型 ----------

  function renderModelRows() {
    const box = document.getElementById('model-cards');
    P.models.forEach((m) => {
      box.append(el('div', { class: 'model-row' }, [
        el('div', null, [el('h3', { text: m.name }), el('span', { class: 'st', 'data-s': m.status, text: m.statusText })]),
        el('p', { text: m.summary }),
      ]));
    });
  }

  function macText(m) {
    const map = { yes: '✓', no: '✕', main: '△ 只有 main 分支', rc: '△ 只有 rc 版', bug: '△ prompt cache 有 bug', ggufbug: '△ prompt cache 有 bug，高精度 GGUF 讀錯', pr: '△ PR 中', cpu: '△ 主線支援，NVFP4 experts 在 Metal 上退回 CPU', nvfp4new: '△ 主線支援，Metal 的 NVFP4 kernel 11/23 才進來，沒人驗證' };
    return 'oMLX ' + map[m.mac.omlx] + '　llama.cpp ' + map[m.mac.llamacpp] + '　mlx-lm ' + map[m.mac.mlxlm];
  }

  function renderModelTable() {
    const t = document.getElementById('model-table');
    const head = el('tr', null, [el('th', { scope: 'col', text: '項目' })].concat(P.models.map((m) => el('th', { scope: 'col', text: m.name }))));
    t.append(el('thead', null, head));
    const rows = [
      ['狀態', (m) => m.statusText],
      ['Repo', (m) => el('code', { text: m.repo })],
      ['授權', (m) => m.license],
      ['總參數', (m) => m.params],
      ['Active', (m) => m.active],
      ['注意力', (m) => m.attention],
      ['原生 context', (m) => m.ctxNote],
      ['KV 每 token（BF16）', (m) => fmt(m.kvBytes.bf16) + ' B'],
      ['原生 context 的 KV', (m) => fmtGiB(kvGiB(m, m.ctx, 'bf16')) + ' GiB（BF16）'],
      ['256K 的 KV', (m) => fmtGiB(kvGiB(m, 262144, 'bf16')) + ' GiB（BF16）'],
      ['KV 備註', (m) => m.kvNote],
      ['官方權重', (m) => m.officialWeights],
      ['內建 draft', (m) => m.draft],
      ['Mac 支援', (m) => [el('div', { text: macText(m) }), el('div', { class: 'note', text: '另有：' + m.mac.other + '。' + m.macNote })]],
    ];
    P.benchmarks.forEach((bm) => rows.push([bm.label, (m) => (m.bench[bm.key] == null ? '—' : nf1.format(m.bench[bm.key])), true]));
    const tb = el('tbody');
    rows.forEach(([label, f, num]) => {
      tb.append(el('tr', null, [el('th', { scope: 'row', text: label })].concat(P.models.map((m) => el('td', { class: num ? 'num' : null }, f(m))))));
    });
    t.append(tb);
  }

  // ---------- Benchmark 門檻 ----------

  const GATE_RESULT = { pass: ['rec', '主力候選'], out: ['no', '移出'], pending: ['watch', '待定'] };

  function gateCell(c, text) {
    const cls = c.ok === true ? 'y' : c.ok === false ? 'n' : 'c';
    const mark = c.ok === true ? '✓ ' : c.ok === false ? '✕ ' : '';
    return el('td', { class: cls }, [mark + text, c.note ? el('div', { class: 'note', text: c.note }) : null]);
  }

  function renderGate() {
    const g = P.gate;
    const rules = document.getElementById('gate-rules');
    g.rules.forEach((r) => rules.append(el('li', null, [el('strong', { text: r.label + '。' }), r.text])));
    const t = document.getElementById('gate-table');
    const cols = ['模型', '放得下', 'DeepSWE v1.1 自報', 'DeepSWE（Mercor 重跑）', 'Terminal-Bench 4.1（tbench.ai）', 'Vals Terminal-Bench 4.0', 'Vals Index', '結果'];
    t.append(el('thead', null, el('tr', null, cols.map((h) => el('th', { scope: 'col', text: h })))));
    const tb = el('tbody');
    g.rows.forEach((r) => {
      const [v, label] = GATE_RESULT[r.result];
      tb.append(el('tr', { class: r.result === 'pass' ? 'pick' : null }, [
        el('th', { scope: 'row', text: r.name }),
        gateCell(r.fit, r.fit.text),
        gateCell(r.deepswe, r.deepswe.v),
        el('td', { class: 'num', text: r.mercor }),
        el('td', { class: 'num', text: r.tb41 }),
        gateCell(r.vals, r.vals.v),
        el('td', { class: 'num', text: r.valsIndex }),
        el('td', null, [el('span', { class: 'verdict', 'data-v': v, text: label }), r.why ? el('div', { class: 'note', text: r.why }) : null]),
      ]));
    });
    t.append(tb);
  }

  // ---------- 候選模型並排 ----------

  function renderMultiples() {
    const box = document.getElementById('multiples');
    const wired = P.hardware.wiredRaisedGiB;
    let anySsd = false;
    P.models.forEach((m) => {
      const { q, b } = recBudget(m);
      if (b.ssdGiB > 0) anySsd = true;
      const st = fitStatus(b.total, wired);
      box.append(el('div', { class: 'multiple' }, [
        el('div', { class: 'multiple-head' }, [
          el('span', { class: 'name', text: m.short }),
          el('span', { class: 'cfg', text: q.label + '，' + ctxText(m.rec.ctx) }),
        ]),
        renderMap(b, { wired, size: 'sm', ruler: false, aria: m.name + ' 共用 ' + fmtGiB(b.total) + ' GiB' }),
        el('div', { class: 'multiple-total' }, [
          el('span', { class: 'status', 'data-s': st.s }, [el('span', { class: 'ic', 'aria-hidden': 'true', text: st.icon })]),
          ' ', el('b', { text: fmtGiB(b.total) }), ' / ' + wired + ' GiB',
          b.ssdGiB > 0 ? el('div', { text: '另放 SSD ' + fmtGiB(b.ssdGiB) + ' GiB' }) : null,
        ]),
      ]));
    });
    const axis = el('div', { class: 'multiples-axis' }, ruler());
    box.append(axis);
    const lg = el('ul', { class: 'mmap-legend' });
    P.segments.forEach((s) => lg.append(el('li', null, [el('span', { class: 'sw', 'data-k': s.key }), s.label])));
    lg.append(el('li', null, [el('span', { class: 'sw', 'data-k': 'reserve' }), '留給 macOS']));
    box.append(lg);
    if (anySsd) box.append(el('p', { class: 'note', text: '細線是 GPU 可用上限（' + wired + ' GiB）。DeepSeek 的 Engram 查表放在 SSD，不算在 RAM 內。' }));
  }

  // ---------- 量化表 ----------

  const VERDICT = { rec: '建議', alt: '可考慮', watch: '觀察', no: '不建議' };

  function speedText(q) {
    return [
      el('div', { class: 'spd' }, [el('span', { class: 'spd-k', text: 'decode' }), range(q.decode.lo, q.decode.hi), ' ', confChip(q.decode.conf)]),
      el('div', { class: 'spd' }, [el('span', { class: 'spd-k', text: 'prefill' }), range(q.prefill.lo, q.prefill.hi), ' ', confChip(q.prefill.conf)]),
    ];
  }

  function renderQuantTable() {
    const t = document.getElementById('quant-table');
    t.append(el('thead', null, el('tr', null, ['方案', 'RAM 內權重', 'SSD', '精度', 'Runtime', '速度 tok/s', '判斷'].map((h) => el('th', { scope: 'col', text: h })))));
    P.models.forEach((m) => {
      const tb = el('tbody');
      tb.append(el('tr', null, el('th', { scope: 'colgroup', colspan: '7', class: 'group', text: m.name + (m.status === 'pending' ? '（權重未釋出，以前一代估算）' : '') })));
      m.quants.forEach((q) => {
        tb.append(el('tr', { class: q.verdict === 'rec' ? 'pick' : null }, [
          el('th', { scope: 'row' }, [q.label, el('small', { text: q.repo })]),
          el('td', { class: 'size' }, [fmt(q.weightsGB) + ' GB', el('small', { style: { display: 'block', color: 'var(--muted)' }, text: '≈ ' + fmtGiB(gbToGiB(q.weightsGB)) + ' GiB' })]),
          el('td', { class: 'size', text: q.ssdGB ? fmt(q.ssdGB) + ' GB' : '—' }),
          el('td', null, [el('div', { text: q.bpw }), el('div', null, [q.quality, ' ', confChip(q.qualityConf)])]),
          el('td', { text: q.runtime }),
          el('td', null, speedText(q)),
          el('td', null, [el('span', { class: 'verdict', 'data-v': q.verdict, text: VERDICT[q.verdict] }), q.verdictText ? el('div', { class: 'note', text: q.verdictText }) : null]),
        ]));
      });
      t.append(tb);
    });
  }

  // ---------- 速度圖 ----------

  function niceMax(v, step) { return Math.ceil(v / step) * step; }

  function renderRangeChart(id, rows, opts) {
    const fig = document.getElementById(id);
    const body = fig.querySelector('.chart-body');
    const max = niceMax(Math.max(...rows.map((r) => r.hi)) * 1.08, opts.step);
    const ticks = [];
    for (let v = 0; v <= max; v += opts.step) ticks.push(v);
    const pos = (v) => (v / max) * 100;

    const rp = el('div', { class: 'rp' });
    rows.forEach((r) => {
      const plot = el('div', { class: 'rp-plot' });
      ticks.forEach((v) => plot.append(el('div', { class: 'rp-grid' + (v === 0 ? ' zero' : ''), style: { left: pos(v) + '%' } })));
      const left = pos(r.lo);
      const width = Math.max(pos(r.hi) - left, 0);
      plot.append(el('div', { class: 'rp-bar', 'data-c': r.conf, style: { left: left + '%', width: width + '%' } }));
      const valText = opts.format(r.lo, r.hi);
      const valLeft = pos(r.hi);
      const val = el('span', { class: 'rp-val', text: valText + '　' + CONF[r.conf] });
      if (valLeft > 72) { val.style.right = (100 - left) + '%'; val.style.paddingLeft = '0'; val.style.paddingRight = '8px'; }
      else val.style.left = 'calc(' + valLeft + '% + 4px)';
      plot.append(val);
      const hit = el('div', { class: 'rp-hit', style: { left: '0', right: '0' } });
      bindTip(hit, valText + opts.unit, r.name + '，' + CONF[r.conf]);
      plot.append(hit);
      rp.append(el('div', { class: 'rp-row' }, [el('div', { class: 'rp-label' }, [r.name, el('small', { text: r.cfg })]), plot]));
    });
    const axis = el('div', { class: 'rp-axis', 'aria-hidden': 'true' });
    ticks.forEach((v) => axis.append(el('span', { style: { left: pos(v) + '%' }, text: fmt(v) })));
    rp.append(el('div', { class: 'rp-axis-wrap' }, axis));
    body.append(rp);

    const tv = el('table', null, [
      el('thead', null, el('tr', null, ['模型', '配置', opts.colLabel, '類型', '依據'].map((h) => el('th', { scope: 'col', text: h })))),
      el('tbody', null, rows.map((r) => el('tr', null, [
        el('th', { scope: 'row', text: r.name }), el('td', { text: r.cfg }), el('td', { class: 'num', text: opts.format(r.lo, r.hi) }),
        el('td', null, confChip(r.conf)), el('td', { text: r.note }),
      ]))),
    ]);
    fig.querySelector('.tv').append(el('div', { class: 'table-wrap' }, tv));
  }

  function renderSpeed() {
    const decodeRows = [];
    const ttftRows = [];
    P.models.forEach((m) => {
      const q = quant(m, m.rec.quant);
      const cfg = q.label;
      decodeRows.push({ name: m.short, cfg, lo: q.decode.lo, hi: q.decode.hi, conf: q.decode.conf, note: q.decode.note });
      ttftRows.push({
        name: m.short, cfg,
        lo: BENCH_CTX / q.prefill.hi, hi: BENCH_CTX / q.prefill.lo, conf: q.prefill.conf,
        note: 'prefill ' + range(q.prefill.lo, q.prefill.hi) + ' tok/s。' + q.prefill.note,
      });
    });
    renderRangeChart('chart-decode', decodeRows, { step: 20, unit: ' tok/s', colLabel: 'tok/s', format: (lo, hi) => range(lo, hi) });
    renderRangeChart('chart-ttft', ttftRows, { step: 60, unit: '', colLabel: '秒', format: (lo, hi) => range(Math.round(lo), Math.round(hi)) + ' 秒' });
  }

  // ---------- 試算器 ----------

  const state = {};

  function radioGroup(container, name, items, current, onChange, rich) {
    container.replaceChildren();
    items.forEach((it) => {
      const input = el('input', { type: 'radio', name, value: it.value });
      input.checked = String(it.value) === String(current);
      input.addEventListener('change', () => onChange(it.value));
      const span = rich ? el('span', null, [it.label, el('small', { text: it.sub })]) : el('span', { text: it.label });
      container.append(el('label', null, [input, span]));
    });
  }

  function setModel(id) {
    const m = model(id);
    // 重建選項會移除目前 focus 的 radio，重建後把 focus 放回新選到的模型
    const hadFocus = document.activeElement && document.activeElement.name === 'model';
    Object.assign(state, { model: id, quant: m.rec.quant, ctx: m.rec.ctx, kv: m.rec.kv, cache: m.rec.cacheGiB });
    document.getElementById('p-cache').value = state.cache;
    buildControls();
    renderPlanner();
    if (hadFocus) document.querySelector('#p-model input[value="' + id + '"]').focus();
  }

  function buildControls() {
    const m = model(state.model);
    radioGroup(document.getElementById('p-model'), 'model', P.models.map((x) => ({ value: x.id, label: x.short })), state.model, setModel);
    radioGroup(document.getElementById('p-quant'), 'quant', m.quants.map((q) => ({
      value: q.id, label: q.label, sub: fmt(q.weightsGB) + ' GB' + (q.ssdGB ? '，SSD ' + fmt(q.ssdGB) + ' GB' : '') + '。' + VERDICT[q.verdict] + (q.verdictText ? '：' + q.verdictText : ''),
    })), state.quant, (v) => { state.quant = v; renderPlanner(); }, true);
    radioGroup(document.getElementById('p-ctx'), 'ctx', m.ctxOptions.map((c) => ({ value: c.tokens, label: c.label })), state.ctx, (v) => { state.ctx = Number(v); renderPlanner(); });
    radioGroup(document.getElementById('p-kv'), 'kv', [{ value: 'bf16', label: 'BF16' }, { value: 'q8', label: '8-bit' }], state.kv, (v) => { state.kv = v; renderPlanner(); });
    radioGroup(document.getElementById('p-wired'), 'wired', [
      { value: P.hardware.wiredRaisedGiB, label: '建議 ' + P.hardware.wiredRaisedGiB + ' GiB' },
      { value: P.hardware.wiredDefaultGiB, label: '預設 ' + P.hardware.wiredDefaultGiB + ' GiB' },
    ], state.wired, (v) => { state.wired = Number(v); renderPlanner(); });
  }

  function renderPlanner() {
    const m = model(state.model);
    const q = quant(m, state.quant);
    const b = budget(m, q, state.ctx, state.kv, state.cache);
    const st = fitStatus(b.total, state.wired);
    document.getElementById('p-cache-out').textContent = state.cache + ' GiB';

    document.getElementById('p-status').replaceChildren(el('span', { class: 'status', 'data-s': st.s }, [
      el('span', { class: 'ic', 'aria-hidden': 'true', text: st.icon }), st.text, el('span', { class: 'why', text: st.why }),
    ]));

    const mapBox = document.getElementById('p-map');
    mapBox.replaceChildren(renderMap(b, { wired: state.wired, size: 'lg', legend: true, aria: '試算結果共用 ' + fmtGiB(b.total) + ' GiB' }));

    const ttftLo = state.ctx / q.prefill.hi, ttftHi = state.ctx / q.prefill.lo;
    const items = [
      ['RAM 內合計', fmtGiB(b.total) + ' GiB', '上限 ' + state.wired + ' GiB'],
      ['KV cache', fmtGiB(b.parts[1].gib) + ' GiB', ctxText(state.ctx) + '，' + (state.kv === 'bf16' ? 'BF16' : '8-bit')],
      ['Decode', range(q.decode.lo, q.decode.hi) + ' tok/s', CONF[q.decode.conf]],
      ['Prefill', range(q.prefill.lo, q.prefill.hi) + ' tok/s', CONF[q.prefill.conf]],
      ['冷啟動讀完整個 context', duration(ttftLo, ttftHi), '沒有 cache 時'],
    ];
    if (b.ssdGiB > 0) items.splice(1, 0, ['SSD', fmtGiB(b.ssdGiB) + ' GiB', '查表，不佔 RAM']);
    document.getElementById('p-breakdown').replaceChildren(...items.map(([k, v, s]) => el('div', null, [el('dt', { text: k }), el('dd', null, [v, ' ', el('small', { text: s })])])));

    const notes = ['精度：' + q.quality + '。Runtime：' + q.runtime + '。'];
    if (q.decode.note) notes.push('Decode：' + q.decode.note + '。');
    if (state.kv === 'q8' && m.id === 'mm') notes.push('還沒有 Mac runtime 確認能把 MiniMax M3.1 的 KV 存成 8-bit：llama.cpp 還不支援 M3.1，oMLX 0.7.1 的 Affine8 KV 能不能用在 MSA 層還沒有人測過。');
    if (state.kv === 'q8' && m.id !== 'mm') notes.push('這個模型的 KV 本來就小，量化 KV 省不了多少，還可能讓某些 server 退回較慢的 attention。');
    if (m.id === 'qwen' && state.ctx > m.ctx) notes.push('超過 262K 要開 YaRN，短 prompt 的品質可能變差。');
    if (state.ctx > BENCH_CTX && q.prefill.conf === 'm') notes.push('Prefill 實測是在 256K 量的，更長的 context 可能更慢。');
    if (m.status === 'pending') notes.push('這個模型的權重還沒釋出，數字是用前一代的架構估算的。');
    document.getElementById('p-notes').textContent = notes.join(' ');
    requestAnimationFrame(() => fitLabels(mapBox));
  }

  function initPlanner() {
    state.wired = P.hardware.wiredRaisedGiB;
    document.getElementById('p-cache').addEventListener('input', (e) => { state.cache = Number(e.target.value); renderPlanner(); });
    setModel(P.primary);
  }

  // ---------- 來源 ----------

  function renderSources() {
    const box = document.getElementById('source-list');
    P.sources.forEach((g) => {
      box.append(el('div', null, [
        el('h3', { text: g.group }),
        el('ul', null, g.items.map(([label, href]) => el('li', null, el('a', { href, text: label, rel: 'noopener' })))),
      ]));
    });
  }

  // ---------- 目錄與主題 ----------

  function initToc() {
    const links = Array.from(document.querySelectorAll('.toc a'));
    const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        links.forEach((a) => a.removeAttribute('aria-current'));
        const a = byId.get(e.target.id);
        if (a) a.setAttribute('aria-current', 'true');
      });
    }, { rootMargin: '-20% 0px -70% 0px' });
    byId.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
  }

  function initTheme() {
    const btn = document.querySelector('.theme-toggle');
    btn.addEventListener('click', () => {
      const root = document.documentElement;
      const cur = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) { /* 無痕模式等情況存不了，沒關係 */ }
    });
  }

  // ---------- 啟動 ----------

  renderHero();
  renderModelRows();
  renderModelTable();
  renderGate();
  renderMultiples();
  renderQuantTable();
  renderSpeed();
  initPlanner();
  renderSources();
  initToc();
  initTheme();
  requestAnimationFrame(() => fitLabels());
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => fitLabels(), 120); });
})();
