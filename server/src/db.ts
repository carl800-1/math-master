import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 数据根目录：
//  - 生产/Docker：编译产物在 /server/dist，故取上一级 /server/data（即 docker-compose 挂载的持久卷）
//  - 开发态：server/src → server/data
// 可用环境变量 DATA_DIR 强制覆盖（Dockerfile 已设为 /server/data），避免相对路径误解析到容器可写层。
export function dataRoot(): string {
  return process.env.DATA_DIR || join(__dirname, '..', 'data');
}
const dataDir = dataRoot();
mkdirSync(dataDir, { recursive: true });

const db = new Database(join(dataDir, 'mathmaster.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS children (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  grade TEXT,
  avatar TEXT,
  subject_focus TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  author TEXT,
  subject TEXT,
  grade TEXT,
  source_type TEXT,
  file_path TEXT,
  imported_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER,
  content TEXT,
  type TEXT,
  subject TEXT,
  grade TEXT,
  knowledge_points TEXT,
  difficulty INTEGER,
  answer TEXT,
  explanation TEXT,
  images TEXT,
  source_page TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wrong_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER,
  child_id INTEGER,
  first_wrong_at TEXT DEFAULT (datetime('now')),
  wrong_count INTEGER DEFAULT 1,
  wrong_reason TEXT,
  status TEXT DEFAULT '未掌握',
  mastery INTEGER DEFAULT 0,
  last_reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS study_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER,
  question_id INTEGER,
  input_type TEXT,            -- 'text' | 'photo'
  problem_text TEXT,
  problem_images TEXT,        -- JSON 数组
  analysis TEXT,              -- JSON：{knowledge_points, exam_focus}
  dialogue TEXT,              -- JSON 数组：[{role, content}]
  conclusion TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER,
  based_on_wrong_qid INTEGER,   -- 触发推荐的薄弱错题
  recommended_qid INTEGER,      -- 推荐的题目
  reason TEXT,
  status TEXT DEFAULT 'pending', -- pending | done | skipped
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER,
  title TEXT,
  question_ids TEXT,          -- JSON 数组
  question_snapshot TEXT,     -- JSON：每题 {id,content,type,knowledge_points,difficulty,answer,explanation}
  status TEXT DEFAULT 'generated', -- generated | graded
  generated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS exam_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER,
  photo_path TEXT,
  answers TEXT,              -- JSON：{question_id: 学生答案}
  graded_results TEXT,       -- JSON 数组
  analysis TEXT,
  score INTEGER,
  status TEXT DEFAULT 'graded',
  submitted_at TEXT DEFAULT (datetime('now'))
);
`);

export default db;
