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
 * The backend `mes` step transition endpoints now return `serverValue` (the
 * current server step state) in 409 responses, so the client can render a
 * precise local-vs-server diff. Parsing remains best-effort and graceful when
 * the field is absent.
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
  // CLI-540：类型分派——Date/RegExp 按值比较；Map/Set 按条目比较。
  // 它们都是 object，落入下方的键枚举路径会把内部状态当作普通字段展开，
  // 产生无意义的 diff。
  if (local instanceof Date || server instanceof Date) {
    const equal =
      local instanceof Date &&
      server instanceof Date &&
      local.getTime() === server.getTime();
    if (!equal) {
      out.push({ path, local, server });
    }
    return;
  }
  if (local instanceof RegExp || server instanceof RegExp) {
    const equal =
      local instanceof RegExp &&
      server instanceof RegExp &&
      local.source === server.source &&
      local.flags === server.flags;
    if (!equal) {
      out.push({ path, local, server });
    }
    return;
  }
  if (local instanceof Map || server instanceof Map) {
    const localMap = local instanceof Map ? local : null;
    const serverMap = server instanceof Map ? server : null;
    if (!localMap || !serverMap) {
      out.push({ path, local, server });
      return;
    }
    if (localMap.size !== serverMap.size) {
      out.push({ path, local, server });
      return;
    }
    for (const [key, value] of localMap) {
      if (!serverMap.has(key)) {
        out.push({ path, local, server });
        return;
      }
      const childPath = path ? `${path}[${String(key)}]` : `[${String(key)}]`;
      collect(value, serverMap.get(key), childPath, out);
    }
    return;
  }
  if (local instanceof Set || server instanceof Set) {
    const localSet = local instanceof Set ? local : null;
    const serverSet = server instanceof Set ? server : null;
    if (
      !localSet ||
      !serverSet ||
      localSet.size !== serverSet.size ||
      [...localSet].some((item) => !serverSet.has(item))
    ) {
      out.push({ path, local, server });
    }
    return;
  }

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