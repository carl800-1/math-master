import { useEffect, useRef, useState } from 'react';
import { api, WrongItem } from './api';

const CHILD_ID = 1;

/** 把图片文件压缩到最长边 maxDim 内，返回 jpeg dataURL（用于视觉模型调用） */
function fileToDataURL(file: File, maxDim = 1280): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解析失败'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

type Tab = 'wrong' | 'solve' | 'import' | 'practice';

export default function App() {
  const [tab, setTab] = useState<Tab>('wrong');
  const [health, setHealth] = useState('...');
  const [llm, setLlm] = useState<{ text: string; vision: string }>({ text: '', vision: '' });

  useEffect(() => {
    api.health().then(h => setHealth(h.ok ? '已连接' : '异常')).catch(() => setHealth('未连接'));
    api.llmStatus().then(setLlm).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="bg-white shadow px-4 py-3 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <h1 className="text-lg font-bold">错题大师</h1>
          <div className="text-xs text-slate-400 text-right leading-tight">
            <div>后端：{health}</div>
            <div>AI：{llm.text || '…'} / 视觉：{llm.vision || '…'}</div>
          </div>
        </div>
        <nav className="max-w-3xl mx-auto flex gap-2 mt-3 flex-wrap">
          <TabBtn active={tab === 'wrong'} onClick={() => setTab('wrong')}>📒 错题本</TabBtn>
          <TabBtn active={tab === 'solve'} onClick={() => setTab('solve')}>💡 引导解题</TabBtn>
          <TabBtn active={tab === 'import'} onClick={() => setTab('import')}>📚 教材导入</TabBtn>
          <TabBtn active={tab === 'practice'} onClick={() => setTab('practice')}>🎯 练习试卷</TabBtn>
        </nav>
      </header>
      <main className="max-w-3xl mx-auto p-4">
        {tab === 'wrong' && <WrongBook />}
        {tab === 'solve' && <Solve />}
        {tab === 'import' && <ImportBook />}
        {tab === 'practice' && <Practice />}
      </main>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-lg text-sm font-medium ${active ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
      {children}
    </button>
  );
}

/* ============ 错题本 ============ */
function WrongBook() {
  const [items, setItems] = useState<WrongItem[]>([]);
  const [content, setContent] = useState('');
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  async function refresh() { setItems(await api.listWrong(CHILD_ID)); }
  useEffect(() => { refresh().catch(() => setItems([])); }, []);

  async function submit() {
    if (!content.trim() && !file) return;
    setBusy(true);
    try {
      let images: string[] = [];
      if (file) {
        const { url } = await api.upload(file);
        images = [url];
      }
      const { id } = await api.addQuestion({
        content: content || (file ? '（图片）' : ''),
        type: '其他', subject: '', grade: '', difficulty: 1, images,
      });
      await api.addWrong({ question_id: id, child_id: CHILD_ID, wrong_reason: reason });
      setContent(''); setReason(''); setFile(null);
      await refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-xl shadow p-4 space-y-2">
        <h2 className="font-semibold">登记一道错题</h2>
        <textarea className="w-full border rounded p-2 text-sm" rows={3}
          placeholder="粘贴错题题干…" value={content}
          onChange={e => setContent(e.target.value)} />
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1 text-sm bg-slate-100 px-3 py-2 rounded cursor-pointer">
            📷 拍照/选图
            <input type="file" accept="image/*" capture="environment" className="hidden"
              onChange={e => setFile(e.target.files?.[0] || null)} />
          </label>
          {file && <span className="text-xs text-slate-500">{file.name}</span>}
        </div>
        <input className="w-full border rounded p-2 text-sm" placeholder="错因（可选）"
          value={reason} onChange={e => setReason(e.target.value)} />
        <button className="bg-blue-600 text-white rounded px-4 py-2 text-sm disabled:opacity-50"
          onClick={submit} disabled={busy}>
          {busy ? '保存中…' : '加入错题本'}
        </button>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">错题列表（{items.length}）</h2>
        {items.map(it => (
          <div key={it.id} className="bg-white rounded-xl shadow p-3 text-sm">
            <button className="w-full text-left" onClick={() => setOpenId(openId === it.id ? null : it.id)}>
              <div className="flex justify-between gap-2">
                <span className="font-medium line-clamp-2">{it.content}</span>
                <span className="text-slate-400 text-xs shrink-0">{openId === it.id ? '收起' : '详情'}</span>
              </div>
              <div className="text-slate-400 text-xs mt-1">
                {it.type} · 掌握度 {it.mastery} · {it.status}
                {it.book_title ? ` · 《${it.book_title}》` : ''}
              </div>
            </button>
            {openId === it.id && <WrongDetail it={it} onChange={refresh} />}
          </div>
        ))}
        {items.length === 0 && <p className="text-slate-400 text-sm">还没有错题，先登记一道吧。</p>}
      </section>
    </div>
  );
}

function WrongDetail({ it, onChange }: { it: WrongItem; onChange: () => void }) {
  const kps: string[] = safeJson<string[]>(it.knowledge_points);
  const [mastery, setMastery] = useState(it.mastery);
  const [status, setStatus] = useState(it.status);

  async function save() {
    await api.updateWrong(it.id, { mastery, status });
    onChange();
  }

  return (
    <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
      {it.images && safeJson<string[]>(it.images).length > 0 && (
        <img src={safeJson<string[]>(it.images)[0]} alt="错题" className="max-h-48 rounded border" />
      )}
      {kps.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {kps.map((k, i) => (
            <span key={i} className="bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded">{k}</span>
          ))}
        </div>
      )}
      {it.answer && <p><b>答案：</b>{it.answer}</p>}
      {it.explanation && <p className="text-slate-600"><b>解析：</b>{it.explanation}</p>}
      {it.wrong_reason && <p className="text-slate-500"><b>错因：</b>{it.wrong_reason}</p>}
      <div className="flex items-center gap-3 pt-1">
        <label className="text-xs">掌握度 {mastery}
          <input type="range" min={0} max={100} step={10} value={mastery}
            onChange={e => setMastery(Number(e.target.value))} className="ml-2" />
        </label>
        <select value={status} onChange={e => setStatus(e.target.value)}
          className="border rounded px-2 py-1 text-xs">
          <option>未掌握</option><option>复习中</option><option>已掌握</option>
        </select>
        <button onClick={save} className="bg-emerald-600 text-white rounded px-3 py-1 text-xs">保存</button>
      </div>
    </div>
  );
}

/* ============ 引导解题 ============ */
function Solve() {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<{
    id: number; extracted: string; kps: string[]; focus: string;
    dialogue: { role: string; content: string }[];
  } | null>(null);
  const [msg, setMsg] = useState('');
  const [saved, setSaved] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null;
    setFile(f);
    if (f) setPreview(URL.createObjectURL(f));
  }

  async function start() {
    if (!text.trim() && !file) return;
    setBusy(true); setSaved(false);
    try {
      let image: string | undefined;
      if (file) image = await fileToDataURL(file);
      const r = await api.solveAnalyze({ text: text.trim() || undefined, image, child_id: CHILD_ID });
      setSession({ id: r.session_id, extracted: r.extracted_text, kps: r.knowledge_points, focus: r.exam_focus, dialogue: [{ role: 'assistant', content: r.first_question }] });
    } finally { setBusy(false); }
  }

  async function send() {
    if (!session || !msg.trim()) return;
    const m = msg.trim(); setMsg('');
    const dialogue = [...session.dialogue, { role: 'user', content: m }];
    setSession({ ...session, dialogue });
    setBusy(true);
    try {
      const r = await api.solveChat({ session_id: session.id, message: m });
      setSession({ ...session, dialogue: r.dialogue });
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    } finally { setBusy(false); }
  }

  async function saveWrong() {
    if (!session) return;
    await api.saveToWrong({ session_id: session.id });
    setSaved(true);
  }

  function reset() {
    setSession(null); setText(''); setFile(null); setPreview(''); setMsg(''); setSaved(false);
  }

  if (!session) {
    return (
      <section className="bg-white rounded-xl shadow p-4 space-y-3">
        <h2 className="font-semibold">拍题 / 输入题目，我来引导你想明白</h2>
        <textarea className="w-full border rounded p-2 text-sm" rows={4}
          placeholder="把题目抄下来或粘贴到这里…" value={text}
          onChange={e => setText(e.target.value)} />
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1 text-sm bg-slate-100 px-3 py-2 rounded cursor-pointer">
            📷 拍照识别
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick} />
          </label>
          {file && <span className="text-xs text-slate-500">{file.name}</span>}
        </div>
        {preview && <img src={preview} alt="题面" className="max-h-48 rounded border" />}
        <button className="bg-blue-600 text-white rounded px-4 py-2 text-sm disabled:opacity-50"
          onClick={start} disabled={busy || (!text.trim() && !file)}>
          {busy ? '分析中…' : '开始引导'}
        </button>
        <p className="text-xs text-slate-400">提示：拍照后由视觉模型提取题干，再分析考点并引导你一步步思考（不会直接给答案）。未配置视觉模型时请直接输入文字。</p>
      </section>
    );
  }

  return (
    <section className="bg-white rounded-xl shadow p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">引导解题中</h2>
        <button onClick={reset} className="text-xs text-slate-400">换一题</button>
      </div>
      <div className="bg-slate-50 rounded-lg p-3 text-sm space-y-1">
        <div className="text-slate-500">📌 考点分析</div>
        <div className="flex flex-wrap gap-1">
          {session.kps.map((k, i) => (
            <span key={i} className="bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded">{k}</span>
          ))}
        </div>
        {session.focus && <p className="text-slate-600">{session.focus}</p>}
      </div>
      <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
        {session.dialogue.map((d, i) => (
          <div key={i} className={`flex ${d.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${d.role === 'user' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-800'}`}>
              {d.content}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex gap-2">
        <input className="flex-1 border rounded p-2 text-sm" placeholder="写下你的想法…"
          value={msg} onChange={e => setMsg(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()} disabled={busy} />
        <button className="bg-blue-600 text-white rounded px-4 py-2 text-sm disabled:opacity-50"
          onClick={send} disabled={busy || !msg.trim()}>{busy ? '…' : '发送'}</button>
      </div>
      <div className="flex gap-2 pt-1">
        <button onClick={saveWrong} disabled={saved}
          className="bg-amber-600 text-white rounded px-3 py-1.5 text-xs disabled:opacity-50">
          {saved ? '✓ 已归入错题本' : '归入错题本'}
        </button>
      </div>
    </section>
  );
}

/* ============ 教材导入 ============ */
function ImportBook() {
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [grade, setGrade] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ book_id: number; count: number; questions: any[] } | null>(null);
  const [err, setErr] = useState('');

  async function doImport() {
    setBusy(true); setErr(''); setResult(null);
    try {
      const meta = { title: title || undefined, subject: subject || undefined, grade: grade || undefined };
      let r;
      if (file) r = await api.importFile(file, meta);
      else if (text.trim()) r = await api.importText({ ...meta, text });
      else { setErr('请粘贴教材文本，或选择 PDF/文本文件'); return; }
      setResult(r);
    } catch (e: any) { setErr(e.message || '导入失败'); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-xl shadow p-4 space-y-2">
        <h2 className="font-semibold">导入教材 / 练习（建题库）</h2>
        <div className="grid grid-cols-3 gap-2">
          <input className="border rounded p-2 text-sm" placeholder="书名" value={title} onChange={e => setTitle(e.target.value)} />
          <input className="border rounded p-2 text-sm" placeholder="学科" value={subject} onChange={e => setSubject(e.target.value)} />
          <input className="border rounded p-2 text-sm" placeholder="年级" value={grade} onChange={e => setGrade(e.target.value)} />
        </div>
        <textarea className="w-full border rounded p-2 text-sm" rows={6}
          placeholder="把教材/练习的一段文本粘贴到这里（每行一题更利于拆分）…" value={text}
          onChange={e => setText(e.target.value)} />
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1 text-sm bg-slate-100 px-3 py-2 rounded cursor-pointer">
            📄 上传 PDF / txt
            <input type="file" accept=".pdf,.txt,text/plain" className="hidden"
              onChange={e => setFile(e.target.files?.[0] || null)} />
          </label>
          {file && <span className="text-xs text-slate-500">{file.name}</span>}
          {file && <button className="text-xs text-slate-400" onClick={() => setFile(null)}>移除</button>}
        </div>
        <button className="bg-blue-600 text-white rounded px-4 py-2 text-sm disabled:opacity-50"
          onClick={doImport} disabled={busy || (!text.trim() && !file)}>
          {busy ? '解析中…' : '解析并入库'}
        </button>
        {err && <p className="text-red-500 text-xs">{err}</p>}
        <p className="text-xs text-slate-400">
          说明：文本经大模型拆题并自动打标签（题型/考点/难度/答案），PDF 为文本型可抽取；扫描版图片 PDF 需配置视觉模型。
          未配置 AI key 时也能导入（演示模式按行拆题）。
        </p>
      </section>

      {result && (
        <section className="bg-white rounded-xl shadow p-4 space-y-2">
          <h2 className="font-semibold">入库成功 · 共 {result.count} 题（book #{result.book_id}）</h2>
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {result.questions.map((q, i) => (
              <div key={i} className="text-sm border-b border-slate-100 py-1">
                <div className="font-medium">{i + 1}. {q.content}</div>
                <div className="text-slate-400 text-xs">
                  {q.type} · 难度{q.difficulty} · 考点{(q.knowledge_points || []).join('、') || '—'} · 答案{q.answer || '—'}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-400">这本题已加入题库，可在「练习试卷 → 针对性推荐」中按薄弱考点跨书抽题练习。</p>
        </section>
      )}
    </div>
  );
}

/* ============ 练习试卷（推荐 + 组卷 + 批改） ============ */
function Practice() {
  const [sub, setSub] = useState<'recommend' | 'exam'>('recommend');

  return (
    <div className="space-y-4">
      <nav className="flex gap-2">
        <TabBtn active={sub === 'recommend'} onClick={() => setSub('recommend')}>🔎 针对性推荐</TabBtn>
        <TabBtn active={sub === 'exam'} onClick={() => setSub('exam')}>📝 组卷与批改</TabBtn>
      </nav>
      {sub === 'recommend' ? <Recommend /> : <Exam />}
    </div>
  );
}

function Recommend() {
  const [list, setList] = useState<any[]>([]);
  const [weak, setWeak] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function gen() {
    setBusy(true); setErr('');
    try {
      const r = await api.generateRecommend(CHILD_ID, 6);
      setWeak(r.weak_kps);
      setList(r.recommendations);
      if (r.recommendations.length === 0 && r.weak_kps.length === 0)
        setErr('还没有错题或薄弱考点，先去错题本/引导解题积累一些吧。');
    } catch (e: any) { setErr(e.message || '生成失败'); }
    finally { setBusy(false); }
  }
  async function refresh() { setList(await api.listRecommendations(CHILD_ID)); }
  useEffect(() => { refresh().catch(() => setList([])); }, []);

  async function mark(id: number, status: string) {
    await api.patchRecommendation(id, status);
    await refresh();
  }

  return (
    <div className="space-y-3">
      {weak.length > 0 && (
        <div className="bg-white rounded-xl shadow p-3 text-sm">
          <div className="text-slate-500 mb-1">📊 薄弱考点画像</div>
          <div className="flex flex-wrap gap-1">
            {weak.map((k, i) => <span key={i} className="bg-rose-50 text-rose-700 text-xs px-2 py-0.5 rounded">{k}</span>)}
          </div>
        </div>
      )}
      <button className="bg-blue-600 text-white rounded px-4 py-2 text-sm disabled:opacity-50 w-full"
        onClick={gen} disabled={busy}>
        {busy ? '生成中…' : '✨ 基于薄弱考点，从其他教材抽相似题'}
      </button>
      {err && <p className="text-red-500 text-xs">{err}</p>}
      <section className="space-y-2">
        <h2 className="font-semibold">推荐练习（{list.length}）</h2>
        {list.map(r => (
          <div key={r.id} className="bg-white rounded-xl shadow p-3 text-sm">
            <div className="flex justify-between gap-2">
              <span className="font-medium">{r.question.content}</span>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-500 shrink-0">{r.status}</span>
            </div>
            <div className="text-slate-400 text-xs mt-1">
              {r.question.type} · 难度{r.question.difficulty}
              {r.book_title ? ` · 《${r.book_title}》` : ''}
            </div>
            <div className="text-blue-600 text-xs mt-1">💡 {r.reason}</div>
            <div className="flex gap-2 mt-2">
              <button className="bg-emerald-600 text-white rounded px-3 py-1 text-xs"
                onClick={() => mark(r.id, 'done')}>已练会</button>
              <button className="bg-slate-200 text-slate-600 rounded px-3 py-1 text-xs"
                onClick={() => mark(r.id, 'skipped')}>暂不练</button>
            </div>
          </div>
        ))}
        {list.length === 0 && <p className="text-slate-400 text-sm">点上面按钮，从题库里按薄弱点抽几道不同书的题来练。</p>}
      </section>
    </div>
  );
}

function Exam() {
  const [count, setCount] = useState(10);
  const [exam, setExam] = useState<any | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [visionNote, setVisionNote] = useState('');

  async function loadHistory() { setHistory(await api.listExams(CHILD_ID)); }
  useEffect(() => { loadHistory().catch(() => setHistory([])); }, []);

  async function gen() {
    setBusy(true); setErr(''); setResult(null); setAnswers({}); setPhoto(null); setVisionNote('');
    try {
      const r = await api.generateExam(CHILD_ID, count);
      const detail = await api.getExam(r.exam_id);
      setExam(detail);
    } catch (e: any) { setErr(e.message || '生成失败'); }
    finally { setBusy(false); }
  }

  async function submit() {
    if (!exam) return;
    setBusy(true); setErr('');
    try {
      const r = await api.submitExam(exam.id, answers, photo || undefined);
      setResult(r);
      await loadHistory();
    } catch (e: any) { setErr(e.message || '批改失败'); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-xl shadow p-4 space-y-2">
        <h2 className="font-semibold">生成一份针对性练习卷</h2>
        <div className="flex items-center gap-2">
          <span className="text-sm">题量</span>
          <input type="number" min={1} max={30} value={count}
            onChange={e => setCount(Number(e.target.value))}
            className="border rounded p-1 w-20 text-sm" />
          <button className="bg-blue-600 text-white rounded px-4 py-2 text-sm disabled:opacity-50"
            onClick={gen} disabled={busy}>{busy ? '生成中…' : '生成试卷'}</button>
        </div>
        {err && <p className="text-red-500 text-xs">{err}</p>}
        {exam && (
          <div className="space-y-2">
            <p className="text-sm text-slate-600">已生成《{exam.title}》，共 {exam.question_snapshot.length} 题。</p>
            <button className="bg-amber-600 text-white rounded px-3 py-1.5 text-xs"
              onClick={() => window.open(`/api/exams/${exam.id}/print`, '_blank')}>
              🖨️ 打印 / 导出 PDF（新标签页）
            </button>
            <p className="text-xs text-slate-400">打印后让孩子在纸上作答，再回到这里拍照/逐题填写上传批改。</p>
          </div>
        )}
      </section>

      {exam && (
        <section className="bg-white rounded-xl shadow p-4 space-y-3">
          <h2 className="font-semibold">作答并上传批改</h2>
          <div className="space-y-3">
            {exam.question_snapshot.map((q: any, i: number) => (
              <div key={q.id} className="border-b border-slate-100 pb-2">
                <div className="text-sm font-medium">{i + 1}. {q.content}</div>
                <textarea className="w-full border rounded p-1 text-sm mt-1" rows={2}
                  placeholder="填写孩子这题的答案…" value={answers[q.id] || ''}
                  onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })} />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-1 text-sm bg-slate-100 px-3 py-2 rounded cursor-pointer">
              📷 拍照上传整页答卷
              <input type="file" accept="image/*" capture="environment" className="hidden"
                onChange={e => { setPhoto(e.target.files?.[0] || null); setVisionNote(''); }} />
            </label>
            {photo && <span className="text-xs text-slate-500">{photo.name}</span>}
          </div>
          <button className="bg-emerald-600 text-white rounded px-4 py-2 text-sm disabled:opacity-50"
            onClick={submit} disabled={busy}>{busy ? '批改中…' : '提交并批改'}</button>
          <p className="text-xs text-slate-400">
            未配置视觉模型时，请使用上面逐题填写答案（系统按答案比对判分）；配置视觉模型后可拍照整页自动识别。
          </p>
        </section>
      )}

      {result && (
        <section className="bg-white rounded-xl shadow p-4 space-y-2">
          <h2 className="font-semibold">批改结果 · 得分 {result.score}</h2>
          <div className="space-y-2">
            {result.results.map((r: any) => (
              <div key={r.question_id} className="text-sm border-b border-slate-100 pb-1">
                <div className="flex justify-between">
                  <span>第 {r.index} 题</span>
                  <span className={r.correct ? 'text-emerald-600' : 'text-rose-600'}>
                    {r.correct ? '✓ 正确' : '✗ 错误'}
                  </span>
                </div>
                <div className="text-slate-500 text-xs">学生：{r.student_answer}　标准：{r.standard_answer || '—'}</div>
                {r.reason && <div className="text-slate-400 text-xs">点评：{r.reason}</div>}
              </div>
            ))}
          </div>
          <div className="bg-slate-50 rounded p-2 text-sm text-slate-600">📋 {result.analysis}</div>
          <p className="text-xs text-slate-400">答错的题已自动回流到错题本。</p>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold">历史试卷（{history.length}）</h2>
        {history.map(e => (
          <div key={e.id} className="bg-white rounded-xl shadow p-3 text-sm flex justify-between">
            <div>
              <div className="font-medium">{e.title}</div>
              <div className="text-slate-400 text-xs">{e.qcount} 题 · {e.generated_at?.slice(0, 16)}</div>
            </div>
            <div className="flex gap-2 items-center">
              <button className="text-xs text-blue-600" onClick={() => window.open(`/api/exams/${e.id}/print`, '_blank')}>打印</button>
              <span className={`text-xs px-2 py-0.5 rounded ${e.status === 'graded' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{e.status}</span>
            </div>
          </div>
        ))}
        {history.length === 0 && <p className="text-slate-400 text-sm">还没有试卷。</p>}
      </section>
    </div>
  );
}

function safeJson<T = any>(s: string | null): T {
  if (!s) return [] as unknown as T;
  try { return JSON.parse(s); } catch { return [] as unknown as T; }
}
