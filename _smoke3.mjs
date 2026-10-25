const BASE = 'http://192.168.3.3:3000';
async function j(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; }
  catch { return { status: r.status, data: t }; }
}
(async () => {
  console.log('1 health:', (await j('GET', '/api/health')).data);

  const a = await j('POST', '/api/solve/analyze', { text: '解方程 2x+3=11', child_id: 1 });
  console.log('2 analyze:', a.status, '| session', a.data.session_id, '| 考点', JSON.stringify(a.data.knowledge_points));
  const sid = a.data.session_id;
  const c = await j('POST', '/api/solve/chat', { session_id: sid, message: '先把3移到右边' });
  console.log('3 chat:', c.status, '| 回复:', (c.data.reply || '').slice(0, 50));
  await j('POST', '/api/solve/save-to-wrong', { session_id: sid });

  const i1 = await j('POST', '/api/import/text', { title: '小学奥数(一)', subject: '数学', grade: '五年级', text: '1. 计算 1/2+1/3=?\n2. 解方程 2x=8\n3. 求 3/4-1/2=?' });
  console.log('4 import book1:', i1.status, '| book_id', i1.data.book_id, '| 题数', i1.data.questions?.length);
  const i2 = await j('POST', '/api/import/text', { title: '课课练(二)', subject: '数学', grade: '五年级', text: '1. 计算 2/5+1/5=?\n2. 解方程 3x=12\n3. 求 1-2/3=?' });
  console.log('5 import book2:', i2.status, '| book_id', i2.data.book_id);

  const rec = await j('GET', '/api/recommendations?child_id=1');
  console.log('6 recommendations:', rec.status, '| 数量', Array.isArray(rec.data) ? rec.data.length : rec.data,
    '| 首条来源', rec.data[0] ? rec.data[0].book_title : '');

  const ex = await j('POST', '/api/exams/generate', { child_id: 1, count: 5 });
  console.log('7 generate exam:', ex.status, '| exam_id', ex.data.exam_id, '| 题数', ex.data.question_ids?.length);
  const qids = ex.data.question_ids || [];

  const pr = await j('GET', '/api/exams/' + ex.data.exam_id + '/print');
  console.log('8 print page:', pr.status, '|', (typeof pr.data === 'string' && pr.data.includes('<html')) ? 'HTML OK' : 'NOT HTML');

  const answers = Object.fromEntries(qids.map((id, i) => [String(id), i % 2 ? '错误答案' : '解答正确']));
  const sub = await j('POST', '/api/exams/' + ex.data.exam_id + '/submit', { answers });
  console.log('9 submit:', sub.status, '| score', sub.data.score, '| 判分条数', sub.data.results?.length);

  const w = await j('GET', '/api/wrong?child_id=1');
  console.log('10 wrong count:', w.data.length);

  console.log('=== DONE ===');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
