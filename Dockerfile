# syntax=docker/dockerfile:1

# 使用官方 Ubuntu 22.04 作为基础镜像
FROM ubuntu:22.04

# 设置环境变量，避免在 apt-get 安装过程中出现交互式提示
ENV DEBIAN_FRONTEND=noninteractive

# --- 1. 安装基础依赖、语言工具链和 Node.js ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    git \
    unzip \
    zip \
    build-essential \
    pkg-config \
    python3 \
    python3-pip \
    pypy3 \
    openjdk-17-jdk \
    kotlin \
    rustc \
    cargo \
    golang \
    # 安装 Node.js 20.x
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    # 清理 apt 缓存
    && rm -rf /var/lib/apt/lists/*

# --- 2. 更新 npm 到最新版本 ---
RUN npm install -g npm@latest

# --- 3. 安装 go-judge (自动检测架构) ---
RUN set -eux; \
  arch="$(uname -m)"; \
  case "$arch" in \
    x86_64)  goarch="amd64" ;; \
    aarch64) goarch="arm64" ;; \
    *) echo "Unsupported arch: $arch" && exit 1 ;; \
  esac; \
  url=$(curl -fsSL https://api.github.com/repos/criyle/go-judge/releases/latest \
    | jq -r --arg goarch "$goarch" '.assets[] | select(.name | test("linux.*\($goarch).*tar.gz$")) | .browser_download_url' \
    | head -n 1); \
  echo "Downloading go-judge for $arch ($url)"; \
  curl -fsSL "$url" | tar -xz -C /usr/local/bin go-judge; \
  chmod +x /usr/local/bin/go-judge

# --- 4. 设置应用工作目录并安装 Node.js 依赖 ---
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts

# --- 5. 拷贝应用代码和入口脚本 ---
COPY server.js entrypoint.sh ./
COPY src/ ./src/
COPY include/ ./include/
COPY config/ ./config/
COPY include/ /lib/testlib/

# 确保 entrypoint.sh 是可执行的，并修复可能的 Windows 换行符问题
RUN chmod +x entrypoint.sh && sed -i 's/\r$//' entrypoint.sh

# --- 6. 设置默认环境变量 ---
ENV PORT=8081 \
    GJ_ADDR=http://127.0.0.1:5050 \
    JUDGE_WORKERS=$(nproc) \
    GJ_PARALLELISM=$(nproc)

# --- 7. 设置容器入口点 ---
ENTRYPOINT ["/app/entrypoint.sh"]
