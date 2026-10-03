/**
 * 编排层：把「地理编码 → 路线 → 海拔 → 天气 → 充电桩 → 能耗模型」串成一次分析。
 * 表单模式和 Agent 工具都调这一个函数，保证两条路的结论完全一致。
 */

import { geocode, routeWithElevation, weatherAlongRoute, findChargersAlongRoute } from './geo.js';
import { analyzeTrip, totalChargingMin, CAL } from './model.js';

/**
 * @param {object} req
 * @param {string} req.origin            出发地文本
 * @param {string} req.destination       目的地文本
 * @param {string[]} [req.waypoints]     途经点
 * @param {object} req.spec              车型规格（evdb.toSpec 或 customSpec）
 * @param {number} [req.passengers]      人数
 * @param {number} [req.luggageKg]       行李重量
 * @param {string} [req.departISO]       出发时刻 ISO
 * @param {number} [req.socStart]        出发电量 %
 * @param {string} [req.hvacMode]        auto|eco|max|off
 * @param {object} settings              { amapKey }
 * @param {(step:string, pct:number)=>void} [onProgress]
 */
export async function runTripAnalysis(req, settings = {}, onProgress = () => {}) {
  const {
    origin, destination, waypoints = [], spec,
    passengers = 2, luggageKg = 20,
    departISO = new Date().toISOString(),
    socStart = 90, hvacMode = 'auto',
  } = req;

  if (!spec) throw new Error('缺少车型信息');
  const amapKey = settings.amapKey || '';

  onProgress('解析出发地', 5);
  const o = await geocode(origin, amapKey);
  onProgress('解析目的地', 12);
  const d = await geocode(destination, amapKey);

  const viaList = [];
  for (let i = 0; i < waypoints.length; i++) {
    const w = String(waypoints[i] || '').trim();
    if (!w) continue;
    onProgress(`解析途经点 ${i + 1}`, 15 + i * 3);
    viaList.push(await geocode(w, amapKey));
  }

  const points = [{ lat: o.lat, lon: o.lon, name: o.name }, ...viaList.map((v) => ({ lat: v.lat, lon: v.lon, name: v.name })), { lat: d.lat, lon: d.lon, name: d.name }];

  onProgress('规划路线', 30);
  const route = await routeWithElevation(points, { amapKey, samples: 60 });

  // 天气和充电桩互不依赖，并行拉 —— Overpass 偶尔要几十秒，串行会白等
  onProgress('拉取沿途天气与充电桩', 58);
  const [weather, chargers] = await Promise.all([
    weatherAlongRoute(route, departISO, 5).catch((e) => {
      console.warn('[weather] 失败，按常温估算：', e.message);
      return {
        samples: [], avgTempC: 20, maxPrecip: 0, avgWindKmh: 0, severe: false, ok: false,
        summary: '天气数据获取失败，已按 20℃ 常温估算',
      };
    }),
    findChargersAlongRoute(route, { amapKey, corridorKm: 12 }).catch((e) => ({
      list: [], source: '不可用', per100km: 0,
      note: `充电站数据获取失败（${e.message}），补能计划仍按模型推算。`,
    })),
  ]);

  onProgress('计算续航与补能方案', 88);
  const analysis = analyzeTrip({
    spec,
    distanceKm: route.distanceKm,
    durationH: route.durationH,
    ascentM: route.ascentM,
    descentM: route.descentM,
    minEle: route.minEle,
    maxEle: route.maxEle,
    passengers,
    luggageKg,
    tempC: weather.avgTempC,
    precipMm: weather.maxPrecip,
    windKmh: weather.avgWindKmh,
    hvacMode,
    socStart,
    chargers: chargers.list,
    profile: route.profile,
  });

  onProgress('完成', 100);

  return {
    generatedAt: new Date().toISOString(),
    origin: o,
    destination: d,
    waypoints: viaList,
    route,
    weather,
    chargers,
    analysis,
    chargingMin: totalChargingMin(analysis.charging),
  };
}

/**
 * 把分析结果压缩成一段「给人看的简报」，同时也作为 Agent 的上下文。
 * 注意：这里只做事实陈述，不做判断——判断交给 LLM 或模板。
 */
export function summarize(result) {
  const a = result.analysis;
  const lines = [];
  lines.push(`【行程】${result.origin.name} → ${result.destination.name}`);
  lines.push(`距离 ${a.input.distanceKm.toFixed(1)} km，预计行驶 ${a.input.durationH.toFixed(1)} h（平均 ${a.seg.avgSpeed.toFixed(0)} km/h）`);
  lines.push(`海拔：最低 ${a.input.minEle} m / 最高 ${a.input.maxEle} m，累计爬升 ${a.input.ascentM} m、下降 ${a.input.descentM} m`);
  lines.push(`天气：${result.weather.summary}；峰值降水 ${result.weather.maxPrecip} mm/h`);
  lines.push(`【车辆】${a.spec.name}，电池 ${a.spec.battery} kWh，官方 CLTC ${a.spec.range} km，整车 ${a.spec.mass} kg + 载重 ${a.extraMassKg} kg`);
  lines.push(`【能耗】总耗电 ${a.totalKwh.toFixed(1)} kWh，实际百公里 ${a.per100Kwh.toFixed(1)} kWh/100km`);
  lines.push(`　拆解：行驶 ${a.seg.driveKwh.toFixed(1)} / 爬坡 ${a.seg.uphillKwh.toFixed(1)} / 回收 -${a.seg.regenKwh.toFixed(1)} / 空调 ${a.seg.hvacKwh.toFixed(1)} / 附件 ${a.seg.auxKwh.toFixed(1)} kWh`);
  lines.push(`【电量】出发 ${a.input.socStart}% → 到达 ${a.arrivalSoc.toFixed(1)}%${a.charging.needed ? `（已含中途 ${a.charging.stops.length} 次补能；不补能则为 ${a.arrivalSocNoCharge.toFixed(1)}%，即电不够）` : ''}；满电实际续航约 ${Math.round(a.effectiveRangeKm)} km，为官方值的 ${(a.discount * 100).toFixed(0)}%`);
  lines.push(`【补能】${a.charging.needed ? `需要 ${a.charging.stops.length} 次充电，合计约 ${totalChargingMin(a.charging)} 分钟` : '无需中途充电'}`);
  for (const s of a.charging.stops) {
    const st = s.station ? `${s.station.name}（距路线 ${s.station.detourKm} km）` : '沿线充电站';
    lines.push(`　- 第 ${s.atKm} km 处 ${st}：SOC ${s.atSoc}% → ${s.targetSoc}%，补 ${s.addKwh} kWh，约 ${s.chargeMin} 分钟`);
  }
  lines.push(`【休息】${a.rests.length ? a.rests.map((r) => `${r.atKm}km 停 ${r.minutes} 分钟`).join('；') : '短途无需专门休息'}`);
  lines.push(`【充电条件】${result.chargers.source}，沿线检索到 ${result.chargers.list.length} 个桩点（约 ${result.chargers.per100km} 个/100km）`);
  if (a.warnings.length) {
    lines.push('【风险】');
    for (const w of a.warnings) lines.push(`　- [${w.level}] ${w.text}`);
  }
  return lines.join('\n');
}
