import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from './db.js';
import solveRouter from './solve.js';
import importRouter from './import.js';
import practiceRouter from './practice.js';
import { llmStatus } from './llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', '..', 'data');
const uploadDir = join(dataDir, 'uploads');
mkdirSync(uploadDir, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// 图片上传（错题照片 / 答卷照片） → 存 data/uploads，返回 /uploads/xxx
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  res.json({ url: `/uploads/${req.file.filename}` });
});
app.use('/uploads', express.static(uploadDir));

// 当前 LLM 配置状态（不暴露 key）
app.get('/api/llm/status', (_req, res) => res.json(llmStatus()));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- children ----------
app.get('/api/children', (_req, res) => {
  res.json(db.prepare('SELECT * FROM children ORDER BY id DESC').all());
});
app.post('/api/children', (req, res) => {
  const { name, grade, avatar, subject_focus } = req.body;
  const info = db
    .prepare('INSERT INTO children (name, grade, avatar, subject_focus) VALUES (?,?,?,?)')
    .run(name, grade, avatar, subject_focus);
  res.json({ id: info.lastInsertRowid });
});

// ---------- books ----------
app.get('/api/books', (_req, res) => {
  res.json(db.prepare('SELECT * FROM books ORDER BY id DESC').all());
});
app.post('/api/books', (req, res) => {
  const { title, author, subject, grade, source_type, file_path } = req.body;
  const info = db
    .prepare('INSERT INTO books (title, author, subject, grade, source_type, file_path) VALUES (?,?,?,?,?,?)')
    .run(title, author, subject, grade, source_type, file_path);
  res.json({ id: info.lastInsertRowid });
});

// ---------- questions ----------
app.get('/api/questions', (_req, res) => {
  res.json(db.prepare('SELECT * FROM questions ORDER BY id DESC').all());
});
app.post('/api/questions', (req, res) => {
  const {
    book_id, content, type, subject, grade,
    knowledge_points, difficulty, answer, explanation, images, source_page,
  } = req.body;
  const info = db
    .prepare(`INSERT INTO questions
      (book_id, content, type, subject, grade, knowledge_points, difficulty, answer, explanation, images, source_page)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      book_id ?? null, content, type, subject, grade,
      JSON.stringify(knowledge_points ?? []), difficulty, answer, explanation,
      JSON.stringify(images ?? []), source_page,
    );
  res.json({ id: info.lastInsertRowid });
});

// ---------- wrong_questions ----------
app.get('/api/wrong', (req, res) => {
  const childId = req.query.child_id;
  const rows = childId
    ? db.prepare(`SELECT w.*, q.content, q.type, q.knowledge_points, q.difficulty, q.answer, q.explanation, q.images, b.title AS book_title
                  FROM wrong_questions w
                  JOIN questions q ON w.question_id = q.id
                  LEFT JOIN books b ON q.book_id = b.id
                  WHERE w.child_id = ? ORDER BY w.id DESC`).all(childId)
    : db.prepare(`SELECT w.*, q.content, q.type, q.knowledge_points, q.images
                  FROM wrong_questions w JOIN questions q ON w.question_id = q.id
                  ORDER BY w.id DESC`).all();
  res.json(rows);
});
app.post('/api/wrong', (req, res) => {
  const { question_id, child_id, wrong_reason, status, mastery } = req.body;
  const info = db
    .prepare('INSERT INTO wrong_questions (question_id, child_id, wrong_reason, status, mastery) VALUES (?,?,?,?,?)')
    .run(question_id, child_id, wrong_reason, status ?? '未掌握', mastery ?? 0);
  res.json({ id: info.lastInsertRowid });
});
app.patch('/api/wrong/:id', (req, res) => {
  const id = Number(req.params.id);
  const { status, mastery, wrong_reason } = req.body;
  const sets: string[] = [];
  const vals: any[] = [];
  if (status !== undefined) { sets.push('status = ?'); vals.push(status); }
  if (mastery !== undefined) { sets.push('mastery = ?'); vals.push(mastery); }
  if (wrong_reason !== undefined) { sets.push('wrong_reason = ?'); vals.push(wrong_reason); }
  if (sets.length === 0) return res.json({ ok: true });
  sets.push("last_reviewed_at = datetime('now')");
  db.prepare(`UPDATE wrong_questions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  res.json({ ok: true });
});

app.use('/api/solve', solveRouter);
app.use('/api/import', importRouter);
app.use('/api', practiceRouter);

// SPA 兜底：必须放在所有 /api 路由之后，否则会拦截 GET /api/* 请求
// 生产/Docker：前端在 /server/public（编译后 __dirname=/server/dist，故取上一级）
// 开发态(tsx)：回退到 web/dist
const staticCandidates = [
  join(__dirname, '..', 'public'),                  // 生产编译态 / Docker：/server/public
  join(__dirname, 'public'),
  join(process.cwd(), 'public'),
  join(__dirname, '..', '..', 'web', 'dist'),       // 开发态 tsx
];
const staticDir = staticCandidates.find((p) => existsSync(p));
if (staticDir) {
  app.use(express.static(staticDir));
  app.get('*', (_req, res) => res.sendFile(join(staticDir, 'index.html')));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`cuoti server listening on :${PORT}`));
