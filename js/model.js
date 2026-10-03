/**
 * 电车真实续航物理模型 + 行程/补能/休息规划
 * =============================================================
 * 设计原则：所有结论都能被拆开算给你看。没有黑盒、没有玄学系数。
 *
 * 能耗 = 行驶能耗（含速度/温度/载重修正）
 *      + 海拔净能耗（爬升做功 − 下坡动能回收）   ← 用户明确要求的部分
 *      + 空调能耗（制热/制冷，按行驶时长）
 *      + 低压附件能耗
 */

// ---------------------------------------------------------------- 常数与曲线

/** 默认标定参数，界面上可调 */
export const CAL = {
  /** CLTC → 真实道路的整体放大系数。CLTC 循环平均车速低、无空调、常温，实测普遍 +15%~+30% */
  kReal: 1.2,
  /** 动能回收效率：电机+电控+电池接受能力，实测 55%~70% */
  regenEff: 0.62,
  /** 低压附件（车机、灯光、水泵、转向助力）平均功耗 kW */
  auxKw: 0.35,
  /** 每位乘员按 70kg 计 */
  passengerKg: 70,
  /** 到达时建议保留的最低 SOC(%) */
  minArrivalSoc: 15,
  /** 出发前遥控预热/预冷的一次性能耗 kWh */
  preconditionKwh: 0.6,
};

/**
 * 车速修正曲线（以 80km/h 为 1.0）
 * 电车能耗随车速呈 U 形：低速段空调与附件占比高，高速段风阻 ∝ v² 主导。
 */
const SPEED_CURVE = [
  [0, 1.08], [15, 1.02], [30, 0.97], [45, 0.94], [60, 0.93],
  [80, 1.0], [90, 1.06], [100, 1.14], [110, 1.23],
  [120, 1.33], [130, 1.44], [140, 1.55], [160, 1.82],
];

/**
 * 温度修正曲线：电池可用容量下降 + 内阻上升 + 热管理自身耗电
 * 这是「同一辆车冬天少跑一百多公里」的主因之一（另一部分是空调制热）。
 */
const TEMP_CURVE = [
  [-30, 0.58], [-25, 0.63], [-20, 0.68], [-15, 0.72], [-10, 0.77],
  [-5, 0.82], [0, 0.86], [5, 0.9], [10, 0.94], [15, 0.98],
  [20, 1.0], [25, 1.0], [28, 0.995], [30, 0.985], [35, 0.96],
  [40, 0.93], [45, 0.9],
];

/** 分段线性插值 */
function interp(x, curve) {
  if (x <= curve[0][0]) return curve[0][1];
  const last = curve[curve.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (x <= x1) {
      const [x0, y0] = curve[i - 1];
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return last[1];
}

/**
 * 空调功率（kW）。冬季制热是电车续航的头号杀手，
 * 热泵车型在 0℃ 以上明显更省，这里给一个折中的实测评效。
 */
export function hvacPowerKw(tempC, mode = 'auto') {
  if (mode === 'off') return 0;
  let p;
  if (tempC <= 20) {
    // 制热：热泵基础 + PTC 补充，0℃ ≈ 2.6kW，-10℃ ≈ 3.4kW
    p = 0.85 + 0.085 * (20 - tempC);
  } else if (tempC >= 26) {
    // 制冷：35℃ ≈ 1.05kW，40℃ ≈ 1.32kW
    p = 0.55 + 0.055 * (tempC - 26);
  } else {
    p = 0.15; // 通风/除雾
  }
  if (mode === 'eco') p *= 0.68;
  if (mode === 'max') p *= 1.35;
  return p;
}

/** 降水等级 → 滚阻/涉水附加系数 */
const PRECIP_CURVE = [
  [0, 1.0], [0.5, 1.01], [2, 1.03], [5, 1.06], [10, 1.1], [20, 1.14],
];

/** 逆风/侧风的近似附加（很低，仅作提示级修正） */
function windFactor(windKmh, avgSpeedKmh) {
  if (!windKmh || !avgSpeedKmh) return 1;
  // 风阻与相对速度平方相关，按 15km/h 风速对应 +2% 量的粗略折算
  return 1 + Math.min(0.06, (windKmh / 15) * 0.02);
}

// ---------------------------------------------------------------- 海拔剖面

/**
 * 从海拔剖面点列计算累计爬升/累计下降。
 * 必须先做轻度平滑，否则 GPS/地形采样噪声会把每一米的抖动都算成爬升，
 * 导致爬升量被夸大好几倍（这是很多「海拔能耗」估算翻车的地方）。
 */
export function computeAscentDescent(profile, smoothWindow = 5) {
  if (!profile || profile.length < 2) return { ascent: 0, descent: 0, minEle: 0, maxEle: 0 };
  const eles = profile.map((p) => p.ele).filter((e) => Number.isFinite(e));
  if (eles.length < 2) return { ascent: 0, descent: 0, minEle: 0, maxEle: 0 };

  // 滑动平均
  const sm = [];
  const half = Math.floor(smoothWindow / 2);
  for (let i = 0; i < eles.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(eles.length - 1, i + half); j++) {
      s += eles[j]; n++;
    }
    sm.push(s / n);
  }

  let ascent = 0, descent = 0;
  for (let i = 1; i < sm.length; i++) {
    const d = sm[i] - sm[i - 1];
    if (d > 0) ascent += d; else descent += -d;
  }
  return {
    ascent: Math.round(ascent),
    descent: Math.round(descent),
    minEle: Math.round(Math.min(...sm)),
    maxEle: Math.round(Math.max(...sm)),
  };
}

/** 高处气温递减率（干绝热近似 6.5℃/km，这里取 6.0 更贴近实测） */
export const LAPSE_RATE = 6.0;

/** 把海拔折算进气温：以参考海拔为基准 */
export function tempAtElevation(baseTempC, baseEleM, targetEleM) {
  return baseTempC - ((targetEleM - baseEleM) / 1000) * LAPSE_RATE;
}

// ---------------------------------------------------------------- 主模型

/**
 * 单车段能耗计算（不含补能规划）
 *
 * @param {object} p
 * @param {object} p.spec        车型规格 {battery, range, mass, dc, ratedPer100}
 * @param {number} p.distanceKm  里程
 * @param {number} p.durationH   耗时（小时）
 * @param {number} p.extraMassKg 额外载重
 * @param {number} p.ascentM     累计爬升
 * @param {number} p.descentM    累计下降
 * @param {number} p.tempC       路段加权平均气温
 * @param {number} p.precipMm    降水
 * @param {number} p.windKmh     风速
 * @param {string} p.hvacMode
 */
export function segmentEnergy(p) {
  const {
    spec, distanceKm, durationH, extraMassKg = 0,
    ascentM = 0, descentM = 0, tempC = 20, precipMm = 0,
    windKmh = 0, hvacMode = 'auto', kReal = CAL.kReal,
  } = p;

  const totalMass = spec.mass + extraMassKg;
  const avgSpeed = durationH > 0 ? distanceKm / durationH : distanceKm;

  // 1) 行驶能耗
  const baseKwh = (spec.ratedPer100 * distanceKm) / 100 * kReal;
  const speedF = interp(avgSpeed, SPEED_CURVE);
  const loadF = 1 + 0.006 * (extraMassKg / 100);
  const tempF = interp(tempC, TEMP_CURVE);
  const precipF = interp(precipMm, PRECIP_CURVE);
  const windF = windFactor(windKmh, avgSpeed);
  const driveKwh = baseKwh * speedF * loadF * tempF * precipF * windF;

  // 2) 海拔：爬升要按整车质量做功，下坡能靠动能回收捞回来一部分
  const g = 9.81;
  const uphillKwh = (totalMass * g * ascentM) / 3.6e6;
  let regenKwh = ((totalMass * g * descentM) / 3.6e6) * CAL.regenEff;
  // 物理上限：不能指望靠下坡把车的电越跑越多（现实中回收功率受电机与电池接受能力限制）
  const regenCap = driveKwh * 0.5;
  const regenCapped = regenKwh > regenCap;
  if (regenCapped) regenKwh = regenCap;
  const elevNetKwh = uphillKwh - regenKwh;

  // 3) 空调
  const hvacKw = hvacPowerKw(tempC, hvacMode);
  const hvacKwh = hvacKw * durationH + (hvacMode === 'off' ? 0 : CAL.preconditionKwh);

  // 4) 低压附件
  const auxKwh = CAL.auxKw * durationH;

  const totalKwh = driveKwh + elevNetKwh + hvacKwh + auxKwh;
  const per100Kwh = distanceKm > 0 ? (totalKwh / distanceKm) * 100 : 0;

  return {
    distanceKm, durationH, avgSpeed, totalMass, extraMassKg,
    baseKwh,
    driveKwh,
    uphillKwh,
    regenKwh,
    regenCapped,
    elevNetKwh,
    hvacKwh,
    hvacKw,
    auxKwh,
    totalKwh,
    per100Kwh,
    factors: { speedF, loadF, tempF, precipF, windF, kReal },
    // 相对官方 CLTC 口径的放大倍数 —— 这就是「续航打几折」的倒数
    realFactor: per100Kwh / spec.ratedPer100,
  };
}

// ---------------------------------------------------------------- 补能与休息

/**
 * 生成充电计划。
 * 策略贴近真实用车习惯：
 *   - 长途优先跑 20% → 80% 这个快充最有效率的区间，而不是等见底再充
 *   - 单段不跑到低于 SOC 15%
 *   - 进山（大幅爬升）之前把电补足，山区桩稀且上坡费电
 */
export function planCharging(opts) {
  const {
    spec, distanceKm, per100Kwh, socStart, minArrivalSoc = CAL.minArrivalSoc,
    ascentM = 0, maxEle = 0, chargers = [], fastestKm = 300,
  } = opts;

  const usableKwh = (spec.battery * socStart) / 100;
  const needKwh = (per100Kwh * distanceKm) / 100;
  const minKwh = (spec.battery * minArrivalSoc) / 100;
  const energyRangeKm = per100Kwh > 0 ? (spec.battery / per100Kwh) * 100 : 0;

  const stops = [];
  const notes = [];
  const swapCapable = !!spec.swap;

  if (needKwh + minKwh <= usableKwh + 1e-6) {
    // 一口气到
    if (swapCapable) {
      notes.push('这台车支持换电：短途用不上，但长途时「3 分钟换一块满电电池」比快充省得多，规划时优先找换电站而不是充电桩。');
    }
    return {
      needed: false,
      stops,
      energyRangeKm,
      usableKwh,
      needKwh,
      notes,
      swapCapable,
      strategy: '无需中途补能',
    };
  }

  // 需要充电：按 20%→80% 窗口切段
  const loSoc = 20, hiSoc = 80;
  const windowKwh = (spec.battery * (hiSoc - loSoc)) / 100;
  const windowKm = per100Kwh > 0 ? (windowKwh / per100Kwh) * 100 : 200;

  let soc = socStart;
  let travelled = 0;
  let guard = 0;

  while (guard++ < 30) {
    // 本段可跑距离：从当前 SOC 跑到 minArrivalSoc 还够跑多远
    const availKwh = (spec.battery * (soc - minArrivalSoc)) / 100;
    let legKm = per100Kwh > 0 ? (availKwh / per100Kwh) * 100 : 0;
    // 单段不超过一个充电窗口的续航，也不超过驾驶节奏上限
    const legLimit = Math.min(windowKm, fastestKm);
    legKm = Math.min(legKm, legLimit);

    const remain = distanceKm - travelled;
    if (legKm >= remain) break; // 剩下的电够直达

    if (legKm <= 1) {
      // 出发电量不足，连第一段都跑不动
      notes.push('出发电量偏低，建议出发前先补电，否则第一段就要找桩。');
      legKm = Math.max(remain, 1);
      break;
    }

    travelled += legKm;
    const socAtStop = soc - (per100Kwh * legKm) / 100 / spec.battery * 100;

    // 找附近充电站
    const near = findNearestCharger(chargers, travelled, distanceKm);
    // 补能时间：20→80% 平均功率约为峰值的 72%，外加 6 分钟插拔/排队
    const targetSoc = 80;
    const addKwh = (spec.battery * (Math.max(targetSoc - socAtStop, 30))) / 100;
    const avgKw = Math.max(spec.dc * 0.72, 25);
    const chargeMin = Math.round((addKwh / avgKw) * 60 + 6);

    stops.push({
      atKm: Math.round(travelled),
      atSoc: Math.round(socAtStop),
      targetSoc,
      addKwh: Number(addKwh.toFixed(1)),
      chargeMin,
      avgKw: Math.round(avgKw),
      station: near,
      progressPct: distanceKm > 0 ? Math.round((travelled / distanceKm) * 100) : 0,
    });

    soc = targetSoc;
  }

  if (ascentM > 600) {
    notes.push(
      `全程累计爬升 ${Math.round(ascentM)}m，上坡段电耗会明显高于平路。建议把进入山区前的最后一次补电充到 85% 以上，山区充电桩密度低、排队风险高。`
    );
  }
  if (maxEle > 2000) {
    notes.push(`路线最高海拔 ${Math.round(maxEle)}m，高原环境下电池放电能力与充电功率都会下降，建议多留 10% 余量。`);
  }
  if (spec.dc < 120) {
    notes.push(`该车型快充峰值仅 ${spec.dc}kW，单次补能时间较长，建议把充电与用餐/休息合并安排。`);
  }
  if (swapCapable) {
    notes.push(
      `这台车支持换电，每次换电约 3 分钟（全程自动、人不用下车），比上面按快充算的 ${stops.reduce((s, x) => s + x.chargeMin, 0)} 分钟总补能时间省得多。` +
      `蔚来换电站全国已超 3400 座、高速平均约 180km 一座，长途请优先用「加电」App 找换电站而不是充电桩；` +
      `但换电站的电池库存与排队情况要现场看，节假日高峰期有等位风险，别把行程卡得太紧。`
    );
  }

  return {
    needed: true,
    stops,
    energyRangeKm,
    usableKwh,
    needKwh,
    notes,
    swapCapable,
    strategy: swapCapable
      ? `中途补能 ${stops.length} 次（支持换电，可压缩到每次约 3 分钟）`
      : `中途补能 ${stops.length} 次，每次充至 80%（快充效率拐点）`,
  };
}

/** 在路线剖面里找离某个里程最近的充电站 */
function findNearestCharger(chargers, atKm, totalKm) {
  if (!chargers || !chargers.length) return null;
  let best = null, bestD = Infinity;
  for (const c of chargers) {
    if (typeof c.km !== 'number') continue;
    const d = Math.abs(c.km - atKm);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (best && bestD <= Math.max(30, totalKm * 0.12)) {
    return { ...best, offsetKm: Math.round(best.km - atKm) };
  }
  return null;
}

/**
 * 安全休息计划。
 * 依据：连续驾驶 2 小时或 200km 应休息 15~20 分钟。
 * 休息点与充电点取并集：充电本身就是一次停留，两者重合就合并，不重合就各算一次
 * ——避免出现「休息 15 分钟、又充电 30 分钟」这种来回折腾的安排。
 */
export function planRests({ durationH, distanceKm, chargeStops = [] }) {
  const maxLegH = 2.0;
  const maxLegKm = 200;
  const points = [];

  const legs = Math.max(1, Math.ceil(Math.max(durationH / maxLegH, distanceKm / maxLegKm)));
  if (legs > 1) {
    const legKm = distanceKm / legs;
    const legH = durationH / legs;
    for (let i = 1; i < legs; i++) {
      points.push({ atKm: Math.round(legKm * i), atHour: Number((legH * i).toFixed(2)), minutes: 18, charge: null, station: null });
    }
  }

  const mergeTol = Math.max(15, distanceKm * 0.06);
  for (const cs of chargeStops) {
    const near = points.find((p) => Math.abs(p.atKm - cs.atKm) < mergeTol);
    if (near) {
      near.charge = cs;
      near.station = cs.station;
      near.minutes = Math.max(20, cs.chargeMin);
    } else {
      points.push({
        atKm: cs.atKm,
        atHour: Number(((cs.atKm / Math.max(distanceKm, 1)) * durationH).toFixed(2)),
        minutes: Math.max(20, cs.chargeMin),
        charge: cs,
        station: cs.station,
      });
    }
  }

  points.sort((a, b) => a.atKm - b.atKm);
  for (const p of points) {
    p.reason = p.charge
      ? `休息 + 充电合并：补 ${p.charge.addKwh} kWh 到 SOC ${p.charge.targetSoc}%`
      : '连续驾驶疲劳节点，建议下车活动、补充饮水';
  }
  return points;
}

// ---------------------------------------------------------------- 总装

/**
 * 一次完整分析。输入尽量少，输出尽量全。
 */
export function analyzeTrip(input) {
  const {
    spec,
    distanceKm, durationH,
    ascentM = 0, descentM = 0, minEle = 0, maxEle = 0,
    passengers = 2, luggageKg = 20,
    tempC = 20, precipMm = 0, windKmh = 0,
    hvacMode = 'auto',
    socStart = 90,
    minArrivalSoc = CAL.minArrivalSoc,
    kReal = CAL.kReal,
    chargers = [],
    profile = [],
  } = input;

  const extraMassKg = passengers * CAL.passengerKg + luggageKg;

  const seg = segmentEnergy({
    spec, distanceKm, durationH, extraMassKg,
    ascentM, descentM, tempC, precipMm, windKmh, hvacMode, kReal,
  });

  // 不充电时的到达电量（可能为负，说明电不够）
  const arrivalSocNoCharge = socStart - (seg.totalKwh / spec.battery) * 100;

  const charging = planCharging({
    spec, distanceKm, per100Kwh: seg.per100Kwh, socStart, minArrivalSoc,
    ascentM, maxEle, chargers,
  });

  // 按补能方案走，真正到达时还剩多少 —— 这才是用户要看的数
  let arrivalSoc = arrivalSocNoCharge;
  if (charging.needed && charging.stops.length) {
    const last = charging.stops[charging.stops.length - 1];
    const remainKm = Math.max(0, distanceKm - last.atKm);
    arrivalSoc = last.targetSoc - ((seg.per100Kwh * remainKm) / 100 / spec.battery) * 100;
  }

  const effectiveRangeKm = seg.per100Kwh > 0 ? (spec.battery / seg.per100Kwh) * 100 : 0;
  const discount = spec.range > 0 ? effectiveRangeKm / spec.range : 1;

  // 拆解表（用于界面条形图与解释）
  const breakdown = [
    { key: 'drive', label: '行驶基础能耗', kwh: seg.driveKwh, note: `官方电耗 ${spec.ratedPer100.toFixed(1)} kWh/100km × ${kReal} 实路系数 × 速度/温度/载重修正` },
    { key: 'speed', label: '　└ 车速修正', kwh: seg.driveKwh - seg.baseKwh, note: `平均车速 ${seg.avgSpeed.toFixed(0)} km/h，修正系数 ${seg.factors.speedF.toFixed(2)}` },
    { key: 'temp', label: '　└ 温度修正', kwh: 0, note: `平均气温 ${tempC.toFixed(1)}℃，电池效率系数 ${seg.factors.tempF.toFixed(2)}` },
    { key: 'elev-up', label: '爬坡做功', kwh: seg.uphillKwh, note: `${Math.round(ascentM)}m 累计爬升 × 整车 ${Math.round(seg.totalMass)}kg` },
    { key: 'elev-regen', label: '下坡动能回收', kwh: -seg.regenKwh, note: `${Math.round(descentM)}m 累计下降，回收效率 ${(CAL.regenEff * 100).toFixed(0)}%${seg.regenCapped ? '（已触回收上限）' : ''}` },
    { key: 'hvac', label: '空调', kwh: seg.hvacKwh, note: `平均 ${seg.hvacKw.toFixed(2)} kW × ${durationH.toFixed(1)}h` },
    { key: 'aux', label: '低压附件', kwh: seg.auxKwh, note: `${CAL.auxKw} kW × ${durationH.toFixed(1)}h` },
  ];
  // 温度修正的贡献：driveKwh 里已含 tempF，单独说明其影响量
  const driveNoTemp = seg.driveKwh / (seg.factors.tempF || 1);
  breakdown[2].kwh = seg.driveKwh - driveNoTemp;

  const rests = planRests({ durationH, distanceKm, chargeStops: charging.stops });

  // 推荐出发 SOC（含 5% 余量）
  const needSoc = minArrivalSoc + (seg.totalKwh / spec.battery) * 100;
  const recommendedSocStart = Math.min(100, Math.ceil((needSoc + 5) / 5) * 5);

  // 情景推算：同一辆车在不同条件下的续航区间
  const scenarios = [];
  const mk = (label, t, v, pass, hv) => {
    const s = segmentEnergy({
      spec, distanceKm: 100, durationH: 100 / v, extraMassKg: pass * CAL.passengerKg + luggageKg,
      ascentM: (ascentM / Math.max(distanceKm, 1)) * 100,
      descentM: (descentM / Math.max(distanceKm, 1)) * 100,
      tempC: t, precipMm, windKmh, hvacMode: hv, kReal,
    });
    const r = (spec.battery / s.per100Kwh) * 100;
    scenarios.push({ label, tempC: t, speed: v, passengers: pass, rangeKm: Math.round(r), per100: Number(s.per100Kwh.toFixed(1)) });
  };
  mk('理想工况', 22, 60, 1, 'off');
  mk('常规工况', 15, 80, 2, 'auto');
  mk('高速工况', 10, 110, 2, 'auto');
  mk('严苛工况', -5, 120, 4, 'auto');

  // ---- 风险提示
  const warnings = [];
  if (!charging.needed) {
    if (arrivalSoc < 5) warnings.push({ level: 'danger', text: `预计到达时仅剩 ${arrivalSoc.toFixed(1)}% 电量，几乎无余量（应考虑中途补能）。` });
    else if (arrivalSoc < minArrivalSoc) warnings.push({ level: 'warn', text: `到达电量 ${arrivalSoc.toFixed(1)}% 低于建议的 ${minArrivalSoc}% 安全线，建议中途补一次电，或把车速降下来。` });
  } else {
    if (arrivalSoc < 10) warnings.push({ level: 'warn', text: `按当前补能方案，到达时约剩 ${arrivalSoc.toFixed(1)}%，仍偏紧。建议最后一次充电多充 10%，或全程车速控制在 110km/h 以内。` });
    warnings.push({ level: 'info', text: `不补能的话，这台车在这条路线上会中途断电（缺 ${(seg.totalKwh - (spec.battery * socStart) / 100).toFixed(1)} kWh）。上表已按 ${charging.stops.length} 次补能重算到达电量。` });
  }

  if (tempC <= 0) warnings.push({ level: 'warn', text: `全程平均气温 ${tempC.toFixed(1)}℃，电池处于低温状态：可用容量下降、快充功率受限，出发前建议插枪预热。` });
  else if (tempC >= 35) warnings.push({ level: 'info', text: `高温 ${tempC.toFixed(1)}℃，空调制冷与电池散热都会增加能耗，正午行车注意电池温度。` });

  if (seg.avgSpeed > 110) warnings.push({ level: 'warn', text: `平均车速 ${seg.avgSpeed.toFixed(0)}km/h，风阻主导能耗。车速从 120 降到 100km/h 通常能多跑 8%~12% 的里程。` });

  if (ascentM > 600) warnings.push({ level: 'info', text: `累计爬升 ${Math.round(ascentM)}m，相当于把 ${(seg.totalMass / 1000).toFixed(1)} 吨的整车整体抬高 ${(ascentM / 1000).toFixed(2)}km，爬坡段电耗可达平路的 1.5~2 倍。` });
  if (descentM > 800) warnings.push({ level: 'info', text: `累计下降 ${Math.round(descentM)}m，动能回收可补回约 ${seg.regenKwh.toFixed(1)} kWh（≈ 增加 ${Math.round((seg.regenKwh / spec.battery) * 100)}% 电量）。长下坡请用动能回收档位，避免长时间踩刹车导致热衰减。` });

  if (precipMm >= 5) warnings.push({ level: 'info', text: `沿途有明显降水（峰值 ${precipMm.toFixed(1)}mm/h），湿滑路面滚阻上升且制动距离变长，建议降低车速。` });

  if (maxEle - minEle > 1500) warnings.push({ level: 'warn', text: `海拔落差 ${Math.round(maxEle - minEle)}m，属于典型山区路线。请按「上坡多耗、下坡回收」的两段式心态规划电量。` });

  if (charging.notes.length) {
    for (const n of charging.notes) warnings.push({ level: 'info', text: n });
  }

  return {
    spec,
    input: { distanceKm, durationH, passengers, luggageKg, socStart, tempC, ascentM, descentM, minEle, maxEle, hvacMode },
    seg,
    extraMassKg,
    totalKwh: seg.totalKwh,
    per100Kwh: seg.per100Kwh,
    arrivalSoc,
    arrivalSocNoCharge,
    effectiveRangeKm,
    discount,
    breakdown,
    charging,
    rests,
    recommendedSocStart,
    scenarios,
    warnings,
    direct: charging.stops.length === 0,
  };
}

/** 估算充电总耗时（分钟） */
export function totalChargingMin(charging) {
  if (!charging || !charging.stops) return 0;
  return charging.stops.reduce((s, x) => s + x.chargeMin, 0);
}

/** 人类可读的时长 */
export function fmtDuration(hours) {
  if (!Number.isFinite(hours)) return '—';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h <= 0) return `${m} 分钟`;
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
}
