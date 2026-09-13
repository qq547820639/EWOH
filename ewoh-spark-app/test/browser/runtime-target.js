function normalizeTarget(value, name) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must be an HTTP(S) URL without embedded credentials`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an origin without a path, query or fragment`);
  }
  return url.origin;
}

function resolveBrowserBaseUrl() {
  return normalizeTarget(process.env.EWOH_E2E_BASE || 'http://127.0.0.1:3106', 'EWOH_E2E_BASE');
}

function resolveBackendUrl() {
  return normalizeTarget(process.env.EWOH_E2E_BACKEND_URL || resolveBrowserBaseUrl(), 'EWOH_E2E_BACKEND_URL');
}

function browserCredentials(role = 'admin') {
  const username = role === 'dispatcher' ? process.env.EWOH_E2E_DISPATCH_USER : process.env.EWOH_E2E_USER;
  const password = role === 'dispatcher' ? process.env.EWOH_E2E_DISPATCH_PASS : process.env.EWOH_E2E_PASS;
  if (!username || !password) {
    throw new Error(`Missing ${role} browser credentials. Use automatic local PG setup or supply EWOH_E2E_USER/PASS and EWOH_E2E_DISPATCH_USER/PASS for an explicit target.`);
  }
  return { username, password };
}

module.exports = { resolveBrowserBaseUrl, resolveBackendUrl, browserCredentials };
