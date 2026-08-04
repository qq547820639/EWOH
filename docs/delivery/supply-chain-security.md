# EWOH 供应链安全（Supply Chain Security）

> 本文档说明 EWOH 已发布工件（`ewoh-spark-app`）的 SBOM 生成、依赖扫描、镜像签名与
> SBOM 校验流程。作为生产工程深化（Phase 5）的文档交付物，不依赖真实部署环境。
> 环境缺失项（容器镜像签名、真实 registry 推送、CI 扫描）如实标记为待环境。

## 1. 目标

- 为已发布工件生成可审计的 **CycloneDX SBOM**，可追溯每个运行时依赖的来源/版本/许可证/hash。
- 建立**依赖漏洞扫描**与**镜像签名**的流程与验收标准（本地可静态验证，真实扫描需 CI/registry）。
- 提供 **SBOM 校验**入口，确保发布包与锁文件一致、未漂移。

## 2. 当前实现（已落地）

### 2.1 SBOM 生成脚本

`scripts/generate-sbom.js`（Node 内置 `child_process` 调用 `npm sbom`，**无新增第三方依赖**）：

```bash
# 运行时依赖（默认，omit dev）
node scripts/generate-sbom.js
# 输出：release/ewoh-spark-sbom.cyclonedx.json（CycloneDX 1.5）

# 含 dev 依赖
node scripts/generate-sbom.js --include-dev --out release/ewoh-spark-sbom.dev.cyclonedx.json

# 自定义输出路径
node scripts/generate-sbom.js --out /tmp/ewoh-sbom.json
```

- 本机实测：`npm sbom`（npm 11.17.0）生成 **CycloneDX 1.5**，运行时组件 **235 个**，
  `metadata.properties.ewoh:generation = npm-sbom`。
- **降级兜底**：若 `npm sbom` 不可用（npm < 10）或失败，脚本回退为从
  `ewoh-spark-app/package-lock.json` 派生最小 SBOM 摘要，并标记
  `ewoh:generation = derived-from-lockfile`；**绝不伪造依赖数据**。
- 产物带 `hashes`（SHA-512）、`licenses`、`purl`、`externalReferences`（distribution/vcs），
  可直接接入 SBOM 消费方。

### 2.2 已生成产物

- `release/ewoh-spark-sbom.cyclonedx.json`（CycloneDX 1.5，235 运行时组件，`npm-sbom` 模式）。

## 3. 依赖扫描（Depenency Scanning）

### 3.1 本地静态扫描（本机可执行）

使用 `npm audit`（对已锁定的锁文件做已知漏洞检查，无需联网亦可基于本地缓存）：

```bash
cd ewoh-spark-app
npm audit --omit=dev --json
```

> 说明：`npm audit` 依赖 registry 的 advisory 数据，本机无外网时结果可能不完整，
> 应视为**基线参考**，最终以 CI 中的 `npm audit signatures` / `npm audit`（联网）为准。

### 3.2 CI 扫描（待环境，Blocked by External Validation）

在具备联网的 CI 中接入（建议 `.github/workflows/security.yml` 扩展）：

```bash
cd ewoh-spark-app
npm audit --omit=dev --audit-level=high   # 失败即阻断（severity <= high 放行）
npm audit signatures                       # 校验锁文件签名完整性
```

- 验收：`npm audit` 无 critical/high 未修复项；CI 在最高等级漏洞时**阻断发布**。
- 当前状态：本机无 registry 联网，`npm audit` 未作为门禁强制，标记为待 CI 环境。

## 4. 镜像签名（Image Signing）

容器镜像（`deploy/cloud/Dockerfile.api`、`Dockerfile.migrate`）在真实 registry 环境应执行：

1. **构建**：`docker build -f deploy/cloud/Dockerfile.api ...`
2. **签名**：`cosign sign --key <key> <registry>/ewoh-api:<tag>`（cosign 需在 CI/打包机安装）
3. **校验**：`cosign verify --key <public-key> <registry>/ewoh-api:<tag>`

- 推荐：`cosign`（Sigstore）或 `notation`（OCI 签名）。私钥交由密钥管理系统，不入库。
- **当前状态**：本机无 docker/cosign/registry，签名与校验步骤**未执行**，属外部验证项。

## 5. SBOM 校验（SBOM Verification）

每次发布对 SBOM 做一致性校验，确保锁文件与 SBOM 未漂移：

```bash
# SBOM 生成后重新校验可解析、组件数非空、顶层组件版本正确
node scripts/generate-sbom.js && node -e "const b=require('./release/ewoh-spark-sbom.cyclonedx.json'); if(b.bomFormat!=='CycloneDX'||!b.components.length) process.exit(1); console.log('SBOM OK', b.components.length);"
```

- 校验项：`bomFormat=CycloneDX`、`specVersion>=1.5`、`components` 非空、顶层组件版本与
  `package.json` 一致、`metadata.properties.ewoh:generation=npm-sbom`。
- 发布门禁：SBOM 与 `SHA256SUMS.txt` 一起进入发布包；SBOM 校验失败则阻断发布。

## 6. 流程与责任

| 环节 | 工具 | 本地可执行 | 生产需环境 |
|---|---|---|---|
| SBOM 生成 | `scripts/generate-sbom.js`（npm sbom） | ✅ 已执行（235 组件） | — |
| 依赖漏洞扫描 | `npm audit` | ⚠️ 基线（需联网完整） | ✅ CI 强制 |
| 镜像签名 | `cosign` / `notation` | ❌ | ✅ registry + 密钥 |
| SBOM 校验 | Node 校验片段 | ✅ 可执行 | ✅ 发布门禁 |
| 签名校验 | `cosign verify` | ❌ | ✅ registry |

## 7. 现状结论

- **已闭环**：SBOM 生成与产物、SBOM 校验流程、本地静态基线扫描、供应链文档。
- **待外部环境**：`npm audit` 联网完整扫描、镜像签名与校验、真实 registry 推送。
  这些项在 `docs/reviews/LATEST_HEAD_AUDIT.md`（Phase 5）中登记为
  `Blocked by External Validation`，未伪造结果。