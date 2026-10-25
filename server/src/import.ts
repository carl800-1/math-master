import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import db, { dataRoot } from './db.js';
import { getTextProvider, ChatMessage } from './llm.js';

const booksDir = join(dataRoot(), 'books');
mkdirSync(booksDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, booksDir),
  filename: (_req, file, cb) => {
    const ext = (extname(file.originalname) || '.bin').toLowerCase();
    cb(null, `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });
const router = Router();

const SPLIT_SYSTEM = `你是一位题库整理助手。下面是一段教材或练习文本。请从中提取所有题目，每题输出一个对象：
{"content":"题干（含可选项，保留原样）","type":"题型（选择题/填空题/计算题/应用题/解答题等）","knowledge_points":["相关考点"],"difficulty":难度1~5的整数,"answer":"参考答案","explanation":"简要解析"}
只输出一个 JSON 数组，不要任何解释文字，也不要用代码块包裹。若文本里没有题目，返回 []。`;

function stripFence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : s.trim();
}
function parseArr(s: string): any[] {
  try { const j = JSON.parse(stripFence(s)); return Array.isArray(j) ? j : []; } catch { return []; }
}
function safeJson<T = any>(s: string | null): T {
  if (!s) return [] as unknown as T;
  try { return JSON.parse(s); } catch { return [] as unknown as T; }
}

function chunkText(text: string, size = 2400): string[] {
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = '';
  for (const line of lines) {
    buf += line + '\n';
    if (buf.length >= size) { chunks.push(buf); buf = ''; }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [text];
}

async function splitText(text: string): Promise<any[]> {
  const provider = getTextProvider();
  const chunks = chunkText(text);
  const out: any[] = [];
  for (const c of chunks) {
    const msgs: ChatMessage[] = [
      { role: 'system', content: SPLIT_SYSTEM },
      { role: 'user', content: c },
    ];
    let raw = '';
    try { raw = await provider.complete(msgs, { json: false, temperature: 0.3 }); }
    catch (e: any) { console.warn('[import] split failed:', e.message); continue; }
    out.push(...parseArr(raw));
  }
  return out;
}

// 动态引入 pdf-parse，规避其 index.js 的 debug 文件读取副作用
async function extractTextFromPdf(buf: Buffer): Promise<string> {
  // @ts-ignore
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  const fn = mod.default || mod;
  const d = await fn(buf);
  return d?.text || '';
}

async function doImport(
  meta: { title?: string; author?: string; subject?: string; grade?: string },
  rawText: string,
  fileInfo?: { path: string; type: string },
) {
  const info = db.prepare(
    'INSERT INTO books (title, author, subject, grade, source_type, file_path) VALUES (?,?,?,?,?,?)',
  ).run(meta.title || '未命名教材', meta.author || null, meta.subject || null, meta.grade || null, fileInfo?.type || 'text', fileInfo?.path || null);
  const bookId = Number(info.lastInsertRowid);

  const qs = await splitText(rawText);
  const inserted: any[] = [];
  const ins = db.prepare(
    `INSERT INTO questions (book_id, content, type, subject, grade, knowledge_points, difficulty, answer, explanation)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const q of qs) {
    const kps = Array.isArray(q.knowledge_points) ? q.knowledge_points : [];
    const r = ins.run(
      bookId, q.content || '', q.type || '', meta.subject || null, meta.grade || null,
      JSON.stringify(kps), Number(q.difficulty) || 1, q.answer || '', q.explanation || '',
    );
    inserted.push({ id: r.lastInsertRowid, ...q });
  }
  return { book_id: bookId, count: inserted.length, questions: inserted };
}

/** POST /api/import/text  { title, author, subject, grade, text } */
router.post('/text', async (req, res) => {
  try {
    const { title, author, subject, grade, text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: '请提供文本' });
    const r = await doImport({ title, author, subject, grade }, text);
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** POST /api/import/file  multipart: file(pdf|txt) + title/author/subject/grade */
router.post('/file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const meta = req.body || {};
    let raw = '';
    const ext = extname(req.file.originalname).toLowerCase();
    if (ext === '.pdf') {
      try { raw = await extractTextFromPdf(readFileSync(req.file.path)); }
      catch (e: any) { return res.status(502).json({ error: 'PDF 解析失败：' + e.message }); }
    } else {
      raw = readFileSync(req.file.path, 'utf-8');
    }
    if (!raw.trim()) {
      return res.status(400).json({ error: '未能从文件中提取到文本（可能是扫描版图片 PDF，需配置视觉模型后处理）' });
    }
    const r = await doImport(meta, raw, { path: req.file.path, type: ext === '.pdf' ? 'pdf' : 'text' });
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
