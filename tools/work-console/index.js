#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const workIndexer = require('../work-indexer/index.js');
const gateEngine = require('../gate-engine/index.js');

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    output: null,
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      options.root = argv[++index];
    } else if (argument === '--output') {
      options.output = argv[++index];
    } else if (argument === '--strict') {
      options.strict = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function computeBlockedItems(graph) {
  const items = graph.items || [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const blocked = new Set(
    items
      .filter((item) => /blocked/i.test(item.status || ''))
      .map((item) => item.id),
  );
  const outgoing = new Map();
  for (const edge of graph.edges || []) {
    if (!edge.blocking) continue;
    const targets = outgoing.get(edge.from) || [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const incoming = new Map();
  for (const edge of graph.edges || []) {
    if (!edge.blocking) continue;
    const sources = incoming.get(edge.to) || [];
    sources.push(edge.from);
    incoming.set(edge.to, sources);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (blocked.has(item.id)) continue;
      const dependencies = incoming.get(item.id) || [];
      if (dependencies.some((dependency) => blocked.has(dependency))) {
        blocked.add(item.id);
        changed = true;
      }
    }
  }
  const affected = new Set();
  const queue = [...blocked];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const target of outgoing.get(current) || []) {
      if (!affected.has(target)) {
        affected.add(target);
        queue.push(target);
      }
    }
  }
  const explicitBlocked = items.filter((item) =>
    /blocked/i.test(item.status || ''),
  );
  const owners = new Set();
  for (const id of explicitBlocked.map((item) => item.id)) {
    const item = byId.get(id);
    if (item?.owner) owners.add(item.owner);
    for (const source of incoming.get(id) || []) {
      const sourceItem = byId.get(source);
      if (sourceItem?.owner) owners.add(sourceItem.owner);
    }
  }
  return {
    blockedItems: explicitBlocked
      .map((item) => item.id)
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        owner: item.owner,
      })),
    affectedItems: [...affected]
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        owner: item.owner,
      })),
    unblockOwners: [...owners].sort(),
  };
}

function computeMissingEvidence(graph) {
  const evidenceByItem = new Map();
  for (const entry of graph.evidence || []) {
    const list = evidenceByItem.get(entry.workItemId) || [];
    list.push(entry);
    evidenceByItem.set(entry.workItemId, list);
  }
  return (graph.items || [])
    .filter((item) =>
      /^(Done|Validation|Integrated|Review)$/i.test(item.status || ''),
    )
    .map((item) => {
      const evidence = evidenceByItem.get(item.id) || [];
      const bad = evidence.filter((entry) =>
        ['expired', 'stale', 'unbound'].includes(entry.status || ''),
      );
      const missing =
        evidence.length === 0 || bad.length === evidence.length;
      return {
        id: item.id,
        title: item.title,
        status: item.status,
        evidenceCount: evidence.length,
        missing,
        staleEvidence: bad.map((entry) => entry.evidenceId),
      };
    })
    .filter((entry) => entry.missing);
}

function loadHumanDecisions(artifactsDir) {
  const file = path.join(artifactsDir, 'work', 'gate-decisions.json');
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const EVIDENCE_META_FIELDS = [
  'commitSha',
  'branch',
  'buildVersion',
  'envFingerprint',
  'dependencyVersion',
  'testTime',
  'verifier',
  'expiresAt',
];

// 审计顶层证据对象的元数据完整性：统计每个字段在所有证据中的缺失/未知数量。
function computeEvidenceMeta(graph) {
  const evidence = graph.evidence || [];
  const total = evidence.length;
  const fields = {};
  for (const field of EVIDENCE_META_FIELDS) {
    let missing = 0;
    let unknown = 0;
    for (const entry of evidence) {
      const value = entry[field];
      if (value === undefined || value === null || value === '') missing += 1;
      if (value === 'unknown') unknown += 1;
    }
    fields[field] = { present: total - missing, missing, unknown };
  }
  return {
    total,
    fields,
    complete: total > 0 && evidence.every((entry) =>
      EVIDENCE_META_FIELDS.every((field) => {
        const value = entry[field];
        return value !== undefined && value !== null && value !== '';
      }),
    ),
  };
}

function computeGraphSummary(graph, artifactsDir) {
  const blockedResult = computeBlockedItems(graph);
  const missingEvidence = computeMissingEvidence(graph);
  const finalGates = gateEngine.calculate(
    graph.gates || [],
    loadHumanDecisions(artifactsDir || graph.sourceRoot),
    artifactsDir || graph.sourceRoot,
  );
  const requiresApproval = finalGates.filter(
    (gate) =>
      gate.calculatedStatus === 'requires_approval' ||
      gate.calculatedStatus === 'pending',
  );
  const blockedOwners = new Set(
    blockedResult.blockedItems.map((item) => item.owner),
  );
  const missingOwners = new Set(
    missingEvidence.map((item) => {
      const found = (graph.items || []).find((candidate) => candidate.id === item.id);
      return found?.owner || '';
    }),
  );
  return {
    generatedAt: graph.generatedAt,
    sourceRoot: graph.sourceRoot,
    criticalPath: graph.criticalPath,
    counts: graph.summary,
    evidenceMeta: computeEvidenceMeta(graph),
    blocked: blockedResult,
    missingEvidence,
    gateSummary: {
      requiresApproval: requiresApproval.map((gate) => ({
        gateId: gate.gateId,
        title: gate.title,
        calculatedStatus: gate.calculatedStatus,
        conditions: gate.conditions || [],
      })),
    },
    answers: {
      whereBlocked:
        blockedResult.blockedItems.length > 0
          ? blockedResult.blockedItems
              .map((item) => `${item.id} ${item.title}`)
              .join('；')
          : '当前没有状态为 blocked 的任务节点',
      whyBlocked:
        blockedResult.blockedItems.length > 0
          ? '阻塞节点或其依赖节点仍处于 Blocked 状态，需要先解除依赖并补齐证据'
          : '无阻塞节点',
      whoCanUnblock:
        blockedResult.unblockOwners.length > 0
          ? blockedResult.unblockOwners.join('、')
          : '无阻塞节点',
      missingEvidence:
        missingEvidence.length > 0
          ? missingEvidence
              .map(
                (item) =>
                  `${item.id}（现有 ${item.evidenceCount} 条，过期/失效 ${item.staleEvidence.length} 条）`,
              )
              .join('；')
          : '无缺失证据',
      affectedTasks:
        blockedResult.affectedItems.length > 0
          ? blockedResult.affectedItems
              .map((item) => `${item.id} ${item.title}`)
              .join('；')
          : '无受影响任务',
    },
    invariantConflicts: graph.invariants || [],
    canUnblock: blockedResult.blockedItems.every((item) => item.owner),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifactsDir = workIndexer.findArtifactsDir(options.root);
  const graph = workIndexer.indexWorkGraph(artifactsDir, {
    root: options.root,
  });
  const summary = computeGraphSummary(graph, artifactsDir);
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.resolve(options.output),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    );
    console.log(`Work console written: ${path.resolve(options.output)}`);
  }
  console.log(
    `Work console: ${summary.blocked.blockedItems.length} blocked | ` +
      `${summary.missingEvidence.length} missing evidence | ` +
      `${summary.gateSummary.requiresApproval.length} gates need approval | ` +
      `${summary.invariantConflicts.length} invariant conflicts`,
  );
  for (const answer of Object.values(summary.answers)) {
    console.log(`  ${answer}`);
  }
  if (
    options.strict &&
    (summary.invariantConflicts.length > 0 || !summary.canUnblock)
  ) {
    process.exitCode = 1;
  }
  // F61-01: strict mode also fails on any unexempted single-source-of-truth
  // semantic conflict (stale HEAD, task/section drift, gate-vs-release
  // readiness, evidence staleness, count drift, etc.).
  if (options.strict) {
    const semanticRules = require('../semantic-rules/lib/engine');
    const semanticCtx = semanticRules.buildContext(options.root);
    const semanticResult = semanticRules.runRules(semanticCtx, { strict: true });
    const unexempted = semanticResult.findings.filter(
      (f) => !(semanticCtx.exemptions || []).includes(f.ruleId),
    );
    if (unexempted.length > 0) {
      console.log(`Semantic conflicts: ${unexempted.length}`);
      for (const finding of unexempted) {
        console.log(
          `  [${finding.severity}] ${finding.ruleId}: ${finding.message}${finding.path ? ` (${finding.path})` : ''}`,
        );
      }
      process.exitCode = 1;
    }
  }
}

module.exports = {
  computeBlockedItems,
  computeEvidenceMeta,
  computeGraphSummary,
  computeMissingEvidence,
  EVIDENCE_META_FIELDS,
  parseArgs,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}
