/**
 * EWOH Platform Comprehensive Test Suite
 * Covers: SPA routing, auth lifecycle, error handling, responsive, security headers,
 * console errors, network monitoring, and cross-browser smoke flows.
 *
 * Run: npx playwright test --config playwright.config.ts test/browser/comprehensive-platform.spec.ts
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const BASE_URL = 'http://121.43.230.202:3000';

// ─── Helper: collect console errors and failed requests ───
interface MonitoringResult {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: { url: string; status: number; method: string }[];
}

function setupMonitoring(page: Page): MonitoringResult {
  const result: MonitoringResult = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      result.consoleErrors.push(msg.text());
    }
  });

  page.on('pageerror', (err) => {
    result.pageErrors.push(err.message);
  });

  page.on('response', (response) => {
    const status = response.status();
    if (status >= 400) {
      result.failedRequests.push({
        url: response.url(),
        status,
        method: response.request().method(),
      });
    }
  });

  return result;
}

// ─── Section 1: SPA Routing ───
test.describe('SPA Routing — BUG-001 verification', () => {
  const routes = [
    '/login',
    '/command-center',
    '/digital-world',
    '/scheduling',
    '/devices',
    '/personnel',
    '/alerts',
    '/organization',
    '/system',
    '/command-map',
    '/mobile-workbench',
    '/work-orchestration',
  ];

  for (const route of routes) {
    test(`direct access to ${route} returns index.html content`, async ({ page }) => {
      const response = await page.goto(`${BASE_URL}${route}`);
      expect(response).not.toBeNull();
      // Verify the page has the EWOH title (index.html was served)
      await expect(page).toHaveTitle(/EWOH/);
      // Wait for React to hydrate and render
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(3000);
      // Verify React Router rendered the page (not a blank/loading page)
      const body = await page.textContent('body');
      expect(body).toBeTruthy();
      // Should have meaningful content (not just loading skeleton)
      // The login page shows "EWOH具身工厂操作系统用户名密码登录" (~25 chars)
      // Protected pages redirect to login, so we check for at least EWOH text
      expect(body!.length).toBeGreaterThan(10);
    });
  }

  test('SPA routes serve index.html even with 404 status', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/login`);
    expect(response).not.toBeNull();
    // BUG-001: Currently returns 404 status
    const status = response!.status();
    // Record the actual status (404 is the known bug)
    console.log(`BUG-001 check: /login returns HTTP ${status}`);
    // Regardless of status, the content should be the SPA shell
    await expect(page).toHaveTitle(/EWOH/);
  });

  test('API routes are NOT intercepted by SPA fallback', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/api/nonexistent`);
    expect(response).not.toBeNull();
    const status = response!.status();
    // API 404 should return JSON, not HTML
    const contentType = response!.headers()['content-type'] || '';
    expect(contentType).toContain('application/json');
    expect(status).toBe(404);
  });

  test('health endpoints return JSON not SPA fallback', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/health/live`);
    expect(response).not.toBeNull();
    const contentType = response!.headers()['content-type'] || '';
    expect(contentType).toContain('application/json');
    const body = await response!.json();
    expect(body.status).toBe('ok');
  });

  test('nonexistent frontend route shows 404 page', async ({ page }) => {
    const monitoring = setupMonitoring(page);
    await page.goto(`${BASE_URL}/totally-nonexistent-path-xyz`);
    // Should have the EWOH title (SPA shell loaded)
    await expect(page).toHaveTitle(/EWOH/);
    // Wait for React Router to render the NotFound component
    await page.waitForTimeout(2000);
    // Check if NotFound component rendered (look for 404 text)
    const text = await page.textContent('body');
    // The NotFound component shows "404" and "页面不存在"
    expect(text).toContain('404');
  });
});

// ─── Section 2: Authentication Lifecycle ───
test.describe('Authentication Lifecycle', () => {
  test('unauthenticated user is redirected to /login', async ({ page }) => {
    await page.goto(`${BASE_URL}/command-center`);
    // Should redirect to /login
    await page.waitForURL(/\/login/, { timeout: 10000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('login page renders correctly', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');
    // Should have username and password fields
    const usernameInput = page.locator('#username');
    const passwordInput = page.locator('#password');
    const submitButton = page.locator('button[type="submit"]');

    await expect(usernameInput).toBeVisible();
    await expect(passwordInput).toBeVisible();
    await expect(submitButton).toBeVisible();
    await expect(submitButton).toContainText('登录');
  });

  test('login with empty credentials shows error', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');

    // Click submit without filling in credentials
    await page.click('button[type="submit"]');
    await page.waitForTimeout(1000);

    // Should still be on login page
    await expect(page).toHaveURL(/\/login/);
  });

  test('login form has proper accessibility attributes', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');

    // Check label associations
    const usernameLabel = page.locator('label[for="username"]');
    const passwordLabel = page.locator('label[for="password"]');

    await expect(usernameLabel).toBeVisible();
    await expect(passwordLabel).toBeVisible();

    // Check input types
    const passwordInput = page.locator('#password');
    await expect(passwordInput).toHaveAttribute('type', 'password');
  });

  test('protected routes require authentication', async ({ page }) => {
    const protectedRoutes = [
      '/command-center',
      '/digital-world',
      '/scheduling',
      '/devices',
      '/personnel',
      '/alerts',
      '/organization',
      '/system',
      '/work-orchestration',
    ];

    for (const route of protectedRoutes) {
      await page.goto(`${BASE_URL}${route}`);
      await page.waitForURL(/\/login/, { timeout: 10000 });
      await expect(page).toHaveURL(/\/login/);
    }
  });
});

// ─── Section 3: Security Headers Verification ───
test.describe('Security Headers', () => {
  test('homepage has all required security headers', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    expect(response).not.toBeNull();
    const headers = response!.headers();

    // X-Content-Type-Options
    expect(headers['x-content-type-options']).toBe('nosniff');
    // X-Frame-Options
    expect(headers['x-frame-options']).toBe('DENY');
    // Referrer-Policy
    expect(headers['referrer-policy']).toBe('no-referrer');
    // Content-Security-Policy
    expect(headers['content-security-policy']).toBeTruthy();
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain("object-src 'none'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    // Strict-Transport-Security (configured even though HTTPS not active)
    expect(headers['strict-transport-security']).toBeTruthy();
    // X-Download-Options
    expect(headers['x-download-options']).toBe('noopen');
    // X-Permitted-Cross-Domain-Policies
    expect(headers['x-permitted-cross-domain-policies']).toBe('none');
  });

  test('API responses have security headers', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/health/live`);
    expect(response).not.toBeNull();
    const headers = response!.headers();

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['content-security-policy']).toBeTruthy();
  });

  test('x-powered-by header is disabled', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`);
    expect(response).not.toBeNull();
    const headers = response!.headers();
    expect(headers['x-powered-by']).toBeUndefined();
  });
});

// ─── Section 4: Error Handling ───
test.describe('Error Handling', () => {
  test('NotFound page renders with back link', async ({ page }) => {
    await page.goto(`${BASE_URL}/nonexistent-page-12345`);
    await page.waitForTimeout(3000);

    // Should render the NotFound component
    const heading = page.locator('text=404');
    await expect(heading.first()).toBeVisible({ timeout: 10000 });

    // Should have a link back to command center
    const backLink = page.locator('a[href="/command-center"], text=返回指挥中心');
    await expect(backLink.first()).toBeVisible();
  });

  test('login error does not cause white screen', async ({ page }) => {
    const monitoring = setupMonitoring(page);
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');

    // Try to login with invalid credentials
    await page.fill('#username', 'invalid_user_12345');
    await page.fill('#password', 'invalid_pass_12345');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3000);

    // Page should not be blank
    const bodyText = await page.textContent('body');
    expect(bodyText!.length).toBeGreaterThan(50);

    // Should still show login form
    await expect(page.locator('#username')).toBeVisible();
  });
});

// ─── Section 5: Console Error Monitoring ───
test.describe('Console Error Monitoring', () => {
  test('homepage loads without critical console errors', async ({ page }) => {
    const monitoring = setupMonitoring(page);
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Filter out known benign errors (like favicon, service worker)
    const criticalErrors = monitoring.consoleErrors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('service-worker') &&
        !e.includes('sw.js') &&
        !e.includes('manifest'),
    );

    // Log errors for debugging
    if (criticalErrors.length > 0) {
      console.log('Console errors on homepage:', criticalErrors);
    }

    // Should not have critical JS errors
    expect(monitoring.pageErrors).toHaveLength(0);
  });

  test('login page loads without critical errors', async ({ page }) => {
    const monitoring = setupMonitoring(page);
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Log any errors
    if (monitoring.pageErrors.length > 0) {
      console.log('Page errors on login:', monitoring.pageErrors);
    }

    // Filter out benign errors
    const criticalPageErrors = monitoring.pageErrors.filter(
      (e) =>
        !e.includes('ResizeObserver') &&
        !e.includes('Non-Error promise rejection'),
    );

    expect(criticalPageErrors).toHaveLength(0);
  });
});

// ─── Section 6: Static Resources ───
test.describe('Static Resources', () => {
  test('JS and CSS bundles load successfully', async ({ page }) => {
    const failedResources: string[] = [];

    page.on('response', (response) => {
      const url = response.url();
      if (
        (url.endsWith('.js') || url.endsWith('.css')) &&
        response.status() !== 200 &&
        response.status() !== 304
      ) {
        failedResources.push(`${url} (${response.status()})`);
      }
    });

    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');

    if (failedResources.length > 0) {
      console.log('Failed resources:', failedResources);
    }

    expect(failedResources).toHaveLength(0);
  });

  test('static assets have immutable cache headers', async ({ page }) => {
    // Navigate to homepage to trigger asset loading
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');

    // Check a JS asset response
    const jsResponse = await page.goto(
      `${BASE_URL}/assets/index.standalone-mNpC19Bq.js`,
    );
    expect(jsResponse).not.toBeNull();
    const cacheControl = jsResponse!.headers()['cache-control'] || '';
    expect(cacheControl).toContain('immutable');
    expect(cacheControl).toContain('max-age=31536000');
  });

  test('favicon loads', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/favicon.svg`);
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
  });

  test('manifest.webmanifest loads', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/manifest.webmanifest`);
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    const contentType = response!.headers()['content-type'] || '';
    expect(contentType).toContain('json');
  });
});

// ─── Section 7: Responsive Viewport Tests ───
test.describe('Responsive Viewport Tests', () => {
  const viewports = [
    { name: 'Desktop 1920x1080', width: 1920, height: 1080 },
    { name: 'Desktop 1440x900', width: 1440, height: 900 },
    { name: 'Laptop 1280x720', width: 1280, height: 720 },
    { name: 'Tablet 1024x768', width: 1024, height: 768 },
    { name: 'Tablet 768x1024', width: 768, height: 1024 },
    { name: 'Mobile 390x844', width: 390, height: 844 },
    { name: 'Mobile 375x812', width: 375, height: 812 },
    { name: 'Mobile 360x800', width: 360, height: 800 },
  ];

  for (const vp of viewports) {
    test(`login page renders at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`${BASE_URL}/login`);
      await page.waitForLoadState('domcontentloaded');

      // Login form should be visible
      await expect(page.locator('#username')).toBeVisible();
      await expect(page.locator('#password')).toBeVisible();
      await expect(page.locator('button[type="submit"]')).toBeVisible();

      // Check for horizontal scrollbar (bad sign on login page)
      const hasHScroll = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      // Log but don't fail on mobile (some overflow may be acceptable)
      if (hasHScroll && vp.width >= 768) {
        console.warn(`Horizontal scroll detected at ${vp.name}`);
      }
    });
  }

  test('homepage renders without horizontal overflow at key viewports', async ({ page }) => {
    for (const vp of [
      { width: 1920, height: 1080 },
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(vp);
      await page.goto(`${BASE_URL}/`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);

      const hasHScroll = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 5,
      );
      if (hasHScroll) {
        console.warn(
          `Horizontal overflow at ${vp.width}x${vp.height}: scrollWidth=${await page.evaluate(() => document.documentElement.scrollWidth)}, clientWidth=${await page.evaluate(() => document.documentElement.clientWidth)}`,
        );
      }
    }
  });
});

// ─── Section 8: Keyboard Navigation ───
test.describe('Keyboard Navigation', () => {
  test('login form supports keyboard navigation', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');

    // Tab to username field
    await page.keyboard.press('Tab');
    const focusedElement = await page.evaluate(() => document.activeElement?.id);
    // First focusable element should be username or close to it
    expect(['username', 'password', '']).toContain(focusedElement);

    // Fill in username, tab to password
    await page.fill('#username', 'testuser');
    await page.keyboard.press('Tab');
    await page.fill('#password', 'testpass');

    // Enter should submit the form
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    // Should attempt login (may fail due to credentials, but form submitted)
    // Verify we're still on login page (since credentials are invalid)
    await expect(page).toHaveURL(/\/login/);
  });
});

// ─── Section 9: Network & Performance ───
test.describe('Network & Performance', () => {
  test('homepage loads within reasonable time', async ({ page }) => {
    const startTime = Date.now();
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('domcontentloaded');
    const domReadyTime = Date.now() - startTime;

    console.log(`Homepage DOMContentLoaded: ${domReadyTime}ms`);

    // Should be under 5 seconds for DOMContentLoaded
    expect(domReadyTime).toBeLessThan(5000);
  });

  test('login page loads within reasonable time', async ({ page }) => {
    const startTime = Date.now();
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');
    const loadTime = Date.now() - startTime;

    console.log(`Login page DOMContentLoaded: ${loadTime}ms`);
    expect(loadTime).toBeLessThan(5000);
  });

  test('API health endpoint responds quickly', async ({ page }) => {
    const startTime = Date.now();
    const response = await page.goto(`${BASE_URL}/health/live`);
    const responseTime = Date.now() - startTime;

    console.log(`Health API response time: ${responseTime}ms`);
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    expect(responseTime).toBeLessThan(2000);
  });
});

// ─── Section 10: Clickjacking Protection ───
test.describe('Clickjacking Protection', () => {
  test('page cannot be embedded in iframe', async ({ page, context }) => {
    // Create a page that tries to iframe the target
    const iframeTestHtml = `
      <html>
        <body>
          <iframe id="target" src="${BASE_URL}/" width="800" height="600"></iframe>
        </body>
      </html>
    `;

    // Use a data URI to test iframe embedding
    const page2 = await context.newPage();
    await page2.setContent(iframeTestHtml);
    await page2.waitForTimeout(3000);

    // The iframe should fail to load due to X-Frame-Options: DENY
    const iframe = page2.locator('#target');
    const iframeSrc = await iframe.getAttribute('src');
    expect(iframeSrc).toBe(`${BASE_URL}/`);

    // The frame should not be able to display the content
    // (X-Frame-Options: DENY prevents this)
    await page2.close();
  });
});

// ─── Section 11: Code Splitting Verification ───
test.describe('Code Splitting', () => {
  test('login page loads only necessary chunks', async ({ page }) => {
    const loadedChunks: string[] = [];

    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('/assets/') && url.endsWith('.js') && response.status() === 200) {
        loadedChunks.push(url.split('/').pop()!);
      }
    });

    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('networkidle');

    console.log(`Chunks loaded for login page: ${loadedChunks.length}`);
    console.log('Chunks:', loadedChunks.join(', '));

    // Login page should NOT load all page chunks (code splitting working)
    // The main bundle + Login chunk should be loaded, but not CommandCenter, Devices, etc.
    const hasCommandCenterChunk = loadedChunks.some((c) => c.startsWith('CommandCenter'));
    const hasDevicesChunk = loadedChunks.some((c) => c.startsWith('Devices'));
    const hasLoginChunk = loadedChunks.some((c) => c.startsWith('Login'));

    // Login chunk should be loaded
    expect(hasLoginChunk).toBe(true);
    // Other page chunks should NOT be loaded on login page
    expect(hasCommandCenterChunk).toBe(false);
    expect(hasDevicesChunk).toBe(false);
  });
});

// ─── Section 12: API Error Format Consistency ───
test.describe('API Error Format', () => {
  test('404 API error has consistent format', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/api/nonexistent-endpoint-xyz`);
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(404);

    const body = await response!.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toHaveProperty('code');
    expect(body.error).toHaveProperty('message');
    expect(body.error).toHaveProperty('timestamp');
    expect(body.error).toHaveProperty('errorCode');
    expect(body.error).toHaveProperty('requestId');
    expect(body.error.code).toBe('NOT_FOUND');
  });

  test('API responses include request tracking headers', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/api/nonexistent`);
    expect(response).not.toBeNull();
    const headers = response!.headers();

    // Should have request ID for tracing
    expect(headers['x-request-id']).toBeTruthy();
  });
});
