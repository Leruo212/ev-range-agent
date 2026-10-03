/**
 * 渲染层：把分析结果画成能看懂的东西。
 * 所有图表都是手写 SVG —— 没有图表库依赖，离线也能跑，样式完全可控。
 */

import { fmtDuration } from './model.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const n0 = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('zh-CN') : '—');
const signed = (v) => (v > 0 ? '+' : '') + n1(v);

// ================================================================ Markdown

/** 够用就好的 Markdown 渲染器：标题/列表/表格/粗体/行内代码/链接/代码块 */
export function mdToHtml(md) {
  if (!md) return '';
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^\s*```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lv = Math.min(4, h[1].length);
      out.push(`<h${lv + 2}>${inline(h[2])}</h${lv + 2}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // 表格
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
        i++;
      }
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((t) => `<li>${inline(t)}</li>`).join('') + `</${tag}>`);
      continue;
    }

    // 空行
    if (!line.trim()) { i++; continue; }

    // 段落
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,4}\s|[-*+]\s|\d+\.\s|>|\|)/.test(lines[i]) && !/^\s*```/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`); else i++;
  }
  return out.join('');
}

// ================================================================ 海拔剖面

/**
 * 海拔剖面图。
 * 关键设计：爬坡段用暖色加粗描出来 —— 用户一眼就能看到「哪一段在吃电」。
 */
export function elevationSVG(profile, opts = {}) {
  const { chargeStops = [], rests = [] } = opts;
  if (!profile || profile.length < 2) return '';

  const W = 800, H = 236;
  const PAD = { l: 48, r: 16, t: 18, b: 36 };
  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;

  const totalKm = profile[profile.length - 1].km || 1;
  const eles = profile.map((p) => p.ele || 0);
  const rawMin = Math.min(...eles);
  let minE = rawMin, maxE = Math.max(...eles);
  const span = Math.max(60, maxE - minE);
  const pad = span * 0.14;
  minE -= pad; maxE += pad;
  // 别把纵轴画到海平面以下——内陆路线看着像事故
  if (minE < 0 && rawMin > 0) minE = 0;

  const X = (km) => PAD.l + (Math.max(0, Math.min(totalKm, km)) / totalKm) * pw;
  const Y = (ele) => PAD.t + ph - ((ele - minE) / (maxE - minE)) * ph;

  // 主折线
  const pts = profile.map((p) => `${X(p.km).toFixed(1)},${Y(p.ele).toFixed(1)}`);
  const linePath = 'M' + pts.join(' L');
  const areaPath = linePath + ` L${X(totalKm).toFixed(1)},${(PAD.t + ph).toFixed(1)} L${X(0).toFixed(1)},${(PAD.t + ph).toFixed(1)} Z`;

  // 爬坡段（坡度 > 2.5%）
  const climbSegs = [];
  let cur = null;
  for (let i = 1; i < profile.length; i++) {
    const dEle = (profile[i].ele || 0) - (profile[i - 1].ele || 0);
    const dKm = (profile[i].km || 0) - (profile[i - 1].km || 0);
    const grade = dKm > 0 ? (dEle / (dKm * 1000)) * 100 : 0;
    if (grade > 2.5) {
      if (cur) cur.idx.push(i);
      else cur = { idx: [i - 1, i] };
    } else if (cur) { climbSegs.push(cur); cur = null; }
  }
  if (cur) climbSegs.push(cur);
  const climbLines = climbSegs
    .filter((s) => (profile[s.idx[s.idx.length - 1]].km - profile[s.idx[0]].km) > totalKm * 0.01)
    .map((s) => {
      const d = s.idx.map((k) => `${X(profile[k].km).toFixed(1)},${Y(profile[k].ele).toFixed(1)}`);
      return `<path d="M${d.join(' L')}" fill="none" stroke="#e07a2f" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" opacity=".95"/>`;
    }).join('');

  // 网格与刻度
  const gridN = 4;
  let grid = '';
  for (let g = 0; g <= gridN; g++) {
    const y = PAD.t + (ph / gridN) * g;
    const ele = maxE - ((maxE - minE) / gridN) * g;
    grid += `<line x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${W - PAD.r}" y2="${y.toFixed(1)}" stroke="#e3e6ec" stroke-width="1"/>`;
    grid += `<text x="${PAD.l - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="#7c8698" font-family="ui-monospace,Menlo,monospace">${Math.round(ele)}</text>`;
  }
  const xticks = 5;
  let xaxis = '';
  for (let g = 0; g <= xticks; g++) {
    const km = (totalKm / xticks) * g;
    const x = X(km);
    xaxis += `<line x1="${x.toFixed(1)}" y1="${PAD.t + ph}" x2="${x.toFixed(1)}" y2="${PAD.t + ph + 4}" stroke="#d3d8e2"/>`;
    xaxis += `<text x="${x.toFixed(1)}" y="${PAD.t + ph + 17}" text-anchor="middle" font-size="10.5" fill="#7c8698" font-family="ui-monospace,Menlo,monospace">${Math.round(km)}km</text>`;
  }

  // 充电/休息标记
  let marks = '';
  for (const s of chargeStops || []) {
    const x = X(s.atKm);
    marks += `<line x1="${x.toFixed(1)}" y1="${PAD.t}" x2="${x.toFixed(1)}" y2="${PAD.t + ph}" stroke="#2563eb" stroke-width="1.4" stroke-dasharray="4 3" opacity=".65"/>`;
    marks += `<circle cx="${x.toFixed(1)}" cy="${PAD.t + 7}" r="5.5" fill="#2563eb"/>`;
    marks += `<text x="${x.toFixed(1)}" y="${PAD.t + 11}" text-anchor="middle" font-size="7.5" fill="#fff" font-weight="700">⚡</text>`;
    marks += `<text x="${x.toFixed(1)}" y="${PAD.t + ph - 6}" text-anchor="middle" font-size="10" fill="#2563eb" font-family="ui-monospace,Menlo,monospace">${s.chargeMin}min</text>`;
  }
  for (const r of rests || []) {
    if ((chargeStops || []).some((s) => Math.abs(s.atKm - r.atKm) < totalKm * 0.02)) continue;
    const x = X(r.atKm);
    marks += `<line x1="${x.toFixed(1)}" y1="${PAD.t}" x2="${x.toFixed(1)}" y2="${PAD.t + ph}" stroke="#0f9d63" stroke-width="1.2" stroke-dasharray="3 3" opacity=".55"/>`;
    marks += `<circle cx="${x.toFixed(1)}" cy="${PAD.t + 7}" r="4.5" fill="#0f9d63"/>`;
  }

  // 最高/最低点标注
  const hi = profile.reduce((a, b) => ((b.ele || 0) > (a.ele || 0) ? b : a), profile[0]);
  const lo = profile.reduce((a, b) => ((b.ele || 0) < (a.ele || 0) ? b : a), profile[0]);
  const ann = `
    <circle cx="${X(hi.km).toFixed(1)}" cy="${Y(hi.ele).toFixed(1)}" r="3.4" fill="#14181f"/>
    <text x="${Math.min(X(hi.km) + 7, W - 90).toFixed(1)}" y="${(Y(hi.ele) - 5).toFixed(1)}" font-size="10.5" fill="#14181f" font-weight="600">最高 ${Math.round(hi.ele)}m</text>
    <circle cx="${X(lo.km).toFixed(1)}" cy="${Y(lo.ele).toFixed(1)}" r="3.4" fill="#7c8698"/>
    <text x="${Math.min(X(lo.km) + 7, W - 90).toFixed(1)}" y="${(Y(lo.ele) + 14).toFixed(1)}" font-size="10.5" fill="#7c8698">最低 ${Math.round(lo.ele)}m</text>`;

  return `<svg class="profile-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="沿途海拔剖面">
  <defs>
    <linearGradient id="eleFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#4f8cf7" stop-opacity=".30"/>
      <stop offset="60%" stop-color="#7ea6f0" stop-opacity=".13"/>
      <stop offset="100%" stop-color="#a8c4f5" stop-opacity=".04"/>
    </linearGradient>
  </defs>
  ${grid}${xaxis}
  <path d="${areaPath}" fill="url(#eleFill)"/>
  <path d="${linePath}" fill="none" stroke="#2563eb" stroke-width="1.8" stroke-linejoin="round"/>
  ${climbLines}
  ${marks}
  ${ann}
  <text x="${PAD.l}" y="11" font-size="10.5" fill="#7c8698">海拔 (m)</text>
</svg>`;
}

// ================================================================ 结果块

function breakdownBlock(a) {
  const items = [
    { label: '行驶基础能耗', kwh: a.seg.driveKwh, color: '#2563eb' },
    { label: '爬坡做功', kwh: a.seg.uphillKwh, color: '#e07a2f' },
    { label: '下坡动能回收', kwh: -a.seg.regenKwh, color: '#0d9488' },
    { label: '空调', kwh: a.seg.hvacKwh, color: '#8b5cf6' },
    { label: '低压附件', kwh: a.seg.auxKwh, color: '#94a3b8' },
  ].filter((x) => Math.abs(x.kwh) > 0.005);
  const max = Math.max(...items.map((x) => Math.abs(x.kwh)), 1);

  const notes = {
    行驶基础能耗: `官方 ${a.spec.ratedPer100.toFixed(1)} kWh/100km × ${a.seg.factors.kReal} 实路系数 × 车速 ${a.seg.factors.speedF.toFixed(2)} × 温度 ${a.seg.factors.tempF.toFixed(2)} × 载重 ${a.seg.factors.loadF.toFixed(2)}`,
    爬坡做功: `${Math.round(a.input.ascentM)}m 累计爬升 × 整车 ${Math.round(a.seg.totalMass)}kg（含人 ${a.extraMassKg}kg）`,
    下坡动能回收: `${Math.round(a.input.descentM)}m 累计下降 × 62% 回收效率${a.seg.regenCapped ? '，已触 50% 物理回收上限' : ''}`,
    空调: `平均 ${a.seg.hvacKw.toFixed(2)} kW × ${a.input.durationH.toFixed(1)}h（含出发前预调 0.6kWh）`,
    低压附件: `0.35 kW × ${a.input.durationH.toFixed(1)}h`,
  };

  const rows = items.map((x) => {
    const pct = (Math.abs(x.kwh) / max) * 100;
    const neg = x.kwh < 0;
    return `<div class="bd-row">
      <div class="bd-label">${x.label}</div>
      <div class="bd-track"><div class="bd-fill" style="width:${pct.toFixed(1)}%;background:${x.color}"></div></div>
      <div class="bd-value" style="color:${neg ? 'var(--regen)' : 'var(--text)'}">${neg ? '−' : ''}${Math.abs(x.kwh).toFixed(2)}</div>
      <div class="bd-note">${esc(notes[x.label] || '')}</div>
    </div>`;
  }).join('');

  return `<div class="breakdown">${rows}
    <div class="bd-row total">
      <div class="bd-label">合计</div>
      <div class="bd-track"><div class="bd-fill" style="width:100%;background:linear-gradient(90deg,#2563eb,#4f8cf7)"></div></div>
      <div class="bd-value">${a.totalKwh.toFixed(2)}</div>
      <div class="bd-note">实际百公里 ${a.per100Kwh.toFixed(1)} kWh/100km，是官方 CLTC 口径 ${a.spec.ratedPer100.toFixed(1)} 的 ${(a.seg.realFactor).toFixed(2)} 倍</div>
    </div>
  </div>`;
}

function weatherBlock(w, analysis) {
  if (!w || !w.samples || !w.samples.length) return '';
  const cells = w.samples.map((s) => {
    const sev = s.precipMm >= 5 ? ' severe' : '';
    return `<div class="wx${sev}">
      <div class="wx-km">${Math.round(s.km)} km</div>
      <div class="wx-temp">${s.tempC != null ? Math.round(s.tempC) + '°' : '—'}</div>
      <div class="wx-text">${esc(s.text)}</div>
      <div class="wx-ele">${Math.round(s.ele || 0)}m${s.precipMm > 0.1 ? ' · 雨' + s.precipMm.toFixed(1) + 'mm' : ''}</div>
    </div>`;
  }).join('');
  return `<div class="weather-strip">${cells}</div>
    <p class="card-hint" style="margin:10px 0 0">已按各点真实海拔用 6℃/1000m 的递减率校正气温。沿途均温 ${n1(w.avgTempC)}℃，峰值降水 ${n1(w.maxPrecip)}mm/h。</p>`;
}

function timelineBlock(a, departISO) {
  const t0 = new Date(departISO).getTime();
  const at = (h) => {
    const d = new Date(t0 + h * 3600 * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const items = [];
  items.push(`<div class="tl-item">
    <div class="tl-dot"></div>
    <div class="tl-head"><span class="tl-title">出发</span><span class="tl-time">${at(0)}</span>
      <span class="tl-pill">SOC ${a.input.socStart}%</span></div>
    <div class="tl-desc">满电可用能量 ${(a.spec.battery * a.input.socStart / 100).toFixed(1)} kWh，预计到达时剩 ${n1(a.arrivalSoc)}%（${(a.spec.battery * Math.max(a.arrivalSoc, 0) / 100).toFixed(1)} kWh）</div>
  </div>`);

  const events = [
    ...a.charging.stops.map((s) => ({ h: (s.atKm / Math.max(a.input.distanceKm, 1)) * a.input.durationH, type: 'charge', data: s })),
    ...a.rests.filter((r) => !r.charge).map((r) => ({ h: r.atHour, type: 'rest', data: r })),
  ].sort((x, y) => x.h - y.h);

  for (const e of events) {
    if (e.type === 'charge') {
      const s = e.data;
      items.push(`<div class="tl-item charge">
        <div class="tl-dot"></div>
        <div class="tl-head"><span class="tl-title">补能 · ${s.station ? esc(s.station.name) : '沿线充电站'}</span>
          <span class="tl-time">约 ${at(e.h)} · 第 ${s.atKm}km</span>
          <span class="tl-pill">停留 ${s.chargeMin} 分钟</span>
          ${a.charging.swapCapable ? '<span class="tl-pill swap-pill">换电约 3 分钟</span>' : ''}</div>
        <div class="tl-desc">SOC ${s.atSoc}% → ${s.targetSoc}%，补入 ${s.addKwh} kWh（平均功率约 ${s.avgKw} kW）${s.station && s.station.detourKm > 0.3 ? `，需绕行 ${s.station.detourKm}km` : ''}
          ${a.charging.swapCapable ? '<br><span class="swap-hint">这台车支持换电：若这一站附近有换电站，整次停留可压缩到约 3 分钟（全程自动、人不用下车）。</span>' : ''}</div>
      </div>`);
    } else {
      const r = e.data;
      items.push(`<div class="tl-item rest">
        <div class="tl-dot"></div>
        <div class="tl-head"><span class="tl-title">安全休息</span>
          <span class="tl-time">约 ${at(e.h)} · 第 ${r.atKm}km</span>
          <span class="tl-pill rest">停留 ${r.minutes} 分钟</span></div>
        <div class="tl-desc">${esc(r.reason)}</div>
      </div>`);
    }
  }

  items.push(`<div class="tl-item end">
    <div class="tl-dot"></div>
    <div class="tl-head"><span class="tl-title">到达 ${esc('目的地')}</span>
      <span class="tl-time">约 ${at(a.input.durationH)}</span>
      <span class="tl-pill">SOC ${n1(a.arrivalSoc)}%</span></div>
    <div class="tl-desc">行驶 ${n1(a.input.distanceKm)} km 用时 ${fmtDuration(a.input.durationH)}${a.charging.stops.length ? `，含补能共 ${fmtDuration(a.input.durationH + a.charging.stops.reduce((s, x) => s + x.chargeMin, 0) / 60)}` : ''}</div>
  </div>`);

  return `<div class="timeline">${items.join('')}</div>`;
}

function compareBlock(rows, currentName) {
  if (!rows || !rows.length) return '';
  const body = rows.map((r) => {
    if (r.error) {
      return `<tr class="is-miss"><td>${esc(r.query)}</td><td colspan="6">${esc(r.error)}</td></tr>`;
    }
    const a = r.analysis;
    const cur = r.spec.name === currentName;
    const okTxt = a.direct ? '可直达' : `${a.charging.stops.length} 次`;
    return `<tr class="${cur ? 'is-current' : ''}">
      <td>${esc(r.spec.name)}</td>
      <td class="num">${r.spec.battery} / ${r.spec.range}</td>
      <td class="num">${a.per100Kwh.toFixed(1)}</td>
      <td class="num hl">${n0(a.effectiveRangeKm)}</td>
      <td class="num">${n1(a.arrivalSoc)}%</td>
      <td class="num">${okTxt}</td>
      <td class="num">${r.chargeMin ? r.chargeMin + ' 分钟' : '—'}</td>
    </tr>`;
  }).join('');

  return `<div class="table-wrap"><table class="cmp">
    <thead><tr>
      <th>车型</th>
      <th style="text-align:right">电池 kWh／官方 km</th>
      <th style="text-align:right">实际 kWh/100km</th>
      <th style="text-align:right">满电可跑</th>
      <th style="text-align:right">到达电量</th>
      <th style="text-align:right">中途补能</th>
      <th style="text-align:right">补能时长</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  <p class="card-hint" style="margin:8px 0 0">
    所有车型共用同一条路线、同一份天气与同一个物理模型，差异只来自车本身（电池、整备质量、风阻标定）。
    对比过程不额外联网——路线数据复用主分析的结果。
  </p>`;
}

function printHead(res, a, departISO) {
  const t = new Date(departISO);
  const p2 = (v) => String(v).padStart(2, '0');
  const when = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
  const now = new Date();
  const gen = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
  return `<div class="print-head">
    <h1>${esc(res.origin.name)} → ${esc(res.destination.name)}　续航与补能方案</h1>
    <p>车型 ${esc(a.spec.name)}（电池 ${a.spec.battery} kWh／官方 ${a.spec.range} km）　
      载员 ${a.input.passengers} 人 + 行李 ${a.input.luggageKg} kg　
      出发 ${when} 电量 ${a.input.socStart}%　
      路线来源 ${esc(res.route.source)}<br>
      由 EV Range（leruo212.github.io/ev-range-agent）生成于 ${gen}。
      能耗为物理模型推算值，误差通常 ±15%，非车企标称数据，仅供行程参考。</p>
  </div>`;
}

function toolBar() {
  return `<div class="result-tools">
    <button id="btn-share" class="btn btn-ghost" type="button">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M12 3v13M8 7l4-4 4 4"/></svg>
      复制分享链接
    </button>
    <button id="btn-print" class="btn btn-ghost" type="button">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M6 9V3h12v6M6 18H4v-6h16v6h-2M8 14h8v7H8z"/></svg>
      打印 / 存 PDF
    </button>
    <span class="spacer"></span>
    <span class="tool-note" id="share-note">链接包含全部参数，别人打开就能看到同一份结果</span>
  </div>`;
}

function warnBlock(warnings) {
  if (!warnings.length) return '';
  const icon = { danger: '!', warn: '!', info: 'i' };
  return `<div class="warns">${warnings.map((w) => `
    <div class="warn-item ${w.level}">
      <span class="wi-icon">${icon[w.level] || 'i'}</span>
      <span>${esc(w.text)}</span>
    </div>`).join('')}</div>`;
}

function scenarioTable(a) {
  const rows = a.scenarios.map((s) => `<tr>
    <td>${esc(s.label)}</td>
    <td class="num">${s.tempC}℃</td>
    <td class="num">${s.speed} km/h</td>
    <td class="num">${s.passengers} 人</td>
    <td class="num">${s.per100.toFixed(1)}</td>
    <td class="num hl">${s.rangeKm}</td>
  </tr>`).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>工况</th><th style="text-align:right">气温</th><th style="text-align:right">平均车速</th>
      <th style="text-align:right">载员</th><th style="text-align:right">百公里电耗</th><th style="text-align:right">满电可跑</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p class="card-hint" style="margin:8px 0 0">按本条路线的平均坡度折算，仅为参考区间，不是承诺。</p>`;
}

// ================================================================ 主入口

export function renderResults(res, container, ctx = {}) {
  const a = res.analysis;
  const { departISO } = ctx;

  const okDirect = a.direct && a.arrivalSoc >= 20;
  const verdictCls = !a.direct ? 'danger' : (a.arrivalSoc >= 20 ? 'ok' : 'warn');
  const verdictIcon = verdictCls === 'ok' ? '✓' : '!';
  const verdictTitle = a.direct
    ? (a.arrivalSoc >= 20
      ? `可以一口气开到，到达还剩 ${n1(a.arrivalSoc)}%`
      : `能直接开到，但到达只剩 ${n1(a.arrivalSoc)}%，余量偏紧`)
    : `开到目的地需要中途补能 ${a.charging.stops.length} 次`;

  const verdictDesc = a.direct
    ? `全程 ${n1(a.input.distanceKm)} km，预计耗电 ${a.totalKwh.toFixed(1)} kWh。电量够用，` +
      `${a.rests.length ? `中途建议在第 ${a.rests[0].atKm}km 处停留 ${a.rests[0].minutes} 分钟（连续驾驶不超过 2 小时）` : '中途无需专门停留'}。`
    : `全程 ${n1(a.input.distanceKm)} km，需要 ${a.totalKwh.toFixed(1)} kWh，而满电可用只有 ${a.spec.battery} kWh。建议中途补能 ${a.charging.stops.length} 次，合计约 ${a.charging.stops.reduce((s, x) => s + x.chargeMin, 0)} 分钟。`;

  const html = `
  <section class="card">
    ${printHead(res, a, departISO)}

    <div class="verdict ${verdictCls}">
      <div class="verdict-icon">${verdictIcon}</div>
      <div>
        <h3>${verdictTitle}</h3>
        <p>${verdictDesc}</p>
      </div>
    </div>

    ${toolBar()}

    <div class="kpis">
      <div class="kpi">
        <div class="kpi-label">总里程 / 行车时长</div>
        <div class="kpi-value">${n1(a.input.distanceKm)}<small>km</small></div>
        <div class="kpi-sub">${fmtDuration(a.input.durationH)} · 均速 ${Math.round(a.seg.avgSpeed)} km/h</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">预计总耗电</div>
        <div class="kpi-value">${a.totalKwh.toFixed(1)}<small>kWh</small></div>
        <div class="kpi-sub">实际 ${a.per100Kwh.toFixed(1)} kWh/100km</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">到达剩余电量</div>
        <div class="kpi-value ${a.arrivalSoc < 15 ? 'neg' : (a.arrivalSoc > 40 ? 'pos' : '')}">${n1(a.arrivalSoc)}<small>%</small></div>
        <div class="kpi-sub">${a.charging.needed
          ? `含中途 ${a.charging.stops.length} 次补能`
          : `建议出发电量 ${a.recommendedSocStart}%`}${a.charging.needed ? ` · 不补能则 ${n1(a.arrivalSocNoCharge)}%` : ''}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">满电实际续航</div>
        <div class="kpi-value">${n0(a.effectiveRangeKm)}<small>km</small></div>
        <div class="kpi-sub">官方 CLTC ${a.spec.range} km，相当于打 <b>${(a.discount * 10).toFixed(1)}</b> 折</div>
      </div>
    </div>

    <div class="block">
      <h3>能耗拆解 <span class="tail">单位 kWh · 每一度电花在哪</span></h3>
      ${breakdownBlock(a)}
    </div>

    <div class="block">
      <h3>沿途海拔剖面 <span class="tail">橙线 = 爬坡段（吃电最多的地方）</span></h3>
      <div class="profile-wrap">
        ${elevationSVG(res.route.profile, { chargeStops: a.charging.stops, rests: a.rests })}
        <div class="profile-legend">
          <span><i style="background:#2563eb"></i>海拔曲线</span>
          <span><i style="background:#e07a2f"></i>爬坡段（坡度 &gt;2.5%）</span>
          <span><i style="background:#2563eb;border-radius:50%"></i>充电点</span>
          <span><i style="background:#0f9d63;border-radius:50%"></i>休息点</span>
          <span>累计爬升 <b>${n0(a.input.ascentM)}</b> m · 累计下降 <b>${n0(a.input.descentM)}</b> m</span>
        </div>
      </div>
    </div>

    <div class="block">
      <h3>沿途天气 <span class="tail">${esc(res.weather.summary)}</span></h3>
      ${weatherBlock(res.weather, a)}
    </div>

    <div class="block">
      <h3>补能与休息时间线 <span class="tail">出发时刻 ${new Date(departISO).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></h3>
      <p class="block-note">${esc(a.charging.strategy)}${
        a.spec.platform ? `　·　整车平台 ${esc(a.spec.platform)}` : ''
      }${a.charging.swapCapable ? '　·　支持换电' : ''}</p>
      ${timelineBlock(a, departISO)}
    </div>

    <div class="block">
      <h3>续航区间推算 <span class="tail">同一辆车，条件不同能差一倍</span></h3>
      ${scenarioTable(a)}
    </div>

    ${ctx.comparison && ctx.comparison.length ? `<div class="block">
      <h3>换台车能跑下来吗 <span class="tail">同一条路线直接对比</span></h3>
      ${compareBlock(ctx.comparison, a.spec.name)}
    </div>` : ''}

    ${a.warnings.length ? `<div class="block">
      <h3>风险与提示 <span class="tail">共 ${a.warnings.length} 条</span></h3>
      ${warnBlock(a.warnings)}
    </div>` : ''}

    <div class="block">
      <h3>数据来源与地点核对</h3>
      <div class="table-wrap" style="margin-bottom:10px">
        <table>
          <thead><tr><th>角色</th><th>输入</th><th>解析到的位置</th><th>坐标</th><th>匹配度</th></tr></thead>
          <tbody>
            ${geoRow('出发地', res.origin)}
            ${(res.waypoints || []).map((w, i) => geoRow('途经点 ' + (i + 1), w)).join('')}
            ${geoRow('目的地', res.destination)}
          </tbody>
        </table>
      </div>
      <p class="card-hint" style="font-size:12px;line-height:1.8;margin:0">
        路线：${esc(res.route.source)}（${n1(res.route.distanceKm)} km）　
        海拔：Copernicus DEM 90m 网格采样 ${res.route.profile.length} 点　
        天气：Open-Meteo 逐时预报，按海拔用 6℃/1000m 校正　
        充电桩：${esc(res.chargers.source)}，沿线 ${res.chargers.list.length} 个（约 ${res.chargers.per100km} 个/100km）
        ${res.chargers.note ? `<br><b>注意：</b>${esc(res.chargers.note)}` : ''}
        ${(res.origin.confidence != null && res.origin.confidence < 0.6) || (res.destination.confidence != null && res.destination.confidence < 0.6)
          ? '<br><b>提示：</b>有地点是按宽松匹配定位的（匹配度偏低）。如果上面解析到的位置不对，把地名写得更具体一些重跑，或在设置里填高德 Key。'
          : ''}
      </p>
    </div>
  </section>`;

  container.innerHTML = html;
  container.hidden = false;
}

function geoRow(role, g) {
  if (!g) return '';
  const conf = g.confidence != null ? g.confidence : null;
  const cls = conf == null ? '' : (conf >= 0.8 ? 'hl' : (conf < 0.6 ? 'warn' : ''));
  const confText = conf == null ? '—' : (conf * 100).toFixed(0) + '%';
  return `<tr>
    <td>${esc(role)}</td>
    <td>${esc(g.query || g.name || '')}</td>
    <td>${esc(g.full || g.name || '')}</td>
    <td class="num">${Number(g.lat).toFixed(3)}, ${Number(g.lon).toFixed(3)}</td>
    <td class="num ${cls}" style="${conf != null && conf < 0.6 ? 'color:var(--warn)' : ''}">${confText}</td>
  </tr>`;
}

export function renderLoading(container, label, pct, steps) {
  container.hidden = false;
  container.innerHTML = `<section class="card">
    <div class="loading">
      <div class="spinner"></div>
      <div id="load-label">${esc(label)}</div>
      <div class="prog"><div class="prog-bar" id="load-bar" style="width:${pct}%"></div></div>
      <div class="steps-list">${(steps || []).map((s) => '· ' + esc(s)).join('<br>')}</div>
    </div>
  </section>`;
}

export function renderError(container, message) {
  container.hidden = false;
  container.innerHTML = `<section class="card">
    <div class="warn-item danger" style="font-size:13px">
      <span class="wi-icon">!</span>
      <span><b>分析失败</b><br>${esc(message)}</span>
    </div>
    <p class="card-hint" style="margin:12px 0 0">
      常见原因：地点名太模糊（换成「城市 + 区县」再试）、网络无法访问开放数据源、
      或者该地区路网数据缺失。也可以填一个高德 Key 提升国内数据的成功率。
    </p>
  </section>`;
}
