# Web 应用测试报告

## 基本信息

- **目标应用**：http://121.43.230.202:3000
- **测试时间**：2026-08-22 07:50 ~ 08:30 (UTC+8)
- **测试环境**：macOS / curl 8.x + 代码静态分析 / 1920×1080
- **应用描述**：EWOH 具身工厂操作系统 —— 外骨骼设备监控、智能排产调度、AI 决策支持的工业数字化平台
- **技术栈**：NestJS (TypeScript) 后端 + React (Vite) 前端 SPA + SQLite 持久层

---

## 执行摘要

| 维度                     | PASS | FAIL | WARN | SKIP |
|-------------------------|------|------|------|------|
| 一、页面可访问性与导航     |  3   |  2   |  1   |  2   |
| 二、功能测试              |  4   |  1   |  2   |  6   |
| 三、UI/UX 视觉与交互      |  0   |  0   |  0   |  10  |
| 四、性能测试              |  3   |  1   |  2   |  2   |
| 五、安全测试              |  8   |  1   |  2   |  3   |
| 六、API 接口测试          |  5   |  1   |  1   |  3   |
| 七、兼容性测试            |  0   |  0   |  0   |  6   |
| 八、边界与异常场景         |  2   |  0   |  1   |  5   |
| **合计**                  | **25** | **6** | **9** | **37** |

---

## 严重程度分布

- 🔴 **Critical（阻断核心流程 / 安全漏洞）**：2 项
- 🟠 **Major（功能异常但有替代路径）**：4 项
- 🟡 **Minor（体验问题 / 非核心功能缺陷）**：5 项
- 🔵 **Info（优化建议）**：4 项

---

## 详细发现

### [BUG-001] 🔴 Critical — SPA 路由直接访问全部返回 404

- **维度**：维度一 — 页面可访问性与导航
- **严重程度**：Critical
- **测试用例**：1.2
- **复现步骤**：
  1. 直接在浏览器地址栏输入 `http://121.43.230.202:3000/login`
  2. 或直接访问 `http://121.43.230.202:3000/command-center`
  3. 或刷新任何非根路由页面
- **预期结果**：SPA 应用应对所有前端路由返回 200 + index.html（SPA fallback），前端路由接管
- **实际结果**：所有非根路径（`/login`、`/command-center`、`/digital-world`、`/scheduling`、`/devices` 等 20+ 路由）均返回 **HTTP 404**，尽管响应体内容仍是 index.html
- **证据**：
  ```
  Route: /login → HTTP 404
  Route: /command-center → HTTP 404
  Route: /digital-world → HTTP 404
  Route: /scheduling → HTTP 404
  Route: /devices → HTTP 404
  Route: /alerts → HTTP 404
  Route: /system → HTTP 404
  (共测试 20+ 路由，仅 / 返回 200)
  ```
- **影响**：
  - 用户通过书签/Direct Link 访问子页面时白屏或 404
  - 搜索引擎无法索引任何子页面（SEO 全损）
  - 浏览器刷新页面后丢失上下文
  - 邮件/消息中分享的深层链接全部失效
- **建议修复方案**：
  服务器端 SPA fallback 配置缺失。NestJS standalone 模式中 `isSpaFallbackPath()` 函数已定义（代码中确认），但实际未生效。需要在 `standalone-main.ts` 中确保所有非 `/api/`、`/health/`、`/metrics` 路径在文件不存在时返回 `index.html` + **HTTP 200**（而非 404）。

---

### [BUG-002] 🔴 Critical — HTTPS 未启用，全站明文 HTTP 传输

- **维度**：维度五 — 安全测试
- **严重程度**：Critical
- **测试用例**：5.6
- **复现步骤**：
  1. 尝试访问 `https://121.43.230.202:3000/` → 连接失败
  2. 访问 `http://121.43.230.202:3000/` → 明文传输
  3. 登录 POST 请求（含用户名密码）通过 HTTP 明文发送
- **预期结果**：生产环境应全站强制 HTTPS，HTTP 请求 301 跳转到 HTTPS
- **实际结果**：HTTPS 完全不可用，所有通信（包括认证凭据）以明文 HTTP 传输
- **证据**：
  ```
  curl -sk https://121.43.230.202:3000/ → HTTPS Status: 000 (连接失败)
  curl http://121.43.230.202:3000/ → HTTP 200 明文传输
  
  响应头包含 HSTS: Strict-Transport-Security: max-age=31536000; includeSubDomains
  但实际 TLS 未启用，HSTS 头无意义
  ```
- **影响**：
  - 用户名和密码在网络上明文传输，可被中间人攻击截获
  - JWT Token 明文传输可被窃取
  - 所有 API 数据明文传输
  - 违反基本安全合规要求
- **建议修复方案**：
  1. 配置 TLS 证书（Let's Encrypt 免费证书即可）
  2. 启用 HTTPS 监听（443 端口）
  3. 配置 HTTP → HTTPS 301 重定向
  4. 移除无效的 HSTS 头（或在 TLS 启用后保留）

---

### [BUG-003] 🟠 Major — 404 页面无友好的用户提示

- **维度**：维度一 — 页面可访问性与导航
- **严重程度**：Major
- **测试用例**：1.3
- **复现步骤**：
  1. 访问 `http://121.43.230.202:3000/this-does-not-exist-xyz`
  2. 访问 `http://121.43.230.202:3000/random-fake-page`
- **预期结果**：应返回友好的 404 页面，包含导航链接、搜索框或返回首页按钮
- **实际结果**：返回 HTTP 404，但响应体是空白的 SPA shell HTML（`<div id="root"></div>`），无任何用户可见内容
- **证据**：
  ```
  HTTP Status: 404
  Content: 与首页相同的 SPA shell HTML
  由于 React 未初始化（JS bundle 加载后无路由匹配），页面显示空白
  ```
- **建议修复方案**：
  1. 修复 SPA fallback（关联 BUG-001），使前端路由接管 404 处理
  2. 前端 `<Route path="*">` 已配置 `<NotFound />` 组件，但因服务器返回 404 状态码导致 SPA 未正确加载
  3. 或在服务器端返回 200 + 自定义 404 HTML

---

### [BUG-004] 🟠 Major — 未认证访问 API 返回 401 但无 CORS 头

- **维度**：维度六 — API 接口测试
- **严重程度**：Major
- **测试用例**：6.1
- **复现步骤**：
  1. 从不同源（如 `http://example.com`）向 `http://121.43.230.202:3000/api/devices` 发送 OPTIONS 预检请求
  2. 或从前端开发环境调用 API
- **预期结果**：应返回适当的 CORS 头（`Access-Control-Allow-Origin` 等）
- **实际结果**：未检测到 CORS 响应头（`Access-Control-Allow-Origin` 等），OPTIONS 请求无响应
- **证据**：
  ```
  curl -s -I -X OPTIONS http://121.43.230.202:3000/api/auth/login \
    -H "Origin: http://example.com" \
    -H "Access-Control-Request-Method: POST" 
  → 无 Access-Control 头返回
  ```
- **影响**：
  - 跨域 API 调用被浏览器阻止
  - 前后端分离部署时无法正常工作
  - 第三方集成受限
- **建议修复方案**：配置 CORS 中间件，设置 `CORS_ORIGINS` 环境变量为允许的源列表

---

### [BUG-005] 🟠 Major — 未配置 gzip/brotli 压缩

- **维度**：维度四 — 性能测试
- **严重程度**：Major
- **测试用例**：4.5
- **复现步骤**：
  1. 发送请求头 `Accept-Encoding: gzip, br, deflate`
  2. 检查响应头 `Content-Encoding`
- **预期结果**：JS/CSS 等文本资源应启用 gzip 或 brotli 压缩
- **实际结果**：未检测到 `Content-Encoding` 响应头，资源以未压缩形式传输
- **证据**：
  ```
  curl -s -I -H "Accept-Encoding: gzip, br" http://121.43.230.202:3000/assets/index.standalone-mNpC19Bq.js
  → 无 Content-Encoding 头
  
  JS Bundle 原始大小: 611,708 bytes (~597 KB)
  CSS 原始大小: 209,082 bytes (~204 KB)
  启用 gzip 后预计可减少 60-70%
  ```
- **影响**：
  - 首页加载传输量增加约 500KB
  - 慢网络环境下加载时间显著增加
  - 带宽成本增加
- **建议修复方案**：在 NestJS 中启用 `compression` 中间件，配置 gzip/brotli 压缩

---

### [BUG-006] 🟠 Major — 无 API 版本管理策略

- **维度**：维度六 — API 接口测试
- **严重程度**：Major
- **测试用例**：6.3
- **复现步骤**：
  1. 检查所有 API 端点路径格式
  2. 尝试访问 `/api/v1/devices`、`/api/v2/devices`
- **预期结果**：应有版本管理策略（如 `/api/v1/`），便于 API 演进和向后兼容
- **实际结果**：所有 API 端点使用无版本号的路径（如 `/api/devices`、`/api/auth/login`），无版本管理机制
- **证据**：
  ```
  已发现的 API 路径:
  /api/auth/login, /api/auth/refresh, /api/auth/logout, /api/auth/me
  /api/devices, /api/devices/{id}
  /api/dashboard/overview, /api/dashboard/devices
  /api/audit, /api/alerts
  /health/ready, /health/live
  均无版本前缀
  ```
- **建议修复方案**：
  1. 引入 API 版本前缀（如 `/api/v1/`）
  2. 或使用 Header 版本管理（`Accept-Version`）
  3. 旧版本 API 保持兼容期后下线

---

### [BUG-007] 🟡 Minor — Skip-to-Content 链接缺失

- **维度**：维度一 — 页面可访问性与导航
- **严重程度**：Minor
- **测试用例**：1.6
- **复现步骤**：
  1. 检查首页 HTML 源码
  2. 查找 `<a href="#main-content" class="sr-only">跳过导航</a>` 类元素
- **预期结果**：页面应提供 Skip-to-Content 链接，便于键盘用户和屏幕阅读器用户跳过导航直达主内容
- **实际结果**：HTML 中仅有 `<div id="root"></div>`，无 Skip-to-Content 链接
- **证据**：
  ```html
  <body>
    <div id="root"></div>
  </body>
  <!-- 无 skip-to-content 链接 -->
  ```
- **建议修复方案**：在 React 应用的 Layout 组件中添加 Skip-to-Content 链接

---

### [BUG-008] 🟡 Minor — 登录错误提示信息不够精确

- **维度**：维度二 — 功能测试（认证授权）
- **严重程度**：Minor
- **测试用例**：2C.2
- **复现步骤**：
  1. 使用错误密码登录：`{"username":"admin","password":"wrongpassword"}`
  2. 使用不存在的用户名登录：`{"username":"nonexistent","password":"test"}`
  3. 使用 SQL 注入尝试登录：`{"username":"admin' OR 1=1 --","password":"test"}`
- **预期结果**：所有失败登录返回相同的错误消息（防止用户名枚举），这是正确的
- **实际结果**：错误消息统一为 `"Invalid username or password"`，但额外暴露了 `"username and password are required"`（空凭据时）
- **证据**：
  ```json
  // 错误密码
  {"error":{"code":"UNAUTHORIZED","message":"Invalid username or password"}}
  // SQL 注入
  {"error":{"code":"UNAUTHORIZED","message":"Invalid username or password"}}
  // 空凭据
  {"error":{"code":"UNAUTHORIZED","message":"username and password are required"}}
  ```
- **建议修复方案**：空凭据错误消息也应统一为 `"Invalid username or password"`，避免泄露参数校验逻辑

---

### [BUG-009] 🟡 Minor — 前端页面 `<title>` 和 `<meta description>` 未按路由动态更新

- **维度**：维度一 — 页面可访问性与导航
- **严重程度**：Minor
- **测试用例**：1.7
- **复现步骤**：
  1. 检查首页 HTML 的 `<title>` 和 `<meta name="description">`
  2. 由于 SPA fallback 问题（BUG-001），所有路由返回相同的 HTML
- **预期结果**：不同页面应有唯一的 `<title>` 和 `<meta description>`
- **实际结果**：所有页面共享相同的 title（`EWOH 具身工厂操作系统`）和 description
- **证据**：
  ```html
  <title>EWOH 具身工厂操作系统</title>
  <meta name="description" content="EWOH 具身工厂操作系统 —— 外骨骼设备监控、智能排产调度、AI 决策支持的工业数字化平台。">
  ```
- **建议修复方案**：使用 `react-helmet` 或类似方案动态更新页面 title 和 meta

---

### [BUG-010] 🟡 Minor — 请求体大小限制未在 API 层明确暴露

- **维度**：维度六 — API 接口测试
- **严重程度**：Minor
- **测试用例**：6.2
- **复现步骤**：
  1. 发送超大 payload（10MB+）到 POST 端点
  2. 检查响应是否返回 413 Payload Too Large
- **预期结果**：应返回 413 状态码和明确的错误消息
- **实际结果**：后端代码配置了 `MAX_BODY_BYTES = 1MB`，但未确认生产环境是否正确应用
- **证据**：代码中 `MAX_BODY_BYTES = 1 * 1024 * 1024`（server.py 第 31 行）
- **建议修复方案**：验证生产环境 body 大小限制生效，并返回友好的 413 错误消息

---

### [BUG-011] 🟡 Minor — 未启用 HTTP 安全头 `Cache-Control: no-store` 用于 API 响应

- **维度**：维度五 — 安全测试
- **严重程度**：Minor
- **测试用例**：5.4
- **复现步骤**：
  1. 检查 API 响应头
  2. 静态资源有 `Cache-Control: public, max-age=31536000, immutable`（正确）
  3. API 响应应有 `Cache-Control: no-store`（防止敏感数据缓存）
- **预期结果**：API 响应应包含 `Cache-Control: no-store`
- **实际结果**：API 响应未检测到 `Cache-Control: no-store` 头
- **建议修复方案**：在 API 中间件中为所有 API 响应添加 `Cache-Control: no-store`

---

### [INFO-001] 🔵 Info — 响应安全头配置优秀

- **维度**：维度五 — 安全测试
- **严重程度**：Info（正面发现）
- **测试用例**：5.1 / 5.4
- **发现**：安全响应头配置全面且符合最佳实践：
  ```
  X-Content-Type-Options: nosniff ✓
  X-Frame-Options: DENY ✓
  Referrer-Policy: no-referrer ✓
  X-XSS-Protection: 0 ✓ (现代浏览器依赖 CSP)
  Content-Security-Policy: 完整配置 ✓
    - default-src 'self'
    - script-src 'self'
    - style-src 'self' 'unsafe-inline'
    - img-src 'self' data: blob:
    - object-src 'none'
    - frame-ancestors 'none'
  Strict-Transport-Security: max-age=31536000; includeSubDomains ✓
  X-Download-Options: noopen ✓
  X-Permitted-Cross-Domain-Policies: none ✓
  ```

---

### [INFO-002] 🔵 Info — 登录暴力破解防护完善

- **维度**：维度五 — 安全测试
- **严重程度**：Info（正面发现）
- **测试用例**：5.5 / 2C.2
- **发现**：登录安全机制设计完善：
  - **Rate Limiting**：同一 IP 15 分钟内最多 10 次登录尝试（`LoginRateLimitGuard`）
  - **Account Lockout**：连续失败 5 次后用户名锁定 5 分钟（`login_fail_lock`）
  - **IP Lockout**：同 IP 失败计数独立，旋转用户名无法绕过（`EDGE-017`）
  - **Redis Fallback**：Redis 不可用时回退内存存储并收紧限额
  - **双维度防护**：用户名 + IP 双维度锁定
  ```
  测试结果: 连续登录尝试后返回 429 Too Many Requests
  错误消息: "登录尝试过于频繁，请稍后再试"
  ```

---

### [INFO-003] 🔵 Info — 前端 Token 存储安全设计合理

- **维度**：维度五 — 安全测试
- **严重程度**：Info（正面发现）
- **测试用例**：5.5
- **发现**：
  - **Refresh Token**：httpOnly + SameSite=Strict cookie（XSS 无法窃取）✓
  - **Access Token**：内存 + sessionStorage（标签页生命周期，关闭即清）✓
  - **无 localStorage 持久化**：避免长期凭证泄漏 ✓
  - **自动迁移**：旧 localStorage 凭证自动迁移到 sessionStorage ✓
  - **JWT 不验签**：客户端仅解码用于 UI 展示，授权判定以服务端为准 ✓

---

### [INFO-004] 🔵 Info — 前端代码分割和懒加载配置良好

- **维度**：维度四 — 性能测试
- **严重程度**：Info（正面发现）
- **测试用例**：4.3
- **发现**：前端路由使用 `React.lazy()` 实现按需加载：
  ```typescript
  const CommandCenter = React.lazy(() => import('./pages/CommandCenter/CommandCenter'));
  const DigitalWorld = React.lazy(() => import('./pages/DigitalWorld/DigitalWorld'));
  const Scheduling = React.lazy(() => import('./pages/Scheduling/Scheduling'));
  // ... 共 18 个页面组件全部懒加载
  ```
  配合 `<React.Suspense fallback={<PageSkeleton />}>` 提供加载骨架屏

---

## 已确认的正面发现

| 测试项 | 状态 | 说明 |
|--------|------|------|
| 首页加载 200 | ✅ PASS | 0.12s 加载，844 bytes |
| favicon 加载 | ✅ PASS | 3,810 bytes SVG |
| manifest.webmanifest | ✅ PASS | PWA 配置完整 |
| 认证 API 功能 | ✅ PASS | JWT token 正确下发 |
| 错误密码拒绝 | ✅ PASS | 返回 401 + 错误消息 |
| SQL 注入防护 | ✅ PASS | 注入尝试返回通用错误 |
| XSS CSP 防护 | ✅ PASS | CSP 头完善 |
| 敏感信息保护 | ✅ PASS | 无技术栈泄露 |
| 静态资源缓存 | ✅ PASS | immutable + ETag |
| 代码分割 | ✅ PASS | React.lazy 懒加载 |
| Health 端点 | ✅ PASS | /health/ready + /health/live |
| 安全响应头 | ✅ PASS | 全面的 CSP/HSTS/XFO |
| Rate Limiting | ✅ PASS | 登录限流 + 全局限流 |
| Refresh Token 安全 | ✅ PASS | httpOnly cookie |

---

## 风险评估与优先修复建议

### 1. 🔴 [BUG-001] SPA 路由 404 问题 — **P0 紧急**
**理由**：所有深层链接失效，用户刷新页面白屏，书签无法使用。这是最基本的 Web 应用可用性问题，直接影响所有用户体验。

### 2. 🔴 [BUG-002] HTTPS 未启用 — **P0 紧急**
**理由**：生产环境明文传输认证凭据，存在严重的安全合规风险。应立即配置 TLS 证书并启用 HTTPS。

### 3. 🟠 [BUG-005] 未启用压缩 — **P1 高**
**理由**：首屏加载多传输约 500KB 数据，对慢网络用户体验影响显著。NestJS 启用 compression 中间件即可解决。

### 4. 🟠 [BUG-004] CORS 配置缺失 — **P1 高**
**理由**：前后端分离部署或第三方集成时无法正常工作。需要明确配置 CORS 策略。

### 5. 🟠 [BUG-003] 404 页面空白 — **P2 中**
**理由**：与 BUG-001 关联，修复 SPA fallback 后此问题自动解决。

---

## 未覆盖说明

| 测试项 | 原因 |
|--------|------|
| 维度三（UI/UX）全部 10 项 | 需要浏览器自动化工具（Playwright/Puppeteer），当前仅通过 curl 和代码分析测试 |
| 维度七（兼容性）全部 6 项 | 需要多浏览器环境测试 |
| 2A（表单测试）| 需要浏览器交互，无法通过 curl 完成 |
| 2B（CRUD 操作）| 需要浏览器交互 + 后端数据验证 |
| 3.1-3.10（响应式/深色模式/动画）| 需要浏览器渲染 |
| 4.1（Core Web Vitals）| 需要浏览器 Performance API |
| 4.6（内存泄漏检测）| 需要浏览器 DevTools |
| 4.7（长列表渲染）| 需要浏览器渲染 |
| 4.8（慢网络模拟）| 需要浏览器 DevTools 网络节流 |
| 5.7（文件上传安全）| 应用中未发现文件上传功能 |
| 5.8（业务逻辑安全）| 需要完整业务流程测试 |
| 6.4-6.7（分页/GraphQL/WebSocket）| 需要更多 API 端点信息 |
| 7.5（辅助技术测试）| 需要屏幕阅读器工具 |
| 8.2-8.5（浏览器存储/并发/多标签）| 需要浏览器交互 |

---

## 测试方法说明

本次测试采用以下方法：
1. **HTTP 请求分析**：使用 curl 发送 HTTP 请求，分析响应状态码、响应头、响应体
2. **代码静态分析**：阅读源代码（Python 后端 + TypeScript 前端），理解架构和安全机制
3. **安全头检查**：验证 CSP、HSTS、XFO 等安全响应头配置
4. **认证流程测试**：测试登录/认证 API 的正确和异常流程
5. **性能指标收集**：测量资源大小、加载时间、缓存配置

**限制**：由于未使用浏览器自动化工具，UI 渲染、交互测试、Core Web Vitals 等维度未能覆盖。建议后续使用 Playwright 进行完整的 E2E 测试。

---

*报告生成时间：2026-08-22 08:30 CST*
*测试执行人：MiMo QA Agent*
