#!/usr/bin/env bash
#
# UX-009 端到端体验测试矩阵 —— CI 触发脚本。
#
# 职责：
#   1. 确保 standalone 客户端构建产物存在（mock 静态托管依赖 dist/client）。
#   2. 收集并列出 UX-009 用例（验证可被 Playwright 收集）。
#   3. 运行 UX-009 用例（mock 数据层，无需真实后端/数据库）。
#   4. 可选：视觉回归（需显式设置 EWOH_VISUAL=1 并有基线）。
#
# 使用：
#   bash scripts/e2e-check.sh
#   EWOH_VISUAL=1 bash scripts/e2e-check.sh   # 额外跑视觉回归
#
# 说明：视觉回归 / 无障碍 / 多视口用例已包含在 UX-009 集合中；视觉用例默认跳过，
#       仅当 EWOH_VISUAL=1 且存在基线时运行。
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> [1/4] 检查 dist/client 构建产物"
if [ ! -f "dist/client/index.standalone.html" ]; then
  echo "    dist/client 缺失，开始构建 standalone 客户端..."
  npm run build:client:standalone
else
  echo "    dist/client 已存在"
fi

echo "==> [2/4] 列出 UX-009 用例（验证可被 Playwright 收集）"
npx playwright test --config playwright.config.ts --list --grep "UX-009"

echo "==> [3/4] 运行 UX-009 端到端用例（mock 数据，无需真实后端）"
# --workers=1 与主配置一致；--retries=0 保证失败如实上报，不掩藏
npx playwright test --config playwright.config.ts --grep "UX-009" --retries=0

if [ "${EWOH_VISUAL:-0}" = "1" ]; then
  echo "==> [4/4] 运行视觉回归（EWOH_VISUAL=1）"
  npx playwright test --config playwright.visual.config.ts
else
  echo "==> [4/4] 跳过视觉回归（未设置 EWOH_VISUAL=1）"
fi

echo "==> UX-009 端到端检查完成"