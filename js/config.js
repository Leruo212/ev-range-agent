/**
 * 本地设置：API 地址 / Key / 模型 全部存在浏览器的 localStorage 里，
 * 直接由浏览器发给服务商，中间不经过任何第三方服务器。
 * 没有后端，也就没有「谁的 key 被存到别人机器上」这回事。
 */

const KEY = 'evra.settings.v1';

export const PRESETS = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hint: '国内可直连，便宜，工具调用稳' },
  { label: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', hint: 'OpenAI 兼容模式' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', hint: 'OpenAI 兼容' },
  { label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', hint: 'OpenAI 兼容' },
  { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct', hint: '聚合多模型' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hint: '需要网络条件' },
  { label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b', hint: '无需 Key，模型自带工具调用能力较弱' },
  { label: '自定义中转', baseUrl: '', model: '', hint: '任何 OpenAI 兼容网关' },
];

export const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.3,
  amapKey: '',
  showRaw: false,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    console.warn('设置保存失败（可能是隐私模式）', e);
  }
}

export function clearSettings() {
  localStorage.removeItem(KEY);
}

export function maskKey(k) {
  if (!k) return '未填写';
  if (k.length <= 10) return k[0] + '••••' + k.slice(-2);
  return `${k.slice(0, 6)}••••••${k.slice(-4)}`;
}
