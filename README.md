# 数学大师（math-master）

面向孩子的数学错题收集与针对性练习软件。三大核心能力：

1. **引导式解题** —— 输入题目（文字或拍照），AI 先做考点分析，再用「苏格拉底式追问」引导孩子自己推导出解法，不直接给答案。
2. **错题收集 + 跨书推荐** —— 错题按题型/考点/难度打标；导入教材（文本或 PDF）后，系统按孩子薄弱考点，从**不同教材**里检索相似题推送练习。
3. **组卷 + 拍照批改** —— 按薄弱点自动组卷、生成可打印 A4 试卷；孩子写完拍照/逐题上传，AI 判分并给出错因，判错题自动回流错题本。

> 显示名「数学大师」（v1.1.0）。当前为单娃版本（数据模型已预留多娃扩展）。

## 技术栈

- 前端：React + TypeScript + Vite + Tailwind（响应式，平板/手机/PC 通吃，支持摄像头拍照与浏览器打印）
- 后端：Node.js + Express + TypeScript（单容器同时托管前端与 API）
- 存储：SQLite 单文件（`data/mathmaster.db`），上传文件存 `data/uploads`
- AI：开放式 LLM 接入层（`OpenAICompatibleProvider`），兼容 DeepSeek / OpenAI / 通义 / 智谱；未配置 key 时自动回落 **Mock 演示模式**（全流程可跑）
- 部署：Docker（GitHub Actions 自动构建推 GHCR，watchtower 自动拉取更新）

## 目录结构

```
math-master/
├── server/            # Express 后端 + SQLite + LLM 接入层
│   ├── src/
│   │   ├── db.ts          # 建表（children/books/questions/wrong_questions/study_records/recommendations/exams/exam_submissions）
│   │   ├── llm.ts         # LLM 通用接入层（文字+视觉，Mock 回落）
│   │   ├── config.ts      # 读取 config/llm.json 或环境变量
│   │   ├── index.ts       # 入口：API 路由 + 静态托管前端
│   │   ├── solve.ts       # ① 引导解题
│   │   ├── import.ts      # ② 教材导入与拆题打标
│   │   └── practice.ts    # ② 跨书推荐 + ③ 组卷/打印/批改
│   └── config/llm.example.json   # LLM 配置示例（复制为 llm.json 填充 key）
├── web/               # React 前端（四个 Tab：错题本/引导解题/教材导入/练习试卷）
├── Dockerfile         # 多阶段构建（web 构建 → 后端编译 → 运行时）
├── docker-compose.yml # 生产部署（GHCR 镜像 + watchtower 自动更新）
└── .github/workflows/ci.yml  # CI：构建+冒烟自测，推送时构建镜像推 GHCR
```

## 本地开发

```bash
# 后端（:3000，已内置前端静态托管）
cd server && npm install && npm start

# 前端热更新（另开终端，:5173，开发态可独立跑）
cd web && npm install && npm run dev
```

浏览器打开 http://localhost:3000 即可。未配置 AI key 时走 Mock 模式，所有流程可演示。

## 接入真实 AI

复制示例并填入 key（**不要提交 `config/llm.json`，已 gitignore**）：

```bash
cp server/config/llm.example.json server/config/llm.json
# 编辑 llm.json：填 text.apiKey（如 DeepSeek）与 vision.apiKey（如 GLM-4V / gpt-4o）
```

重启服务即自动切换为真实模型，代码零改动。

## 部署到绿联 NAS / 任意 Docker 主机

镜像由 CI 自动构建并推送到 `ghcr.io/carl800-1/math-master:latest`。

```bash
# 1) 首次：登录 GHCR（用有 read:packages 权限的 GitHub Personal Access Token）
docker login ghcr.io -u carl800-1

# 2) 启动（compose 已含 watchtower 自动更新）
docker compose up -d

# 3) 访问 http://<主机IP>:3000
```

设置 AI key：在 NAS 上 `math-master` 容器里放 `config/llm.json`，或挂载一个目录覆盖
`/server/config/llm.json`（compose 已预留 `./data` 卷；可按需再挂一个 config 卷）。

## CI / 自动生成

`.github/workflows/ci.yml`：

- **test**：每次 push / PR 构建镜像并冒烟自测（`/api/health`、`/api/llm/status`、引导解题），不推送。
- **publish**：仅 push 到 `main` 或打 `v*` tag 时，构建并推送镜像到 GHCR（latest / sha / tag 多标签）。
- NAS 上的 watchtower 每 5 分钟检查 GHCR，发现新镜像即自动拉取重建 → **推送即部署**。

## 数据隐私

题库与错题均存于部署机本地 SQLite，不上云。AI key 仅存于部署机本地配置，不进镜像、不提交仓库。
