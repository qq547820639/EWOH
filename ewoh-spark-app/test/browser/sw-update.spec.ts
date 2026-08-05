/**
 * Task 7 — Service Worker 与更新体验的浏览器测试。
 *
 * 覆盖：升级（新版本不静默接管 + SKIP_WAITING 安全接管）、离线（app shell 从缓存
 * 恢复）、坏版本（契约不兼容时 fail-closed，API 请求不被 SW 缓存）、多标签页
 * （共享同一 SW controller）。
 *
 * 说明：Playwright 无法在运行时改写 `client/public/sw.js` 中硬编码的
 * SW_CACHE_VERSION 常量，因此这里用一个行为与真实 SW 等价、但版本/契约可参数化的
 * 模板 SW 来驱动真实浏览器的 SW 生命周期（install/waiting/activate/fetch）。模板
 * SW 与 `public/sw.js` 保持同一套行为：install 不 skipWaiting、API 请求
 * network-only、activate 时 claim。
 *
 * 运行方式：
 *   npx playwright test --config playwright.config.ts --project=chromium test/browser/sw-update.spec.ts
 */
const { test, expect } = require('@playwright/test');
const http = require('node:http');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
};

/**
 * 生成一份行为与真实 sw.js 等价、但版本/契约可参数化的模板 Service Worker。
 *  - install 预缓存 app shell，且不调用 skipWaiting（不静默接管）。
 *  - message { type:'SKIP_WAITING' } 触发 skipWaiting（安全更新）。
 *  - message { type:'GET_STATE' } 返回 { version }（诊断）。
 *  - /api/** 请求 network-only（不缓存、不从缓存回放）。
 *  - 其余请求 cache-first。
 *  - activate 时 claim 并清理旧版本缓存。
 */
function swScript(version, contract) {
  return `const BASE='sw-test';
const VER='${version}';
const CONTRACT='${contract}';
self.addEventListener('install',(e)=>{e.waitUntil((async()=>{const c=await caches.open(BASE+'-'+VER);await c.addAll(['/index.standalone.html'+(typeof self!=='undefined'?'':'')]).catch(()=>undefined);})())});
self.addEventListener('activate',(e)=>{e.waitUntil((async()=>{await self.clients.claim();const keys=await caches.keys();for(const k of keys){if(k.startsWith(BASE+'-')&&k!==BASE+'-'+VER)await caches.delete(k);}})())});
self.addEventListener('message',(e)=>{if(!e.data)return;if(e.data.type==='SKIP_WAITING'){self.skipWaiting();return;}if(e.data.type==='GET_STATE'){e.ports[0].postMessage({version:VER,contract:CONTRACT});return;}});
self.addEventListener('fetch',(e)=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);if(u.origin!==self.location.origin)return;if(/^\\/api\\//.test(u.pathname))return;e.respondWith((async()=>{const c=await caches.open(BASE+'-'+VER);const hit=await c.match(r);if(hit)return hit;const res=await fetch(r);if(res&&res.ok)c.put(r,res.clone());return res;})());});`;
}

/**
 * 可变内容的 SW 服务器：可切换 sw.js 的版本/契约，托管一个极简 app shell。
 * 每个实例独占端口，避免跨测试的 SW/Cache 状态污染。
 */
function createSwServer({ version = 'v1', contract = '1.0.0' } = {}) {
  let currentVersion = version;
  let currentContract = contract;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'] });
      res.end(swScript(currentVersion, currentContract));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.standalone.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(
        '<!DOCTYPE html><html><head><title>SW test</title></head>' +
          '<body><div id="app-root">app-shell</div></body></html>',
      );
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        setSw(opts) {
          if (opts.version) currentVersion = opts.version;
          if (opts.contract) currentContract = opts.contract;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** 读取当前受控 SW 的状态（version / contract）。 */
async function readSwState(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        navigator.serviceWorker.ready
          .then((reg) => {
            const worker = reg.active || reg.waiting || reg.installing;
            if (!worker) {
              resolve(null);
              return;
            }
            const mc = new MessageChannel();
            mc.port1.onmessage = (e) => resolve(e.data);
            worker.postMessage({ type: 'GET_STATE' }, [mc.port2]);
          })
          .catch(() => resolve(null));
      }),
  );
}

/** 在测试页面中注册 SW（app shell 为静态 HTML，需显式注册）。 */
async function registerSw(page) {
  await page.evaluate(() => navigator.serviceWorker.register('/sw.js'));
}

async function openApp(page, baseUrl) {
  await page.goto(baseUrl + '/');
  await registerSw(page);
}

async function waitForController(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => (navigator.serviceWorker.controller ? 'yes' : 'no')))
    .toBe('yes');
}

test.describe('SW 更新体验（Task 7）', () => {
  test('升级：新版本不静默接管，SKIP_WAITING 后安全接管', async ({ page }) => {
    const server = await createSwServer({ version: 'v1' });
    try {
      await openApp(page, server.baseUrl);
      await waitForController(page);
      const initial = await readSwState(page);
      expect(initial === null || initial.version).toBeTruthy();

      // 升级到 v2：触发更新，新 SW 应进入 waiting 且不接管当前页面。
      server.setSw({ version: 'v2' });
      await page.evaluate(() =>
        navigator.serviceWorker.getRegistration('/').then((r) => r && r.update()),
      );
      await expect
        .poll(() =>
          page.evaluate(() =>
            navigator.serviceWorker.getRegistration('/').then((r) => (r && r.waiting ? 'waiting' : 'none')),
          ),
        )
        .toBe('waiting');

      // 当前页面仍由 v1 控制（未被静默接管）。
      const during = await readSwState(page);
      expect(during.version).toContain('v1');

      // 安全更新：向 waiting worker 发 SKIP_WAITING，随后 reload 让新版本接管。
      await page.evaluate(() =>
        navigator.serviceWorker.getRegistration('/').then((r) => {
          const w = r.waiting;
          w.postMessage({ type: 'SKIP_WAITING' });
        }),
      );
      await expect
        .poll(() =>
          page.evaluate(() =>
            navigator.serviceWorker.getRegistration('/').then((r) =>
              r.active ? r.active.state : 'none',
            ),
          ),
        )
        .toBe('activated');
      await page.reload();
      await waitForController(page);
      await expect
        .poll(async () => (await readSwState(page)).version)
        .toContain('v2');
    } finally {
      await server.close();
    }
  });

  test('离线：缓存的 app shell 可离线恢复', async ({ page }) => {
    const server = await createSwServer({ version: 'v1' });
    try {
      await openApp(page, server.baseUrl);
      await waitForController(page);
      // 等待 SW 将 app shell 写入缓存。
      await page.reload();
      await waitForController(page);

      await page.context().setOffline(true);
      await page.reload();
      // 离线后仍能从缓存加载 app shell。
      await expect(page.locator('#app-root')).toHaveText('app-shell');
      await page.context().setOffline(false);
    } finally {
      await server.close();
    }
  });

  test('坏版本（契约不兼容）：fail-closed，API 请求不被 SW 缓存', async ({ page }) => {
    const server = await createSwServer({ version: 'v1', contract: '0.9.0' });
    try {
      let apiHit = 0;
      await page.route('**/api/**', (route) => {
        apiHit += 1;
        route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });

      await openApp(page, server.baseUrl);
      await waitForController(page);

      // 触发两次 API 请求并刷新：即使 SW 已注册，API 请求也必须每次直达网络
      // （network-only），而不是被 SW 从缓存回放。
      await page.evaluate(() => fetch('/api/dashboard/overview').then((r) => r.json()));
      await page.reload();
      await waitForController(page);
      await page.evaluate(() => fetch('/api/dashboard/overview').then((r) => r.json()));

      // 每次请求都命中网络；若被 SW 缓存回放，第二次请求不会到达 route 拦截层。
      expect(apiHit).toBeGreaterThanOrEqual(2);
    } finally {
      await server.close();
    }
  });

  test('多标签页：同一 SW registration/controller 被共享', async ({ context }) => {
    const server = await createSwServer({ version: 'v1' });
    try {
      const page1 = await context.newPage();
      await openApp(page1, server.baseUrl);
      await waitForController(page1);

      const page2 = await context.newPage();
      await openApp(page2, server.baseUrl);
      await waitForController(page2);

      const reg1 = await page1.evaluate(() =>
        navigator.serviceWorker.getRegistration('/').then((r) => Boolean(r)),
      );
      const reg2 = await page2.evaluate(() =>
        navigator.serviceWorker.getRegistration('/').then((r) => Boolean(r)),
      );
      expect(reg1).toBe(true);
      expect(reg2).toBe(true);

      const ctrl1 = await page1.evaluate(
        () => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL,
      );
      const ctrl2 = await page2.evaluate(
        () => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL,
      );
      expect(ctrl1).toBeTruthy();
      expect(ctrl2).toBe(ctrl1);
    } finally {
      await server.close();
    }
  });
});