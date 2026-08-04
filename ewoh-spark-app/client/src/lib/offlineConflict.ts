export interface ConflictDiff {
  path: string;
  local: unknown;
  server: unknown;
}

export interface ConflictModel {
  localValue: unknown;
  serverValue: unknown;
  diff: ConflictDiff[];
  /** Heuristic recommendation: prefer the server value unless it is empty. */
  recommended: 'local' | 'server';
}

export interface ConflictErrorPayload {
  status?: number;
  data?: {
    message?: unknown;
    serverValue?: unknown;
    localValue?: unknown;
    current?: unknown;
  };
  response?: {
    status?: number;
    data?: {
      message?: unknown;
      serverValue?: unknown;
      localValue?: unknown;
      current?: unknown;
    };
  };
}

/**
 * Extracts the server value (and any locally-known value) from a conflict error.
 * The backend currently returns only a `STATE_CONFLICT` message; `serverValue`
 * parsing is best-effort and graceful when the field is absent.
 * TODO: backend — include `serverValue` (current server state) in 409 responses
 * so the client can render a precise local-vs-server diff.
 */
export function parseConflictPayload(
  error: unknown,
): { serverValue?: unknown; localValue?: unknown } | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const record = error as ConflictErrorPayload;
  const status = record.status ?? record.response?.status;
  if (status !== 409) {
    return null;
  }
  const data = record.data ?? record.response?.data;
  if (!data || typeof data !== 'object') {
    return null;
  }
  const serverValue = data.serverValue ?? data.current;
  if (serverValue === undefined) {
    return null;
  }
  return {
    serverValue,
    localValue: data.localValue,
  };
}

/**
 * Recursively diffs two (possibly nested) values into a flat list of path-level
 * differences so the UI can render "本地值/服务端值" per changed field.
 */
export function diffValues(local: unknown, server: unknown): ConflictDiff[] {
  const diffs: ConflictDiff[] = [];
  collect(local, server, '', diffs);
  return diffs;
}

function collect(
  local: unknown,
  server: unknown,
  path: string,
  out: ConflictDiff[],
): void {
  const bothObjects =
    local !== null &&
    typeof local === 'object' &&
    server !== null &&
    typeof server === 'object' &&
    !Array.isArray(local) &&
    !Array.isArray(server);

  if (bothObjects) {
    const localObj = local as Record<string, unknown>;
    const serverObj = server as Record<string, unknown>;
    const keys = new Set([...Object.keys(localObj), ...Object.keys(serverObj)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      collect(localObj[key], serverObj[key], childPath, out);
    }
    return;
  }

  if (local !== server) {
    out.push({ path, local, server });
  }
}

/**
 * Builds a conflict model for the UI. `recommended` is a heuristic: when the
 * server has no value (null/undefined) we recommend keeping the local value,
 * otherwise the server is treated as the source of truth.
 */
export function buildConflictModel(
  localValue: unknown,
  serverValue: unknown,
): ConflictModel {
  const diff = diffValues(localValue, serverValue);
  const recommended: 'local' | 'server' =
    serverValue === null || serverValue === undefined ? 'local' : 'server';
  return { localValue, serverValue, diff, recommended };
}