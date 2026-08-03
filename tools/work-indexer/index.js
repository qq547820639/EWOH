#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_PATHS = [
  { path: '.codex/artifacts/task-board.md', required: true, owner: 'AG-00', mediaType: 'text/markdown' },
  { path: '.codex/artifacts/gates.md', required: true, owner: 'AG-00', mediaType: 'text/markdown' },
  { path: '.codex/artifacts/agent-registry.md', required: true, owner: 'AG-00', mediaType: 'text/markdown' },
  { path: '.codex/artifacts/risk-register.md', required: true, owner: 'AG-00', mediaType: 'text/markdown' },
  { path: '.codex/artifacts/decision-log.md', required: true, owner: 'AG-00', mediaType: 'text/markdown' },
  { path: '.codex/artifacts/phase-state.md', required: true, owner: 'AG-00', mediaType: 'text/markdown' },
  { path: '.codex/artifacts/state.json', required: true, owner: 'AG-00', mediaType: 'application/json' },
  { path: '.codex/artifacts/intent-anchor.md', required: true, owner: 'AG-00', mediaType: 'text/markdown' },
  { path: '.codex/artifacts/understanding.md', required: true, owner: 'AG-00', mediaType: 'text/markdown' },
  { path: '.codex/artifacts/work/task-graph.md', required: true, owner: 'AG-00', mediaType: 'text/markdown' },
  { path: '.codex/artifacts/authoritative-plan-final6.txt', required: true, owner: 'AG-00', mediaType: 'text/plain' },
];

function findArtifactsDir(cwd) {
  const candidates = [
    process.env.EWOH_WORK_ARTIFACTS_DIR,
    path.resolve(cwd, '.codex/artifacts'),
    path.resolve(cwd, '..', '.codex/artifacts'),
    path.resolve(cwd, '..', '..', '.codex/artifacts'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'task-board.md'))) {
      return candidate;
    }
  }
  return path.resolve(cwd, '.codex/artifacts');
}

function checksum(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function runGit(args, root) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .replace(/\s+$/g, '');
  } catch {
    return '';
  }
}

function parseYamlFrontMatter(text) {
  const source = String(text || '');
  if (!source.startsWith('---\n')) {
    return { frontMatter: {}, body: source };
  }
  const end = source.indexOf('\n---', 4);
  if (end === -1) {
    return { frontMatter: {}, body: source };
  }
  const block = source.slice(4, end);
  const body = source.slice(end + 4).replace(/^\n/, '');
  const frontMatter = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim().replace(/^["']|["']$/g, '');
    if (value === 'true' || value === 'false') {
      value = value === 'true';
    } else if (value !== '' && !Number.isNaN(Number(value))) {
      value = Number(value);
    }
    frontMatter[key] = value;
  }
  return { frontMatter, body };
}

function currentEnvFingerprint(root) {
  const lockFile = path.join(root, 'ewoh-spark-app', 'package-lock.json');
  const envFile = path.join(root, '.codex', 'artifacts', 'inventory', 'environment.md');
  const parts = [];
  for (const file of [lockFile, envFile]) {
    parts.push(
      fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `missing:${file}`,
    );
  }
  return sha256Text(parts.join('\n---\n'));
}

function currentBuildVersion(root) {
  const changelog = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(changelog)) return 'unknown';
  const match = fs
    .readFileSync(changelog, 'utf8')
    .match(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}/m);
  return match?.[1] || 'unknown';
}

function currentDependencyVersion(root) {
  const lockFile = path.join(root, 'ewoh-spark-app', 'package-lock.json');
  if (!fs.existsSync(lockFile)) return 'unknown';
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const rootPackage = lock.packages?.[''] || {};
    return `${lock.lockfileVersion ?? 'unknown'}:${rootPackage.version ?? 'unknown'}`;
  } catch {
    return 'unknown';
  }
}

function currentCodeHead(root) {
  return runGit(
    [
      'log',
      '-1',
      '--format=%H',
      '--',
      'ewoh-spark-app/server',
      'ewoh-spark-app/client/src',
      'src/edge_platform',
      'tools',
      'scripts',
      'contracts',
      'db',
    ],
    root,
  );
}

function deriveEvidenceBinding(artifactsDir, root, entry, file, sourceText) {
  const { frontMatter, body } = parseYamlFrontMatter(sourceText);
  const linked = body.match(/\b(T-\d{3}|G\d{2}|WP-[A-Z-]+\d{3})\b/);
  const testTime = frontMatter.testTime
    ? new Date(frontMatter.testTime).toISOString()
    : fs.statSync(file).mtime.toISOString();
  const expiresAt = frontMatter.expiresAt
    ? new Date(frontMatter.expiresAt).toISOString()
    : new Date(Date.parse(testTime) + 90 * 24 * 60 * 60 * 1000).toISOString();
  const commitSha = frontMatter.commitSha
    ? String(frontMatter.commitSha)
    : runGit(['log', '-1', '--format=%H', '--', path.relative(root, file)], root);
  const branch = frontMatter.branch
    ? String(frontMatter.branch)
    : runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root) || 'unknown';
  const codeHead = currentCodeHead(root);
  const envFingerprint = frontMatter.envFingerprint
    ? String(frontMatter.envFingerprint)
    : currentEnvFingerprint(root);
  const buildVersion = frontMatter.buildVersion
    ? String(frontMatter.buildVersion)
    : currentBuildVersion(root);
  const dependencyVersion = frontMatter.dependencyVersion
    ? String(frontMatter.dependencyVersion)
    : currentDependencyVersion(root);
  const verifier = frontMatter.verifier
    ? String(frontMatter.verifier)
    : 'unknown';
  const hasFrontMatter = Object.keys(frontMatter).length > 0;
  const workItemIds = Array.isArray(frontMatter.workItemIds)
    ? frontMatter.workItemIds.map(String)
    : typeof frontMatter.workItemIds === 'string'
      ? frontMatter.workItemIds
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  const expired = Date.parse(expiresAt) <= Date.now();
  const staleByCommit = Boolean(codeHead && commitSha && codeHead !== commitSha);
  const staleByEnv =
    Boolean(frontMatter.envFingerprint) &&
    frontMatter.envFingerprint !== currentEnvFingerprint(root);
  let status = 'valid';
  let staleReason = undefined;
  if (!hasFrontMatter) {
    status = 'unbound';
    staleReason = 'evidence file has no machine-readable front matter';
  } else if (expired) {
    status = 'expired';
    staleReason = `evidence expired at ${expiresAt}`;
  } else if (staleByCommit || staleByEnv) {
    status = 'stale';
    staleReason = staleByCommit
      ? `evidence commit ${commitSha} differs from code HEAD ${codeHead}`
      : 'environment fingerprint differs from current workspace';
  }
  return {
    frontMatter,
    body,
    workItemId: frontMatter.workItemId
      ? String(frontMatter.workItemId)
      : linked?.[1] || '',
    workItemIds,
    commitSha,
    branch,
    buildVersion,
    envFingerprint,
    dependencyVersion,
    testTime,
    verifier,
    expiresAt,
    status,
    staleReason,
  };
}

function mediaType(file) {
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.yaml') || file.endsWith('.yml')) return 'application/yaml';
  if (file.endsWith('.md')) return 'text/markdown';
  if (file.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

function normalizeHeader(header) {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isSeparatorRow(row) {
  return (
    row.length > 0 &&
    row.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/`/g, '')))
  );
}

function markdownTables(text) {
  const tables = [];
  let current = null;
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      if (/^Wave\s|^W\d/i.test(heading[2])) {
        section = heading[2].trim();
      }
      current = null;
      continue;
    }
    if (!line.trim().startsWith('|')) {
      if (current) {
        tables.push(current);
        current = null;
      }
      continue;
    }
    const cells = splitRow(line);
    if (cells.length < 2) {
      continue;
    }
    if (!current) {
      current = { section, header: cells, rows: [] };
    } else if (isSeparatorRow(cells)) {
      // markdown separator
    } else {
      current.rows.push(cells);
    }
  }
  if (current) {
    tables.push(current);
  }
  return tables;
}

function rowsToObjects(table) {
  return table.rows.map((row) => {
    const object = {};
    table.header.forEach((header, index) => {
      object[normalizeHeader(header)] = row[index] ?? '';
    });
    return object;
  });
}

function splitAgents(value) {
  return String(value || '')
    .split(/[\/,，、\s]+/)
    .map((part) => part.trim())
    .filter((part) => /^(AG|ORCH|PROD|INT|VAL|PX)-\d{2}$/i.test(part))
    .map((part) => part.toUpperCase());
}

function parseTaskBoard(text) {
  const items = [];
  for (const table of markdownTables(text)) {
    const objects = rowsToObjects(table);
    const header = table.header.map(normalizeHeader);
    if (!header.includes('id') || !(header.includes('task') || header.includes('name'))) {
      continue;
    }
    for (const row of objects) {
      const id = (row.id || '').trim();
      const title = (row.task || row.name || '').trim();
      if (!id || !title) continue;
      const owner = (row.owner || row.agent || '').trim();
      items.push({
        id,
        title,
        type: 'task',
        status: (row.status || 'Proposed').trim(),
        owner: owner || 'AG-00',
        agents: splitAgents(owner),
        wave: /^Wave\s+(.+)$/i.test(table.section)
          ? table.section.replace(/^Wave\s+/i, '')
          : undefined,
        evidence: (row.evidence || '').trim() || undefined,
        summary: (row.output_contract || row.deliverable || '').trim() || undefined,
      });
    }
  }
  return items;
}

function parseGates(text) {
  const gates = [];
  for (const table of markdownTables(text)) {
    const objects = rowsToObjects(table);
    const header = table.header.map(normalizeHeader);
    if (!header.includes('gate') || !header.includes('meaning')) {
      continue;
    }
    for (const row of objects) {
      const gateId = (row.gate || '').trim();
      if (!gateId) continue;
      const title = (row.meaning || '').trim();
      const status = (row.current_status || row.status || '').trim();
      const calculated = calculateGateStatus(status);
      gates.push({
        id: gateId,
        title,
        type: 'gate',
        status,
        owner: 'AG-00',
        evidence: (row.evidence_required || '').trim() || undefined,
        calculatedStatus: calculated,
        humanDecision: null,
        conditions: (row.evidence_required || '')
          .split(';')
          .map((item) => item.trim())
          .filter(Boolean),
      });
    }
  }
  return gates;
}

function calculateGateStatus(rawStatus) {
  const value = String(rawStatus || '').toLowerCase();
  if (value.includes('passed')) return 'passed';
  if (value.includes('blocked')) return 'blocked';
  if (value.includes('validation') || value.includes('in progress')) return 'in_progress';
  if (value.includes('pending') || value.includes('production pending')) {
    return 'requires_approval';
  }
  return 'pending';
}

function parseActors(text) {
  const actors = [];
  for (const table of markdownTables(text)) {
    const objects = rowsToObjects(table);
    const header = table.header.map(normalizeHeader);
    if (!header.includes('id') || !header.includes('role')) {
      continue;
    }
    for (const row of objects) {
      const actorId = (row.id || '').trim();
      if (!actorId) continue;
      const role = (row.role || '').trim();
      actors.push({
        actorId,
        name: (row.nickname || row.name || actorId).trim(),
        kind: /^(human|team)$/i.test(role) ? role.toLowerCase() : 'agent',
        role,
        ownership: (row.ownership || row.owns || '').trim() || undefined,
        permissions: (row.permissions || '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        runtime: (row.runtime || row.local_mapping || '').trim() || undefined,
        status: (row.status || 'registered').trim(),
      });
    }
  }
  return actors;
}

function parseRisks(text) {
  const risks = [];
  for (const table of markdownTables(text)) {
    const objects = rowsToObjects(table);
    const header = table.header.map(normalizeHeader);
    if (!header.includes('id') || !header.includes('risk')) {
      continue;
    }
    for (const row of objects) {
      const id = (row.id || '').trim();
      if (!id) continue;
      risks.push({
        id,
        title: (row.risk || '').trim(),
        severity: normalizeSeverity(row.level || row.severity),
        likelihood: row.likelihood || undefined,
        trigger: row.trigger || undefined,
        owner: (row.owner || '').trim() || undefined,
        mitigation: (row.current_mitigation || row.mitigation || '').trim() || undefined,
        status: row.status || 'open',
        linkedItems: splitAgents(row.linked_items || ''),
      });
    }
  }
  return risks;
}

function normalizeSeverity(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('critical')) return 'critical';
  if (raw.includes('high')) return 'high';
  if (raw.includes('medium')) return 'medium';
  return 'low';
}

function parseDecisions(text) {
  const decisions = [];
  for (const table of markdownTables(text)) {
    const objects = rowsToObjects(table);
    const header = table.header.map(normalizeHeader);
    if (!header.includes('id') || !header.includes('decision')) {
      continue;
    }
    for (const row of objects) {
      const id = (row.id || '').trim();
      if (!id) continue;
      decisions.push({
        id,
        title: (row.decision || '').trim(),
        date: (row.date || '').trim(),
        decision: (row.decision || '').trim(),
        rationale: (row.rationale || '').trim() || undefined,
        reversibility: (row.reversibility || '').trim() || undefined,
      });
    }
  }
  return decisions;
}

function extractCriticalPath(text) {
  const lines = text.split(/\r?\n/);
  const capture = [];
  let active = false;
  for (const line of lines) {
    if (/^#{1,6}\s*Critical Path/i.test(line)) {
      active = true;
      continue;
    }
    if (active) {
      if (/^#{1,6}\s/.test(line)) break;
      if (line.trim()) capture.push(line.trim());
    }
  }
  return capture.join(' ') || 'not specified';
}

function parseTaskGraph(text) {
  const items = [];
  const edges = [];
  let edgeIndex = 0;
  for (const table of markdownTables(text)) {
    const objects = rowsToObjects(table);
    const header = table.header.map(normalizeHeader);
    if (header.includes('wave') && header.includes('parallel_work')) {
      for (const row of objects) {
        const id = (row.wave || '').trim();
        if (!id) continue;
        items.push({
          id,
          title: (row.parallel_work || '').trim(),
          type: 'wave',
          status: row.exit ? 'Proposed' : 'Proposed',
          owner: 'AG-00',
          wave: id,
          summary: (row.exit || '').trim() || undefined,
        });
        const dependencies = String(row.waits_for || row.depends_on || '')
          .split(',')
          .map((part) => part.trim())
          .filter(
            (part) => part && !/^(none|n\/a|-)$/i.test(part),
          );
        for (const dependency of dependencies) {
          edges.push({
            id: `E-${String(++edgeIndex).padStart(3, '0')}`,
            from: dependency,
            to: id,
            edgeType: 'depends',
            blocking: true,
            evidenceRequirement: row.exit || undefined,
          });
        }
      }
    } else if (header.includes('package') && header.includes('depends_on')) {
      for (const row of objects) {
        const id = (row.package || '').trim();
        if (!id) continue;
        items.push({
          id,
          title: id,
          type: 'package',
          status: (row.status || 'Proposed').trim(),
          owner: (row.owner || 'AG-00').trim(),
          agents: splitAgents(row.owner),
          summary: row.output_contract || undefined,
        });
        const dependencies = String(row.depends_on || '')
          .split(',')
          .map((part) => part.trim())
          .filter(
            (part) => part && !/^(none|n\/a|-)$/i.test(part),
          );
        for (const dependency of dependencies) {
          edges.push({
            id: `E-${String(++edgeIndex).padStart(3, '0')}`,
            from: dependency,
            to: id,
            edgeType: 'depends',
            blocking: true,
          });
        }
      }
    }
  }
  return { items, edges, criticalPath: extractCriticalPath(text) };
}

function parseEvidence(artifactsDir, root) {
  const evidenceDir = path.join(artifactsDir, 'work', 'evidence');
  const result = [];
  if (!fs.existsSync(evidenceDir)) {
    return result;
  }
  for (const entry of fs.readdirSync(evidenceDir).sort()) {
    if (!entry.endsWith('.md')) continue;
    const file = path.join(evidenceDir, entry);
    const text = fs.readFileSync(file, 'utf8');
    const binding = deriveEvidenceBinding(
      artifactsDir,
      root || path.resolve(artifactsDir, '..'),
      entry,
      file,
      text,
    );
    const titleMatch = binding.body.match(/^#\s+(.+)$/m);
    const title = (titleMatch?.[1] || entry.replace(/\.md$/, '')).trim();
    const kind = /review/i.test(entry)
      ? 'review'
      : /round|e2e|tck|test/i.test(entry)
        ? 'test'
        : 'evidence';
    const resultValue = /PASSED|passed|PASS|GREEN|green/i.test(binding.body)
      ? 'passed'
      : /FAILED|failed|BLOCKED|blocked/i.test(binding.body)
        ? 'failed'
        : 'unknown';
    const baseEvidenceId = `EVD-${entry.replace(/\.md$/, '').replace(/[^A-Za-z0-9]+/g, '-')}`;
    const linkedItems =
      binding.workItemIds.length > 0
        ? binding.workItemIds
        : [binding.workItemId];
    for (const [index, workItemId] of linkedItems.entries()) {
      result.push({
      evidenceId:
        linkedItems.length > 1 ? `${baseEvidenceId}-${index + 1}` : baseEvidenceId,
      workItemId,
      kind,
      path: `.codex/artifacts/work/evidence/${entry}`,
      checksum: checksum(file),
      result: resultValue,
      title,
      branch: binding.branch,
      commitSha: binding.commitSha,
      buildVersion: binding.buildVersion,
      envFingerprint: binding.envFingerprint,
      dependencyVersion: binding.dependencyVersion,
      testTime: binding.testTime,
      verifier: binding.verifier,
      expiresAt: binding.expiresAt,
      status: binding.status,
      staleReason: binding.staleReason,
      });
    }
  }
  return result;
}

function validateGraph(graph) {
  const conflicts = [];
  const itemIds = new Set((graph.items || []).map((item) => item.id));
  const evidenceIds = new Set((graph.evidence || []).map((entry) => entry.evidenceId));
  const nodeIds = new Set([...itemIds, ...evidenceIds]);
  const itemSeen = new Set();
  for (const item of graph.items || []) {
    if (itemSeen.has(item.id)) {
      conflicts.push(`duplicate item id: ${item.id}`);
    }
    itemSeen.add(item.id);
    if (!item.owner || !String(item.owner).trim()) {
      conflicts.push(`item without owner: ${item.id}`);
    }
    if (!item.status || !String(item.status).trim()) {
      conflicts.push(`item without status: ${item.id}`);
    }
  }
  const edgeSeen = new Set();
  for (const edge of graph.edges || []) {
    if (edgeSeen.has(edge.id)) {
      conflicts.push(`duplicate edge id: ${edge.id}`);
    }
    edgeSeen.add(edge.id);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      conflicts.push(
        `orphan edge ${edge.id}: ${edge.from} -> ${edge.to}`,
      );
    }
  }
  const evidenceSeen = new Set();
  for (const entry of graph.evidence || []) {
    if (evidenceSeen.has(entry.evidenceId)) {
      conflicts.push(`duplicate evidence id: ${entry.evidenceId}`);
    }
    evidenceSeen.add(entry.evidenceId);
  }
  const blocking = (graph.edges || []).filter((edge) => edge.blocking);
  const adjacency = new Map();
  for (const edge of blocking) {
    const targets = adjacency.get(edge.from) || [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const visiting = new Set();
  const visited = new Set();
  const hasCycle = (node) => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const target of adjacency.get(node) || []) {
      if (hasCycle(target)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (const node of adjacency.keys()) {
    if (hasCycle(node)) {
      conflicts.push(`blocking dependency cycle detected at ${node}`);
      break;
    }
  }
  return conflicts;
}

function parseResources(artifactsDir) {
  const file = path.join(artifactsDir, 'inventory', 'environment.md');
  const resources = [];
  if (!fs.existsSync(file)) {
    return resources;
  }
  for (const table of markdownTables(fs.readFileSync(file, 'utf8'))) {
    const objects = rowsToObjects(table);
    const header = table.header.map(normalizeHeader);
    if (!header.includes('tool') && !header.includes('name')) continue;
    for (const row of objects) {
      const name = (row.tool || row.name || '').trim();
      if (!name) continue;
      const notes = `${row.version || ''} ${row.notes || ''}`.trim();
      const status = /missing|unavailable|absent|no\b/i.test(notes) ? 'missing' : 'available';
      resources.push({
        resourceId: `RES-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name,
        kind: 'environment',
        status,
        purpose: notes || undefined,
      });
    }
  }
  return resources;
}

function parseHandoffs(artifactsDir) {
  const handoffDir = path.join(artifactsDir, 'work', 'handoffs');
  const result = [];
  if (!fs.existsSync(handoffDir)) return result;
  for (const entry of fs.readdirSync(handoffDir).sort()) {
    if (!entry.endsWith('.md')) continue;
    const file = path.join(handoffDir, entry);
    const text = fs.readFileSync(file, 'utf8');
    const title = (text.match(/^#\s+(.+)$/m)?.[1] || entry.replace(/\.md$/, '')).trim();
    const baseId = entry.replace(/\.md$/, '');
    result.push({
      handoffId: baseId.startsWith('HO-') ? baseId : `HO-${baseId}`,
      fromActor: text.match(/^From:\s*(.+)$/m)?.[1]?.trim() || 'unknown',
      toActor: text.match(/^To:\s*(.+)$/m)?.[1]?.trim() || 'unknown',
      scope: title,
      status: text.match(/^Status:\s*(.+)$/m)?.[1]?.trim() || 'open',
      createdAt: fs.statSync(file).mtime.toISOString(),
      contextPack: `.codex/artifacts/work/handoffs/${entry}`,
    });
  }
  return result;
}

function parseArtifacts(artifactsDir, paths) {
  const result = [];
  for (const entry of paths) {
    const relative = entry.path.startsWith('.codex/artifacts/')
      ? entry.path.slice('.codex/artifacts/'.length)
      : entry.path;
    const file = path.resolve(artifactsDir, relative);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
    result.push({
      artifactId: relative.replace(/\.codex\/artifacts\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, ''),
      path: relative,
      mediaType: entry.mediaType || mediaType(file),
      checksum: checksum(file),
      version: 'current',
      producedBy: entry.owner || 'AG-00',
      sensitivity: 'internal',
    });
  }
  return result;
}

function loadPathRegistry(root) {
  const file = path.resolve(root, 'contracts/work/artifact-paths.json');
  if (!fs.existsSync(file)) return DEFAULT_PATHS;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed.paths) && parsed.paths.length > 0) {
      return parsed.paths;
    }
  } catch {
    // fall back to defaults
  }
  return DEFAULT_PATHS;
}

function indexWorkGraph(artifactsDir, options = {}) {
  const root = options.root || path.resolve(artifactsDir, '..');
  const pathRegistry = loadPathRegistry(root);
  const taskBoard = fs.existsSync(path.join(artifactsDir, 'task-board.md'))
    ? fs.readFileSync(path.join(artifactsDir, 'task-board.md'), 'utf8')
    : '';
  const gatesText = fs.existsSync(path.join(artifactsDir, 'gates.md'))
    ? fs.readFileSync(path.join(artifactsDir, 'gates.md'), 'utf8')
    : '';
  const agentText = fs.existsSync(path.join(artifactsDir, 'agent-registry.md'))
    ? fs.readFileSync(path.join(artifactsDir, 'agent-registry.md'), 'utf8')
    : '';
  const riskText = fs.existsSync(path.join(artifactsDir, 'risk-register.md'))
    ? fs.readFileSync(path.join(artifactsDir, 'risk-register.md'), 'utf8')
    : '';
  const decisionText = fs.existsSync(path.join(artifactsDir, 'decision-log.md'))
    ? fs.readFileSync(path.join(artifactsDir, 'decision-log.md'), 'utf8')
    : '';
  const taskGraphText = fs.existsSync(path.join(artifactsDir, 'work', 'task-graph.md'))
    ? fs.readFileSync(path.join(artifactsDir, 'work', 'task-graph.md'), 'utf8')
    : '';

  const items = [];
  const edges = [];
  const itemMap = new Map();
  const addItem = (item) => {
    if (!itemMap.has(item.id)) {
      itemMap.set(item.id, item);
      items.push(item);
    }
  };

  for (const task of parseTaskBoard(taskBoard)) addItem(task);
  for (const gate of parseGates(gatesText)) {
    const { calculatedStatus, humanDecision, conditions, ...item } = gate;
    addItem(item);
  }
  const graph = parseTaskGraph(taskGraphText);
  for (const item of graph.items) addItem(item);
  edges.push(...graph.edges);

  let edgeIndex = edges.length;
  const addEdge = (edge) => {
    edgeIndex += 1;
    edges.push({ id: `E-${String(edgeIndex).padStart(3, '0')}`, ...edge });
  };

  // Evidence edges from evidence records to their linked work items.
  const evidence = parseEvidence(artifactsDir, root);
  for (const entry of evidence) {
    if (entry.workItemId && itemMap.has(entry.workItemId)) {
      addEdge({
        from: entry.workItemId,
        to: entry.evidenceId,
        edgeType: 'evidence',
        blocking: false,
      });
    }
  }

  const gates = parseGates(gatesText);
  const gateMap = new Map(gates.map((gate) => [gate.id, gate]));
  const actors = parseActors(agentText);
  const risks = parseRisks(riskText);
  const decisions = parseDecisions(decisionText);
  const resources = parseResources(artifactsDir);
  const handoffs = parseHandoffs(artifactsDir);
  const artifacts = parseArtifacts(artifactsDir, pathRegistry);

  const statusCounts = {};
  for (const item of items) {
    const status = item.status || 'Unknown';
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  const conflicts = [];
  const missing = pathRegistry
    .filter((entry) => entry.required)
    .map((entry) => entry.path)
    .filter((entryPath) => {
      const relative = entryPath.startsWith('.codex/artifacts/')
        ? entryPath.slice('.codex/artifacts/'.length)
        : entryPath;
      return !fs.existsSync(path.resolve(artifactsDir, relative));
    });
  if (missing.length > 0) {
    conflicts.push(`missing required artifacts: ${missing.join(', ')}`);
  }

  const graphData = {
    schema: 'ewoh:///work-graph/v1',
    generatedAt: new Date().toISOString(),
    sourceRoot: artifactsDir,
    criticalPath: graph.criticalPath,
    summary: {
      itemCount: items.length,
      edgeCount: edges.length,
      actorCount: actors.length,
      artifactCount: artifacts.length,
      evidenceCount: evidence.length,
      gateCount: gates.length,
      riskCount: risks.length,
      decisionCount: decisions.length,
      statusCounts,
      conflicts,
    },
    items,
    edges,
    actors,
    artifacts,
    evidence,
    gates: gates.map((gate) => ({
      gateId: gate.id,
      title: gate.title,
      calculatedStatus: gate.calculatedStatus,
      humanDecision: gate.humanDecision,
      conditions: gate.conditions,
      approver: null,
      decidedAt: null,
    })),
    risks,
    decisions,
    resources,
    handoffs,
  };
  graphData.invariants = validateGraph(graphData);
  return graphData;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    output: null,
    strict: false,
    invariants: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      options.root = argv[++index];
    } else if (argument === '--output') {
      options.output = argv[++index];
    } else if (argument === '--strict') {
      options.strict = true;
    } else if (argument === '--invariants') {
      options.invariants = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifactsDir = findArtifactsDir(options.root);
  const graph = indexWorkGraph(artifactsDir, { root: options.root });
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(
      path.resolve(options.output),
      `${JSON.stringify(graph, null, 2)}\n`,
      'utf8',
    );
    console.log(`Work graph written: ${path.resolve(options.output)}`);
  }
  const counts = graph.summary;
  console.log(
    `Work graph index: ${counts.itemCount} items | ${counts.edgeCount} edges | ` +
      `${counts.actorCount} actors | ${counts.evidenceCount} evidence | ${counts.gateCount} gates | ` +
      `${counts.conflicts.length} conflicts`,
  );
  for (const conflict of counts.conflicts) {
    console.log(`  conflict: ${conflict}`);
  }
  if (options.strict && counts.conflicts.length > 0) {
    process.exitCode = 1;
  }
  if (options.invariants && graph.invariants.length > 0) {
    console.log('Invariant violations:');
    for (const conflict of graph.invariants) {
      console.log(`  ${conflict}`);
    }
    process.exitCode = 1;
  }
}

module.exports = {
  calculateGateStatus,
  findArtifactsDir,
  indexWorkGraph,
  markdownTables,
  parseActors,
  parseDecisions,
  parseEvidence,
  parseGates,
  parseResources,
  parseRiskText: parseRisks,
  parseTaskBoard,
  parseTaskGraph,
  rowsToObjects,
  validateGraph,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}
