import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ModelConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface LLMConfig {
  text: ModelConfig;   // 文字模型：考点分析、苏格拉底对话
  vision: ModelConfig; // 视觉模型：拍照提取题干（如 GLM-4V / Qwen-VL / GPT-4o）
}

const CONFIG_PATH = join(__dirname, '..', 'config', 'llm.json');

function fromEnv(prefix: 'TEXT' | 'VISION', fallback: Partial<ModelConfig>): ModelConfig {
  return {
    baseURL: process.env[`CUOTI_LLM_${prefix}_BASE_URL`] || fallback.baseURL || '',
    apiKey: process.env[`CUOTI_LLM_${prefix}_API_KEY`] || fallback.apiKey || '',
    model: process.env[`CUOTI_LLM_${prefix}_MODEL`] || fallback.model || '',
  };
}

let cached: LLMConfig | null = null;

export function loadLLMConfig(): LLMConfig {
  if (cached) return cached;
  let file: Partial<LLMConfig> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {
      console.warn('[llm] config/llm.json 解析失败，使用环境变量/默认', e);
    }
  }
  const text = fromEnv('TEXT', file.text || {});
  const vision = fromEnv('VISION', file.vision || {});
  cached = { text, vision };
  return cached;
}

/** 文字模型是否已配置（有 baseURL + apiKey 才走真实 API，否则回落 Mock） */
export function hasTextModel(cfg: LLMConfig = loadLLMConfig()): boolean {
  return Boolean(cfg.text.baseURL && cfg.text.apiKey);
}

/** 视觉模型是否已配置 */
export function hasVisionModel(cfg: LLMConfig = loadLLMConfig()): boolean {
  return Boolean(cfg.vision.baseURL && cfg.vision.apiKey);
}
