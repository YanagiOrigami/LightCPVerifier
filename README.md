# LightCPVerifier

LightCPVerifier 是一个轻量级的编程题评测系统（Compatible Programming Problem Judger），基于 [go-judge](https://github.com/criyle/go-judge) 提供沙箱运行，支持 **传统型题目 + 特殊评测（SPJ）**，目前仅支持默认题型（`type=default`）。

## 特性

- 支持多语言：C++17 / Python3 / PyPy3 / Java
- 题目配置基于 `config.yaml`，支持子任务与测试点的时间、内存限制配置
- 沙箱内编译与运行（完全遵循 go-judge 的设计）
- 支持 testlib 检查器（SPJ），可自动编译并运行
- 内存队列 + 本地持久化结果
- REST API 接口，便于与其他系统对接
- 自动分桶保存提交（减少单目录文件过多）

---

## 目录结构

```plaintext
LightCPVerifier/
├── problems/                # 存放题目
│   └── <pid>/
│       ├── config.yaml       # 题目配置
│       ├── statement.txt     # 题面
│       ├── checker.cc        # 检查器 (可选，默认 chk.cc)
│       └── testdata/         # 测试数据 (.in/.out 或 .in/.ans)
├── data/                     # 运行时数据（计数器等）
├── submissions/              # 提交归档
├── server.js                 # 评测服务主程序
└── package.json
```

---

## 题目配置示例 (`config.yaml`)

```yaml
type: default
time: 1s
memory: 256m
subtasks:
  - time: 1s
    memory: 256m
    cases:
      - input: 1.in
        output: 1.out
      - input: 2.in
        output: 2.out
checker: chk.cc
checker_type: testlib
filename: main.cpp
```

---

## 环境准备

### 1. 安装依赖

- Node.js 18+
- g++, openjdk, python3, pypy3
- [go-judge](https://github.com/criyle/go-judge)

```bash
apt-get update && apt-get install -y   g++ openjdk-17-jdk-headless python3 pypy3
```

### 2. 在镜像中添加 testlib

假设你的 testlib 在 `include/` 目录：

```dockerfile
# Dockerfile 片段
COPY include/ /lib/testlib/
RUN chmod -R a+r /lib/testlib
```

### 3. 配置 go-judge 挂载

`mount.yaml` 添加：

```yaml
- source: /lib/testlib
  destination: /lib/testlib
  readOnly: true
```

启动 go-judge 时指定：

```bash
go-judge --mount-conf=mount.yaml
```

---

## 运行 LightCPVerifier

1. 启动 go-judge
   ```bash
   go-judge --mount-conf=mount.yaml
   ```
2. 启动 Node.js 评测服务
   ```bash
   npm install
   node server.js
   ```

默认端口 `8081`，可通过 `PORT` 环境变量调整。

---

## API

### 提交代码

`POST /submit`

```json
{
  "pid": "A001",
  "lang": "cpp",
  "code": "#include <bits/stdc++.h>\nusing namespace std; int main(){...}"
}
```

返回：
```json
{ "sid": 1 }
```

---

### 查询结果

`GET /result/:sid`

返回：
```json
{
  "status": "done",
  "passed": true,
  "cases": [
    { "ok": true, "status": "Accepted", "time": 1000000, "memory": 65536, "msg": "" }
  ]
}
```

---

### 获取题面

`GET /problem/:pid/statement`  
返回纯文本题面。

---

### 健康检查

`GET /health`  
返回 `{ "ok": true }`

---

### 获得Submissions

`GET /submissions/expert`
返回 tar.gz 压缩包

---

### 获得全部题目&题面

`GET /problems`
`GET /problems?statement=true`
返回题目和题面

---



## 环境变量

| 变量名             | 默认值                   | 说明 |
|--------------------|--------------------------|------|
| `PORT`             | 8081                     | 服务端口 |
| `GJ_ADDR`          | http://127.0.0.1:5050    | go-judge 地址 |
| `TESTLIB_INSIDE`   | /lib/testlib              | testlib 在沙箱中的路径 |
| `SUB_BUCKET`       | 100                      | 提交分桶大小 |
| `SUBMISSIONS_DIR`  | ./submissions            | 提交归档目录 |
| `JUDGE_WORKERS`    | 4                        | 并发 Worker 数量 |
