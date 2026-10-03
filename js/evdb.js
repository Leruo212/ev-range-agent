/**
 * 车型数据库
 * ---------------------------------------------------------------
 * 字段说明：
 *   battery  可用电量 kWh（不是总电量，已扣除厂商预留的上下限缓冲）
 *   range    官方 CLTC 续航 km
 *   mass     整备质量 kg
 *   dc       直流快充峰值功率 kW（用于估算补能时间）
 *   ac       交流慢充功率 kW
 *   platform 整车平台（可选）。蔚来/乐道用这个区分 NT2.0 / NT2.5 / NT3.0 ——
 *            它直接决定 400V 还是 900V、快充天花板是 125kW 还是 600kW
 *   swap     支持换电（可选）。蔚来/乐道为 true，约 3 分钟换一块满电电池。
 *            长途补能策略和纯充电车型完全不同，会在补能建议里单独提示
 *
 * 数据来源：各厂商官网 / 工信部申报信息 / 易车参数页，2024–2026 款为主。
 * 这些是「参考值」而不是权威值——同一款车不同年款、不同轮圈、不同座椅布局
 * 的续航能差 10% 以上，界面上允许用户手动覆盖电池容量与官方续航。
 *
 * 电量口径（重要）：battery 记的是**可用电量**而不是标称容量。
 *   · 蔚来/乐道 100 kWh 包按 ~92% 可用折算 → 记 92
 *   · 蔚来/乐道 102 kWh 包按 ~92% 可用折算 → 记 94
 *   · 75 kWh 包 → 记 70.5
 * 这样反推出来的百公里电耗才和官方口径对得上。（工信部申报电耗含充电损耗，
 * 比电池端电耗高约 10%，两者别混用。）
 *
 * 注意：CLTC 是实验室循环，真实道路普遍打 8 折上下，
 * 高速 + 低温 + 满载叠加时打 5 折也不稀奇。模型里 kReal 就是干这个的。
 */

export const EV_DB = [
  // ---------- 特斯拉 ----------
  { id: 'tesla-m3-rwd', brand: '特斯拉', model: 'Model 3 后轮驱动版', year: 2024, battery: 60.0, range: 606, mass: 1760, dc: 170, ac: 11 },
  { id: 'tesla-m3-lr', brand: '特斯拉', model: 'Model 3 长续航全轮驱动版', year: 2024, battery: 78.4, range: 713, mass: 1834, dc: 250, ac: 11 },
  { id: 'tesla-my-rwd', brand: '特斯拉', model: 'Model Y 后轮驱动版', year: 2025, battery: 62.5, range: 593, mass: 1921, dc: 170, ac: 11 },
  { id: 'tesla-my-lr', brand: '特斯拉', model: 'Model Y 长续航全轮驱动版', year: 2025, battery: 78.4, range: 719, mass: 1997, dc: 250, ac: 11 },
  { id: 'tesla-ms', brand: '特斯拉', model: 'Model S 双电机全轮驱动版', year: 2024, battery: 95.0, range: 715, mass: 2069, dc: 250, ac: 11 },

  // ---------- 比亚迪 ----------
  { id: 'byd-seagull', brand: '比亚迪', model: '海鸥 405km 飞翔版', year: 2025, battery: 38.9, range: 405, mass: 1260, dc: 40, ac: 6.6 },
  { id: 'byd-dolphin', brand: '比亚迪', model: '海豚 420km 骑士版', year: 2025, battery: 44.9, range: 420, mass: 1435, dc: 60, ac: 7 },
  { id: 'byd-yuan-plus', brand: '比亚迪', model: '元PLUS 510km 超越型', year: 2025, battery: 60.5, range: 510, mass: 1690, dc: 80, ac: 7 },
  { id: 'byd-qin-plus', brand: '比亚迪', model: '秦PLUS EV 510km 卓越型', year: 2025, battery: 57.6, range: 510, mass: 1680, dc: 90, ac: 7 },
  { id: 'byd-song-plus', brand: '比亚迪', model: '宋PLUS EV 520km 旗舰型', year: 2025, battery: 71.7, range: 520, mass: 1950, dc: 90, ac: 7 },
  { id: 'byd-han-ev', brand: '比亚迪', model: '汉EV 715km 四驱旗舰', year: 2025, battery: 85.4, range: 715, mass: 2020, dc: 120, ac: 7 },
  { id: 'byd-seal', brand: '比亚迪', model: '海豹 700km 四驱性能版', year: 2025, battery: 82.5, range: 700, mass: 2055, dc: 150, ac: 7 },
  { id: 'byd-tang-ev', brand: '比亚迪', model: '唐EV 730km 四驱版', year: 2025, battery: 108.8, range: 730, mass: 2630, dc: 170, ac: 7 },

  // ---------- 蔚来 ----------
  // NT2.0 / NT2.5 = 400V 架构，快充天花板约 125~200kW
  // NT3.0 = 900V 架构（最高 925V / 765A），峰值 600kW，5C
  { id: 'nio-et5-75', brand: '蔚来', model: 'ET5 75kWh', year: 2025, battery: 70.5, range: 560, mass: 2165, dc: 140, ac: 11, platform: 'NT2.5', swap: true },
  { id: 'nio-es6-75', brand: '蔚来', model: 'ES6 75kWh', year: 2025, battery: 70.5, range: 490, mass: 2345, dc: 140, ac: 11, platform: 'NT2.5', swap: true },
  { id: 'nio-et5-100', brand: '蔚来', model: 'ET5 100kWh', year: 2025, battery: 92.0, range: 710, mass: 2210, dc: 180, ac: 11, platform: 'NT2.5', swap: true },
  // ET7 注意：**不在 NT3.0 平台**。截至 2026-10 仍是 NT2.0（400V），
  // 李斌已明确 2026 年 ET7/EC7 无换代计划，只做过座舱（8295P）与座椅升级。
  // 官方配置器口径：100kWh + 21 英寸轮圈 = CLTC 665km。
  { id: 'nio-et7-100', brand: '蔚来', model: 'ET7 100kWh 行政版', year: 2026, battery: 92.0, range: 665, mass: 2379, dc: 125, ac: 11, platform: 'NT2.0', swap: true },
  // ---- 以下三款才是 NT3.0（900V、峰值 600kW、与 ET9 通用电池包）----
  { id: 'nio-et9', brand: '蔚来', model: 'ET9 102kWh', year: 2026, battery: 94.0, range: 650, mass: 2700, dc: 600, ac: 11, platform: 'NT3.0', swap: true },
  { id: 'nio-es8-nt3', brand: '蔚来', model: 'ES8 第三代 102kWh 六座', year: 2026, battery: 94.0, range: 635, mass: 2630, dc: 600, ac: 11, platform: 'NT3.0', swap: true },
  { id: 'nio-es9', brand: '蔚来', model: 'ES9 102kWh 行政豪华版', year: 2026, battery: 94.0, range: 620, mass: 2845, dc: 600, ac: 11, platform: 'NT3.0', swap: true },

  // ---------- 乐道（蔚来子品牌，同属 NT3.0 换电体系）----------
  { id: 'onvo-l60', brand: '乐道', model: 'L60 60kWh', year: 2025, battery: 60.0, range: 555, mass: 1955, dc: 180, ac: 11, platform: 'NT3.0', swap: true },
  // L90 直流峰值按官方「快充 10–80% 约 25 分钟」反推（85kWh × 70% / 25min ≈ 143kW 平均）
  { id: 'onvo-l90-rwd', brand: '乐道', model: 'L90 85kWh 后驱六座', year: 2026, battery: 85.0, range: 600, mass: 2300, dc: 200, ac: 11, platform: 'NT3.0', swap: true },
  { id: 'onvo-l90-awd', brand: '乐道', model: 'L90 85kWh 四驱六座', year: 2026, battery: 85.0, range: 570, mass: 2360, dc: 200, ac: 11, platform: 'NT3.0', swap: true },

  // ---------- 其他新势力 ----------
  { id: 'xpeng-p7i', brand: '小鹏', model: 'P7i 702 Max', year: 2025, battery: 86.2, range: 702, mass: 2010, dc: 175, ac: 11 },
  { id: 'xpeng-g6', brand: '小鹏', model: 'G6 580 长续航 Max', year: 2025, battery: 66.0, range: 580, mass: 1995, dc: 280, ac: 11 },
  { id: 'xpeng-g9', brand: '小鹏', model: 'G9 702 Max', year: 2025, battery: 93.1, range: 702, mass: 2250, dc: 315, ac: 11 },
  { id: 'xpeng-mona03', brand: '小鹏', model: 'MONA M03 620 超长续航', year: 2025, battery: 62.2, range: 620, mass: 1739, dc: 96, ac: 6.6 },
  { id: 'li-mega', brand: '理想', model: 'MEGA Ultra', year: 2025, battery: 102.7, range: 710, mass: 2765, dc: 520, ac: 11 },
  { id: 'li-i8', brand: '理想', model: 'i8 Max', year: 2025, battery: 97.8, range: 720, mass: 2610, dc: 400, ac: 11 },
  { id: 'aito-m5', brand: '问界', model: 'M5 纯电 Max', year: 2025, battery: 80.0, range: 602, mass: 2235, dc: 100, ac: 11 },
  { id: 'zeekr-001', brand: '极氪', model: '001 WE 86kWh', year: 2025, battery: 86.0, range: 741, mass: 2200, dc: 360, ac: 11 },
  { id: 'zeekr-007', brand: '极氪', model: '007 后驱智驾版', year: 2025, battery: 75.0, range: 688, mass: 1910, dc: 340, ac: 11 },
  { id: 'xiaomi-su7-std', brand: '小米', model: 'SU7 标准版', year: 2025, battery: 73.6, range: 700, mass: 1980, dc: 130, ac: 11 },
  { id: 'xiaomi-su7-pro', brand: '小米', model: 'SU7 Pro', year: 2025, battery: 94.3, range: 830, mass: 2010, dc: 165, ac: 11 },
  { id: 'xiaomi-su7-max', brand: '小米', model: 'SU7 Max', year: 2025, battery: 101.0, range: 800, mass: 2205, dc: 480, ac: 11 },
  { id: 'xiaomi-yu7', brand: '小米', model: 'YU7 Max', year: 2025, battery: 101.7, range: 760, mass: 2450, dc: 400, ac: 11 },

  // ---------- 传统车企 ----------
  { id: 'gac-aion-s', brand: '广汽埃安', model: 'AION S Plus 610km', year: 2025, battery: 69.9, range: 610, mass: 1740, dc: 90, ac: 7 },
  { id: 'gac-aion-y', brand: '广汽埃安', model: 'AION Y Plus 610km', year: 2025, battery: 76.8, range: 610, mass: 1850, dc: 100, ac: 7 },
  { id: 'vw-id3', brand: '大众', model: 'ID.3 450km', year: 2025, battery: 57.3, range: 450, mass: 1790, dc: 100, ac: 11 },
  { id: 'vw-id4', brand: '大众', model: 'ID.4 CROZZ 605km', year: 2025, battery: 84.8, range: 605, mass: 2020, dc: 100, ac: 11 },
  { id: 'bmw-i3', brand: '宝马', model: 'i3 eDrive35L', year: 2025, battery: 70.3, range: 526, mass: 1975, dc: 100, ac: 11 },
  { id: 'benz-eqe', brand: '奔驰', model: 'EQE 350 先型特别版', year: 2025, battery: 96.1, range: 717, mass: 2330, dc: 170, ac: 11 },
  { id: 'audi-q4', brand: '奥迪', model: 'Q4 e-tron 50 quattro', year: 2025, battery: 84.8, range: 605, mass: 2160, dc: 125, ac: 11 },
  { id: 'wuling-bingo', brand: '五菱', model: '缤果 333km 灵犀尊享版', year: 2025, battery: 37.9, range: 333, mass: 1250, dc: 50, ac: 6.6 },
  { id: 'wuling-mini', brand: '五菱', model: '宏光MINIEV 300km', year: 2025, battery: 26.5, range: 300, mass: 850, dc: 30, ac: 3.3 },
  { id: 'leapmotor-c11', brand: '零跑', model: 'C11 610 智享版', year: 2025, battery: 78.5, range: 610, mass: 2140, dc: 100, ac: 7 },
  { id: 'changan-sl03', brand: '深蓝', model: 'SL03 705 纯电版', year: 2025, battery: 79.97, range: 705, mass: 1900, dc: 100, ac: 7 },
  { id: 'im-ls6', brand: '智己', model: 'LS6 760 后驱版', year: 2025, battery: 100.0, range: 760, mass: 2310, dc: 396, ac: 11 },
  { id: 'arcfox-as', brand: '极狐', model: '阿尔法S 708 森林版', year: 2025, battery: 93.6, range: 708, mass: 2080, dc: 150, ac: 11 },
  { id: 'denza-d9', brand: '腾势', model: 'D9 EV 600 尊享型', year: 2025, battery: 103.0, range: 600, mass: 2895, dc: 166, ac: 11 },
  { id: 'lucid-air', brand: '其他', model: 'Lucid Air Grand Touring', year: 2025, battery: 112.0, range: 830, mass: 2360, dc: 300, ac: 19 },
];

/** 车型库里的品牌列表（用于界面分组） */
export const EV_BRANDS = [...new Set(EV_DB.map((c) => c.brand))];

/** 精确 id 查询 */
export function getCarById(id) {
  return EV_DB.find((c) => c.id === id) || null;
}

/** 模糊搜索：支持「小米 SU7」「su7」「model 3」，也支持按平台/换电找车（「NT3.0」「换电」） */
export function searchCars(query, limit = 12) {
  if (!query) return EV_DB.slice(0, limit);
  const q = String(query).toLowerCase().replace(/\s+/g, '');
  const scored = [];
  for (const car of EV_DB) {
    // 把平台和「换电」也纳入可搜索文本 —— 用户的真实问法是「NT3.0 平台有哪些车」
    const full = `${car.brand} ${car.model} ${car.platform || ''} ${car.swap ? '换电' : ''}`;
    const flat = full.toLowerCase().replace(/\s+/g, '');
    let score = 0;
    if (flat === q) score = 100;
    else if (flat.startsWith(q)) score = 80;
    else if (flat.includes(q)) score = 60;
    else {
      // 逐字包含，容忍「小米su7max」这种全挤压输入
      let i = 0;
      for (const ch of q) {
        const at = flat.indexOf(ch, i);
        if (at === -1) { i = -999; break; }
        i = at + 1;
      }
      if (i > -900) score = 30;
      // 平台/换电是"分类"而不是"名字"，命中给一点额外权重，免得被一堆弱命中淹没
      if (score && car.platform && car.platform.toLowerCase().includes(q)) score += 25;
      if (score && car.swap && q.includes('换电')) score += 25;
    }
    if (score > 0) scored.push({ car, score });
  }
  scored.sort((a, b) => b.score - a.score || a.car.mass - b.car.mass);
  return scored.slice(0, limit).map((s) => s.car);
}

/** 把车型对象转成模型需要的规格（带默认兜底） */
export function toSpec(car) {
  if (!car) return null;
  const battery = Number(car.battery) || 60;
  const range = Number(car.range) || 500;
  return {
    id: car.id,
    name: `${car.brand ? car.brand + ' ' : ''}${car.model}`,
    battery,
    range,
    mass: Number(car.mass) || 1800,
    dc: Number(car.dc) || 100,
    ac: Number(car.ac) || 7,
    platform: car.platform || null,
    swap: !!car.swap,
    // 官方百公里电耗（CLTC 口径）
    ratedPer100: (battery / range) * 100,
  };
}

/** 自定义车型（用户手填） */
export function customSpec({ name, battery, range, mass, dc, ac, swap }) {
  const b = Number(battery) || 60;
  const r = Number(range) || 500;
  return {
    id: 'custom',
    name: name || '自定义车型',
    battery: b,
    range: r,
    mass: Number(mass) || 1800,
    dc: Number(dc) || 100,
    ac: Number(ac) || 7,
    platform: null,
    swap: !!swap,
    ratedPer100: (b / r) * 100,
  };
}
