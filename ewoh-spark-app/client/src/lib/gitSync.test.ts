import {
  buildApprovalPacket,
  buildDryRunPreview,
  buildFailureRecord,
  buildMappingStatus,
  buildMappingView,
  buildProviderData,
  buildTimelineFromSources,
  canExecute,
  computeIncrementalSync,
  createIdempotencyKey,
  detectConflicts,
  HIGH_RISK_OPERATIONS,
  isHighRisk,
  isRetryableFailure,
  linkLabel,
  mergeTimeline,
  summarizeCi,
  summarizeMapping,
  suggestRetry,
  type ApprovalPacket,
  type GitMappingRow,
} from './gitSync';

describe('gitSync 映射', () => {
  it('根据 issue/pr 编号推导双向映射状态', () => {
    expect(buildMappingStatus({ issueNumber: 1, prNumber: 2 })).toBe('bidirectional');
    expect(buildMappingStatus({ issueNumber: 1, prNumber: null })).toBe('issue_only');
    expect(buildMappingStatus({ issueNumber: null, prNumber: 2 })).toBe('pr_only');
    expect(buildMappingStatus({ issueNumber: null, prNumber: null })).toBe('unlinked');
  });

  it('为映射行补充派生字段', () => {
    const rows: GitMappingRow[] = [
      {
        workItemId: 'W1',
        title: 't',
        issueNumber: 1,
        prNumber: 2,
        branch: 'b',
        commitSha: 'abc',
        state: 'pr_linked',
        missing: false,
      },
    ];
    const view = buildMappingView(rows);
    expect(view[0].mappingStatus).toBe('bidirectional');
  });

  it('汇总映射计数', () => {
    const summary = summarizeMapping([
      { workItemId: 'A', issueNumber: 1, prNumber: 2 } as GitMappingRow,
      { workItemId: 'B', issueNumber: 1, prNumber: null } as GitMappingRow,
      { workItemId: 'C', issueNumber: null, prNumber: null } as GitMappingRow,
    ]);
    expect(summary.bidirectional).toBe(1);
    expect(summary.issue_only).toBe(1);
    expect(summary.unlinked).toBe(1);
    expect(summary.tracked).toBe(2);
    expect(summary.missing).toBe(1);
  });

  it('生成链接文案', () => {
    expect(linkLabel(123)).toBe('#123');
    expect(linkLabel(null)).toBeNull();
    expect(linkLabel(undefined)).toBeNull();
  });
});

describe('gitSync dry-run 预览', () => {
  it('汇总文件级新增/删除/行数', () => {
    const preview = buildDryRunPreview([
      { file: 'a.ts', added: 3, deleted: 1 },
      { file: 'b.ts', added: 0, deleted: 2 },
    ]);
    expect(preview.totalFiles).toBe(2);
    expect(preview.totalAdded).toBe(3);
    expect(preview.totalDeleted).toBe(3);
    expect(preview.totalLines).toBe(6);
    expect(preview.files[0].lines).toBe(4);
  });
});

describe('gitSync 冲突检测', () => {
  it('输出字段级本地/服务端差异', () => {
    const conflicts = detectConflicts([
      { workItemId: 'W1', local: { status: 'pending' }, server: { status: 'reported' } },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('status');
    expect(conflicts[0].local).toBe('pending');
    expect(conflicts[0].server).toBe('reported');
    expect(conflicts[0].recommended).toBe('server');
  });

  it('服务端为空时推荐本地值', () => {
    const conflicts = detectConflicts([
      { workItemId: 'W1', local: 'x', server: null },
    ]);
    expect(conflicts[0].recommended).toBe('local');
  });
});

describe('gitSync CI 汇总', () => {
  it('任一 failed 则整体 failed', () => {
    const summary = summarizeCi([
      { ref: 'a', kind: 'commit', status: 'success' },
      { ref: 'a', kind: 'commit', status: 'failed' },
    ]);
    expect(summary.status).toBe('failed');
    expect(summary.failed).toBe(1);
    expect(summary.total).toBe(2);
  });

  it('存在 pending 时整体 pending', () => {
    expect(
      summarizeCi([
        { ref: 'a', kind: 'pr', status: 'success' },
        { ref: 'a', kind: 'pr', status: 'pending' },
      ]).status,
    ).toBe('pending');
  });

  it('全部成功则为 success，空列表为 unknown', () => {
    expect(
      summarizeCi([{ ref: 'a', kind: 'commit', status: 'success' }]).status,
    ).toBe('success');
    expect(summarizeCi([]).status).toBe('unknown');
  });
});

describe('gitSync 审批门禁', () => {
  it('创建/合并/关闭 PR 为高风险操作', () => {
    expect(HIGH_RISK_OPERATIONS).toEqual(['create_pr', 'merge_pr', 'close_pr']);
    expect(isHighRisk('merge_pr')).toBe(true);
    expect(isHighRisk('create_issue')).toBe(false);
  });

  it('高风险操作未经批准不得执行', () => {
    const packet: ApprovalPacket = buildApprovalPacket({
      operation: 'merge_pr',
      workItemId: 'W1',
      reason: '合并',
      actor: 'alice',
      rollbackPoint: 'main@{0}',
    });
    expect(packet.approved).toBe(false);
    expect(canExecute('merge_pr', packet)).toBe(false);
    expect(canExecute('create_issue', packet)).toBe(true);
  });

  it('批准后高风险操作可执行', () => {
    const packet: ApprovalPacket = {
      ...buildApprovalPacket({
        operation: 'close_pr',
        workItemId: 'W1',
        reason: '',
        actor: 'bob',
        rollbackPoint: 'main@{0}',
      }),
      approved: true,
    };
    expect(canExecute('close_pr', packet)).toBe(true);
  });
});

describe('gitSync 失败补偿', () => {
  it('网络/超时类失败可重试', () => {
    expect(isRetryableFailure('GitHub API timeout')).toBe(true);
    expect(isRetryableFailure('网络连接失败')).toBe(true);
    expect(isRetryableFailure('PERMISSION_DENIED')).toBe(false);
  });

  it('构建失败记录并给出重试建议', () => {
    const failure = buildFailureRecord({
      operation: 'merge_pr',
      workItemId: 'W1',
      reason: 'GitHub API timeout',
      idempotencyKey: 'k1',
    });
    expect(failure.retryable).toBe(true);
    expect(suggestRetry(failure).retryable).toBe(true);
    const exhausted = { ...failure, retryCount: 3 };
    expect(suggestRetry(exhausted).retryable).toBe(false);
  });
});

describe('gitSync 幂等键', () => {
  it('相同输入产生相同幂等键，不同输入产生不同键', () => {
    const a = createIdempotencyKey('merge_pr', 'W1', 'main');
    const b = createIdempotencyKey('merge_pr', 'W1', 'main');
    const c = createIdempotencyKey('merge_pr', 'W1', 'dev');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('gitSync 增量同步', () => {
  it('对比前后快照输出新增/删除/变更', () => {
    const result = computeIncrementalSync(
      [
        { workItemId: 'A', updatedAt: '2026-01-01T00:00:00Z' },
        { workItemId: 'B', updatedAt: '2026-01-01T00:00:00Z' },
      ],
      [
        { workItemId: 'A', updatedAt: '2026-01-02T00:00:00Z' },
        { workItemId: 'C', updatedAt: '2026-01-03T00:00:00Z' },
      ],
    );
    expect(result.added).toEqual(['C']);
    expect(result.removed).toEqual(['B']);
    expect(result.changed).toEqual(['A']);
    expect(result.nextCursor).toBe('2026-01-03T00:00:00.000Z');
  });
});

describe('gitSync 统一时间线', () => {
  it('合并事件并按时间倒序', () => {
    const events = mergeTimeline([
      { id: '1', kind: 'gate', at: '2026-01-01T00:00:00Z', summary: '门禁' },
      { id: '2', kind: 'ci', at: '2026-01-02T00:00:00Z', summary: 'CI' },
    ]);
    expect(events[0].id).toBe('2');
  });

  it('从工作图源构建时间线，仅收录带时间戳的事件', () => {
    const timeline = buildTimelineFromSources({
      evidence: [
        { id: 'E1', workItemId: 'W1', kind: 'unit', result: 'pass', testTime: '2026-01-01T00:00:00Z' },
      ],
      gates: [
        { gateId: 'G1', workItemId: 'W1', title: '合并门禁', calculatedStatus: 'approved', decidedAt: '2026-01-02T00:00:00Z' },
        { gateId: 'G2', calculatedStatus: 'pending', decidedAt: null },
      ],
      agents: [{ actorId: 'A1', name: 'agent', status: 'running' }],
    });
    expect(timeline).toHaveLength(2);
    expect(timeline[0].kind).toBe('gate');
    expect(timeline[1].kind).toBe('evidence');
  });
});

describe('gitSync 组合视图', () => {
  it('聚合全部派生视图', () => {
    const data = buildProviderData({
      rows: [
        {
          workItemId: 'W1',
          title: 't',
          issueNumber: 1,
          prNumber: 2,
          branch: 'b',
          commitSha: 'abc',
          state: 'pr_linked',
          missing: false,
        } as GitMappingRow,
      ],
      changes: [{ file: 'a.ts', added: 1, deleted: 0 }],
      conflicts: [{ workItemId: 'W1', local: { s: 1 }, server: { s: 2 } }],
      ciChecks: [{ ref: 'main', kind: 'commit', status: 'success' }],
      timelineExtra: [{ id: 'x', kind: 'sync', at: '2026-01-01T00:00:00Z', summary: '计划' }],
    });
    expect(data.mapping[0].mappingStatus).toBe('bidirectional');
    expect(data.mappingSummary.tracked).toBe(1);
    expect(data.dryRun.totalAdded).toBe(1);
    expect(data.conflicts).toHaveLength(1);
    expect(data.ci.status).toBe('success');
    expect(data.timeline).toHaveLength(1);
    expect(data.providerConnected).toBe(false);
  });
});