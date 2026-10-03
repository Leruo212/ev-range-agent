/**
 * Agent 层
 * =============================================================
 * 一个标准的 function-calling 循环：模型负责理解意图和表达，
 * 所有数字都来自工具（本地物理模型 + 真实路网/天气数据），模型不许自己编。
 *
 * 用户自带 API：任何 OpenAI 兼容的 /chat/completions 网关都能用。
 */

import { EV_DB, searchCars, getCarById, toSpec, customSpec } from './evdb.js';
import { geocode, routeWithElevation, weatherAlongRoute, findChargersAlongRoute } from './geo.js';
import { segmentEnergy, totalChargingMin, CAL, hvacPowerKw } from './model.js';
import { runTripAnalysis, compareOnRoute } from './trip.js';

// ---------------------------------------------------------------- LLM 客户端

/** 把用户填的各种写法统一成 chat/completions 端点 */
export function chatEndpoint(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('API 地址为空，请先在设置里填写');
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`;
  if (/\/compatible-mode$/.test(b)) return `${b}/v1/chat/completions`;
  return `${b}/chat/completions`;
}

function modelsEndpoint(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) b = b.replace(/\/chat\/completions$/, '');
  if (/\/compatible-mode$/.test(b)) return `${b}/v1/models`;
  return `${b}/models`;
}

export async function listModels(settings) {
  const res = await fetch(modelsEndpoint(settings.baseUrl), {
    headers: { Authorization: `Bearer ${settings.apiKey}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
}

/** 单次对话补全（带 tools 时支持工具调用） */
async function chatCompletion(settings, body) {
  if (!settings.apiKey && !/localhost|127\.0\.0\.1/.test(settings.baseUrl)) {
    throw new Error('未填写 API Key');
  }
  const res = await fetch(chatEndpoint(settings.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 400);
    try { msg = JSON.parse(text).error?.message || msg; } catch (e) { /* keep raw */ }
    throw new Error(`模型接口返回 ${res.status}：${msg}`);
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('模型返回不是合法 JSON：' + text.slice(0, 200)); }
  if (data.error) throw new Error(data.error.message || '模型返回错误');
  if (!data.choices || !data.choices.length) throw new Error('模型未返回任何结果');
  return data;
}

// ---------------------------------------------------------------- 工具实现

/** 路线缓存：同一次会话里重复查同一条路线不重复打接口 */
const routeCache = new Map();
const cacheKey = (o, d) => `${String(o).trim().toLowerCase()}→${String(d).trim().toLowerCase()}`;

async function getRoute(o, d, waypoints, settings) {
  const k = cacheKey(o, d) + '|' + (waypoints || []).join(',');
  if (routeCache.has(k)) return routeCache.get(k);

  const amapKey = settings.amapKey || '';
  const o1 = await geocode(o, amapKey);
  const d1 = await geocode(d, amapKey);
  const via = [];
  for (const w of waypoints || []) {
    if (String(w || '').trim()) via.push(await geocode(w, amapKey));
  }
  const points = [
    { lat: o1.lat, lon: o1.lon, name: o1.name },
    ...via.map((v) => ({ lat: v.lat, lon: v.lon, name: v.name })),
    { lat: d1.lat, lon: d1.lon, name: d1.name },
  ];
  const route = await routeWithElevation(points, { amapKey, samples: 60 });
  const out = { origin: o1, destination: d1, waypoints: via, route };
  routeCache.set(k, out);
  if (routeCache.size > 20) routeCache.delete(routeCache.keys().next().value);
  return out;
}

/** 天气也缓存：compare_cars 与 analyze_trip 打同一条路线时不必重复拉一遍 */
const weatherCache = new Map();
async function getWeather(route, departISO, settings) {
  const key = `${route.distanceKm.toFixed(1)}|${(departISO || '').slice(0, 13)}`;
  if (weatherCache.has(key)) return weatherCache.get(key);
  const w = await weatherAlongRoute(route, departISO || new Date().toISOString(), 5);
  weatherCache.set(key, w);
  if (weatherCache.size > 12) weatherCache.delete(weatherCache.keys().next().value);
  return w;
}

/** 充电桩同理 */
const chargerCache = new Map();
async function getChargers(route, settings) {
  const key = route.distanceKm.toFixed(1) + '|' + (route.coords[0]?.lon.toFixed(2) || '') + (route.coords[route.coords.length - 1]?.lon.toFixed(2) || '');
  if (chargerCache.has(key)) return chargerCache.get(key);
  const c = await findChargersAlongRoute(route, { amapKey: settings.amapKey || '', corridorKm: 12 });
  chargerCache.set(key, c);
  if (chargerCache.size > 12) chargerCache.delete(chargerCache.keys().next().value);
  return c;
}

/** 从剖面里挑出最陡的几段爬坡/下坡，让模型能说「在哪一段上坡」 */
function describeClimbs(profile, top = 4) {
  if (!profile || profile.length < 3) return { climbs: [], descents: [] };
  const segs = [];
  let cur = null;
  for (let i = 1; i < profile.length; i++) {
    const d = profile[i].ele - profile[i - 1].ele;
    const dkm = (profile[i].km || 0) - (profile[i - 1].km || 0);
    const grade = dkm > 0 ? (d / (dkm * 1000)) * 100 : 0;
    if (d > 3) {
      if (cur && cur.sign > 0) { cur.toKm = profile[i].km; cur.gain += d; }
      else { if (cur) segs.push(cur); cur = { sign: 1, fromKm: profile[i - 1].km, toKm: profile[i].km, gain: d, grade }; }
    } else if (d < -3) {
      if (cur && cur.sign < 0) { cur.toKm = profile[i].km; cur.gain += -d; }
      else { if (cur) segs.push(cur); cur = { sign: -1, fromKm: profile[i - 1].km, toKm: profile[i].km, gain: -d, grade }; }
    } else if (cur) { segs.push(cur); cur = null; }
  }
  if (cur) segs.push(cur);
  const fmt = (s) => ({
    fromKm: Math.round(s.fromKm || 0),
    toKm: Math.round(s.toKm || 0),
    deltaM: Math.round(s.gain),
    avgGradePct: Number((Math.abs(s.gain) / Math.max(1, ((s.toKm || 0) - (s.fromKm || 0)) * 1000) * 100).toFixed(1)),
  });
  const climbs = segs.filter((s) => s.sign > 0).map(fmt).sort((a, b) => b.deltaM - a.deltaM).slice(0, top);
  const descents = segs.filter((s) => s.sign < 0).map(fmt).sort((a, b) => b.deltaM - a.deltaM).slice(0, top);
  return { climbs, descents };
}

function compactProfile(profile, n = 30) {
  if (!profile || !profile.length) return [];
  const step = Math.max(1, Math.floor(profile.length / n));
  const out = [];
  for (let i = 0; i < profile.length; i += step) {
    out.push([Math.round(profile[i].km || 0), Math.round(profile[i].ele || 0)]);
  }
  const last = profile[profile.length - 1];
  if (!out.length || out[out.length - 1][0] !== Math.round(last.km || 0)) {
    out.push([Math.round(last.km || 0), Math.round(last.ele || 0)]);
  }
  return out;
}

/** 结果 → 给模型的紧凑 JSON */
function packAnalysis(res) {
  const a = res.analysis;
  const { climbs, descents } = describeClimbs(res.route.profile);
  return {
    trip: {
      from: res.origin.name,
      to: res.destination.name,
      waypoints: res.waypoints.map((w) => w.name),
      distance_km: Number(a.input.distanceKm.toFixed(1)),
      duration_h: Number(a.input.durationH.toFixed(2)),
      duration_text: `${Math.floor(a.input.durationH)}小时${Math.round((a.input.durationH % 1) * 60)}分`,
      avg_speed_kmh: Number(a.seg.avgSpeed.toFixed(1)),
      route_source: res.route.source,
      toll_yuan: res.route.toll,
    },
    elevation: {
      min_m: a.input.minEle,
      max_m: a.input.maxEle,
      total_ascent_m: a.input.ascentM,
      total_descent_m: a.input.descentM,
      main_climbs: climbs,
      main_descents: descents,
      profile_km_ele: compactProfile(res.route.profile),
    },
    weather: {
      summary: res.weather.summary,
      avg_temp_c: res.weather.avgTempC,
      max_precip_mm_h: res.weather.maxPrecip,
      avg_wind_kmh: res.weather.avgWindKmh,
      severe: res.weather.severe,
      samples: res.weather.samples.map((s) => ({
        km: Math.round(s.km),
        ele_m: Math.round(s.ele || 0),
        temp_c: s.tempC,
        precip_mm: s.precipMm,
        wind_kmh: s.windKmh,
        weather: s.text,
      })),
    },
    vehicle: {
      name: a.spec.name,
      battery_kwh: a.spec.battery,
      cltc_range_km: a.spec.range,
      curb_mass_kg: a.spec.mass,
      dc_peak_kw: a.spec.dc,
      payload_kg: a.extraMassKg,
    },
    energy: {
      total_kwh: Number(a.totalKwh.toFixed(2)),
      per_100km_kwh: Number(a.per100Kwh.toFixed(2)),
      breakdown_kwh: {
        drive: Number(a.seg.driveKwh.toFixed(2)),
        climb: Number(a.seg.uphillKwh.toFixed(2)),
        regen_credit: Number(-a.seg.regenKwh.toFixed(2)),
        hvac: Number(a.seg.hvacKwh.toFixed(2)),
        aux: Number(a.seg.auxKwh.toFixed(2)),
      },
      correction_factors: {
        cltc_to_real: a.seg.factors.kReal,
        speed: Number(a.seg.factors.speedF.toFixed(3)),
        temperature: Number(a.seg.factors.tempF.toFixed(3)),
        payload: Number(a.seg.factors.loadF.toFixed(3)),
      },
    },
    soc: {
      start_pct: a.input.socStart,
      arrival_pct: Number(a.arrivalSoc.toFixed(1)),
      arrival_pct_if_no_charging: Number(a.arrivalSocNoCharge.toFixed(1)),
      recommended_start_pct: a.recommendedSocStart,
    },
    range: {
      effective_full_km: Math.round(a.effectiveRangeKm),
      vs_cltc_pct: Math.round(a.discount * 100),
      scenarios: a.scenarios,
    },
    charging: {
      needed: a.charging.needed,
      strategy: a.charging.strategy,
      total_charge_min: totalChargingMin(a.charging),
      stops: a.charging.stops.map((s) => ({
        at_km: s.atKm,
        soc_on_arrival: s.atSoc,
        charge_to_soc: s.targetSoc,
        add_kwh: s.addKwh,
        minutes: s.chargeMin,
        station: s.station ? { name: s.station.name, detour_km: s.station.detourKm, source: s.station.source } : null,
      })),
      notes: a.charging.notes,
    },
    rests: a.rests.map((r) => ({
      at_km: r.atKm,
      at_hour: r.atHour,
      minutes: r.minutes,
      reason: r.reason,
      station: r.station ? r.station.name : null,
    })),
    charger_density: {
      source: res.chargers.source,
      count: res.chargers.list.length,
      per_100km: res.chargers.per100km,
      nearest_to_route: res.chargers.list.slice(0, 12).map((c) => ({
        name: c.name, km: c.km, detour_km: c.detourKm, source: c.source,
      })),
      note: res.chargers.note,
    },
    warnings: a.warnings,
  };
}

/** 参数兜底：模型经常漏字段 */
function normSpec(args) {
  if (args.car_id) {
    const c = getCarById(args.car_id);
    if (c) return toSpec(c);
  }
  if (args.car_query) {
    const list = searchCars(args.car_query, 1);
    if (list.length) return toSpec(list[0]);
  }
  if (args.battery_kwh || args.cltc_range_km) {
    return customSpec({
      name: args.car_name || '自定义车型',
      battery: args.battery_kwh,
      range: args.cltc_range_km,
      mass: args.curb_mass_kg,
      dc: args.dc_peak_kw,
    });
  }
  return null;
}

/** 工具注册表 */
export const TOOL_IMPL = {
  async search_car_model({ query }) {
    const list = searchCars(query, 10);
    return {
      query,
      count: list.length,
      models: list.map((c) => ({
        car_id: c.id,
        name: `${c.brand} ${c.model}`,
        year: c.year,
        battery_kwh: c.battery,
        cltc_range_km: c.range,
        curb_mass_kg: c.mass,
        dc_peak_kw: c.dc,
      })),
      hint: list.length
        ? '用 car_id 调用 analyze_trip 即可。若用户的车不在列表里，用 battery_kwh + cltc_range_km + curb_mass_kg 直接传参。'
        : '车型库里没有匹配项，请向用户确认电池容量与官方续航（或让他在界面上手动填写自定义车型）。',
      total_in_db: EV_DB.length,
    };
  },

  async plan_route({ origin, destination, waypoints }, ctx) {
    const { origin: o, destination: d, route } = await getRoute(origin, destination, waypoints, ctx.settings);
    const { climbs, descents } = describeClimbs(route.profile);
    return {
      from: o.name, to: d.name,
      distance_km: Number(route.distanceKm.toFixed(1)),
      duration_h: Number(route.durationH.toFixed(2)),
      source: route.source,
      elevation: {
        min_m: route.minEle, max_m: route.maxEle,
        total_ascent_m: route.ascentM, total_descent_m: route.descentM,
        main_climbs: climbs, main_descents: descents,
      },
      profile_km_ele: compactProfile(route.profile, 24),
    };
  },

  async get_weather_along_route({ origin, destination, depart_time }, ctx) {
    const { route, origin: o, destination: d } = await getRoute(origin, destination, [], ctx.settings);
    const w = await getWeather(route, depart_time, ctx.settings);
    return {
      from: o.name, to: d.name,
      summary: w.summary,
      avg_temp_c: w.avgTempC,
      max_precip_mm_h: w.maxPrecip,
      avg_wind_kmh: w.avgWindKmh,
      has_severe_weather: w.severe,
      samples: w.samples.map((s) => ({ km: Math.round(s.km), ele_m: Math.round(s.ele || 0), temp_c: s.tempC, weather: s.text, precip_mm: s.precipMm })),
      note: w.ok ? null : '天气接口不可达，已按常温估算',
    };
  },

  async find_charging_stations({ origin, destination }, ctx) {
    const { route, origin: o, destination: d } = await getRoute(origin, destination, [], ctx.settings);
    const c = await getChargers(route, ctx.settings);
    return {
      from: o.name, to: d.name,
      source: c.source,
      count: c.list.length,
      per_100km: c.per100km,
      stations: c.list.slice(0, 40).map((s) => ({ name: s.name, at_km: s.km, detour_km: s.detourKm, source: s.source })),
      note: c.note,
    };
  },

  /**
   * 纯能耗模型：不联网，参数全给就能算。
   * 用于「如果换成 4 个人会怎样」「如果气温降到 -5℃ 呢」这类反事实问题。
   */
  async estimate_energy(args) {
    const spec = normSpec(args);
    if (!spec) return { error: '缺少车型参数：请提供 car_id / car_query，或直接给 battery_kwh 与 cltc_range_km' };
    const seg = segmentEnergy({
      spec,
      distanceKm: args.distance_km || 100,
      durationH: args.duration_h || (args.distance_km || 100) / (args.avg_speed_kmh || 80),
      extraMassKg: (args.passengers ?? 2) * CAL.passengerKg + (args.luggage_kg ?? 20),
      ascentM: args.ascent_m || 0,
      descentM: args.descent_m || 0,
      tempC: args.temperature_c ?? 20,
      precipMm: args.precipitation_mm ?? 0,
      windKmh: args.wind_kmh ?? 0,
      hvacMode: args.hvac_mode || 'auto',
    });
    const fullRange = (spec.battery / seg.per100Kwh) * 100;
    return {
      vehicle: spec.name,
      inputs: {
        distance_km: args.distance_km, passengers: args.passengers ?? 2,
        temperature_c: args.temperature_c ?? 20, ascent_m: args.ascent_m || 0,
        descent_m: args.descent_m || 0, hvac_mode: args.hvac_mode || 'auto',
        avg_speed_kmh: Number(seg.avgSpeed.toFixed(1)),
      },
      total_energy_kwh: Number(seg.totalKwh.toFixed(2)),
      per_100km_kwh: Number(seg.per100Kwh.toFixed(2)),
      breakdown_kwh: {
        drive: Number(seg.driveKwh.toFixed(2)),
        climb: Number(seg.uphillKwh.toFixed(2)),
        regen_credit: Number(-seg.regenKwh.toFixed(2)),
        hvac: Number(seg.hvacKwh.toFixed(2)),
        aux: Number(seg.auxKwh.toFixed(2)),
      },
      full_charge_range_km: Math.round(fullRange),
      hvac_power_kw: Number(hvacPowerKw(args.temperature_c ?? 20, args.hvac_mode || 'auto').toFixed(2)),
    };
  },

  /** 一把梭：拉路线+天气+充电桩，跑完整模型 */
  async analyze_trip(args, ctx) {
    const spec = normSpec(args);
    if (!spec) {
      return {
        error: '缺少车型信息。请先用 search_car_model 找 car_id，或让用户提供电池容量(kWh)与官方续航(km)。',
      };
    }
    if (!args.origin || !args.destination) {
      return { error: '缺少 origin 或 destination，请向用户确认出发地和目的地。' };
    }
    const res = await runTripAnalysis({
      origin: args.origin,
      destination: args.destination,
      waypoints: args.waypoints || [],
      spec,
      passengers: args.passengers ?? 2,
      luggageKg: args.luggage_kg ?? 20,
      departISO: args.depart_time || new Date().toISOString(),
      socStart: args.soc_start_pct ?? 90,
      hvacMode: args.hvac_mode || 'auto',
    }, ctx.settings, (step, pct) => ctx.onStep && ctx.onStep(`analyze_trip · ${step}`, pct));
    return packAnalysis(res);
  },

  /** 同一条路线横向对比多款车，只拉一次路线数据 */
  async compare_cars(args, ctx) {
    const { origin, destination, passengers = 2, luggage_kg = 20, depart_time, soc_start_pct = 90, hvac_mode = 'auto' } = args;
    if (!origin || !destination) return { error: '缺少 origin 或 destination' };
    const queries = args.cars || [];
    if (!queries.length) return { error: '请提供 cars 数组，例如 ["小米 SU7 Pro", "特斯拉 Model 3 后轮驱动版"]' };

    const { origin: o, destination: d, route } = await getRoute(origin, destination, args.waypoints || [], ctx.settings);
    const weather = await getWeather(route, depart_time, ctx.settings);
    const chargers = await getChargers(route, ctx.settings);

    // 与界面上的对比表复用同一个实现，避免"对话里算一套、界面里算另一套"
    const rows = compareOnRoute(
      { route, weather, chargers },
      queries,
      { passengers, luggageKg: luggage_kg, socStart: soc_start_pct, hvacMode: hvac_mode }
    );

    return {
      from: o.name, to: d.name,
      distance_km: Number(route.distanceKm.toFixed(1)),
      ascent_m: route.ascentM, descent_m: route.descentM,
      avg_temp_c: weather.avgTempC,
      passengers,
      comparison: rows.map((r) => {
        if (r.error) return { query: r.query, error: r.error };
        const a = r.analysis;
        return {
          name: r.spec.name,
          battery_kwh: r.spec.battery,
          cltc_range_km: r.spec.range,
          total_kwh: Number(a.totalKwh.toFixed(2)),
          per_100km_kwh: Number(a.per100Kwh.toFixed(2)),
          arrival_soc_pct: Number(a.arrivalSoc.toFixed(1)),
          effective_range_km: Math.round(a.effectiveRangeKm),
          vs_cltc_pct: Math.round(a.discount * 100),
          charging_stops: a.charging.stops.length,
          total_charge_min: r.chargeMin,
          feasible_direct: a.direct,
        };
      }),
      note: '所有车型用的都是同一条路线、同一份天气与同一个物理模型，差异只来自车本身。',
    };
  },
};

// ---------------------------------------------------------------- 工具声明

export const TOOL_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'search_car_model',
      description: '在内置车型库里搜索车型，返回 car_id 以及电池容量/官方续航/整备质量/快充功率。用户提到任何车型时先调这个。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '车型关键词，如「小米 SU7」「model 3」「比亚迪 汉」' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plan_route',
      description: '规划驾车路线并返回距离、时长、海拔剖面（最低/最高海拔、累计爬升、累计下降、主要爬坡段位置）。用户问里程或地形时用。',
      parameters: {
        type: 'object',
        properties: {
          origin: { type: 'string', description: '出发地' },
          destination: { type: 'string', description: '目的地' },
          waypoints: { type: 'array', items: { type: 'string' }, description: '途经点列表（可选）' },
        },
        required: ['origin', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather_along_route',
      description: '获取沿线天气：各采样点的气温、降水、风速、天气现象，以及全line均温。已按各点真实海拔做过气温校正。',
      parameters: {
        type: 'object',
        properties: {
          origin: { type: 'string' },
          destination: { type: 'string' },
          depart_time: { type: 'string', description: '出发时刻，ISO 8601 格式，如 2026-10-04T08:00。不填则用当前时间' },
        },
        required: ['origin', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_charging_stations',
      description: '检索沿线充电站（OSM 或高德 POI），返回站名与它对应的路线里程位置、绕行距离。',
      parameters: {
        type: 'object',
        properties: { origin: { type: 'string' }, destination: { type: 'string' } },
        required: ['origin', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'estimate_energy',
      description: '纯能耗计算（不联网、很快）。用于反事实追问，例如「如果改成 4 个人」「如果气温 -5℃」「如果换成爬升 2000m 的山路」。',
      parameters: {
        type: 'object',
        properties: {
          car_id: { type: 'string', description: '车型 id（来自 search_car_model）' },
          car_query: { type: 'string', description: '车型关键词，找不到 car_id 时用' },
          car_name: { type: 'string' },
          battery_kwh: { type: 'number', description: '可用电池容量，自定义车型时必填' },
          cltc_range_km: { type: 'number', description: '官方续航，自定义车型时必填' },
          curb_mass_kg: { type: 'number' },
          dc_peak_kw: { type: 'number' },
          distance_km: { type: 'number' },
          duration_h: { type: 'number' },
          avg_speed_kmh: { type: 'number' },
          passengers: { type: 'integer' },
          luggage_kg: { type: 'number' },
          ascent_m: { type: 'number', description: '累计爬升' },
          descent_m: { type: 'number', description: '累计下降' },
          temperature_c: { type: 'number' },
          precipitation_mm: { type: 'number' },
          wind_kmh: { type: 'number' },
          hvac_mode: { type: 'string', enum: ['auto', 'eco', 'max', 'off'], description: '空调模式，默认 auto' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_trip',
      description: '【主力工具】一次完成完整续航分析：路线+海拔+天气+充电桩+能耗拆解+补能方案+休息计划+风险提示。用户给出「车型 + 出发点 + 目的地」时直接调用这个。',
      parameters: {
        type: 'object',
        properties: {
          origin: { type: 'string' },
          destination: { type: 'string' },
          waypoints: { type: 'array', items: { type: 'string' } },
          car_id: { type: 'string', description: '车型 id' },
          car_query: { type: 'string', description: '车型关键词（未先搜车型时可直接填）' },
          car_name: { type: 'string' },
          battery_kwh: { type: 'number' },
          cltc_range_km: { type: 'number' },
          curb_mass_kg: { type: 'number' },
          dc_peak_kw: { type: 'number' },
          passengers: { type: 'integer', description: '乘员人数，默认 2' },
          luggage_kg: { type: 'number', description: '行李总重 kg，默认 20' },
          depart_time: { type: 'string', description: '出发时刻 ISO 8601' },
          soc_start_pct: { type: 'number', description: '出发电量百分比，默认 90' },
          hvac_mode: { type: 'string', enum: ['auto', 'eco', 'max', 'off'] },
        },
        required: ['origin', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_cars',
      description: '在同一条路线上横向对比 2~5 款车的能耗、到达电量、充电次数与总补能时间。用户问「哪个车能跑下来」时用。',
      parameters: {
        type: 'object',
        properties: {
          origin: { type: 'string' },
          destination: { type: 'string' },
          waypoints: { type: 'array', items: { type: 'string' } },
          cars: { type: 'array', items: { type: 'string' }, description: '车型关键词数组' },
          passengers: { type: 'integer' },
          luggage_kg: { type: 'number' },
          depart_time: { type: 'string' },
          soc_start_pct: { type: 'number' },
        },
        required: ['origin', 'destination', 'cars'],
      },
    },
  },
];

// ---------------------------------------------------------------- 系统提示词

export function systemPrompt() {
  const now = new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `你是「续航参谋」，一个专做电动车真实续航与长途补能规划的出行助手。

当前时间：${iso}（中国标准时间 UTC+8）。用户默认在中国境内。

## 你的铁律
1. **所有数字必须来自工具返回结果**。禁止凭记忆报里程、海拔、气温、电耗。工具没返回就再说一次或者告诉用户查不到。
2. 结论先行。第一段就说「能不能一口气开到 / 需要在哪充几次」。
3. 输出用 Markdown，短句 + 表格 + 要点。不要写长篇散文，不要复述工具原始 JSON。
4. 凡是估算都要带上不确定度来源（低温、高速、满载各打多少折），不要给一个假装精确的数字。

## 标准动作
用户给出「车型 + 出发地 + 目的地」→ 直接调 analyze_trip（车型关键词填 car_query 即可），拿到结果后按这个结构回答：
1. **一句话结论**：总里程、能不能直达、大概几点到。
2. **能耗账**：总耗电 kWh、实际百公里电耗、对比官方值的折扣。用拆解数据说明钱花在哪——尤其是爬坡贡献了多少 kWh、下坡回收回来多少。
3. **电量曲线**：出发 SOC → 到达 SOC，中途每次充电的位置与时长。
4. **海拔影响**：指出主要爬坡段在多少公里处、爬升多少米。上坡段电耗是平路的几倍、下坡能回收多少。
5. **休息与补能建议**：几点在哪休息多久，是否与充电合并。
6. **风险提示**：把工具返回的 warnings 按严重程度排好，用一句话说清后果和对策。

## 追问处理
- 「换成 X 车呢」→ compare_cars 或多调几次 analyze_trip。
- 「如果多坐两个人」「如果 -5℃」→ estimate_energy。
- 「路上充电方便吗」→ find_charging_stations。
- 用户没说车型或没说全地点 → 别猜，直接问他；车型不确定时先 search_car_model 给 3 个候选让他选。
- 用户说「我的车」「Model Y 之类模糊」→ search_car_model 后确认版本（电池容量不同续航差很多）。

## 数据来源要诚实说明
- 路线与海拔：高德或 OpenStreetMap/OSRM + Copernicus DEM，海拔为 90m 网格地形，与实际路面有 ±10~30m 误差。
- 天气：Open-Meteo 逐时预报，已按各点海拔做气温校正。
- 充电桩：高德 POI 或 OSM，覆盖率有限，务必提醒用户出发前用专业充电 App 复核。
- 能耗模型：物理推算（整车质量 × 爬升做功 − 动能回收 + 空调 + 附件），不是实测。误差通常在 ±15%。

不要输出"作为 AI 我无法"这类话。也不要主动说自己是哪个模型。`;
}

// ---------------------------------------------------------------- Agent 循环

/**
 * @param {object} p
 * @param {object} p.settings
 * @param {Array}  p.messages    完整对话历史（会被就地追加）
 * @param {Function} p.onEvent   (type, payload) => void
 *   type: 'assistant_delta' | 'tool_start' | 'tool_end' | 'step' | 'error'
 */
export async function runAgent({ settings, messages, onEvent = () => {}, maxSteps = 8 }) {
  const ctx = {
    settings,
    onStep: (label, pct) => onEvent('step', { label, pct }),
  };

  for (let step = 0; step < maxSteps; step++) {
    onEvent('step', { label: step === 0 ? '思考中' : '继续推理', pct: 0 });

    let data;
    try {
      data = await chatCompletion(settings, {
        model: settings.model,
        messages: [{ role: 'system', content: systemPrompt() }, ...messages],
        tools: TOOL_SCHEMA,
        tool_choice: 'auto',
        temperature: settings.temperature ?? 0.3,
        stream: false,
      });
    } catch (e) {
      // 部分网关/本地模型不支持 tools，降级成纯对话
      if (/tools|function|tool_choice|400|422/i.test(e.message)) {
        onEvent('step', { label: '该模型不支持工具调用，降级为纯对话模式', pct: 0 });
        data = await chatCompletion(settings, {
          model: settings.model,
          messages: [{ role: 'system', content: systemPrompt() }, ...messages],
          temperature: settings.temperature ?? 0.3,
          stream: false,
        });
        const content = data.choices[0].message.content || '';
        messages.push({ role: 'assistant', content });
        return { content, steps: step + 1, degraded: true };
      }
      throw e;
    }

    const msg = data.choices[0].message;
    const calls = msg.tool_calls || [];

    if (!calls.length) {
      const content = msg.content || '';
      messages.push({ role: 'assistant', content });
      return { content, steps: step + 1 };
    }

    // 把 assistant 的 tool_calls 消息原样放回历史
    messages.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: calls,
    });

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch (e) {
        args = {};
      }
      onEvent('tool_start', { name, args });

      let result;
      try {
        const impl = TOOL_IMPL[name];
        if (!impl) throw new Error(`未知工具 ${name}`);
        result = await impl(args, ctx);
      } catch (e) {
        result = { error: String(e.message || e) };
      }

      onEvent('tool_end', { name, result });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 60000),
      });
    }
  }

  return { content: '（推理步数已达上限，请把问题拆小一点再问一次）', steps: maxSteps, truncated: true };
}
