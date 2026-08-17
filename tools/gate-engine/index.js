#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const workIndexer = require('../work-indexer/index.js');

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    graph: null,
    output: null,
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      options.root = argv[++index];
    } else if (argument === '--graph') {
      options.graph = argv[++index];
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

/**
 * calculate(gates, humanDecisions, options)
 * TOOL-011: 移除未使用的 artifactsDir 死参数。
 * TOOL-003: 人工 approved/conditional 决策必须携带有效 approver——非空，
 * 且当提供 options.actors（work graph 的 agent-registry 演员）时，
 * approver 必须是其中注册的 human/team 演员（与上游 RBAC 一致）；
 * 无效 approver 的正向决策不予采纳，回退常规状态判定并标记原因。
 * TOOL-012: 需审批判定改用显式 /^G(\d+)$/ 编号匹配 + 标题关键词，
 * 不再对 gateId 做“剔除非数字取整”的宽松解析。
 */
function calculate(gates, humanDecisions, options = {}) {
  const decisions = new Map(
    humanDecisions.map((entry) => [entry.gateId, entry]),
  );
  const humanActors = new Set(
    (options.actors || [])
      .filter((actor) => actor && /^(human|team)$/i.test(String(actor.kind || '')))
      .map((actor) => String(actor.actorId || actor.name || '').trim())
      .filter(Boolean),
  );
  const validApprover = (human) => {
    const approver = String(human?.approver || '').trim();
    if (!approver) return false;
    if (humanActors.size > 0 && !humanActors.has(approver)) return false;
    return true;
  };
  return gates.map((gate) => {
    const human = decisions.get(gate.gateId) || null;
    const base = gate.calculatedStatus || 'pending';
    let finalStatus = base;
    let humanDecisionInvalid = null;
    const gateNo = gate.gateId.match(/^G(\d+)$/);
    if (human?.decision === 'approved') {
      if (validApprover(human)) {
        finalStatus = 'approved';
      } else {
        humanDecisionInvalid = 'approved decision lacks a valid approver (non-empty human/team actor)';
        if (
          base === 'passed' &&
          ((gateNo && Number(gateNo[1]) >= 10) ||
            /production|acceptance|closeout/i.test(gate.title))
        ) {
          finalStatus = 'requires_approval';
        }
      }
    } else if (human?.decision === 'rejected') {
      finalStatus = 'rejected';
    } else if (human?.decision === 'conditional') {
      if (validApprover(human)) {
        finalStatus = 'conditional';
      } else {
        humanDecisionInvalid = 'conditional decision lacks a valid approver (non-empty human/team actor)';
        if (
          base === 'passed' &&
          ((gateNo && Number(gateNo[1]) >= 10) ||
            /production|acceptance|closeout/i.test(gate.title))
        ) {
          finalStatus = 'requires_approval';
        }
      }
    } else if (
      base === 'passed' &&
      ((gateNo && Number(gateNo[1]) >= 10) ||
        /production|acceptance|closeout/i.test(gate.title))
    ) {
      finalStatus = 'requires_approval';
    }
    return {
      gateId: gate.gateId,
      title: gate.title,
      calculatedStatus: finalStatus,
      baseStatus: base,
      humanDecision: human?.decision ?? null,
      humanDecisionInvalid,
      approver: human?.approver ?? null,
      decidedAt: human?.decidedAt ?? null,
      conditions: gate.conditions || [],
      evidenceCount: gate.evidenceCount ?? 0,
    };
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifactsDir = workIndexer.findArtifactsDir(options.root);
  const graph = options.graph
    ? JSON.parse(fs.readFileSync(path.resolve(options.graph), 'utf8'))
    : workIndexer.indexWorkGraph(artifactsDir, { root: options.root });
  const humanDecisions = loadHumanDecisions(artifactsDir);
  const gates = calculate(graph.gates || [], humanDecisions, { actors: graph.actors });
  const pending = gates.filter((gate) => gate.calculatedStatus === 'requires_approval');
  const result = {
    generatedAt: new Date().toISOString(),
    gateCount: gates.length,
    approvedCount: gates.filter((gate) => gate.calculatedStatus === 'approved').length,
    requiresApprovalCount: pending.length,
    gates,
  };
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(
      path.resolve(options.output),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
    console.log(`Gate decisions written: ${path.resolve(options.output)}`);
  }
  console.log(
    `Gate engine: ${result.gateCount} gates | ${result.approvedCount} approved | ` +
      `${result.requiresApprovalCount} require human approval`,
  );
  for (const gate of pending) {
    console.log(`  approval required: ${gate.gateId} ${gate.title}`);
  }
  if (options.strict && result.requiresApprovalCount > 0) {
    process.exitCode = 2;
  }
}

module.exports = { calculate, loadHumanDecisions };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}
