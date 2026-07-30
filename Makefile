# EWOH 受控试点系统 - 常用命令
# 用法：make <target>   例如 make test / make lint / make run
# 开发环境推荐以进程方式运行（make run），docker-compose 用于试点部署。

.PHONY: run run-stub test lint lint-fix security format clean help

help:  ## 显示所有可用目标
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

run:  ## 启动平台（装配真实模块，缺失时回退 stub）
	python -m edge_platform.run

run-stub:  ## 强制以 stub 模式启动（仅工程自测，不作为真机验收依据）
	python -m edge_platform.run --stub

test:  ## 运行 unittest 测试套件
	python -m unittest discover -s edge_platform/tests -v

lint:  ## 静态检查（ruff，不修改代码）
	ruff check edge_platform

lint-fix:  ## 自动修复可修复的 lint 问题（import 排序等）
	ruff check --fix edge_platform

security:  ## 静态安全扫描（bandit，低噪音级别）
	bandit -r edge_platform -ll

format:  ## 代码格式化（ruff format）
	ruff format edge_platform

clean:  ## 清理构建产物与临时文件
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	find . -type f -name '*.pyc' -delete
	rm -f edge_platform/demo.db ./demo.db
	rm -rf logs .pytest_cache .ruff_cache
