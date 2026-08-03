const baseUrl = process.env.PERF_BASE_URL || 'http://127.0.0.1:3100';
const concurrency = Number(process.env.PERF_CONCURRENCY || 50);
const total = Number(process.env.PERF_TOTAL || 500);
const path = process.env.PERF_PATH || '/health/live';
const method = process.env.PERF_METHOD || 'GET';
const token = process.env.PERF_TOKEN || '';
const body = process.env.PERF_BODY || '';

const headers = { 'content-type': 'application/json' };
if (token) headers.authorization = `Bearer ${token}`;

async function worker(remaining, latencies, failures) {
  while (remaining.current < total) {
    const index = remaining.current++;
    const start = performance.now();
    try {
      const response = await fetch(baseUrl + path, {
        method,
        headers,
        body: body || undefined,
      });
      latencies[index] = performance.now() - start;
      if (!response.ok) failures.current++;
    } catch {
      latencies[index] = performance.now() - start;
      failures.current++;
    }
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

(async () => {
  const remaining = { current: 0 };
  const failures = { current: 0 };
  const latencies = new Array(total);
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker(remaining, latencies, failures)));
  const elapsedMs = performance.now() - started;
  const ok = total - failures.current;
  const values = latencies.filter((value) => typeof value === 'number');
  console.log(JSON.stringify({
    url: baseUrl + path,
    method,
    total,
    concurrency,
    ok,
    failed: failures.current,
    elapsedMs: Math.round(elapsedMs),
    qps: Math.round((total / elapsedMs) * 1000),
    p50Ms: Math.round(percentile(values, 50) * 100) / 100,
    p95Ms: Math.round(percentile(values, 95) * 100) / 100,
  }, null, 2));
  process.exit(failures.current === 0 ? 0 : 1);
})();
