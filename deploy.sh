#!/usr/bin/env bash
#
# deploy.sh — SmartTrade 一键部署更新脚本
#
# 用法：
#   bash deploy.sh              # 默认更新，不带 Web
#   bash deploy.sh web          # 更新后以 Web 模式重启
#
# 前置条件：
#   - 服务器已安装 Node.js >= 18、npm、git
#   - 已配置 SSH 密钥（或有权限 pull）
#   - 项目目录已经是 git 仓库，且 remote origin 正确
#   - (可选) 已安装 PM2 — 如果未安装，脚本会询问安装方式
#
# 不会覆盖：
#   - .env（API 密钥、配置）
#   - data/ 下的数据库文件

set -euo pipefail

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

# ── 步骤 1: 拉取最新代码 ──
echo ""
echo "========================================"
echo " SmartTrade 部署更新"
echo "========================================"
echo ""

info "拉取最新代码..."
git pull
info "当前 commit: $(git rev-parse --short HEAD)"

# ── 步骤 2: 安装依赖 ──
echo ""
info "安装依赖..."
npm install --omit=dev

# ── 步骤 3: 编译 TypeScript ──
echo ""
info "编译 TypeScript..."
npm run build

# ── 步骤 4: 日志目录 ──
mkdir -p data/logs

# ── 步骤 5: 重启进程 ──
echo ""
MODE="${1:-}"

if command -v pm2 &> /dev/null; then
  if [ "$MODE" = "web" ]; then
    info "重启 smarttrade (Web 模式)..."
    pm2 start ecosystem.config.js --env web --update-env 2>/dev/null || \
    pm2 restart ecosystem.config.js --env web --update-env
  else
    info "重启 smarttrade..."
    pm2 start ecosystem.config.js --update-env 2>/dev/null || \
    pm2 restart ecosystem.config.js --update-env
  fi
  pm2 save
  info "部署完成！"
  echo ""
  pm2 show smarttrade
elif [ "$MODE" = "web" ]; then
  warn "未检测到 PM2，使用 node 直接启动 (Web 模式)..."
  node dist/index.js --web
else
  warn "未检测到 PM2，使用 node 直接启动..."
  node dist/index.js
fi

echo ""
echo "========================================"
echo " 部署完成"
echo "========================================"
