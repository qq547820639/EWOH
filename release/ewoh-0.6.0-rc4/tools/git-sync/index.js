#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const workIndexer = require('../work-indexer/index.js');

function gitInfo(root) {
  try {
    const exec = (args) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    let remote = '';
    try {
      remote = exec(['config', '--get', 'remote.origin.url']);
    } catch {
      remote = '';
    }
    return {
      branch: exec(['rev-parse', '--abbrev-ref', 'HEAD']),
      headSha: exec(['rev-parse', 'HEAD']),
      remote,
    };
  } catch {
    return { branch: 'unknown', headSha: '', remote: '' };
  }
}

function buildGitSyncPlan(items, registry, git = {}) {
  const tracked = new Map(
    (registry || []).map((entry) => [entry.workItemId, entry]),
  );
  const entries = items
    .filter((item) => ['task', 'package', 'wave'].includes(item.type))
    .map((item) => {
      const record = tracked.get(item.id) || {};
      const issueNumber = Number.isInteger(record.issueNumber)
        ? record.issueNumber
        : null;
      const prNumber = Number.isInteger(record.prNumber)
        ? record.prNumber
        : null;
      const missing = !issueNumber || !prNumber;
      return {
        workItemId: item.id,
        title: item.title,
        type: item.type,
        status: item.status,
        owner: item.owner,
        evidence: item.evidence ?? null,
        wave: item.wave ?? null,
        issueNumber,
        prNumber,
        branch: record.branch ?? null,
        commitSha: record.commitSha ?? null,
        state: record.state ?? (prNumber ? 'pr_linked' : issueNumber ? 'issue_linked' : 'unlinked'),
        missing,
      };
    });
  return {
    schema: 'ewoh:///git-sync/v1',
    generatedAt: new Date().toISOString(),
    repository: git.remote || '',
    branch: git.branch || 'unknown',
    headSha: git.headSha || '',
    itemCount: entries.length,
    trackedCount: entries.filter((entry) => !entry.missing).length,
    missingCount: entries.filter((entry) => entry.missing).length,
    status: 'offline',
    source: '.codex/artifacts/work/git-sync.json',
    items: entries,
  };
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    output: null,
    apply: false,
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      options.root = argv[++index];
    } else if (argument === '--output') {
      options.output = argv[++index];
    } else if (argument === '--apply') {
      options.apply = true;
    } else if (argument === '--strict') {
      options.strict = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function loadRegistry(artifactsDir) {
  const file = path.join(artifactsDir, 'work', 'git-sync.json');
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function requireApproval() {
  const approved = process.env.EWOH_GIT_SYNC_APPROVED === 'true';
  const enabled = process.env.EWOH_GIT_SYNC_ENABLED === 'true';
  const token = process.env.GITHUB_TOKEN;
  if (!approved || !enabled || !token) {
    throw new Error(
      'live GitHub sync requires EWOH_GIT_SYNC_ENABLED=true, GITHUB_TOKEN, and EWOH_GIT_SYNC_APPROVED=true',
    );
  }
}

function liveApply(plan, registryFile, root) {
  requireApproval();
  const remote = plan.repository;
  const match = remote.match(/(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`cannot derive GitHub owner/repo from ${remote}`);
  }
  const [, owner, repo] = match;
  const token = process.env.GITHUB_TOKEN;
  const missing = plan.items.filter((entry) => entry.missing);
  const created = [];
  for (const entry of missing) {
    const response = awaitFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'ewoh-git-sync',
        },
        body: JSON.stringify({
          title: `[EWOH] ${entry.workItemId}: ${entry.title}`,
          body: [
            `Owner: ${entry.owner}`,
            `Type: ${entry.type}`,
            `Wave: ${entry.wave || 'n/a'}`,
            `Status: ${entry.status}`,
            `Evidence: ${entry.evidence || 'n/a'}`,
            `Source: ${plan.source}`,
          ].join('\n'),
        }),
      },
    );
    created.push({
      workItemId: entry.workItemId,
      issueNumber: response.number,
      htmlUrl: response.html_url,
    });
  }
  const previous = loadRegistry(path.dirname(registryFile));
  const next = previous.map((entry) => {
    const createdEntry = created.find((item) => item.workItemId === entry.workItemId);
    return createdEntry
      ? { ...entry, issueNumber: createdEntry.issueNumber, state: 'issue_linked' }
      : entry;
  });
  for (const entry of created) {
    if (!next.some((item) => item.workItemId === entry.workItemId)) {
      next.push({
        workItemId: entry.workItemId,
        issueNumber: entry.issueNumber,
        state: 'issue_linked',
      });
    }
  }
  fs.writeFileSync(registryFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { created, registryFile };
}

function awaitFetch(url, options) {
  return fetch(url, options).then(async (response) => {
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    }
    return response.json();
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifactsDir = workIndexer.findArtifactsDir(options.root);
  const graph = workIndexer.indexWorkGraph(artifactsDir, { root: options.root });
  const registry = loadRegistry(artifactsDir);
  const plan = buildGitSyncPlan(graph.items, registry, gitInfo(options.root));
  if (options.apply) {
    const result = liveApply(plan, path.join(artifactsDir, 'work', 'git-sync.json'), options.root);
    plan.status = 'live';
    plan.items = plan.items.map((entry) => {
      const created = result.created.find((item) => item.workItemId === entry.workItemId);
      return created ? { ...entry, issueNumber: created.issueNumber, missing: false } : entry;
    });
    plan.trackedCount = plan.items.filter((entry) => !entry.missing).length;
    plan.missingCount = plan.items.filter((entry) => entry.missing).length;
  }
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(
      path.resolve(options.output),
      `${JSON.stringify(plan, null, 2)}\n`,
      'utf8',
    );
    console.log(`Git sync plan written: ${path.resolve(options.output)}`);
  }
  console.log(
    `Git sync plan: ${plan.itemCount} items | ${plan.trackedCount} tracked | ` +
      `${plan.missingCount} missing | mode ${plan.status}`,
  );
  if (options.strict && plan.missingCount > 0) {
    process.exitCode = 1;
  }
}

module.exports = { buildGitSyncPlan, gitInfo, loadRegistry };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  }
}
