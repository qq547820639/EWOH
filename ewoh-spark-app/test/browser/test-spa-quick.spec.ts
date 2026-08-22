import { test, expect } from '@playwright/test';
const BASE_URL = 'http://121.43.230.202:3000';

test('root / loads with content (200)', async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/`);
  console.log(`Root status: ${response?.status()}`);
  await page.waitForTimeout(5000);
  const title = await page.title();
  const bodyText = await page.textContent('body');
  console.log(`Title: ${title}`);
  console.log(`Body length: ${bodyText?.length}`);
  console.log(`Body preview: ${bodyText?.substring(0, 200)}`);
});

test('/login with 404 status - check rendering', async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/login`);
  console.log(`/login status: ${response?.status()}`);
  await page.waitForTimeout(5000);
  const title = await page.title();
  const bodyText = await page.textContent('body');
  console.log(`Title: ${title}`);
  console.log(`Body length: ${bodyText?.length}`);
  console.log(`Body preview: ${bodyText?.substring(0, 200)}`);
  
  // Check all network requests
  const consoleMessages: string[] = [];
  page.on('console', msg => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => consoleMessages.push(`[pageerror] ${err.message}`));
  await page.waitForTimeout(2000);
  console.log('Console messages:', consoleMessages.join('\n'));
});
