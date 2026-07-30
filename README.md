# EWOH 受控试点系统

外骨骼人员作业协同与风险分析平台。纯 Python 标准库实现，运行时零第三方依赖。

本仓库分为两层：

- **`delivery/`** — V1.0 一次性交付包（冻结）。包含开发基线、技术规范、数据与算法、
  安全合规、测试验收、V0.5 演示原型、场景评估、商务谈判与源文件，附 SHA256 校验清单。
  进入 `delivery/` 后按 `delivery/00_交付总览/README.md` 使用。
- **`src/edge_platform/`** — V0.6 受控试点系统（活跃开发）。已取代 `delivery/06_Demo_Prototype`
  中的 V0.5 原型。

## 顶层目录

| 目录/文件              | 说明                                                          |
|------------------------|---------------------------------------------------------------|
| `delivery/`            | V1.0 冻结交付包（`00_`~`09_` + 项目执行总控台）              |
| `src/edge_platform/`   | V0.6 活跃平台代码（采集/推理/适配/服务/API）                  |
| `docs/`                | 活跃开发文档（API/部署/运维/验收骨架）                        |
| `deploy/`              | 试点部署编排（`docker-compose.yml` + `.env.example`）         |
| `Makefile`             | 常用命令入口（run/test/lint/security/format/clean）          |
| `pyproject.toml`       | 项目元数据与工具配置（src 布局）                              |
| `SECURITY.md`          | 安全策略与平台安全边界声明                                    |
| `CHANGELOG.md`         | 变更日志                                                      |

## 快速开始（开发环境）

```bash
python -m pip install -r requirements-dev.txt   # 可选：ruff/bandit/pytest
make run          # 启动平台（真实模块缺失时回退 stub），访问 http://127.0.0.1:8765
make test         # unittest 测试套件
make lint         # ruff 静态检查
```

代码采用 `src/` 布局，`make run` 等价于 `PYTHONPATH=src python -m edge_platform.run`。

## 试点部署

```bash
cd deploy
cp .env.example .env   # 按现场填写
docker compose up -d
```

详见 `docs/deployment/README.md`。

## 安全边界

EWOH 是只读监督与风险分析平台，**不参与设备实时安全控制**。急停、限扭、关节实时控制、
助力闭环等能力永久保留在设备控制器本地。详见 `SECURITY.md`。

## 交付包校验

V1.0 冻结交付包位于 `delivery/`，校验清单见 `delivery/00_交付总览/SHA256SUMS.txt`：

```bash
cd delivery
sha256sum -c 00_交付总览/SHA256SUMS.txt
```
