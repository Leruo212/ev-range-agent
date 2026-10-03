/**
 * 数据获取层
 * =============================================================
 * 默认全部走「不需要 API Key」的开放数据：
 *   地理编码  Photon (komoot)           —— OSM 数据，中文支持尚可
 *   路线规划  OSRM 公共实例             —— OpenStreetMap 路网
 *   地形海拔  Open-Meteo Elevation API  —— Copernicus DEM 90m
 *   天气      Open-Meteo Forecast API
 *   充电桩    Overpass API (OSM amenity=charging_station)
 *
 * 如果用户填了高德 Key，路线 / 地理编码 / 充电桩会自动切到高德
 * —— 国内路网与 POI 数据明显更准，尤其是城市道路与新建路段。
 */

import { computeAscentDescent, tempAtElevation } from './model.js';

// ---------------------------------------------------------------- 工具

const memCache = new Map();

async function cached(key, fn, ttlMs = 10 * 60 * 1000) {
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  memCache.set(key, { t: Date.now(), v });
  return v;
}

export async function fetchJSON(url, { timeout = 20000, init } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function haversine(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 折线总长度（km） */
export function polylineLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
  return d;
}

/** 沿折线按等距取 n 个采样点，返回 [{lat, lon, km}] */
export function sampleAlong(coords, n) {
  if (!coords.length) return [];
  const total = polylineLength(coords);
  if (total === 0 || n < 2) return [{ ...coords[0], km: 0 }];
  const step = total / (n - 1);
  const out = [{ ...coords[0], km: 0 }];
  let acc = 0, target = step, i = 1;
  while (i < coords.length && out.length < n) {
    const segLen = haversine(coords[i - 1], coords[i]);
    acc += segLen;
    if (acc >= target - 1e-9) {
      out.push({ ...coords[i], km: Number(acc.toFixed(2)) });
      target += step;
    }
    i++;
  }
  if (out.length < n) out.push({ ...coords[coords.length - 1], km: Number(total.toFixed(2)) });
  return out;
}

/** 把任意点投影到路线上，返回它对应的大致里程 */
export function projectToRoute(coords, point) {
  let bestKm = 0, bestD = Infinity, acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1], coords[i]);
    const mid = { lat: (coords[i - 1].lat + coords[i].lat) / 2, lon: (coords[i - 1].lon + coords[i].lon) / 2 };
    const dist = haversine(mid, point);
    if (dist < bestD) { bestD = dist; bestKm = acc + d / 2; }
    acc += d;
  }
  return { km: bestKm, offsetKm: bestD };
}

// ---------------------------------------------------------------- 地理编码

function fmtPhoton(f) {
  const p = f.properties || {};
  const parts = [p.name, p.street, p.district, p.county, p.city, p.state, p.country]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
  return {
    name: parts.slice(0, 2).join(' · '),
    full: parts.join(' · '),
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    city: p.city || p.county || '',
    district: p.district || '',
    state: p.state || '',
    raw: p,
    source: 'OSM/Photon',
  };
}

const ADMIN_SUFFIX = /[省市区县镇乡村旗盟]/;

/**
 * 把「重庆市武隆区仙女山」切成 ["重庆","武隆","仙女山"]
 * Photon 对长中文串的相关性排序很差（会拿「重庆市」前缀去匹配渝北的 POI），
 * 所以必须自己拆词、多次尝试、再按词命中率挑结果。
 */
function splitTokens(q) {
  const toks = String(q)
    .split(/[省市区县镇乡村旗盟自治特别行政]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  // 长地名再补一个前缀子词（通常是城市名），提高词覆盖率判定的容错
  const extra = [];
  for (const t of toks) {
    if (t.length >= 5) extra.push(t.slice(0, 2));
    if (t.length >= 7) extra.push(t.slice(0, 3));
  }
  return [...new Set([...toks, ...extra])];
}

/**
 * 候选打分。
 * 关键信号是「这个候选是否真的匹配了本次尝试用的查询串」——
 * 而不是简单的词命中，否则「宜昌三峡大坝」会被匹配到「宜昌三峡机场」。
 */
function scoreCandidate(cand, attemptStr, attemptIdx, anchor, tokens) {
  const nameHay = [cand.name, cand.full].join(' ').toLowerCase();
  const adminHay = [cand.city, cand.district, cand.state].join(' ').toLowerCase();
  const at = String(attemptStr).toLowerCase();
  const nm = String(cand.name || '').toLowerCase();

  let exactish = 0;
  if (nm === at || nm === at.replace(/[省市区县]+$/, '')) exactish = 1;
  else if (nameHay.includes(at)) exactish = 0.92;
  else if (adminHay.includes(at)) exactish = 0.75;

  let cov = 0;
  if (tokens.length) {
    let s = 0;
    for (const t of tokens) {
      const tl = t.toLowerCase();
      if (adminHay.includes(tl)) s += 1;
      else if (nameHay.includes(tl)) s += 0.6;
    }
    cov = s / tokens.length;
  }

  let score = exactish * 0.68 + cov * 0.32 - attemptIdx * 0.1;

  // 锚点距离：同名异地是 Photon 最典型的错法（「杭州西湖」会命中台湾同名地物）
  if (anchor) {
    const d = haversine(anchor, cand);
    if (d > 300) score -= 0.5;
    else if (d > 150) score -= 0.2;
    else if (d < 40) score += 0.1;
  }
  return score;
}

/** 找出查询里的地理锚点（通常是城市名），用于给 Photon 做位置偏置 */
async function findAnchor(q, tokens) {
  const cands = [];
  if (tokens.length >= 2) cands.push(tokens[0], tokens[1]);
  // 「乌鲁木齐地窝堡机场」这种没有行政后缀的长串，得靠前缀试出来
  for (let len = 2; len <= 5; len++) {
    if (q.length > len) cands.push(q.slice(0, len));
  }
  for (const c of [...new Set(cands)]) {
    if (!c || c.length < 2 || c.length > 10) continue;
    try {
      const d = await fetchJSON(`https://photon.komoot.io/api/?q=${encodeURIComponent(c)}&limit=1`, { timeout: 9000 });
      const f = (d.features || [])[0];
      if (!f) continue;
      const p = f.properties || {};
      const hay = [p.name, p.city, p.state, p.district, p.county, p.street].filter(Boolean).join(' ');
      if (!hay.includes(c)) continue;
      const lat = f.geometry.coordinates[1];
      const lon = f.geometry.coordinates[0];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      return { lat, lon, name: p.name || c, token: c };
    } catch (e) { /* 试下一个候选 */ }
  }
  return null;
}

/** 生成多级尝试策略，从最精确到最宽松 */
function buildAttempts(q, anchor) {
  const tokens = splitTokens(q);
  const list = [q];
  const squeezed = q.replace(/[省市区县镇乡村旗盟]+/g, '');
  if (squeezed && squeezed !== q) list.push(squeezed);

  if (anchor && q.startsWith(anchor.token)) {
    const rest = q.slice(anchor.token.length).replace(/^[省市区县镇乡村旗盟]+/, '');
    if (rest && rest.length >= 2) list.push(rest);
  }

  if (tokens.length >= 2) {
    const tail = tokens[tokens.length - 1];
    if (!list.includes(tail)) list.push(tail);
    const headTail = tokens[0] + tail;
    if (!list.includes(headTail)) list.push(headTail);
  }

  // 长整串地名：掐掉不同长度的前缀逐级试
  // 「拉萨布达拉宫」→「布达拉宫」；「乌鲁木齐地窝堡机场」→「地窝堡机场」
  const base = tokens[0] || q;
  for (const len of [2, 3, 4, 5]) {
    if (base.length >= len + 2) list.push(base.slice(len));
  }

  // 只留最后的行政单位：「重庆市武隆区」→「武隆区」
  const m = q.match(/[^\s省市区县]{2,6}[区县市旗]/g);
  if (m && m.length) list.push(m[m.length - 1]);

  return [...new Set(list.map((s) => String(s).trim()).filter((s) => s.length >= 2))].slice(0, 7);
}

const geocodeCache = new Map();

/**
 * 地理编码。
 * 高德 Key 存在时优先走高德；否则用 Photon + 自建的城市锚点偏置与多轮候选打分。
 * Photon 的相关性排序对长中文串很不友好，这一层是必需的而不是锦上添花。
 */
export async function geocode(place, amapKey) {
  const q = String(place || '').trim();
  if (!q) throw new Error('地点为空');

  if (amapKey) {
    try {
      const url = `https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(amapKey)}&address=${encodeURIComponent(q)}&output=JSON`;
      const data = await fetchJSON(url, { timeout: 12000 });
      if (data.status === '1' && data.geocodes && data.geocodes.length) {
        const g = data.geocodes[0];
        const [lon, lat] = g.location.split(',').map(Number);
        return {
          name: q,
          full: g.formatted_address || q,
          lat, lon,
          city: g.city || '',
          district: g.district || '',
          source: '高德',
          confidence: 0.95,
        };
      }
    } catch (e) {
      // 静默回退到免费栈
    }
  }

  const ck = `geo:${q}`;
  if (geocodeCache.has(ck)) return geocodeCache.get(ck);

  const tokens = splitTokens(q);
  const anchor = await findAnchor(q, tokens);
  const attempts = buildAttempts(q, anchor);

  const bias = anchor ? `&lat=${anchor.lat.toFixed(4)}&lon=${anchor.lon.toFixed(4)}` : '';
  const pool = [];
  const seen = new Set();
  let firstErr = null;

  for (let i = 0; i < attempts.length; i++) {
    let feats = [];
    try {
      const data = await fetchJSON(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(attempts[i])}&limit=8${bias}`,
        { timeout: 12000 }
      );
      feats = (data.features || []).map(fmtPhoton);
    } catch (e) {
      if (!firstErr) firstErr = e;
    }
    for (const f of feats) {
      const key = `${f.lat.toFixed(4)},${f.lon.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push({ ...f, _score: scoreCandidate(f, attempts[i], i, anchor, tokens), _attempt: i });
    }
    // 最精确的那一轮就已经拿到高置信结果，不必再退而求其次
    if (pool.some((p) => p._score >= 0.9)) break;
  }

  if (!pool.length) {
    if (firstErr && /fetch|network|abort/i.test(String(firstErr.message))) {
      throw new Error(`地理编码服务不可达（${firstErr.message}）。请检查网络，或在设置里填一个高德 Key。`);
    }
    throw new Error(
      `找不到地点「${q}」。试试更通行的写法（如「重庆北站」「武隆区」），` +
      `或者在设置里填一个高德 Key——国内 POI 准确度会高很多。`
    );
  }

  pool.sort((a, b) => b._score - a._score);
  const best = pool[0];
  const out = { ...best };
  delete out.raw;
  out.query = q;
  out.matched = attempts[best._attempt];
  out.anchor = anchor ? anchor.name : null;
  out.confidence = Number(Math.max(0, Math.min(1, best._score)).toFixed(2));
  geocodeCache.set(ck, out);
  return out;
}

/** 联想搜索（界面输入框用）。注意 Photon 只支持 default/de/en/fr，传 lang=zh 会 400。 */
export async function suggestPlaces(query, limit = 6) {
  if (!query || query.trim().length < 2) return [];
  const q = query.trim();
  return cached(`photon:${q}:${limit}`, async () => {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit}`;
    let data;
    try {
      data = await fetchJSON(url, { timeout: 10000 });
    } catch (e) {
      const short = q.replace(/[省市区县]/g, '');
      if (!short || short === q) return [];
      data = await fetchJSON(`https://photon.komoot.io/api/?q=${encodeURIComponent(short)}&limit=${limit}`, { timeout: 10000 });
    }
    return (data.features || []).map(fmtPhoton);
  }, 5 * 60 * 1000);
}

// ---------------------------------------------------------------- 路线

/** OSRM 路线（免费，无需 Key） */
async function routeOSRM(points) {
  const coordStr = points.map((p) => `${p.lon},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson&alternatives=false&steps=false`;
  const data = await fetchJSON(url, { timeout: 25000 });
  if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
    throw new Error(`路线规划失败：${data.code || '未知错误'}`);
  }
  const r = data.routes[0];
  const coords = r.geometry.coordinates.map((c) => ({ lon: c[0], lat: c[1] }));
  return {
    distanceKm: r.distance / 1000,
    durationH: r.duration / 3600,
    coords,
    source: 'OSRM / OpenStreetMap',
    toll: null,
  };
}

/** 高德驾车路线（需用户自备 Key） */
async function routeAmap(points, key) {
  const origin = `${points[0].lon},${points[0].lat}`;
  const destination = `${points[points.length - 1].lon},${points[points.length - 1].lat}`;
  let waypoints = '';
  if (points.length > 2) {
    waypoints = '&waypoints=' + points.slice(1, -1).map((p) => `${p.lon},${p.lat}`).join(';');
  }
  const url = `https://restapi.amap.com/v5/direction/driving?key=${encodeURIComponent(key)}&origin=${origin}&destination=${destination}${waypoints}&strategy=32&show_fields=cost,polyline&output=JSON`;
  const data = await fetchJSON(url, { timeout: 20000 });
  if (data.status !== '1') {
    throw new Error(`高德路线失败：${data.info || data.infocode}`);
  }
  const path = data.route.paths[0];
  const coords = [];
  for (const step of path.steps || []) {
    const pl = step.polyline || '';
    for (const pair of pl.split(';')) {
      const [lon, lat] = pair.split(',').map(Number);
      if (Number.isFinite(lon) && Number.isFinite(lat)) coords.push({ lon, lat });
    }
  }
  if (!coords.length) throw new Error('高德未返回路径几何，无法生成海拔剖面');
  return {
    distanceKm: Number(path.distance) / 1000,
    durationH: Number(path.cost?.duration || path.duration || 0) / 3600,
    coords,
    source: '高德地图',
    toll: path.cost?.tolls != null ? Number(path.cost.tolls) : null,
    trafficLights: path.cost?.traffic_lights,
  };
}

/**
 * 路线规划总入口
 * @param {Array<{lat,lon,name}>} points 至少两个
 * @param {object} opts { amapKey }
 */
export async function planRoute(points, opts = {}) {
  if (!points || points.length < 2) throw new Error('至少需要起点和终点');
  const { amapKey } = opts;

  if (amapKey) {
    try {
      return await routeAmap(points, amapKey);
    } catch (e) {
      console.warn('[route] 高德不可用，回退 OSRM：', e.message);
      const r = await routeOSRM(points);
      r.note = `高德路线不可用（${e.message}），已回退到 OpenStreetMap 路网。`;
      return r;
    }
  }
  return routeOSRM(points);
}

// ---------------------------------------------------------------- 海拔

/**
 * 沿路线取海拔剖面。
 * Open-Meteo 的 elevation 端点单次最多 100 个坐标，按 90m 分辨率 DEM 取值。
 */
export async function elevationProfile(coords, samples = 60) {
  const pts = sampleAlong(coords, samples);
  const chunks = [];
  for (let i = 0; i < pts.length; i += 90) chunks.push(pts.slice(i, i + 90));

  const out = [];
  for (const chunk of chunks) {
    const lat = chunk.map((p) => p.lat.toFixed(5)).join(',');
    const lon = chunk.map((p) => p.lon.toFixed(5)).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`;
    const data = await fetchJSON(url, { timeout: 20000 });
    const eles = data.elevation || [];
    chunk.forEach((p, i) => out.push({ ...p, ele: Number(eles[i]) || 0 }));
  }
  return out;
}

/** 路线 + 海拔剖面 + 爬升下降，一体化 */
export async function routeWithElevation(points, opts = {}) {
  const route = await planRoute(points, opts);
  const profile = await elevationProfile(route.coords, opts.samples || 60);
  const ad = computeAscentDescent(profile, 5);
  // 用地理距离口径统一里程刻度
  const geoLen = polylineLength(route.coords);
  const scale = geoLen > 0 ? route.distanceKm / geoLen : 1;
  for (const p of profile) p.km = Number((p.km * scale).toFixed(2));

  return {
    ...route,
    profile,
    ascentM: ad.ascent,
    descentM: ad.descent,
    minEle: ad.minEle,
    maxEle: ad.maxEle,
  };
}

// ---------------------------------------------------------------- 天气

const WMO_TEXT = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
};

export const weatherText = (code) => WMO_TEXT[code] || '未知';
export const isSevere = (code) => (code >= 61 && code <= 67) || (code >= 71 && code <= 77) || (code >= 80 && code <= 86) || code >= 95;

/**
 * 沿线天气。在路线上取若干采样点，按预计到达时刻取逐时预报，
 * 再用海拔递减率把格点气温校正到该点的真实海拔。
 */
export async function weatherAlongRoute(route, departISO, points = 5) {
  const samples = sampleAlong(route.coords, points);
  const t0 = new Date(departISO).getTime();
  const totalH = route.durationH;

  const results = [];
  for (let i = 0; i < samples.length; i++) {
    const sp = samples[i];
    const frac = samples.length > 1 ? i / (samples.length - 1) : 0;
    const arrive = new Date(t0 + frac * totalH * 3600 * 1000);
    const dateStr = arrive.toISOString().slice(0, 10);

    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', sp.lat.toFixed(4));
    url.searchParams.set('longitude', sp.lon.toFixed(4));
    url.searchParams.set('hourly', 'temperature_2m,apparent_temperature,precipitation,wind_speed_10m,weather_code');
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('start_date', dateStr);
    url.searchParams.set('end_date', dateStr);

    let pick = null, gridEle = null;
    try {
      const data = await fetchJSON(url.toString(), { timeout: 15000 });
      gridEle = data.elevation ?? null;
      const times = data.hourly?.time || [];
      const idxHour = arrive.getHours();
      let idx = times.findIndex((t) => new Date(t).getHours() === idxHour);
      if (idx < 0) idx = Math.min(times.length - 1, Math.max(0, idxHour));
      pick = {
        tempC: data.hourly.temperature_2m?.[idx],
        feelC: data.hourly.apparent_temperature?.[idx],
        precipMm: data.hourly.precipitation?.[idx] ?? 0,
        windKmh: data.hourly.wind_speed_10m?.[idx] ?? 0,
        code: data.hourly.weather_code?.[idx] ?? 0,
      };
    } catch (e) {
      pick = null;
    }

    results.push({
      idx: i,
      km: sp.km,
      lat: sp.lat,
      lon: sp.lon,
      frac,
      time: arrive.toISOString(),
      gridEle,
      ok: !!pick,
      tempC: pick?.tempC ?? null,
      rawTempC: pick?.tempC ?? null,
      feelC: pick ? (gridEle != null ? pick.feelC : pick.feelC) : null,
      precipMm: pick?.precipMm ?? 0,
      windKmh: pick?.windKmh ?? 0,
      code: pick?.code ?? 0,
      text: weatherText(pick?.code ?? 0),
    });
  }

  // 用真实海拔校正气温
  for (const r of results) {
    const prof = nearestProfile(route.profile, r.km);
    r.ele = prof ? prof.ele : (r.gridEle ?? 0);
    if (r.tempC != null && r.gridEle != null) {
      r.tempC = Number(tempAtElevation(r.tempC, r.gridEle, r.ele).toFixed(1));
    }
  }

  const usable = results.filter((r) => r.tempC != null);
  const avgTempC = usable.length
    ? usable.reduce((s, r) => s + r.tempC, 0) / usable.length
    : 20;
  const maxPrecip = Math.max(0, ...results.map((r) => r.precipMm || 0));
  const avgWind = usable.length ? usable.reduce((s, r) => s + (r.windKmh || 0), 0) / usable.length : 0;
  const severe = results.some((r) => isSevere(r.code));

  return {
    samples: results,
    avgTempC: Number(avgTempC.toFixed(1)),
    maxPrecip: Number(maxPrecip.toFixed(1)),
    avgWindKmh: Number(avgWind.toFixed(1)),
    severe,
    ok: usable.length > 0,
    summary: usable.length
      ? `${results[0].text} → ${results[Math.floor(results.length / 2)].text} → ${results[results.length - 1].text}，沿途均温 ${avgTempC.toFixed(1)}℃`
      : '天气数据获取失败，已按 20℃ 常温估算',
  };
}

function nearestProfile(profile, km) {
  if (!profile || !profile.length) return null;
  let best = profile[0], bd = Infinity;
  for (const p of profile) {
    const d = Math.abs((p.km || 0) - km);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// ---------------------------------------------------------------- 充电桩

/** Overpass(OSM) 查询充电站，多镜像依次尝试（总预算约 25 秒，超时就把机会让给降级提示） */
async function chargersOverpass(bbox) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const q = `[out:json][timeout:20];(node["amenity"="charging_station"](${b});way["amenity"="charging_station"](${b}););out center 120;`;
  const mirrors = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  let lastErr = null;
  for (const m of mirrors) {
    try {
      const url = `${m}?data=${encodeURIComponent(q)}`;
      const data = await fetchJSON(url, { timeout: 12000 });
      return (data.elements || []).map((e) => {
        const lat = e.lat ?? e.center?.lat;
        const lon = e.lon ?? e.center?.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          name: e.tags?.name || 'OSM 充电站',
          operator: e.tags?.operator || null,
          lat, lon,
          power: e.tags?.['charging_station:output'] || e.tags?.socket || null,
          source: 'OSM',
        };
      }).filter(Boolean);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('充电站数据源不可用');
}

/** 高德周边 POI 搜充电站 */
async function chargersAmap(samples, key) {
  const out = [];
  for (const s of samples.slice(0, 6)) {
    const url = `https://restapi.amap.com/v3/place/around?key=${encodeURIComponent(key)}&location=${s.lon.toFixed(5)},${s.lat.toFixed(5)}&keywords=${encodeURIComponent('充电站')}&radius=8000&offset=25&page=1&extensions=base&output=JSON`;
    try {
      const data = await fetchJSON(url, { timeout: 15000 });
      for (const poi of data.pois || []) {
        const [lon, lat] = String(poi.location).split(',').map(Number);
        if (!Number.isFinite(lat)) continue;
        out.push({
          name: poi.name,
          address: poi.address,
          lat, lon,
          power: null,
          source: '高德',
        });
      }
    } catch (e) { /* 单个点失败不影响整体 */ }
  }
  return out;
}

/**
 * 沿线充电站
 * @returns {Promise<{list:Array, source:string, note?:string, per100km:number}>}
 */
export async function findChargersAlongRoute(route, opts = {}) {
  const { amapKey, corridorKm = 12 } = opts;
  const total = route.distanceKm;
  const raw = [];

  if (amapKey) {
    try {
      const s = sampleAlong(route.coords, 6);
      raw.push(...(await chargersAmap(s, amapKey)));
    } catch (e) { /* fallthrough */ }
  }

  if (!raw.length) {
    // OSM：用路线外包框 + 中间矩形，粗略但够用
    const lats = route.coords.map((c) => c.lat);
    const lons = route.coords.map((c) => c.lon);
    const pad = corridorKm / 111 * 1.5;
    const bbox = {
      north: Math.max(...lats) + pad,
      south: Math.min(...lats) - pad,
      east: Math.max(...lons) + pad,
      west: Math.min(...lons) - pad,
    };
    try {
      raw.push(...(await chargersOverpass(bbox)));
    } catch (e) {
      return {
        list: [], source: '不可用', per100km: 0,
        note: '充电站数据源当前不可达（Overpass API 被网络策略拦截或超时）。补能计划仍按模型推算，但无法给出具体站名，建议出发前用高德/特来电等 App 复核桩位。',
      };
    }
  }

  // 投影到路线上，剔除偏离走廊过远的点
  const seen = new Set();
  const list = [];
  for (const c of raw) {
    const key = `${c.name}|${c.lat.toFixed(3)}|${c.lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pr = projectToRoute(route.coords, c);
    if (pr.offsetKm > corridorKm) continue;
    list.push({ ...c, km: Number(pr.km.toFixed(1)), detourKm: Number(pr.offsetKm.toFixed(1)) });
  }
  list.sort((a, b) => a.km - b.km);

  const src = amapKey && list.some((x) => x.source === '高德') ? '高德 POI' : 'OSM Overpass';
  return {
    list,
    source: src,
    per100km: total > 0 ? Number(((list.length / total) * 100).toFixed(1)) : 0,
    note: !list.length ? '路线上未检索到充电站记录（OSM 在部分区域覆盖不足），建议出发前用专业充电 App 复核。' : null,
  };
}
