#!/usr/bin/env node
'use strict';

/**
 * truth-status — machine-verifiable release status model.
 *
 * Single shared source for the four-state gate status model, STALE detection
 * and the Production Ready computation. Consumers (truth-manifest, truth-gate,
 * CI, UI) import this module so the meaning of a status is identical everywhere
 * and a BLOCKED_BY_ENVIRONMENT item can never silently count as PASS.
 *
 * Four distinct statuses:
 *   NOT_RUN              未执行
 *   FAILED               执行失败
 *   BLOCKED_BY_ENVIRONMENT  环境阻塞（必不与 PASS 等价）
 *   SUCCEEDED            执行成功（唯一计为 PASS 的状态）
 *
 * Production Ready is AUTO-COMPUTED from the current SHA's gating results and
 * is never hand-filled. It is false when any mandatory gate is not SUCCEEDED,
 * when the evidence was recorded against a different commit SHA (STALE), or
 * when no gate results are recorded at all.
 */

const STATUS = Object.freeze({
  NOT_RUN: 'NOT_RUN',
  FAILED: 'FAILED',
  BLOCKED_BY_ENVIRONMENT: 'BLOCKED_BY_ENVIRONMENT',
  SUCCEEDED: 'SUCCEEDED',
});

const STATUS_LABELS = Object.freeze({
  [STATUS.NOT_RUN]: '未执行',
  [STATUS.FAILED]: '执行失败',
  [STATUS.BLOCKED_BY_ENVIRONMENT]: '环境阻塞',
  [STATUS.SUCCEEDED]: '执行成功',
});

const VALID_STATUSES = Object.freeze(Object.values(STATUS));

/**
 * The only statuses that count as PASS. BLOCKED_BY_ENVIRONMENT is intentionally
 * NOT included: an environment-blocked gate must not be presented as passing.
 */
function isPass(status) {
  return status === STATUS.SUCCEEDED;
}

/**
 * true when the evidence was generated against a different commit than the
 * current build SHA. A STALE artifact/UI must surface the mismatch explicitly.
 */
function isStale(evidence, currentSha) {
  if (!currentSha || !evidence || !evidence.evaluatedCommitSha) {
    return false;
  }
  return evidence.evaluatedCommitSha !== currentSha;
}

/**
 * A gate is mandatory unless it explicitly opts out. Default preserves the
 * safest posture: every recorded gate participates in Production Ready.
 */
function isMandatory(gate) {
  return gate && gate.mandatory !== false;
}

/**
 * Compute Production Ready from the current SHA's gating results.
 *
 * @param {object}  evidence    evidence manifest with `evaluatedCommitSha` and
 *                              `gates` (array of { id/name, status, mandatory }).
 * @param {string}  currentSha  live build commit SHA (full). Pass null/undefined
 *                              to skip STALE comparison (e.g. at generation time
 *                              the recorded SHA IS the current SHA).
 * @returns {{ready: boolean, stale: boolean, reasons: string[]}}
 */
function computeProductionReady(evidence, currentSha, opts) {
  opts = opts || {};
  const reasons = [];
  const gates = evidence && Array.isArray(evidence.gates) ? evidence.gates : [];
  const stale = isStale(evidence, currentSha);

  if (stale) {
    reasons.push(
      `STALE: evidence evaluatedCommitSha=${evidence.evaluatedCommitSha} != current=${currentSha}`,
    );
  }

  const mandatory = gates.filter(isMandatory);
  if (mandatory.length === 0) {
    reasons.push('no mandatory gate results recorded');
  }
  for (const gate of mandatory) {
    const id = gate.id || gate.name || 'gate';
    if (!isPass(gate.status)) {
      reasons.push(`gate ${id} -> ${gate.status} (${statusLabel(gate.status)})`);
    }
  }

  return {
    ready: reasons.length === 0,
    stale,
    reasons,
  };
}

function statusLabel(status) {
  return STATUS_LABELS[status] || 'unknown';
}

/**
 * Normalize/validate a raw status value; returns null when invalid.
 */
function parseStatus(value) {
  return VALID_STATUSES.includes(value) ? value : null;
}

module.exports = {
  STATUS,
  STATUS_LABELS,
  VALID_STATUSES,
  computeProductionReady,
  isMandatory,
  isPass,
  isStale,
  parseStatus,
  statusLabel,
};