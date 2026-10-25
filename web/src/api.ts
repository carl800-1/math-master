const BASE = '/api';

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export interface WrongItem {
  id: number;
  question_id: number;
  child_id: number;
  wrong_reason: string | null;
  status: string;
  mastery: number;
  content: string;
  type: string | null;
  knowledge_points: string;
  difficulty: number | null;
  answer: string | null;
  explanation: string | null;
  images: string | null;
  book_title: string | null;
}

export const api = {
  health: () => req<{ ok: boolean }>('/health'),
  listWrong: (childId?: number) =>
    req<WrongItem[]>(`/wrong${childId ? `?child_id=${childId}` : ''}`),
  addQuestion: (q: any) =>
    req<{ id: number }>('/questions', { method: 'POST', body: JSON.stringify(q) }),
  addWrong: (w: any) =>
    req<{ id: number }>('/wrong', { method: 'POST', body: JSON.stringify(w) }),
  updateWrong: (id: number, patch: any) =>
    req<{ ok: boolean }>(`/wrong/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  addChild: (c: any) =>
    req<{ id: number }>('/children', { method: 'POST', body: JSON.stringify(c) }),
  listChildren: () => req<any[]>('/children'),

  // 引导解题
  solveAnalyze: (body: { text?: string; image?: string; child_id?: number }) =>
    req<{
      session_id: number;
      extracted_text: string;
      knowledge_points: string[];
      exam_focus: string;
      first_question: string;
    }>('/solve/analyze', { method: 'POST', body: JSON.stringify(body) }),
  solveChat: (body: { session_id: number; message: string }) =>
    req<{ reply: string; dialogue: { role: string; content: string }[] }>(
      '/solve/chat', { method: 'POST', body: JSON.stringify(body) }),
  listSessions: (childId = 1) =>
    req<any[]>(`/solve/sessions?child_id=${childId}`),
  saveToWrong: (body: { session_id: number; wrong_reason?: string }) =>
    req<{ question_id: number; wrong_id: number }>(
      '/solve/save-to-wrong', { method: 'POST', body: JSON.stringify(body) }),

  // 文件上传
  upload: async (file: File): Promise<{ url: string }> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  llmStatus: () => req<{ text: string; vision: string }>('/llm/status'),

  // 教材导入
  importText: (body: { title?: string; author?: string; subject?: string; grade?: string; text: string }) =>
    req<{ book_id: number; count: number; questions: any[] }>(
      '/import/text', { method: 'POST', body: JSON.stringify(body) }),
  importFile: async (file: File, meta: { title?: string; author?: string; subject?: string; grade?: string }) => {
    const fd = new FormData();
    fd.append('file', file);
    for (const k of Object.keys(meta)) if (meta[k as keyof typeof meta]) fd.append(k, meta[k as keyof typeof meta] as string);
    const res = await fetch('/api/import/file', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  // 跨书推荐
  generateRecommend: (childId = 1, limit = 5) =>
    req<{ weak_kps: string[]; recommendations: any[] }>(
      '/recommend', { method: 'POST', body: JSON.stringify({ child_id: childId, limit }) }),
  listRecommendations: (childId = 1) =>
    req<any[]>('/recommendations?child_id=' + childId),
  patchRecommendation: (id: number, status: string) =>
    req<{ ok: boolean }>(`/recommendations/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),

  // 组卷 + 批改
  generateExam: (childId = 1, count = 10, title?: string) =>
    req<{ exam_id: number; title: string; count: number }>(
      '/exams/generate', { method: 'POST', body: JSON.stringify({ child_id: childId, count, title }) }),
  listExams: (childId = 1) =>
    req<any[]>('/exams?child_id=' + childId),
  getExam: (id: number) =>
    req<any>('/exams/' + id),
  submitExam: async (id: number, answers: Record<number, string>, file?: File) => {
    const fd = new FormData();
    fd.append('answers', JSON.stringify(answers));
    if (file) fd.append('file', file);
    const res = await fetch(`/api/exams/${id}/submit`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
};
