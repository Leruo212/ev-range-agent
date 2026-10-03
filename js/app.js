/**
 * 应用入口：表单 → 分析 → 渲染 → 对话
 */

import { EV_DB, searchCars, toSpec, customSpec, getCarById } from './evdb.js';
import { loadSettings, saveSettings, DEFAULT_SETTINGS, PRESETS, maskKey } from './config.js';
import { runTripAnalysis, summarize, compareOnRoute } from './trip.js';
import { runAgent, listModels } from './agent.js';
import { suggestPlaces } from './geo.js';
import { renderResults, renderLoading, renderError, mdToHtml, esc } from './ui.js';

const $ = (id) => document.getElementById(id);

let settings = loadSettings();
let currentSpec = null;
let lastResult = null;
let chatMessages = [];
let busy = false;

// ================================================================ 初始化

function boot() {
  buildCarList();
  buildPresets();
  syncSettingsUI();
  setDefaultDepart();
  bindForm();
  bindChat();
  bindSettings();

  const sp = new URLSearchParams(location.search);

  // 分享链接优先：带完整参数的链接打开就直接还原并跑一遍
  if (sp.has('demo')) {
    fillDemo();
    setTimeout(() => runFromForm(), 60);
    return;
  }
  if (sp.get('o') && sp.get('d') && (sp.get('car') || sp.get('cb'))) {
    applyParams(sp);
    setTimeout(() => runFromForm(), 60);
    return;
  }

  $('car-input').value = '小米 SU7 Pro';
  resolveCar('小米 SU7 Pro');
}

/** 把 URL 参数还原到表单上 */
function applyParams(sp) {
  const set = (id, v) => { if (v != null && v !== '') $(id).value = v; };
  set('origin', sp.get('o'));
  set('destination', sp.get('d'));
  set('waypoints', sp.get('w'));
  set('compare', sp.get('cmp'));
  set('passengers', sp.get('pax'));
  set('luggage', sp.get('lug'));
  set('hvac', sp.get('hvac'));
  if (sp.get('soc')) {
    $('soc').value = sp.get('soc');
    $('soc-val').textContent = sp.get('soc') + '%';
  }
  if (sp.get('t')) $('depart').value = sp.get('t');

  const carId = sp.get('car');
  if (carId && carId !== 'custom' && getCarById(carId)) {
    $('car-input').value = `${getCarById(carId).brand} ${getCarById(carId).model}`;
    resolveCar($('car-input').value);
    return;
  }
  if (sp.get('cb')) {
    set('c-name', sp.get('cn'));
    set('c-battery', sp.get('cb'));
    set('c-range', sp.get('cr'));
    set('c-mass', sp.get('cm'));
    set('c-dc', sp.get('cd'));
    const cs = readCustomCar();
    if (cs) {
      currentSpec = cs;
      $('car-input').value = cs.name;
      renderCarPicked();
    }
  }
}

/** 把当前表单状态编码成可分享的链接 */
function buildShareURL() {
  const p = collectParams();
  const sp = new URLSearchParams();
  sp.set('o', p.origin);
  sp.set('d', p.destination);
  if (p.waypoints.length) sp.set('w', p.waypoints.join(','));
  if (p.compare.length) sp.set('cmp', p.compare.join(','));

  const carId = $('car-id').value;
  if (carId && getCarById(carId)) {
    sp.set('car', carId);
  } else {
    sp.set('car', 'custom');
    sp.set('cn', p.spec.name);
    sp.set('cb', p.spec.battery);
    sp.set('cr', p.spec.range);
    sp.set('cm', p.spec.mass);
    sp.set('cd', p.spec.dc);
  }
  sp.set('pax', p.passengers);
  sp.set('lug', p.luggageKg);
  sp.set('soc', p.socStart);
  sp.set('hvac', p.hvacMode);
  if ($('depart').value) sp.set('t', $('depart').value);
  return `${location.origin}${location.pathname}?${sp.toString()}`;
}

function buildCarList() {
  const dl = $('car-list');
  // 副标题里带上平台与换电，用户才能发现「NT3.0 有哪些车」
  dl.innerHTML = EV_DB.map((c) => {
    const meta = [`CLTC ${c.range}km`, `${c.battery}kWh`];
    if (c.platform) meta.push(c.platform);
    if (c.swap) meta.push('可换电');
    return `<option value="${esc(c.brand)} ${esc(c.model)}">${esc(meta.join(' · '))}</option>`;
  }).join('');
}

function setDefaultDepart() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const pad = (v) => String(v).padStart(2, '0');
  $('depart').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ================================================================ 车型

function resolveCar(query) {
  const q = String(query || '').trim();
  if (!q) { currentSpec = null; renderCarPicked(); return; }
  const exact = EV_DB.find((c) => `${c.brand} ${c.model}` === q);
  const list = exact ? [exact] : searchCars(q, 1);
  if (list.length) {
    currentSpec = toSpec(list[0]);
    $('car-id').value = list[0].id;
  } else {
    currentSpec = null;
    $('car-id').value = '';
  }
  renderCarPicked();
}

function renderCarPicked() {
  const box = $('car-picked');
  if (!currentSpec) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  currentSpec.swap = !!currentSpec.swap;
  box.innerHTML = `<b>${esc(currentSpec.name)}</b>
    ${currentSpec.platform ? `<span class="tag">${esc(currentSpec.platform)}</span>` : ''}
    ${currentSpec.swap ? '<span class="tag tag-swap">支持换电</span>' : ''}
    <span>电池 ${currentSpec.battery} kWh</span>
    <span>CLTC ${currentSpec.range} km</span>
    <span>${currentSpec.mass} kg</span>
    <span>快充 ${currentSpec.dc} kW</span>
    <span>官方电耗 ${currentSpec.ratedPer100.toFixed(1)} kWh/100km</span>`;
}

function readCustomCar() {
  const name = $('c-name').value.trim();
  const battery = parseFloat($('c-battery').value);
  const range = parseFloat($('c-range').value);
  if (!battery || !range) return null;
  return customSpec({
    name: name || '自定义车型',
    battery, range,
    mass: parseFloat($('c-mass').value),
    dc: parseFloat($('c-dc').value),
    swap: $('c-swap').checked,
  });
}

// ================================================================ 地点联想

function bindAutocomplete(inputEl, listEl) {
  let timer = null;
  let items = [];
  let active = -1;

  const close = () => { listEl.hidden = true; listEl.innerHTML = ''; items = []; active = -1; };

  const choose = (p) => {
    inputEl.value = p.name || p.full;
    close();
  };

  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    const q = inputEl.value.trim();
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      try {
        const list = await suggestPlaces(q, 6);
        items = list;
        if (!list.length) { close(); return; }
        listEl.innerHTML = list.map((p, i) =>
          `<div class="ac-item" data-i="${i}">${esc(p.name)}<small>${esc(p.full)}</small></div>`).join('');
        listEl.hidden = false;
        active = -1;
      } catch (e) { close(); }
    }, 320);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (listEl.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); e.preventDefault(); }
    else if (e.key === 'Enter' && active >= 0) { choose(items[active]); e.preventDefault(); }
    else if (e.key === 'Escape') close();
    [...listEl.children].forEach((el, i) => el.classList.toggle('active', i === active));
  });

  listEl.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.ac-item');
    if (!el) return;
    e.preventDefault();
    choose(items[Number(el.dataset.i)]);
  });

  inputEl.addEventListener('blur', () => setTimeout(close, 160));
}

// ================================================================ 表单

function bindForm() {
  bindAutocomplete($('origin'), $('ac-origin'));
  bindAutocomplete($('destination'), $('ac-destination'));

  $('car-input').addEventListener('change', () => resolveCar($('car-input').value));
  $('car-input').addEventListener('input', () => {
    const q = $('car-input').value.trim();
    const exact = EV_DB.find((c) => `${c.brand} ${c.model}` === q);
    if (exact) resolveCar(q);
  });
  for (const id of ['c-name', 'c-battery', 'c-range', 'c-mass', 'c-dc']) {
    $(id).addEventListener('input', () => {
      const c = readCustomCar();
      if (c) { currentSpec = c; renderCarPicked(); }
    });
  }
  $('c-swap').addEventListener('change', () => {
    const c = readCustomCar();
    if (c) { currentSpec = c; renderCarPicked(); }
  });

  $('soc').addEventListener('input', () => { $('soc-val').textContent = $('soc').value + '%'; });

  $('btn-run').addEventListener('click', () => { runFromForm(); });

  $('btn-demo').addEventListener('click', () => { fillDemo(); runFromForm(); });
}

function fillDemo() {
  $('car-input').value = '小米 SU7 Pro';
  resolveCar('小米 SU7 Pro');
  $('origin').value = '重庆市渝北区';
  $('destination').value = '重庆市武隆区仙女山';
  $('waypoints').value = '';
  $('compare').value = '特斯拉 Model Y 长续航全轮驱动版, 理想 i8 Max';
  $('passengers').value = 3;
  $('luggage').value = 30;
  $('soc').value = 90;
  $('soc-val').textContent = '90%';
  $('hvac').value = 'auto';
  setDefaultDepart();
}

function collectParams() {
  const origin = $('origin').value.trim();
  const destination = $('destination').value.trim();
  if (!origin) throw new Error('请填写出发地');
  if (!destination) throw new Error('请填写目的地');
  if (!currentSpec) throw new Error('请选择一个车型（或展开手动填写参数）');

  const departVal = $('depart').value;
  const departISO = departVal ? new Date(departVal).toISOString() : new Date().toISOString();

  return {
    origin, destination,
    waypoints: $('waypoints').value.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean),
    compare: $('compare').value.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean).slice(0, 3),
    spec: currentSpec,
    passengers: Math.max(1, parseInt($('passengers').value, 10) || 1),
    luggageKg: Math.max(0, parseFloat($('luggage').value) || 0),
    departISO,
    socStart: parseInt($('soc').value, 10),
    hvacMode: $('hvac').value,
  };
}

async function runFromForm() {
  if (busy) return;
  let params;
  try {
    params = collectParams();
  } catch (e) {
    setStatus(e.message, 'err');
    return;
  }

  const container = $('results');
  busy = true;
  $('btn-run').disabled = true;
  setStatus('正在拉取数据…', '');
  const steps = [];
  renderLoading(container, '正在准备…', 3, steps);
  container.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const res = await runTripAnalysis(params, settings, (label, pct) => {
      steps.push(label);
      setStatus(label + '…', '');
      const lbl = $('load-label');
      const bar = $('load-bar');
      if (lbl) lbl.textContent = label + '…';
      if (bar) bar.style.width = pct + '%';
      const sl = container.querySelector('.steps-list');
      if (sl) sl.innerHTML = steps.map((s) => '· ' + esc(s)).join('<br>');
    });

    lastResult = res;

    // 对比车型复用同一份路线/天气数据，不额外打接口。
    // 本车永远排在第一行 —— 「我这台车 vs 别的车」才是用户真正要看的对比。
    let comparison = [];
    if (params.compare.length) {
      try {
        const others = params.compare.filter((q) => {
          const hit = searchCars(q, 1)[0];
          return !hit || `${hit.brand} ${hit.model}` !== params.spec.name;
        });
        comparison = compareOnRoute(
          res,
          [{ spec: params.spec }, ...others],
          {
            passengers: params.passengers,
            luggageKg: params.luggageKg,
            socStart: params.socStart,
            hvacMode: params.hvacMode,
          }
        );
      } catch (e) {
        console.warn('[compare] 失败：', e);
      }
    }

    renderResults(res, container, { departISO: params.departISO, comparison });
    bindResultTools();

    // 把参数写回地址栏，刷新和分享都还在这份结果上
    try {
      history.replaceState(null, '', buildShareURL());
    } catch (e) { /* 自定义车型信息不全时忽略 */ }

    // 把结论注入对话上下文，后续追问不必重新算一遍
    const sm = summarize(res);
    chatMessages.push({
      role: 'user',
      content: `【背景｜本地分析引擎刚跑出的结果，后续回答请以此为事实依据，不要重复调用相同参数的 analyze_trip】\n${sm}`,
    });
    pushMsg('assistant', `已拿到分析结果，存在上下文里了。有想追问的直接说，比如「如果路上堵了两小时」「改成凌晨出发会怎样」「换台车呢」。`);

    setStatus('完成', 'ok');
    const real = res.analysis;
    $('chat-model').textContent = `${settings.model || '未填模型'} · ${maskKey(settings.apiKey)}`;
    if (!settings.apiKey) {
      pushMsg('error', '提示：还没配置模型 API，对话功能需要先在右上角「API 设置」里填地址和 Key。上面的分析与计算不依赖 API，已经全部可用。');
    }
    void real;
  } catch (e) {
    console.error(e);
    renderError(container, e.message || String(e));
    setStatus('失败', 'err');
  } finally {
    busy = false;
    $('btn-run').disabled = false;
  }
}

function setStatus(text, cls) {
  const el = $('run-status');
  el.textContent = text;
  el.className = 'run-status' + (cls ? ' ' + cls : '');
}

/** 结果区是整块重渲染的，按钮每次都要重新绑 */
function bindResultTools() {
  const note = $('share-note');

  const shareBtn = $('btn-share');
  if (shareBtn) {
    shareBtn.addEventListener('click', async () => {
      let url = location.href;
      if (location.search.length < 2) {
        try { url = buildShareURL(); } catch (e) { /* 用当前地址兜底 */ }
      }
      let ok = false;
      try {
        await navigator.clipboard.writeText(url);
        ok = true;
      } catch (e) {
        // http 局域网等非安全上下文没有 clipboard API，退回 execCommand
        try {
          const ta = document.createElement('textarea');
          ta.value = url;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (e2) { ok = false; }
      }
      if (note) {
        note.textContent = ok
          ? '✓ 已复制，发给别人打开就是同一份结果'
          : '浏览器不允许自动复制 —— 链接就在上方地址栏，手动复制即可';
        note.className = 'tool-note' + (ok ? ' ok' : '');
      }
    });
  }

  const printBtn = $('btn-print');
  if (printBtn) printBtn.addEventListener('click', () => window.print());
}

// ================================================================ 对话

function pushMsg(role, content, opts = {}) {
  const log = $('chat-log');
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;
  const body = document.createElement('div');
  body.className = 'msg-body';
  if (role === 'user') body.textContent = content;
  else if (role === 'error') body.innerHTML = esc(content);
  else body.innerHTML = mdToHtml(content);
  div.appendChild(body);
  if (opts.trace) {
    const t = document.createElement('div');
    t.className = 'tool-trace';
    t.innerHTML = opts.trace;
    div.appendChild(t);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return { div, body };
}

function bindChat() {
  const ta = $('chat-text');

  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat();
    }
  });
  $('btn-send').addEventListener('click', sendChat);
  $('btn-clear-chat').addEventListener('click', () => {
    chatMessages = [];
    $('chat-log').innerHTML = '';
    pushMsg('assistant', '对话已清空。表单里的分析结果也一并从上下文里移除了，需要的话重新跑一次。');
  });

  document.querySelectorAll('.chip').forEach((c) => {
    c.addEventListener('click', () => {
      $('chat-text').value = c.textContent.trim();
      sendChat();
    });
  });
}

async function sendChat() {
  if (busy) {
    pushMsg('error', '正在跑上一次分析，等它出来再问——不然工具会打架。');
    return;
  }
  const ta = $('chat-text');
  const text = ta.value.trim();
  if (!text) return;

  if (!settings.apiKey && !/localhost|127\.0\.0\.1/.test(settings.baseUrl)) {
    pushMsg('user', text);
    pushMsg('error', '还没填 API Key。点右上角「API 设置」，选一个服务商、贴上 Key，保存后就能对话了。\n（续航空分析本身不需要 Key，表格里点「开始续航分析」即可。）');
    ta.value = '';
    return;
  }

  ta.value = '';
  ta.style.height = 'auto';
  pushMsg('user', text);
  chatMessages.push({ role: 'user', content: text });

  busy = true;
  $('btn-send').disabled = true;
  const { div, body } = pushMsg('assistant', '');
  body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';

  const traces = [];
  div.classList.add('msg-stacked');
  const traceEl = document.createElement('div');
  traceEl.className = 'tool-trace';
  traceEl.style.display = 'none';
  div.appendChild(traceEl);

  try {
    const res = await runAgent({
      settings,
      messages: chatMessages,
      onEvent: (type, p) => {
        if (type === 'step') {
          if (p.label && !/思考中|继续推理/.test(p.label)) {
            traces.push(`<span class="tt-ok">✓</span> ${esc(p.label)}`);
          }
        } else if (type === 'tool_start') {
          traces.push(`<span class="tt-ok">→</span> 调用 <b>${esc(p.name)}</b> ${esc(shortArgs(p.args))}`);
        } else if (type === 'tool_end') {
          const bad = p.result && p.result.error;
          traces.push(bad
            ? `<span class="tt-err">✕</span> ${esc(p.name)}：${esc(String(p.result.error).slice(0, 120))}`
            : `<span class="tt-ok">✓</span> ${esc(p.name)} 返回数据`);
        }
        traceEl.style.display = traces.length ? 'block' : 'none';
        traceEl.innerHTML = traces.join('<br>');
        $('chat-log').scrollTop = $('chat-log').scrollHeight;
      },
    });
    body.innerHTML = mdToHtml(res.content || '（模型没有返回内容）');
    if (res.degraded) {
      body.innerHTML += '<p style="color:var(--warn);font-size:12px;margin-top:8px">⚠ 当前模型不支持工具调用，已降级为纯对话——它无法主动查路线和天气。</p>';
    }
  } catch (e) {
    body.innerHTML = `<b>调用失败</b><br>${esc(e.message || String(e))}`;
    div.className = 'msg msg-error';
  } finally {
    busy = false;
    $('btn-send').disabled = false;
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
  }
}

function shortArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const keys = ['origin', 'destination', 'car_query', 'car_id', 'query', 'cars', 'distance_km'];
  const parts = [];
  for (const k of keys) {
    if (args[k] != null) parts.push(`${k}=${Array.isArray(args[k]) ? args[k].join('/') : args[k]}`);
    if (parts.length >= 3) break;
  }
  return parts.length ? parts.join('，') : '';
}

// ================================================================ 设置

function buildPresets() {
  $('preset-row').innerHTML = PRESETS.map((p, i) =>
    `<button class="preset" type="button" data-i="${i}" title="${esc(p.hint)}">${esc(p.label)}</button>`).join('');
  $('preset-row').addEventListener('click', (e) => {
    const b = e.target.closest('.preset');
    if (!b) return;
    const p = PRESETS[Number(b.dataset.i)];
    if (p.baseUrl) $('set-base').value = p.baseUrl;
    if (p.model) $('set-model').value = p.model;
    $('set-base').focus();
  });
}

function syncSettingsUI() {
  $('set-base').value = settings.baseUrl || '';
  $('set-key').value = settings.apiKey || '';
  $('set-model').value = settings.model || '';
  $('set-amap').value = settings.amapKey || '';
  $('set-temp').value = settings.temperature ?? 0.3;
  $('set-temp-val').textContent = settings.temperature ?? 0.3;
  $('chat-model').textContent = settings.apiKey
    ? `${settings.model || '未填模型'} · ${maskKey(settings.apiKey)}`
    : '未配置模型 — 点右上角「API 设置」';
}

function bindSettings() {
  const modal = $('modal');
  const open = () => { modal.hidden = false; };
  const close = () => { modal.hidden = true; };

  $('btn-settings').addEventListener('click', open);
  modal.addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });

  $('set-temp').addEventListener('input', () => { $('set-temp-val').textContent = $('set-temp').value; });

  $('btn-save').addEventListener('click', () => {
    settings = {
      ...settings,
      baseUrl: $('set-base').value.trim(),
      apiKey: $('set-key').value.trim(),
      model: $('set-model').value.trim(),
      amapKey: $('set-amap').value.trim(),
      temperature: parseFloat($('set-temp').value) || 0.3,
    };
    saveSettings(settings);
    syncSettingsUI();
    close();
    pushMsg('assistant', `设置已保存到本机浏览器。当前模型：\`${settings.model || '未填'}\`，Key：\`${maskKey(settings.apiKey)}\`。现在可以直接问我了。`);
  });

  $('btn-test').addEventListener('click', async () => {
    const el = $('test-result');
    const base = $('set-base').value.trim();
    const key = $('set-key').value.trim();
    el.className = 'test-result';
    el.textContent = '正在测试…';
    if (!base) { el.className = 'test-result err'; el.textContent = '请先填 API 地址'; return; }

    // 先试 /models，不支持就直接打一发最小对话
    try {
      const models = await listModels({ baseUrl: base, apiKey: key });
      el.className = 'test-result ok';
      el.innerHTML = `✓ 连接成功，该网关提供 ${models.length} 个模型。<br>可用示例：<code>${esc(models.slice(0, 6).join('</code> <code>'))}</code>`;
      return;
    } catch (e) { /* 继续试对话 */ }

    try {
      const r = await fetch((() => {
        let b = base.replace(/\/+$/, '');
        if (/\/chat\/completions$/.test(b)) return b;
        if (/\/v\d+$/.test(b)) return `${b}/chat/completions`;
        if (/\/compatible-mode$/.test(b)) return `${b}/v1/chat/completions`;
        return `${b}/chat/completions`;
      })(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model: $('set-model').value.trim(),
          messages: [{ role: 'user', content: '回复两个字：可用' }],
          max_tokens: 16,
        }),
      });
      const t = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
      const d = JSON.parse(t);
      const c = d.choices?.[0]?.message?.content || '';
      el.className = 'test-result ok';
      el.innerHTML = `✓ 对话接口可用，模型回复：<code>${esc(String(c).slice(0, 60))}</code>`;
    } catch (e) {
      el.className = 'test-result err';
      el.innerHTML = `✕ 连接失败：${esc(e.message || String(e))}<br>
        <span style="color:var(--muted)">请检查：地址是否写成 <code>https://xxx/v1</code> 形式、Key 是否有效、模型名是否在该网关存在。浏览器直连本地 Ollama 时记得放行跨域。</span>`;
    }
  });
}

// ================================================================ 启动

boot();
window.__evra = { runFromForm, state: () => ({ settings, currentSpec, lastResult }) };
