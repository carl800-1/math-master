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
        knowledge_points: ['待标注'],
        difficulty: 2,
        answer: '（待补充）',
        explanation: '（导入示例，建议在题库中补充标准答案与解析）',
      }));
      return JSON.stringify(qs);
    }

    if (opts.json) {
      // 命中考点分析场景
      return JSON.stringify({
        knowledge_points: ['分数加减法', '通分', '异分母运算'],
        exam_focus: '考查异分母分数加法的通分能力与运算准确性，属于小学分数运算核心考点。',
        first_question:
          '这道题里两个分数分母不一样，要先把它们变成「分母相同」才能相加。你能想到用什么办法让它们的分母变得一样吗？',
      });
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
