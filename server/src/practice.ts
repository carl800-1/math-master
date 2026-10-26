import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import db, { dataRoot } from './db.js';
import { getTextProvider, getVisionProvider, ChatMessage } from './llm.js';
import { hasVisionModel, hasTextModel } from './config.js';

const uploadDir = join(dataRoot(), 'uploads');
mkdirSync(uploadDir, { recursive: true });

const subUpload = multer({ storage: multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    cb(null, `ans-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  },
}), limits: { fileSize: 20 * 1024 * 1024 } });

const router = Router();

function safeJson<T = any>(s: string | null): T {
  if (!s) return [] as unknown as T;
  try { return JSON.parse(s); } catch { return [] as unknown as T; }
}

/* ============ 跨书相似题推荐 ============ */

function weakProfile(childId: number) {
  const rows = db.prepare(
    `SELECT q.id, q.book_id, q.knowledge_points
     FROM wrong_questions w JOIN questions q ON w.question_id = q.id
     WHERE w.child_id = ? AND w.status <> '已掌握'`,
  ).all(childId) as any[];
  const kps = new Map<string, number>();
  for (const r of rows) {
    for (const k of safeJson<string[]>(r.knowledge_points)) kps.set(k, (kps.get(k) || 0) + 1);
  }
  return { kps, rows };
}

/** POST /api/recommend  { child_id, limit } → 生成并持久化推荐 */
router.post('/recommend', (req, res) => {
  const childId = Number(req.body.child_id) || 1;
  const limit = Number(req.body.limit) || 5;
  const { kps, rows } = weakProfile(childId);
  if (kps.size === 0) return res.json({ weak_kps: [], recommendations: [] });

  const wrongIds = new Set(rows.map(r => r.id));
  const candidates = db.prepare(
    `SELECT id, book_id, content, knowledge_points, type, difficulty
     FROM questions
     WHERE id NOT IN (SELECT question_id FROM wrong_questions WHERE child_id = ?)`,
  ).all(childId) as any[];

  let scored = candidates.map(c => {
    const ckps = safeJson<string[]>(c.knowledge_points);
    let overlap = 0;
    for (const k of ckps) if (kps.has(k)) overlap++;
    let crossBook = false;
    for (const r of rows) { if (r.book_id && r.book_id !== c.book_id) { crossBook = true; break; } }
    const score = overlap * 10 + (crossBook ? 5 : 0) + (c.difficulty || 1) * 0.1;
    return { c, overlap, score };
  }).filter(x => x.overlap > 0)
    .sort((a, b) => b.score - a.score);

  // 兜底：若错题已覆盖所有「同考点」候选（无重叠），则推荐其他教材的未做题作为拓展练习，
  // 保证只要有未做过的题，推荐功能就不会返回空（避免体验死胡同）。
  if (scored.length === 0) {
    scored = candidates.map(c => {
      let crossBook = false;
      for (const r of rows) { if (r.book_id && r.book_id !== c.book_id) { crossBook = true; break; } }
      return { c, overlap: 0, score: (crossBook ? 5 : 1) + (c.difficulty || 1) * 0.1 };
    }).sort((a, b) => b.score - a.score);
  }
  scored = scored.slice(0, limit);

  const out: any[] = [];
  const ins = db.prepare(
    'INSERT INTO recommendations (child_id, based_on_wrong_qid, recommended_qid, reason) VALUES (?,?,?,?)',
  );
  const existing = new Set(
    (db.prepare('SELECT recommended_qid FROM recommendations WHERE child_id = ? AND status = \'pending\'').all(childId) as any[])
      .map(x => x.recommended_qid),
  );
  for (const x of scored) {
    if (existing.has(x.c.id)) continue;
    const based = rows.find(r => {
      const rk = safeJson<string[]>(r.knowledge_points);
      const ck = safeJson<string[]>(x.c.knowledge_points);
      return ck.some(k => rk.includes(k));
    });
    const reasonKps = safeJson<string[]>(x.c.knowledge_points).slice(0, 2).join('、');
    const reason = x.overlap > 0
      ? `针对你常错的考点：${reasonKps}`
      : `拓展练习（其他教材），巩固基础`;
    const r = ins.run(childId, based ? based.id : null, x.c.id, reason);
    out.push({ id: r.lastInsertRowid, question: x.c, reason, status: 'pending' });
  }
  // 没有新生成的推荐时（候选都已推荐过），回退返回已有的「待练习」推荐，
  // 保证前端重复点击「生成推荐」不会看到空白列表（接口幂等）。
  if (out.length === 0) {
    const exist = db.prepare(
      `SELECT r.id AS rid, r.reason, r.status, q.id AS qid, q.content, q.type, q.knowledge_points, q.difficulty
       FROM recommendations r JOIN questions q ON r.recommended_qid = q.id
       WHERE r.child_id = ? AND r.status = 'pending' ORDER BY r.id DESC`,
    ).all(childId) as any[];
    for (const r of exist) {
      out.push({
        id: r.rid,
        question: { id: r.qid, content: r.content, type: r.type, knowledge_points: r.knowledge_points, difficulty: r.difficulty },
        reason: r.reason,
        status: r.status,
      });
    }
  }
  const weakKps = [...kps.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  res.json({ weak_kps: weakKps, recommendations: out });
});

/** GET /api/recommendations?child_id=1 —— 返回结构与 POST /recommend 保持一致（嵌套 question），供前端直接渲染 */
router.get('/recommendations', (req, res) => {
  const childId = Number(req.query.child_id) || 1;
  const rows = db.prepare(
    `SELECT r.*, q.content, q.type, q.knowledge_points, q.difficulty, q.answer, b.title AS book_title
     FROM recommendations r
     JOIN questions q ON r.recommended_qid = q.id
     LEFT JOIN books b ON q.book_id = b.id
     WHERE r.child_id = ? ORDER BY r.id DESC`,
  ).all(childId) as any[];
  const out = rows.map(r => ({
    id: r.id,
    based_on_wrong_qid: r.based_on_wrong_qid,
    recommended_qid: r.recommended_qid,
    reason: r.reason,
    status: r.status,
    book_title: r.book_title,
    question: {
      id: r.recommended_qid,
      content: r.content,
      type: r.type,
      knowledge_points: r.knowledge_points,
      difficulty: r.difficulty,
      answer: r.answer,
    },
  }));
  res.json(out);
});

/** PATCH /api/recommendations/:id  { status } */
router.patch('/recommendations/:id', (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body;
  if (!['pending', 'done', 'skipped'].includes(status)) return res.status(400).json({ error: '非法状态' });
  db.prepare('UPDATE recommendations SET status = ? WHERE id = ?').run(status, id);
  res.json({ ok: true });
});

/* ============ 组卷 + 打印 + 批改 ============ */

/** POST /api/exams/generate  { child_id, title?, count? } */
router.post('/exams/generate', (req, res) => {
  const childId = Number(req.body.child_id) || 1;
  const count = Number(req.body.count) || 10;
  const title = req.body.title || `针对性练习卷 ${new Date().toLocaleDateString('zh-CN')}`;

  const recs = db.prepare('SELECT recommended_qid FROM recommendations WHERE child_id = ? AND status = \'pending\'').all(childId) as any[];
  const weaks = db.prepare('SELECT question_id FROM wrong_questions WHERE child_id = ? AND status <> \'已掌握\'').all(childId) as any[];
  const gen = db.prepare('SELECT id FROM questions ORDER BY RANDOM() LIMIT ?').all(Math.max(0, count)) as any[];

  const idset = new Set<number>();
  const pool: number[] = [];
  const push = (id?: number) => { if (id && !idset.has(id)) { idset.add(id); pool.push(id); } };
  for (const r of [...recs, ...weaks]) push(r.recommended_qid || r.question_id);
  for (const g of gen) push(g.id);

  const ids = pool.slice(0, count);
  const snap = ids.length
    ? db.prepare(
        `SELECT id, content, type, knowledge_points, difficulty, answer, explanation
         FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`,
      ).all(...ids) as any[]
    : [];
  const info = db.prepare(
    'INSERT INTO exams (child_id, title, question_ids, question_snapshot, status) VALUES (?,?,?,?,?)',
  ).run(childId, title, JSON.stringify(ids), JSON.stringify(snap), 'generated');
  res.json({ exam_id: info.lastInsertRowid, title, count: ids.length, question_ids: ids });
});

/** GET /api/exams?child_id=1 */
router.get('/exams', (req, res) => {
  const childId = Number(req.query.child_id) || 1;
  const rows = db.prepare(
    `SELECT id, title, status, generated_at,
            (SELECT COUNT(*) FROM json_each(question_ids)) AS qcount
     FROM exams WHERE child_id = ? ORDER BY id DESC`,
  ).all(childId);
  res.json(rows);
});

/** GET /api/exams/:id */
router.get('/exams/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM exams WHERE id = ?').get(Number(req.params.id)) as any;
  if (!e) return res.status(404).json({ error: 'not found' });
  res.json({ ...e, question_ids: safeJson<number[]>(e.question_ids), question_snapshot: safeJson(e.question_snapshot) });
});

/** GET /api/exams/:id/print → A4 打印页（无答案） */
router.get('/exams/:id/print', (req, res) => {
  const e = db.prepare('SELECT * FROM exams WHERE id = ?').get(Number(req.params.id)) as any;
  if (!e) return res.status(404).send('not found');
  const snap = safeJson<any[]>(e.question_snapshot);
  const child = db.prepare('SELECT name FROM children WHERE id = ?').get(e.child_id) as any;
  const html = renderPrintHtml(e.title, child?.name || '', snap);
  res.type('html').send(html);
});

/** POST /api/exams/:id/submit  multipart file(照片) 或 json {answers} */
router.post('/exams/:id/submit', subUpload.single('file'), async (req, res) => {
  try {
    const examId = Number(req.params.id);
    const e = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId) as any;
    if (!e) return res.status(404).json({ error: 'exam not found' });
    const snapshot = safeJson<any[]>(e.question_snapshot);

    let answers: Record<string, string> = {};
    const a = req.body.answers;
    if (a) { try { answers = typeof a === 'string' ? JSON.parse(a) : a; } catch { /* ignore */ } }
    const photoFile = req.file?.filename || null;

    // 输入校验：避免无有效输入时触发 500（真实场景：拍照但未配视觉模型）
    if (photoFile && !hasVisionModel() && Object.keys(answers).length === 0) {
      return res.status(400).json({
        error: '已收到照片，但未配置视觉模型。请在「设置」中填入支持图片的模型 key，或改用「逐题填写答案」。',
      });
    }
    if (!photoFile && Object.keys(answers).length === 0) {
      return res.status(400).json({ error: '请提供答卷照片，或使用「逐题填写答案」。' });
    }

    const { results, score, analysis } = await grade(snapshot, photoFile, answers);

    const tx = db.transaction(() => {
      for (const r of results) {
        if (!r.correct) {
          const ex = db.prepare('SELECT id FROM wrong_questions WHERE question_id = ? AND child_id = ?')
            .get(r.question_id, e.child_id) as any;
          if (ex) {
            db.prepare(`UPDATE wrong_questions
                        SET wrong_count = wrong_count + 1, status = '未掌握',
                            mastery = MAX(0, mastery - 10), last_reviewed_at = datetime('now')
                        WHERE id = ?`).run(ex.id);
          } else {
            db.prepare('INSERT INTO wrong_questions (question_id, child_id, wrong_reason, status, mastery) VALUES (?,?,?,?,?)')
              .run(r.question_id, e.child_id, '试卷作答错误', '未掌握', 0);
          }
        }
      }
      const info = db.prepare(
        'INSERT INTO exam_submissions (exam_id, photo_path, answers, graded_results, analysis, score, status) VALUES (?,?,?,?,?,?,\'graded\')',
      ).run(examId, photoFile, JSON.stringify(answers), JSON.stringify(results), analysis, score);
      db.prepare("UPDATE exams SET status = 'graded' WHERE id = ?").run(examId);
      return { submission_id: info.lastInsertRowid };
    });
    res.json({ ...tx(), score, analysis, results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ============ 批改逻辑 ============ */

async function grade(
  snapshot: any[],
  photoFile: string | null,
  answers: Record<string, string>,
): Promise<{ results: any[]; score: number; analysis: string }> {
  // 1) 有照片且配置了视觉模型 → VLM 读图判分
  if (photoFile && hasVisionModel()) {
    const dataUrl = readUploadAsDataUrl(photoFile);
    const prompt =
      '这是一份学生手写的答卷照片。试卷各题的题干与标准答案如下（JSON）：\n'
      + JSON.stringify(snapshot.map(q => ({ index: snapshot.indexOf(q) + 1, content: q.content, answer: q.answer })))
      + '\n请识别学生每题的作答，与标准答案比对判断正误，严格以 JSON 返回：'
      + '{"results":[{"index":题号,"student_answer":"学生作答原文","correct":true/false,"reason":"简要说明"}],"analysis":"整体点评","score":正确题数}。';
    const provider = getVisionProvider();
    const msgs: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] },
    ];
    const raw = await provider.complete(msgs);
    const parsed = tryParse(raw);
    if (parsed) return normalizeGrade(snapshot, parsed);
  }

  // 2) 提供了逐题文字答案 → 文字模型判分（无模型则简单比对）
  if (Object.keys(answers).length > 0) {
    if (hasTextModel()) {
      const prompt =
        '请作为阅卷老师，根据题目与标准答案，判断学生每题作答是否正确。\n'
        + JSON.stringify(snapshot.map(q => ({ index: snapshot.indexOf(q) + 1, content: q.content, answer: q.answer, student: answers[q.id] ?? '' })))
        + '\n严格以 JSON 返回：{"results":[{"index":题号,"student_answer":"学生作答","correct":true/false,"reason":"错因或点评"}],"analysis":"整体点评","score":正确题数}。';
      const provider = getTextProvider();
      const parsed = tryParse(await provider.complete(
        [{ role: 'system', content: '你是严谨的阅卷老师，只输出 JSON。' }, { role: 'user', content: prompt }],
        { json: true, temperature: 0.3 },
      ));
      if (parsed) return normalizeGrade(snapshot, parsed);
    }
    return simpleGrade(snapshot, answers);
  }

  // 3) 既没有照片(视觉)也没有文字答案
  throw new Error('未配置视觉模型，请用「逐题填写答案」或配置 vision 模型后拍照上传。');
}

function normalizeGrade(snapshot: any[], parsed: any) {
  const byIndex = new Map<number, any>();
  (parsed.results || []).forEach((r: any) => byIndex.set(r.index, r));
  const results = snapshot.map((q, i) => {
    const r = byIndex.get(i + 1) || {};
    return {
      question_id: q.id,
      index: i + 1,
      student_answer: r.student_answer ?? '(未知)',
      correct: r.correct === true,
      standard_answer: q.answer || '',
      reason: r.reason || '',
    };
  });
  const correctN = results.filter(r => r.correct).length;
  const score = results.length ? Math.round((correctN / results.length) * 100) : 0;
  return { results, score, analysis: parsed.analysis || `答对 ${correctN}/${results.length} 题。` };
}

// 无模型时的轻量判分：学生答案与标准答案做正则化包含比对
function simpleGrade(snapshot: any[], answers: Record<string, string>) {
  const results = snapshot.map((q, i) => {
    const student = (answers[q.id] || '').toString().trim();
    const std = (q.answer || '').toString().trim();
    const norm = (s: string) => s.replace(/\s+/g, '');
    const correct = student.length > 0 && (std.length === 0 || norm(std).includes(norm(student)) || norm(student).includes(norm(std)));
    return {
      question_id: q.id,
      index: i + 1,
      student_answer: student || '(空)',
      correct,
      standard_answer: std,
      reason: correct ? '答对了' : '与参考答案不一致，请核对',
    };
  });
  const correctN = results.filter(r => r.correct).length;
  const score = results.length ? Math.round((correctN / results.length) * 100) : 0;
  const analysis = `共 ${results.length} 题，答对 ${correctN} 题，得分 ${score}。`
    + (correctN < results.length ? '建议重点复习答错的题目对应考点。' : '掌握得不错，继续保持！');
  return { results, score, analysis };
}

function tryParse(s: string): any {
  try { return JSON.parse(stripFence(s)); } catch { return null; }
}
function stripFence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : s.trim();
}
function readUploadAsDataUrl(filename: string): string {
  const p = join(uploadDir, filename);
  if (!existsSync(p)) throw new Error('照片文件不存在');
  const b = readFileSync(p);
  const ext = filename.split('.').pop()?.toLowerCase() || 'jpg';
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${b.toString('base64')}`;
}

function renderPrintHtml(title: string, childName: string, questions: any[]): string {
  const items = questions.map((q, i) => `
    <div class="q">
      <div class="qno">${i + 1}.</div>
      <div class="qbody">
        <div class="qcontent">${escapeHtml(q.content)}</div>
        <div class="blank">答：____________________________________________________________</div>
        <div class="blank">____________________________________________________________</div>
      </div>
    </div>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: "PingFang SC","Microsoft YaHei",sans-serif; color:#111; }
  h1 { text-align:center; font-size:20px; margin:6px 0; }
  .meta { text-align:center; color:#555; font-size:13px; margin-bottom:16px; }
  .q { display:flex; gap:8px; margin-bottom:18px; page-break-inside: avoid; }
  .qno { font-weight:bold; min-width:22px; }
  .qcontent { white-space:pre-wrap; line-height:1.6; }
  .blank { color:#999; font-size:13px; margin-top:6px; }
  .tip { margin-top:24px; color:#888; font-size:12px; border-top:1px dashed #ccc; padding-top:8px; }
</style></head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">姓名：__________　${escapeHtml(childName)}　日期：__________</div>
  ${items}
  <div class="tip">本卷由「错题大师」生成 · 做完后拍照上传即可自动批改</div>
</body></html>`;
}
function escapeHtml(s: string): string {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export default router;
