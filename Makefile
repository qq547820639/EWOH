# EWOH 受控试点系统 - 常用命令
# 用法：make <target>   例如 make test / make lint / make run
# 开发环境推荐以进程方式运行（make run），docker-compose 用于试点部署。
# 代码采用 src/ 布局，运行入口通过 PYTHONPATH=src 解析 edge_platform 包。

.PHONY: run run-stub demo test test-contract connector-tck lint lint-fix security format clean help

PYTHON ?= python3

help:  ## 显示所有可用目标
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

run:  ## 启动平台（装配真实模块，缺失时回退 stub）
	PYTHONPATH=src $(PYTHON) -m edge_platform.run

run-stub:  ## 强制以 stub 模式启动（仅工程自测，不作为真机验收依据）
	PYTHONPATH=src $(PYTHON) -m edge_platform.run --stub

demo:  ## 一键演示：启动 stub 平台并自动打开指挥地图（Ctrl-C 停止）
	$(PYTHON) tools/run_demo.py --port 8765

test:  ## 运行 unittest 测试套件
	$(PYTHON) -m unittest discover -s src/edge_platform/tests -v

test-contract:  ## 运行契约测试（tests/，需 pytest；也可用 unittest 运行）
	PYTHONPATH=src $(PYTHON) -m pytest tests/ -q

connector-tck:  ## 运行连接器 TCK（Manifest/配置/健康/脱敏/乱序补传）
	PYTHONPATH=src $(PYTHON) scripts/connector-tck.py

lint:  ## 静态检查（ruff，不修改代码）
	ruff check src/edge_platform

lint-fix:  ## 自动修复可修复的 lint 问题（import 排序等）
	ruff check --fix src/edge_platform

security:  ## 静态安全扫描（bandit，低噪音级别）
	bandit -r src/edge_platform -ll

format:  ## 代码格式化（ruff format）
	ruff format src/edge_platform

clean:  ## 清理构建产物与临时文件
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	find . -type f -name '*.pyc' -delete
	rm -f src/edge_platform/demo.db ./demo.db
	rm -rf logs .pytest_cache .ruff_cache
