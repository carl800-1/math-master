import { loadLLMConfig, hasTextModel, hasVisionModel, ModelConfig } from './config.js';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface CompleteOpts {
  json?: boolean;       // 要求模型返回 JSON（若服务商支持 response_format）
  temperature?: number;
  max_tokens?: number;
}

export interface LLMProvider {
  readonly id: string;
  complete(messages: ChatMessage[], opts?: CompleteOpts): Promise<string>;
}

/** OpenAI 兼容实现（覆盖 DeepSeek / OpenAI / 通义 / 智谱 / 本地 Ollama 等） */
class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  constructor(private cfg: ModelConfig, id: string) {
    this.id = id;
  }

  async complete(messages: ChatMessage[], opts: CompleteOpts = {}): Promise<string> {
    const body: any = {
      model: this.cfg.model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.max_tokens ?? 1024,
    };
    if (opts.json) body.response_format = { type: 'json_object' };

    const res = await fetch(`${this.cfg.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`LLM ${this.id} 调用失败 ${res.status}: ${txt.slice(0, 300)}`);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() ?? '';
  }
}

/** 演示模式下的启发式考点推断（仅用于无 key 演示；真实部署由 LLM 打标） */
function inferKps(text: string): string[] {
  const t = text || '';
  const kps: string[] = [];
  if (/方程/.test(t)) kps.push('一元一次方程', '方程求解');
  if (/(分数|\/|通分|分母|约分)/.test(t)) kps.push('分数运算', '通分');
  if (/(计算|加减|乘除|四则)/.test(t)) kps.push('四则运算');
  if (/(面积|周长|长方形|正方形|圆|图形|三角形)/.test(t)) kps.push('图形与几何');
  if (/(百分数|百分比|%|折扣)/.test(t)) kps.push('百分数应用');
  if (/(比例|比)/.test(t)) kps.push('比和比例');
  if (/(行程|工程|鸡兔|相遇|追及)/.test(t)) kps.push('应用题');
  if (kps.length === 0) kps.push('基础运算');
  return [...new Set(kps)];
}

/** 未配置 key 时使用的演示 Provider，保证全流程可跑通、可验收 */
class MockProvider implements LLMProvider {
  readonly id = 'mock';

  async complete(messages: ChatMessage[], opts: CompleteOpts = {}): Promise<string> {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
    const sysMsg = messages.find(m => m.role === 'system' && typeof m.content === 'string') as
      | { content: string }
      | undefined;
    const systemText = sysMsg ? sysMsg.content : '';
    await new Promise(r => setTimeout(r, 250)); // 模拟网络延迟

    // 命中「教材拆题」场景：把文本按行拆成若干题目，便于无 key 演示
    if (systemText.includes('题库整理助手')) {
      const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 5);
      const qs = (lines.length ? lines : [text.slice(0, 60)]).map((line, i) => ({
        content: line,
        type: i % 2 === 0 ? '选择题' : '填空题',
        knowledge_points: inferKps(line),
        difficulty: 2,
        answer: '（待补充）',
        explanation: '（导入示例，建议在题库中补充标准答案与解析）',
      }));
      return JSON.stringify(qs);
    }

    if (opts.json) {
      // 命中考点分析场景
      const kps = inferKps(text);
      const focus = `考查${kps.slice(0, 2).join('、')}等考点，建议先引导孩子理解题意、梳理已知条件再动手。`;
      const firstQ = /方程/.test(text)
        ? '这是一道方程题，目标就是把 x 单独留在一边。你先想想：第一步可以先把哪个数移到等号另一边？'
        : /(分数|\/|通分|分母)/.test(text)
        ? '这两个分数的分母不同，要先让它们「单位」一致才能运算。你能想到用什么办法吗？'
        : '先别急着算，我们一起把题目里的已知信息和要求理一理。你能说说这道题想让我们求什么吗？';
      return JSON.stringify({ knowledge_points: kps, exam_focus: focus, first_question: firstQ });
    }

    // 苏格拉底续问：根据孩子最新回复给一个推进式追问 / 提示
    if (/不会|卡住|不懂|想不出|help/i.test(text)) {
      return '没关系，我们一步一步来。你已经知道这是分数加法对吧？那先告诉我：要把 1/2 和 1/3 加起来，能不能直接把分子分母分别相加？为什么不行？';
    }
    if (/通分|公分母|变成一样|相同分母/i.test(text)) {
      return '很好，你说到点子上了！那 2 和 3 的最小公倍数是几？找到它之后，1/2 和 1/3 分别要变成以它为分母的什么分数？';
    }
    return '嗯，继续想想看～ 你刚才说的这一步，是为了让两个分数「单位」一样。那接下来该怎么做才能得到最后的答案呢？把你的想法告诉我。';
  }
}

let textProvider: LLMProvider | null = null;
let visionProvider: LLMProvider | null = null;

export function getTextProvider(): LLMProvider {
  if (textProvider) return textProvider;
  const cfg = loadLLMConfig();
  textProvider = hasTextModel(cfg)
    ? new OpenAICompatibleProvider(cfg.text, `text:${cfg.text.model}`)
    : new MockProvider();
  return textProvider;
}

export function getVisionProvider(): LLMProvider {
  if (visionProvider) return visionProvider;
  const cfg = loadLLMConfig();
  // 未单独配视觉模型时，若文字模型支持多模态（如 GPT-4o / Qwen-VL）可复用
  visionProvider = hasVisionModel(cfg)
    ? new OpenAICompatibleProvider(cfg.vision, `vision:${cfg.vision.model}`)
    : hasTextModel(cfg)
    ? new OpenAICompatibleProvider(cfg.text, `text(as-vision):${cfg.text.model}`)
    : new MockProvider();
  return visionProvider;
}

export function llmStatus() {
  const cfg = loadLLMConfig();
  return {
    text: hasTextModel(cfg) ? cfg.text.model : 'mock',
    vision: hasVisionModel(cfg) ? cfg.vision.model : hasTextModel(cfg) ? `${cfg.text.model}(复用)` : 'mock',
  };
}
