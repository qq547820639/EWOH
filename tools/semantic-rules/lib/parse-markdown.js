'use strict';

/**
 * F61-01 normalized Markdown parser.
 *
 * Parses a Markdown document into a normalized structure:
 *   {
 *     frontMatter: { key: value },   // YAML-like front matter block
 *     sections: [ { level, title, raw, body } ],
 *     tables: [ { section, header: [..], rows: [ [..] ] , objects: [ {..} ] } ],
 *     body: string
 *   }
 *
 * Uses only Node built-ins. Intentionally dependency-free (no yaml/markdown
 * libs) so it runs anywhere Node runs.
 */

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function normalizeHeader(header) {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function splitRow(line) {
  // Strip leading/trailing pipes and split on unescaped pipes.
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isSeparatorRow(cells) {
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/`/g, '')))
  );
}

/**
 * Parse a simple YAML-like front matter block. Values are coerced to
 * boolean/number when they look like one; quoted strings are unquoted.
 * Nested/array values are not fully supported (kept as raw strings) which is
 * sufficient for the authoritative artifact front matter.
 */
function parseFrontMatterBlock(block) {
  const frontMatter = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    } else if (value === 'null' || value === '~') {
      value = null;
    } else if (value !== '' && !Number.isNaN(Number(value))) {
      value = Number(value);
    }
    frontMatter[key] = value;
  }
  return frontMatter;
}

/**
 * Parse the YAML front matter block at the top of a document.
 * @returns {{ frontMatter: object, body: string }}
 */
function parseFrontMatter(text) {
  const source = String(text || '');
  const match = source.match(FRONT_MATTER_RE);
  if (!match) {
    return { frontMatter: {}, body: source };
  }
  const block = match[1];
  const body = source.slice(match[0].length).replace(/^\r?\n/, '');
  return { frontMatter: parseFrontMatterBlock(block), body };
}

/**
 * Parse markdown tables out of a document body. Each table is associated with
 * the nearest preceding heading (its "section"). Returns an array of:
 *   { section, header, rows, objects, raw }
 */
function parseTables(body) {
  const tables = [];
  let current = null;
  let section = '';
  let header = null;
  let inFence = false;
  let inCode = false;

  const flushBlock = () => {
    if (current) {
      current.raw = current.raw.join('\n').replace(/^\n+|\n+$/g, '');
      tables.push(current);
      current = null;
    }
    header = null;
  };

  for (const line of String(body || '').split(/\r?\n/)) {
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      if (inFence) {
        inFence = false;
      } else {
        inFence = true;
      }
      flushBlock();
      continue;
    }
    if (inFence) continue;
    if (/^    /.test(line) || /^\t/.test(line)) {
      inCode = true;
      flushBlock();
      continue;
    }
    if (inCode) {
      if (!/^    /.test(line) && !/^\t/.test(line)) inCode = false;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushBlock();
      section = heading[2].trim();
      continue;
    }

    if (!trimmed.startsWith('|')) {
      flushBlock();
      continue;
    }

    const cells = splitRow(line);
    if (cells.length < 2) {
      flushBlock();
      continue;
    }

    if (!current && !header) {
      // First line of a table: treat as header.
      header = cells;
      current = { section, header, rows: [], objects: [], raw: [line] };
    } else if (current && isSeparatorRow(cells)) {
      current.raw.push(line);
    } else if (current) {
      current.raw.push(line);
      current.rows.push(cells);
      const obj = {};
      current.header.forEach((h, index) => {
        obj[normalizeHeader(h)] = cells[index] ?? '';
      });
      current.objects.push(obj);
    } else {
      flushBlock();
    }
  }
  flushBlock();
  return tables;
}

/**
 * Parse the section structure (headings) of a document.
 * Returns an array of { level, title, raw, body } for each heading.
 */
function parseSections(body) {
  const sections = [];
  let current = null;
  for (const line of String(body || '').split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      if (current) {
        current.raw = current.raw.join('\n').replace(/^\n+|\n+$/g, '');
        current.body = current.body.join('\n').replace(/^\n+|\n+$/g, '');
        sections.push(current);
      }
      current = { level: heading[1].length, title: heading[2].trim(), raw: [], body: [] };
      continue;
    }
    if (current) {
      current.raw.push(line);
      current.body.push(line);
    }
  }
  if (current) {
    current.raw = current.raw.join('\n').replace(/^\n+|\n+$/g, '');
    current.body = current.body.join('\n').replace(/^\n+|\n+$/g, '');
    sections.push(current);
  }
  return sections;
}

/**
 * Normalized markdown parser entry point.
 * @returns {{ frontMatter: object, sections: array, tables: array, body: string }}
 */
function parseMarkdown(text) {
  const { frontMatter, body } = parseFrontMatter(text);
  return {
    frontMatter,
    sections: parseSections(body),
    tables: parseTables(body),
    body,
  };
}

module.exports = {
  parseFrontMatter,
  parseMarkdown,
  parseSections,
  parseTables,
  normalizeHeader,
  splitRow,
  isSeparatorRow,
};