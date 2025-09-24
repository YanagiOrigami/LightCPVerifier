# LightCPVerifier

Lightweight programming problem judging service built on top of [go-judge](https://github.com/criyle/go-judge). It runs submissions inside go-judge sandboxes, supports both classic and interactive problems, and exposes a compact REST API that is easy to integrate with OJ frontends, pipelines, or ad-hoc scripts.

轻量级编程题评测协调器，基于 go-judge 沙箱运行。支持多语言评测、testlib 检查器、交互题以及压缩包快捷导入，适合作为小型 OJ、题库或内部评测引擎的后端组件。

---

## Highlights
- **go-judge sandbox orchestration**：支持 C++17 / Python3 / PyPy3 / Java，沙箱内编译与运行，自动清理缓存文件。
- **多题型覆盖**：`type: default`、`interactive` 均可；自动编译 testlib 检查器与交互器，生成二进制缓存。
- **文件分桶归档**：`SubmissionManager` 将提交落盘到 `submissions/<bucket>/<sid>/`，附带 `meta.json` 与 `result.json`，方便调试与备份。
- **问题打包/导入工具链**：提供 `scripts/setup.py`、`scripts/submit.py` 等 CLI，配合 `/problem/setup` 等 API 快速整理题目资产。
- **Docker 友好**：内置 `Dockerfile` + `docker-compose.yml`，一条命令即可在服务器部署；entrypoint 自动拉起 go-judge 与服务。
- **清晰的 REST API**：`POST /submit`、`GET /result/:sid` 等接口覆盖提交、结果查询、题面、压缩导出等核心需求。

---

## Architecture Overview
- `server.js`：Express 入口，装配 `JudgeEngine`、`ProblemManager` 与 `SubmissionManager`，并注册 REST 路由。
- `src/judge_engine.js`：提交队列与工作线程，负责调用 go-judge 完成编译和逐测试点评测。
- `src/problem_manager.js`：题目加载、配置验证、压缩包导入、checker/interactor 预编译、打包导出。
- `src/gojudge.js`：与 go-judge HTTP API 通信，封装编译/运行/文件缓存。
- `src/router.js`：REST API 定义，包含提交、结果、题目管理、归档、健康检查等路由。
- `src/utils.js`：目录/文件工具、单位转换、测试用例枚举、提交 ID 管理器。
- `scripts/`：批量上传题目、批量提交、结果抓取的辅助脚本，便于和现有题库/刷题记录联动。

---

## Requirements
### Runtime dependencies
- Node.js ≥ 18（ESM 项目，需原生 `import` 支持）。
- 可执行的 go-judge（推荐最新 release），并保证 HTTP 控制端口可访问。
- 评测语言所需的编译器/解释器，例如：`g++`、`openjdk-17-jdk`、`python3`、`pypy3` 等。
- testlib 头文件（仓库自带 `include/testlib.h`，也可使用自定义版本）。

在类 Debian/Ubuntu 主机上的最小化依赖安装示例：
```bash
sudo apt update
sudo apt install -y g++ openjdk-17-jdk-headless python3 pypy3
# 根据需要安装 go-judge，可参考 Dockerfile 中的自动下载脚本
```

---

## Quick Start
### Option A · Local machine
1. **获取源码并安装依赖**
   ```bash
   git clone https://github.com/YanagiOrigami/LightCPVerifier.git
   cd LightCPVerifier
   npm install
   ```
2. **启动 go-judge**
   - 准备 `mount.yaml`、`seccomp.yaml`、`cgroup` 等配置，确保题目数据、提交目录都以只读/读写方式正确挂载。
   - 启动示例：`go-judge --mount-conf=mount.yaml --parallelism=4`
3. **启动 LightCPVerifier 服务**
   ```bash
   # 常用环境变量见后文
   PORT=8081 \
   GJ_ADDR=http://127.0.0.1:5050 \
   JUDGE_WORKERS=4 \
   node server.js
   ```
4. **验证服务是否存活**：访问 `http://localhost:8081/health` 应返回 `{ "ok": true }`。

> 若评测使用 testlib，请将头文件放置到 go-judge 沙箱可见路径，并通过 `TESTLIB_INSIDE` 指定（默认 `/lib/testlib`）。

### Option B · Docker / Compose（推荐部署方式）
1. 确保主机已安装 Docker 与 Docker Compose。
2. 仓库根目录执行：
   ```bash
   docker compose up --build -d
   ```
3. `docker-compose.yml` 默认将 `./problems`、`./submissions`、`./data` 绑定到容器 `/app` 目录，go-judge 与 orchestrator 共容器运行。
4. 自行调整：`JUDGE_WORKERS` 与 `GJ_PARALLELISM`（并发度）、端口映射、题目目录位置等。

> `entrypoint.sh` 会先启动 go-judge，再启动 Node 服务。如需拆分部署，可将 go-judge 独立运行并把 `GJ_ADDR` 指向相应地址。

---

## Repository Layout
```text
LightCPVerifier/
├── server.js              # Express 入口
├── src/
│   ├── judge_engine.js    # 评测核心与 worker 管理
│   ├── problem_manager.js # 题目载入、导入、导出
│   ├── gojudge.js         # go-judge API 封装
│   ├── router.js          # REST 路由
│   ├── upload.js          # 上传中间件（multer）
│   └── utils.js           # 工具函数 + SubmissionManager
├── problems/              # 题库（示例数据）
├── submissions/           # 提交归档（运行时生成）
├── data/                  # 运行数据（计数器等）
├── scripts/               # CLI 辅助脚本
├── config/langs.yaml      # 语言配置示例
├── include/testlib.h      # testlib 头文件
├── Dockerfile
├── docker-compose.yml
├── entrypoint.sh
└── package.json
```

---

## Problem Lifecycle & Config
题目目录形如 `problems/<pid>/`，常见文件：
- `config.yaml`：题目元数据（见下例）。
- `statement.txt`：纯文本题面（`GET /problem/:pid/statement` 调用输出）。
- `testdata/`：测试数据对，命名可在配置中指定前后缀。
- `checker.cpp` / `chk.cc`：testlib 检查器源码，可选。
- `interactor.cpp`：交互器源码，限 `type: interactive`。

典型 `config.yaml`：
```yaml
type: default          # default / interactive / leetcode(预留)
time_limit: 1s         # 支持 500ms / 2s 等格式
memory_limit: 256m
checker: chk.cc        # 可省略 -> 使用默认名
filename: main.cpp     # 可选，指定选手源文件名
subtasks:
  - score: 100
    n_cases: 10        # 或者使用 cases: [{ input: "1.in", output: "1.ans" }]
```

交互题示例：
```yaml
type: interactive
interactor: interactor.cpp
checker: checker.cpp
subtasks:
  - score: 100
    n_cases: 2
```

### 导入 / 导出题目
- `POST /problem/add-problem`：创建题目目录并（可选）解压上传包。
- `POST /problem/setup`：对已有题目执行打包流程，自动生成 `config.yaml`（缺失时）、复制测试数据、编译 checker/interactor 并缓存二进制、生成 `<pid>.tar.gz`。
- `GET /package/:pid`：下载题目打包产物（`<pid>.tar.gz`）。

辅助脚本：
- `scripts/setup.py`：批量压缩题目并调用上述 API。
- `scripts/submit.py`：遍历本地提交记录批量 POST `/submit`。
- `scripts/fetch.py`：根据 sid 映射批量轮询结果。

---

## REST API Summary
| Method & Path | 描述 | 说明 |
| ------------- | ---- | ---- |
| `POST /submit` | 提交代码 | 支持 `multipart/form-data`（`code` 文件或文本字段）、`application/json`、`application/x-www-form-urlencoded`；语言别名自动归一化到 `cpp`/`py` 等。返回 `{ "sid": 1 }`。 |
| `GET /result/:sid` | 查询结果 | 默认返回完整 JSON；`?short=1` 仅返回 `{ status, passed }`。队列中返回 404。 |
| `GET /problems` | 题目列表 | 可选 `?statement=true` 联合返回题面文本。 |
| `GET /problem/:pid/statement` | 题面 | 纯文本响应。 |
| `GET /submissions/export` | 导出提交 | 流式返回 tar.gz（按当前 `submissions` 目录）。 |
| `POST /submissions/reset` | 清空提交 | 清空内存队列、结果缓存并清理落盘提交。 |
| `POST /problem/setup` | 题目整理 | 上传 zip (`zipfile` 字段) + `pid`，生成/刷新题目内容。 |
| `POST /problem/add-problem` | 新增题目 | 创建题目目录，上传 zip（可选）。 |
| `GET /package/:pid` | 下载题包 | 返回 `<pid>.tar.gz`。 |
| `GET /health` | 健康检查 | `{ "ok": true }`。

所有路由均默认使用 JSON 错误响应（`{ error, message }`）。

---

## Environment Variables
| 变量名 | 默认值 | 用途 |
| ------ | ------ | ---- |
| `PORT` | `8081` | Express 服务监听端口。 |
| `GJ_ADDR` | `http://127.0.0.1:5050` | go-judge HTTP 地址。 |
| `JUDGE_WORKERS` | `4` | 判题 worker 数量（Node 层并发）。 |
| `SUB_BUCKET` | `100` | 提交分桶大小，避免单目录文件过多。 |
| `SUBMISSIONS_DIR` | `./submissions` | 提交归档根目录。 |
| `TESTLIB_INSIDE` | `/lib/testlib` | 沙箱内 testlib 头文件路径。 |
| `GJ_PARALLELISM` | 未设置 | entrypoint 使用，控制 go-judge 并发度。 |

根据主机算力调整 `JUDGE_WORKERS` / `GJ_PARALLELISM`，并配合 go-judge 的 CPU/内存限制策略。

---

## Operational Notes
- **结果缓存**：评测完成后结果写入 `submissions/<bucket>/<sid>/result.json`，`JudgeEngine.getResult` 会优先返回内存缓存，之后可以多次访问落盘结果。
- **交互题**：通过 go-judge 的 `pipeMapping` 运行双进程；请确保交互器可执行在沙箱内正常运行（编译所需的 testlib 和依赖需提前挂载）。
- **语言扩展**：可参考 `config/langs.yaml` 自定义编译/运行指令，或扩展 `GoJudgeClient.prepareProgram` 支持更多语言。
- **日志**：目前主要使用 `console.log` 输出，可配合 `pm2` / `systemd` 等外部工具进行日志采集与轮换。

---

## License
[AGPL-3.0](LICENSE)

## Acknowledgements
- [go-judge](https://github.com/criyle/go-judge) —— 核心沙箱执行引擎。
- [hydro-oj](https://github.com/hydro-dev/Hydro) —— 基于 go-judge 的 OJ 平台，理念与实现给予灵感。

> 本 README 旨在覆盖仓库主体内容（Node/服务端部分）；`node_modules` 等 npm 产物无需阅读。
