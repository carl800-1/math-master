import { Router } from 'express';
import db from './db.js';
import { getTextProvider, getVisionProvider, ChatMessage } from './llm.js';
import { hasVisionModel } from './config.js';

const router = Router();

const ANALYZE_SYSTEM = `你是一位资深中小学辅导老师。面对一道题，请完成两件事：
1) 分析这道题的「考点」与「考查意图」；
2) 设计一个能引导孩子自己开口思考的「第一个引导问题」（开放式、不直接给做法、用孩子能懂的语言）。
只做分析与提问，不要给出完整解答。
请严格以 JSON 返回：{"knowledge_points":["考点1","考点2"],"exam_focus":"一句话考查意图","first_question":"第一个引导问题"}。`;

const CHAT_SYSTEM = `你是孩子的辅导老师，用苏格拉底式提问引导孩子自己思考，绝不先给标准答案。
规则：
- 用中文、鼓励的语气，每次只提一个问题或给一个微小提示再追问。
- 根据对话历史，针对孩子最新的回答，提出能推进思考的下一步问题。
- 若孩子明显卡住，先给一个台阶式的小提示，再追问。
- 若孩子已基本想通，给予肯定并让他完整说出做法，最后可简要点明关键。`;

function stripFence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : s.trim();
}

function parseJSON(s: string): any {
  try { return JSON.parse(stripFence(s)); } catch { return null; }
}

// 拍照提取题干：把图片交给视觉模型，返回题目文字
async function extractTextFromImage(imageDataUrl: string): Promise<string> {
  const provider = getVisionProvider();
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '请仔细识别这张图片中的题目文字，只输出题面原文（含题干与选项，如有），不要解释、不要作答。若图片不是题目或无法识别，请输出「[无法识别]」.' },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];
  return provider.complete(messages);
}

/** POST /api/solve/analyze  { text?, image?(dataURL), child_id? } */
router.post('/analyze', async (req, res) => {
  try {
    let text: string = (req.body.text || '').toString().trim();
    const image: string = req.body.image || '';
    const childId = Number(req.body.child_id) || 1;
    let inputType = 'text';
    let extractedText = '';
    let visionNote = '';

    if (image) {
      inputType = 'photo';
      if (hasVisionModel()) {
        try {
          extractedText = await extractTextFromImage(image);
        } catch (e: any) {
          return res.status(502).json({ error: '视觉模型调用失败：' + e.message });
        }
        if (!text) text = extractedText;
      } else {
        // 未配置视觉模型：复用文字，或要求文字录入
        visionNote = '未配置视觉模型，已使用你输入的文字；在 server/config/llm.json 配置 vision 模型后可拍照自动提取题干。';
        if (!text) {
          return res.status(400).json({ error: '未配置视觉模型，请直接输入题目文字，或在 server/config/llm.json 配置 vision 模型。' });
        }
      }
    }

    if (!text) {
      return res.status(400).json({ error: '请提供题目文字或图片' });
    }

    const provider = getTextProvider();
    const messages: ChatMessage[] = [
      { role: 'system', content: ANALYZE_SYSTEM },
      { role: 'user', content: `题目：\n${text}` },
    ];
    let analysis: any;
    try {
      analysis = parseJSON(await provider.complete(messages, { json: true, temperature: 0.4 }));
    } catch (e: any) {
      return res.status(502).json({ error: '文字模型调用失败：' + e.message });
    }
    if (!analysis) {
      return res.status(502).json({ error: '模型返回无法解析（期望 JSON）' });
    }

    const info = db.prepare(
      `INSERT INTO study_records (child_id, question_id, input_type, problem_text, problem_images, analysis, dialogue)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      childId, null, inputType, text,
      JSON.stringify(image ? [image] : []),
      JSON.stringify({ knowledge_points: analysis.knowledge_points, exam_focus: analysis.exam_focus }),
      JSON.stringify([]),
    );
    const sessionId = Number(info.lastInsertRowid);

    res.json({
      session_id: sessionId,
      extracted_text: extractedText,
      knowledge_points: analysis.knowledge_points || [],
      exam_focus: analysis.exam_focus || '',
      first_question: analysis.first_question || '我们先从题目里已知的信息开始想，你能说说这道题要我们求什么吗？',
      ...(visionNote ? { vision_note: visionNote } : {}),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/solve/chat  { session_id, message } */
router.post('/chat', async (req, res) => {
  try {
    const sessionId = Number(req.body.session_id);
    const message = (req.body.message || '').toString().trim();
    if (!sessionId || !message) return res.status(400).json({ error: '缺少 session_id 或 message' });

    const row = db.prepare('SELECT * FROM study_records WHERE id = ?').get(sessionId) as any;
    if (!row) return res.status(404).json({ error: '会话不存在' });

    const dialogue = JSON.parse(row.dialogue || '[]');
    dialogue.push({ role: 'user', content: message });

    const history: ChatMessage[] = [{ role: 'system', content: CHAT_SYSTEM }];
    if (row.problem_text) history.push({ role: 'user', content: `（题目：${row.problem_text}）` });
    for (const m of dialogue) history.push({ role: m.role, content: m.content });

    const provider = getTextProvider();
    const reply = await provider.complete(history, { temperature: 0.6 });
    dialogue.push({ role: 'assistant', content: reply });

    db.prepare('UPDATE study_records SET dialogue = ? WHERE id = ?').run(JSON.stringify(dialogue), sessionId);
    res.json({ reply, dialogue });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/solve/sessions?child_id=1 */
router.get('/sessions', (req, res) => {
  const childId = Number(req.query.child_id) || 1;
  const rows = db.prepare(
    `SELECT id, child_id, input_type, problem_text, analysis, created_at
     FROM study_records WHERE child_id = ? ORDER BY id DESC`,
  ).all(childId);
  res.json(rows);
});

/** POST /api/solve/save-to-wrong  { session_id, wrong_reason? } → 建题 + 登记错题 */
router.post('/save-to-wrong', (req, res) => {
  const sessionId = Number(req.body.session_id);
  const wrongReason = req.body.wrong_reason || '引导解题后仍未掌握';
  if (!sessionId) return res.status(400).json({ error: '缺少 session_id' });

  const row = db.prepare('SELECT * FROM study_records WHERE id = ?').get(sessionId) as any;
  if (!row) return res.status(404).json({ error: '会话不存在' });

  const tx = db.transaction(() => {
    const q = db.prepare(
      `INSERT INTO questions (content, type, knowledge_points, images)
       VALUES (?,?,?,?)`,
    ).run(
      row.problem_text,
      '引导解题',
      (() => { try { return JSON.stringify(JSON.parse(row.analysis).knowledge_points || []); } catch { return '[]'; } })(),
      row.problem_images,
    );
    const w = db.prepare(
      `INSERT INTO wrong_questions (question_id, child_id, wrong_reason, status, mastery)
       VALUES (?,?,?,?,?)`,
    ).run(q.lastInsertRowid, row.child_id, wrongReason, '未掌握', 0);
    db.prepare('UPDATE study_records SET question_id = ? WHERE id = ?').run(q.lastInsertRowid, sessionId);
    return { question_id: q.lastInsertRowid, wrong_id: w.lastInsertRowid };
  });
  res.json(tx());
});

export default router;
