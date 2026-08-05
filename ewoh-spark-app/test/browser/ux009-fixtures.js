/**
 * UX-009 端到端体验测试矩阵 —— 共享 fixture 模块。
 *
 * 设计目标：让 UX-009 的浏览器用例可独立运行（无需真实后端 / 数据库）。
 *  1. 启动一个只读静态服务器，托管 `dist/client` 的 standalone 构建产物，
 *     并提供 SPA history fallback（非文件路径一律回退到 index.standalone.html）。
 *  2. 通过 `page.addInitScript` 预注入 localStorage 会话，模拟不同角色登录态。
 *  3. 通过 `page.route` 拦截 `/api/**`，返回可控的 mock 数据层。
 *  4. 提供离线 / 弱网 / 多视口 / 无障碍语义检查等辅助函数。
 *
 * 说明：本模块不是 spec 文件（不以 .spec.js 结尾），不会被 Playwright 收集。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_DIR = path.resolve(__dirname, '..', '..', 'dist', 'client');
const INDEX_HTML = path.join(CLIENT_DIR, 'index.standalone.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

/**
 * 启动托管 dist/client 的静态服务器。
 * 返回 { baseUrl, close }。端口取 0（自动分配），避免与其它用例冲突。
 */
function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      let filePath = path.join(CLIENT_DIR, url.pathname);
      if (url.pathname === '/') filePath = INDEX_HTML;
      if (!filePath.startsWith(CLIENT_DIR)) filePath = INDEX_HTML;
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        // SPA history fallback：非资源路径一律回退到 index.standalone.html
        filePath = INDEX_HTML;
      }
      const ext = path.extname(filePath).toLowerCase();
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** 分成小块按带宽速率限速写入响应体（bytes/sec，0 表示不限速）。 */
function writeRateLimited(res, data, bytesPerSec) {
  const CHUNK = 16384;
  let offset = 0;
  const delayMs = Math.max(1, (CHUNK / bytesPerSec) * 1000);
  const timer = setInterval(() => {
    if (offset >= data.length) {
      clearInterval(timer);
      res.end();
      return;
    }
    const end = Math.min(offset + CHUNK, data.length);
    res.write(data.subarray(offset, end));
    offset = end;
  }, delayMs);
  res.on('close', () => clearInterval(timer));
}

/**
 * 统一的服务端限速/故障注入层（state 见 startThrottledServer）。
 * 顺序：随机断连(dropRate) → 错误状态注入(errorStatus) → 超时(timeoutMs) → 延迟(latency) → 带宽(bandwidth)。
 * 这是纯 node http 实现，与浏览器无关，因此 Chromium / Firefox / WebKit 命中同一套弱网语义。
 */
function serveThrottled(res, state, response) {
  if (state.dropRate > 0 && Math.random() < state.dropRate) {
    // 随机断连：直接销毁 socket，模拟物理断网/连接重置。
    res.destroy();
    return;
  }
  if (state.errorStatus) {
    response = {
      status: state.errorStatus,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({ message: `injected error ${state.errorStatus}` }),
      ),
    };
  }
  const body = Buffer.isBuffer(response.body)
    ? response.body
    : Buffer.from(String(response.body));
  let finished = false;
  const timer =
    state.timeoutMs > 0
      ? setTimeout(() => {
          if (!finished) {
            // 网关超时：挂起后销毁连接，模拟后端超时。
            res.destroy();
          }
        }, state.timeoutMs)
      : null;
  const send = () => {
    if (finished || res.destroyed) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    res.writeHead(response.status || 200, response.headers || {});
    if (state.bandwidth && state.bandwidth > 0) {
      writeRateLimited(res, body, state.bandwidth);
    } else {
      res.end(body);
    }
    finished = true;
  };
  if (state.latency && state.latency > 0) {
    setTimeout(send, state.latency);
  } else {
    send();
  }
}

/** 行为与真实 sw.js 等价、版本/契约可参数化的模板 Service Worker（复用 sw-update 思路）。 */
function swScript(version, contract) {
  return `const BASE='sw-test';const VER='${version}';const CONTRACT='${contract}';
self.addEventListener('install',(e)=>{e.waitUntil((async()=>{const c=await caches.open(BASE+'-'+VER);await c.add('/index.standalone.html').catch(()=>undefined);})())});
self.addEventListener('activate',(e)=>{e.waitUntil((async()=>{await self.clients.claim();const ks=await caches.keys();for(const k of ks){if(k.startsWith(BASE+'-')&&k!==BASE+'-'+VER)await caches.delete(k);}})())});
self.addEventListener('message',(e)=>{if(!e.data)return;if(e.data.type==='SKIP_WAITING'){self.skipWaiting();return;}if(e.data.type==='GET_STATE'){e.ports[0].postMessage({version:VER,contract:CONTRACT});return;}});
self.addEventListener('fetch',(e)=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);if(u.origin!==self.location.origin)return;if(/^\\/api\\//.test(u.pathname))return;e.respondWith((async()=>{const c=await caches.open(BASE+'-'+VER);const hit=await c.match(r);if(hit)return hit;const res=await fetch(r);if(res&&res.ok)c.put(r,res.clone());return res;})());});`;
}

const SW_SHELL_HTML =
  '<!DOCTYPE html><html><head><title>SW weak-net test</title></head>' +
  '<body><div id="app-root">app-shell</div></body></html>';

/**
 * 启动一个「跨浏览器可复用的弱网测试服务器」。
 *
 * 与 startStaticServer 的差异：所有响应都经过服务端限速/故障注入层，因此
 * Chromium / Firefox / WebKit 都能命中同一套弱网语义（无需依赖 CDP
 * Network.emulateNetworkConditions 这类 Chromium-only 机制）。
 *
 * options：
 *   latency     - 每请求额外延迟（ms）
 *   bandwidth   - 响应带宽上限（bytes/sec，0=不限速）
 *   dropRate    - 随机断连概率（0-1，命中即销毁连接，模拟物理断网/连接重置）
 *   timeoutMs   - 网关超时（ms，模拟后端挂起后超时）
 *   errorStatus - 注入错误响应状态码（默认响应该状态码的 JSON 错误）
 *   sw          - 若为 true，则托管一个参数化 SW 的最小 shell（用于 SW 更新弱网用例）
 *   swVersion / swContract - SW 初始版本/契约
 *
 * 返回 { baseUrl, configureThrottle(next), setSw(opts), close }。
 * configureThrottle 可在测试运行时动态调整弱网参数（按用例参数化）。
 */
function startThrottledServer(options = {}) {
  return new Promise((resolve, reject) => {
    const state = {
      latency: options.latency ?? 0,
      bandwidth: options.bandwidth ?? 0,
      dropRate: options.dropRate ?? 0,
      timeoutMs: options.timeoutMs ?? 0,
      errorStatus: options.errorStatus ?? 0,
    };
    const swMode = Boolean(options.sw);
    let swVersion = options.swVersion || 'v1';
    let swContract = options.swContract || '1.0.0';

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      // 随机断连优先在请求抵达时同步结算：立即重置 socket，模拟物理断网/连接重置。
      // 放在异步 readFile 之前，确保 Chromium / Firefox / WebKit 的 fetch 都观察到「连接被重置」
      // 而非「正常结束」，从而稳定 reject（规避 Firefox 对正常 socket close 的宽容处理）。
      if (state.dropRate > 0 && Math.random() < state.dropRate) {
        req.socket.destroy();
        return;
      }

      if (swMode) {
        if (url.pathname === '/sw.js') {
          serveThrottled(res, state, {
            status: 200,
            headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
            body: swScript(swVersion, swContract),
          });
          return;
        }
        if (url.pathname === '/' || url.pathname === '/index.standalone.html') {
          serveThrottled(res, state, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            body: SW_SHELL_HTML,
          });
          return;
        }
        res.writeHead(404);
        res.end('not found');
        return;
      }

      // 静态模式：托管 dist/client（与 startStaticServer 一致，含 SPA fallback）
      let filePath = path.join(CLIENT_DIR, url.pathname);
      if (url.pathname === '/') filePath = INDEX_HTML;
      if (!filePath.startsWith(CLIENT_DIR)) filePath = INDEX_HTML;
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = INDEX_HTML;
      }
      const ext = path.extname(filePath).toLowerCase();
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        serveThrottled(res, state, {
          status: 200,
          headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' },
          body: data,
        });
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        configureThrottle(next) {
          Object.assign(state, next);
        },
        setSw(opts) {
          if (opts && opts.version) swVersion = opts.version;
          if (opts && opts.contract) swContract = opts.contract;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * UX-009 需求中的角色映射到代码库角色（EwohRole）。
 * 质检员/签到/质量处置在代码中由移动工作台（worker 角色）承担，故复用 worker。
 */
const ROLES = {
  worker: { userId: 'u-worker', username: '操作员小王', roles: ['worker'] },
  dispatcher: { userId: 'u-dispatcher', username: '计划员小李', roles: ['dispatcher'] },
  workshop_lead: { userId: 'u-lead', username: '厂长老陈', roles: ['workshop_lead'] },
  safety_admin: { userId: 'u-safety', username: '安全员老周', roles: ['safety_admin'] },
  device_ops: { userId: 'u-device', username: '设备运维老吴', roles: ['device_ops'] },
  global_admin: { userId: 'u-admin', username: '项目Owner老赵', roles: ['global_admin'] },
};

/**
 * 预注入会话的 init 脚本（在页面脚本运行前执行）。
 * 通过 sessionStorage 标记仅在「首次加载」注入一次：走「会话过期→重定向登录」的用例中，
 * 重定向后的登录页不应再被重新注入令牌，否则会因 isAuthenticated() 为真而跳回受保护页。
 * localStorage 在同一 origin 的多次导航间天然持久，故不会丢失会话。
 */
function sessionInitScript(role) {
  return function sessionInit(arg) {
    if (window.sessionStorage.getItem('ewoh_session_injected')) {
      return;
    }
    window.sessionStorage.setItem('ewoh_session_injected', '1');
    window.localStorage.setItem('ewoh_access_token', 'fake-access-token');
    window.localStorage.setItem('ewoh_refresh_token', 'fake-refresh-token');
    window.localStorage.setItem(
      'ewoh_auth_user',
      JSON.stringify({
        userId: arg.userId,
        username: arg.username,
        roles: arg.roles,
        orgId: 'default-factory',
      }),
    );
  };
}

/**
 * 用指定角色登录并打开指定路径。
 * 若设置了 role 之外的额外 init 脚本，会先注入（如离线队列预置）。
 */
async function openSession(page, baseUrl, role, route = '/command-center', extraInit) {
  if (extraInit) {
    await page.addInitScript(extraInit);
  }
  await page.addInitScript(sessionInitScript(role), role);
  await page.goto(baseUrl + route);
}

/**
 * 拦截 /api/** 并返回 mock 数据。
 * handlers 键支持三种形式：
 *  - `METHOD /path`（如 `GET /api/work/gates`）
 *  - `/path`（忽略方法）
 *  - `*`（兜底）
 * 值可为：普通对象/数组（→ 200 JSON），或 `{ status, body }`，或返回二者的函数。
 * 未匹配的 API 请求默认返回 404 JSON，避免回退到静态服务器返回 HTML。
 */
async function mockApi(page, handlers) {
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const keyMethod = `${method} ${url.pathname}`;
    const matcher = handlers[keyMethod] ?? handlers[url.pathname] ?? handlers['*'];
    if (!matcher) {
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'not mocked: ' + keyMethod }),
      });
      return;
    }
    const value =
      typeof matcher === 'function'
        ? matcher({
            url,
            method,
            route,
            body: req.postDataJSON ? req.postDataJSON() : undefined,
          })
        : matcher;
    const response =
      value && typeof value === 'object' && 'status' in value && 'body' in value
        ? value
        : { status: 200, body: value };
    route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });
}

/**
 * 弱网模拟：对所有请求（含 API 与静态资源）注入延迟，近似低带宽/高延迟。
 * 需在 mockApi 之后注册，这样弱网路由先命中并 continue() 给 mock 路由。
 */
async function weakNetwork(page, delayMs = 400) {
  await page.route('**/*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    // fallback 会继续交给「后注册」的 mockApi 路由处理，而不是直接发到网络。
    await route.fallback();
  });
}

/** 缓存命中：让后续 reload 在离线时仍能加载应用外壳（模拟离线重启恢复）。 */
async function primeAppShell(page, baseUrl, route) {
  await page.goto(baseUrl + route);
  await page.waitForLoadState('domcontentloaded');
}

/** 视口预设：桌面 / 工业平板 / 手机。 */
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
};

/**
 * 核心页面无障碍语义检查（axe 之外的轻量语义检查）。
 * 返回问题列表；空数组表示通过。断言可在用例中调用。
 *
 * 说明：此处聚焦「核心语义检查」（h1 / main 地标 / 按钮可访问名 / 图片 alt / 控件标签）。
 * 触控目标尺寸（WCAG 2.5 Target Size）属于设计规范层面的 UX-007 范畴，页面导航/输入框等
 * 目标尺寸由 UX-007 统一保证，不在本测试矩阵内做严格硬性断言，避免误报真实的布局设计项。
 */
async function collectA11yIssues(page) {
  return page.evaluate(() => {
    const issues = [];
    const hasText = (el) => (el.textContent || '').trim().length > 0;
    const getAccessibleName = (el) =>
      (el.getAttribute('aria-label') || '').trim() ||
      (el.getAttribute('title') || '').trim() ||
      (el.textContent || '').trim();

    // 1) 每页应有且仅有一个 h1
    const h1s = document.querySelectorAll('h1');
    if (h1s.length === 0) issues.push('缺少 <h1> 主标题');
    if (h1s.length > 1) issues.push(`存在 ${h1s.length} 个 <h1>`);

    // 2) 有 main/nav 语义地标
    if (!document.querySelector('main')) issues.push('缺少 <main> 地标');

    // 3) 按钮需有可访问名称
    document.querySelectorAll('button').forEach((btn) => {
      if (!hasText(btn) && !getAccessibleName(btn)) {
        issues.push('按钮无可访问名称');
      }
    });

    // 4) 图片需有 alt
    document.querySelectorAll('img').forEach((img) => {
      if (img.getAttribute('alt') === null) issues.push('图片缺少 alt 属性');
    });

    // 5) 输入控件需有可关联标签或 aria-label
    document.querySelectorAll('input, select, textarea').forEach((input) => {
      const id = input.getAttribute('id');
      const hasLabel =
        (id && document.querySelector(`label[for="${id}"]`)) ||
        getAccessibleName(input);
      if (!hasLabel) issues.push(`控件缺少标签: <${input.tagName.toLowerCase()}>`);
    });

    return issues;
  });
}

module.exports = {
  ROLES,
  VIEWPORTS,
  startStaticServer,
  startThrottledServer,
  openSession,
  sessionInitScript,
  mockApi,
  weakNetwork,
  primeAppShell,
  collectA11yIssues,
};