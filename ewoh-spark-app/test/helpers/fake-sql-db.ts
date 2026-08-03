type Row = Record<string, unknown>;

function extractSql(statement: unknown): { text: string; params: unknown[] } {
  const chunks = (statement as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) {
    throw new Error('FakeSqlDb only supports drizzle SQL objects');
  }
  const params: unknown[] = [];
  const text = chunks
    .map((chunk) => {
      if (
        chunk &&
        typeof chunk === 'object' &&
        Array.isArray((chunk as { value?: unknown[] }).value)
      ) {
        return ((chunk as { value: string[] }).value ?? []).join('');
      }
      params.push(chunk);
      return `$${params.length}`;
    })
    .join('');
  return { text, params };
}

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  let i = 0;
  while (i <= input.length - separator.length) {
    const char = input[i];
    if (quote) {
      if (char === quote && input[i - 1] !== '\\') {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      i += 1;
      continue;
    }
    if (char === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && input.startsWith(separator, i)) {
      parts.push(input.slice(start, i));
      i += separator.length;
      start = i;
      continue;
    }
    i += 1;
  }
  parts.push(input.slice(start));
  return parts;
}

function extractParens(
  text: string,
  start: number,
): { content: string; end: number } | null {
  const open = text.indexOf('(', start);
  if (open < 0) {
    return null;
  }
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return { content: text.slice(open + 1, i), end: i };
      }
    }
  }
  return null;
}

function tableName(text: string): string | null {
  const match = text.match(/(?:from|into|update)\s+public\.([a-z_]+)/i);
  return match ? match[1] : null;
}

function parseWhere(text: string): string {
  const whereMatch = text.match(/\bwhere\b/i);
  if (!whereMatch) {
    return '';
  }
  const rest = text
    .slice((whereMatch.index ?? 0) + whereMatch[0].length)
    .replace(/\border\s+by[\s\S]*$/i, '')
    .replace(/\blimit[\s\S]*$/i, '')
    .trim();
  return rest;
}

function parseOrderBy(
  text: string,
): { column: string; direction: 'asc' | 'desc' } | null {
  const match = text.match(/order\s+by\s+([a-z_]+)\s*(asc|desc)?/i);
  if (!match) {
    return null;
  }
  return { column: match[1], direction: (match[2]?.toLowerCase() as 'asc' | 'desc') ?? 'asc' };
}

function parseLimit(text: string, params: unknown[]): number | null {
  const match = text.match(/limit\s+(\$\d+|\d+)/i);
  if (!match) {
    return null;
  }
  const raw = match[1];
  return raw.startsWith('$') ? Number(params[Number(raw.slice(1)) - 1]) : Number(raw);
}

export class FakeSqlDb {
  private readonly tables = new Map<string, Row[]>();
  private seq = 0;

  async execute(statement: unknown): Promise<Row[]> {
    const { text, params } = extractSql(statement);
    const queryText = text.trim();
    const table = tableName(queryText);
    if (!table) {
      throw new Error(`FakeSqlDb cannot resolve table: ${queryText}`);
    }
    const rows = this.ensureTable(table);
    if (/^insert/i.test(queryText)) {
      return this.insert(table, rows, queryText, params);
    }
    if (/^update/i.test(queryText)) {
      return this.update(table, rows, queryText, params);
    }
    if (/^select/i.test(queryText)) {
      return this.select(table, rows, queryText, params);
    }
    throw new Error(`FakeSqlDb unsupported statement: ${queryText}`);
  }

  private ensureTable(table: string): Row[] {
    const existing = this.tables.get(table);
    if (existing) {
      return existing;
    }
    const rows: Row[] = [];
    this.tables.set(table, rows);
    return rows;
  }

  private insert(table: string, rows: Row[], text: string, params: unknown[]): Row[] {
    const valuesMatch = text.match(/values/i);
    if (!valuesMatch) {
      throw new Error(`FakeSqlDb insert without values: ${text}`);
    }
    const columnsMatch = text.match(/insert\s+into\s+public\.\w+\s*\(([\s\S]*?)\)/i);
    if (!columnsMatch) {
      throw new Error(`FakeSqlDb insert without columns: ${text}`);
    }
    const parens = extractParens(text, (valuesMatch.index ?? 0) + valuesMatch[0].length);
    if (!parens) {
      throw new Error(`FakeSqlDb insert without value parens: ${text}`);
    }
    const columns = splitTopLevel(columnsMatch[1], ',').map((column) => column.trim());
    const valueTokens = splitTopLevel(parens.content, ',');
    const row: Row = {};
    columns.forEach((column, index) => {
      const value = this.evaluateValue(valueTokens[index] ?? 'default', params);
      if (value !== undefined) {
        row[column] = value;
      }
    });
    this.applyDefaults(table, row);
    rows.push(row);

    const returning = text.slice(parens.end + 1).match(/returning\s+([\s\S]+)$/i);
    if (returning) {
      const requested = splitTopLevel(returning[1], ',').map((column) =>
        column.trim().replace(/\s+as\s+\w+$/i, ''),
      );
      const result: Row = {};
      for (const column of requested) {
        result[column] = row[column];
      }
      return [result];
    }
    return [];
  }

  private update(table: string, rows: Row[], text: string, params: unknown[]): Row[] {
    const match = text.match(/set\s+([\s\S]*?)\s+where\s+([\s\S]+)$/i);
    if (!match) {
      throw new Error(`FakeSqlDb update without set/where: ${text}`);
    }
    const assignments = splitTopLevel(match[1], ',').map((assignment) => assignment.trim());
    const wherePart = match[2].replace(/\s+returning\s+[\s\S]+$/i, '');
    const conditions = splitTopLevel(wherePart, ' and ').map((condition) => condition.trim());
    const targets = rows.filter((row) =>
      conditions.every((condition) => this.evaluateCondition(condition, row, params)),
    );
    for (const row of targets) {
      for (const assignment of assignments) {
        const assignmentMatch = assignment.match(/^([a-z_]+)\s*=\s*(.+)$/i);
        if (!assignmentMatch) {
          throw new Error(`FakeSqlDb unsupported assignment: ${assignment}`);
        }
        const valueText = assignmentMatch[2];
        const arithmetic = valueText.match(/^([a-z_]+)\s*([+-])\s*(\$\d+|\d+)$/i);
        let value: unknown;
        if (arithmetic) {
          const rightRaw = arithmetic[3];
          const right = rightRaw.startsWith('$')
            ? Number(params[Number(rightRaw.slice(1)) - 1])
            : Number(rightRaw);
          const left = Number(row[arithmetic[1]] ?? 0);
          value = arithmetic[2] === '-' ? left - right : left + right;
        } else {
          value = this.evaluateValue(valueText, params);
        }
        if (value !== undefined) {
          row[assignmentMatch[1]] = value;
        }
      }
    }
    const returningMatch = text.match(/returning\s+([\s\S]+)$/i);
    if (returningMatch) {
      const requested = splitTopLevel(returningMatch[1], ',').map((column) =>
        column.trim().replace(/\s+as\s+\w+$/i, ''),
      );
      return targets.map((row) => {
        const result: Row = {};
        for (const column of requested) {
          result[column] = row[column];
        }
        return result;
      });
    }
    return [];
  }

  private select(table: string, rows: Row[], text: string, params: unknown[]): Row[] {
    let result = rows;
    const where = parseWhere(text);
    if (where) {
      const conditions = splitTopLevel(where, ' and ').map((condition) => condition.trim());
      result = result.filter((row) =>
        conditions.every((condition) => this.evaluateCondition(condition, row, params)),
      );
    }
    const order = parseOrderBy(text);
    if (order) {
      result = [...result].sort((a, b) => {
        const left = a[order.column];
        const right = b[order.column];
        const comparison =
          typeof left === 'number' && typeof right === 'number'
            ? left - right
            : String(left ?? '').localeCompare(String(right ?? ''));
        return order.direction === 'desc' ? -comparison : comparison;
      });
    }
    const limit = parseLimit(text, params);
    if (limit !== null) {
      result = result.slice(0, limit);
    }
    return result.map((row) => ({ ...row }));
  }

  private evaluateCondition(condition: string, row: Row, params: unknown[]): boolean {
    const inMatch = condition.match(/^([a-z_]+)\s+in\s*\((.+)\)$/i);
    if (inMatch) {
      const values = splitTopLevel(inMatch[2], ',').map((value) =>
        this.evaluateValue(value, params),
      );
      return values.includes(row[inMatch[1]]);
    }
    const equal = condition.match(/^([a-z_]+)\s*=\s*(.+)$/i);
    if (equal) {
      return row[equal[1]] === this.evaluateValue(equal[2], params);
    }
    const greaterOrEqual = condition.match(/^([a-z_]+)\s*>=\s*(.+)$/i);
    if (greaterOrEqual) {
      return Number(row[greaterOrEqual[1]]) >= Number(this.evaluateValue(greaterOrEqual[2], params));
    }
    const lessOrEqual = condition.match(/^([a-z_]+)\s*<=\s*(.+)$/i);
    if (lessOrEqual) {
      return Number(row[lessOrEqual[1]]) <= Number(this.evaluateValue(lessOrEqual[2], params));
    }
    const greater = condition.match(/^([a-z_]+)\s*>\s*(.+)$/i);
    if (greater) {
      return Number(row[greater[1]]) > Number(this.evaluateValue(greater[2], params));
    }
    const less = condition.match(/^([a-z_]+)\s*<\s*(.+)$/i);
    if (less) {
      return Number(row[less[1]]) < Number(this.evaluateValue(less[2], params));
    }
    throw new Error(`FakeSqlDb unsupported condition: ${condition}`);
  }

  private evaluateValue(token: string, params: unknown[]): unknown {
    const value = token.trim();
    if (value === 'default' || value === '') {
      return undefined;
    }
    if (value === 'null') {
      return null;
    }
    if (value === 'now()') {
      return new Date();
    }
    const coalesce = value.match(
      /coalesce\(\s*\(select\s+max\(([a-z_]+)\)\s+from\s+public\.([a-z_]+)\)\s*,\s*0\s*\)/i,
    );
    if (coalesce) {
      const tableRows = this.tables.get(coalesce[2]) ?? [];
      return tableRows.reduce(
        (max, row) => Math.max(max, Number(row[coalesce[1]] ?? 0)),
        0,
      );
    }
    const parameterCast = value.match(/^(\$\d+)::jsonb$/);
    if (parameterCast) {
      const raw = params[Number(parameterCast[1].slice(1)) - 1];
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
    if (/^\$\d+$/.test(value)) {
      return params[Number(value.slice(1)) - 1];
    }
    const jsonLiteral = value.match(/^'(.*)'::jsonb$/s);
    if (jsonLiteral) {
      return JSON.parse(jsonLiteral[1].replace(/''/g, "'"));
    }
    const literal = value.match(/^'(.*)'$/s);
    if (literal) {
      return literal[1].replace(/''/g, "'");
    }
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      return Number(value);
    }
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    return value;
  }

  private applyDefaults(table: string, row: Row): void {
    if (table === 'ewoh_control_request' && !row.requested_at) {
      row.requested_at = new Date();
    }
    if (table === 'ewoh_control_command' && !row.sent_at) {
      row.sent_at = new Date();
    }
    if (table === 'ewoh_control_result' && !row.completed_at) {
      row.completed_at = new Date();
    }
    if (table === 'ewoh_resource_preorder' && !row.start_time) {
      row.start_time = new Date();
    }
    if (table === 'ewoh_resource_binding' && !row.start_time) {
      row.start_time = new Date();
    }
    if (table === 'ewoh_world_delta_log') {
      if (!row.seq) {
        row.seq = ++this.seq;
      }
      if (!row.occurred_at) {
        row.occurred_at = new Date();
      }
    }
    if (table === 'ewoh_world_snapshot' && !row.created_at) {
      row.created_at = new Date();
    }
  }
}
