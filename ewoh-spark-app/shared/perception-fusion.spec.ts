import {
  AMBIENT_WATCH_THRESHOLDS,
  DEFAULT_SOURCE_POLICIES,
  PERSON_EXPECTED_SOURCES,
  POSITION_TOLERANCE_M,
  POSTURE_BEND_DEG,
  POSTURE_PITCH_DISAGREEMENT_DEG,
  VISION_KEYPOINT_MIN_SCORE,
  deriveExoAction,
  deriveVisionTrunkPitch,
  uprightnessOf,
  fusePerception,
  perceptionFusionId,
  summarizeAmbientChannels,
  validateFusedPerception,
  type FusePerceptionInput,
  type PerceptionObservation,
} from './perception-fusion';

const NOW = '2026-09-12T08:00:00.000Z';

function observation(overrides: Partial<PerceptionObservation> = {}): PerceptionObservation {
  return {
    source: 'uwb',
    sourceId: 'TAG-1',
    dimension: 'position',
    observedAt: '2026-09-12T07:59:50.000Z',
    quality: 'good',
    confidence: 0.9,
    value: { x: 10, y: 20, z: 0, stationId: 'ST-1' },
    matchedBy: 'direct',
    ...overrides,
  };
}

function input(overrides: Partial<FusePerceptionInput> = {}): FusePerceptionInput {
  return {
    subjectId: 'person:P-1',
    windowStart: '2026-09-12T07:59:00.000Z',
    windowEnd: '2026-09-12T08:00:00.000Z',
    now: NOW,
    observations: [
      observation(),
      observation({
        source: 'exo_imu',
        sourceId: 'EXO-1',
        dimension: 'posture',
        confidence: 0.85,
        value: { pitchDeg: 12, action: 'standing' },
        matchedBy: 'wearer_binding',
      }),
      observation({
        source: 'vision',
        sourceId: 'CAM-1',
        dimension: 'station_presence',
        confidence: 0.8,
        value: { stationId: 'ST-1', present: true },
        matchedBy: 'track_id',
      }),
    ],
    stationFromLocation: { stationId: 'ST-1', distanceM: 1.2, radiusM: 5, basis: 'nearest station within 5m' },
    taskContext: { stationId: 'ST-1', expectedAction: 'pick', basis: 'task:T-1' },
    ...overrides,
  };
}

describe('fusePerception（§5 融合公式与五条规则）', () => {
  it('规则 1：UWB 与视觉同工位 → 一致 + 高置信', () => {
    const fused = fusePerception(input());
    expect(fused.agreement).toBe('consistent');
    expect(fused.station?.stationId).toBe('ST-1');
    expect(fused.confidence.level).toBe('high');
    expect(fused.confidence.degraded).toBe(false);
    expect(fused.conflicts).toEqual([]);
    expect(fused.strongAdviceAllowed).toBe(true);
    expect(fused.ruleTrace.find((r) => r.rule === 'rule1_uwb_vision_same_station')?.fired).toBe(true);
    expect(validateFusedPerception(fused)).toEqual([]);
  });

  it('规则 2：UWB 与视觉工位不一致 → 冲突记录（各源都保留，不静默丢弃）', () => {
    const fused = fusePerception(input({
      observations: [
        observation(),
        observation({ source: 'vision', sourceId: 'CAM-1', dimension: 'station_presence', value: { stationId: 'ST-2' } }),
      ],
      taskContext: null,
    }));
    expect(fused.agreement).toBe('conflict');
    expect(fused.conflicts).toHaveLength(1);
    const conflict = fused.conflicts[0];
    expect(conflict.dimension).toBe('station_presence');
    expect(conflict.severity).toBe('high');
    // 三个工位信号都保留（uwb 实测 + vision 交叉验证 + station_semantics 映射），一个不一致即冲突
    expect(conflict.participants.map((p) => p.source).sort()).toEqual(['station_semantics', 'uwb', 'vision']);
    expect(conflict.detail).toContain('ST-1');
    // 冲突时工位置空（不投票、不取第一个），但两个源都在证据里
    expect(fused.station?.stationId).toBeNull();
    expect(fused.strongAdviceAllowed).toBe(false);
    expect(fused.ruleTrace.find((r) => r.rule === 'rule2_conflict_recorded')?.fired).toBe(true);
    expect(validateFusedPerception(fused)).toEqual([]);
  });

  it('规则 3：摄像头不可用但外骨骼与工位信号正常 → 继续推断并降级', () => {
    const fused = fusePerception(input({
      observations: [
        observation(),
        observation({ source: 'exo_imu', sourceId: 'EXO-1', dimension: 'posture', confidence: 0.8, value: { pitchDeg: 8, action: 'walking' } }),
      ],
      taskContext: null,
    }));
    expect(fused.agreement).toBe('partial');
    expect(fused.confidence.degraded).toBe(true);
    expect(fused.confidence.level).not.toBe('unknown');
    expect(fused.confidence.missingSources).toContain('vision');
    expect(fused.notes.join(' ')).toContain('摄像头不可用');
    const rule3 = fused.ruleTrace.find((r) => r.rule === 'rule3_camera_down_degrade');
    expect(rule3?.fired).toBe(true);
    expect(fused.strongAdviceAllowed).toBe(true); // 降级但仍可用：允许建议，但页面必须显示降级
  });

  it('规则 4：任一源缺失 → 置信度按权重下降但不中断输出', () => {
    const full = fusePerception(input());
    const missingVisionAndTask = fusePerception(input({
      observations: [observation()],
      taskContext: null,
      stationFromLocation: { stationId: 'ST-1', distanceM: 1.0, radiusM: 5, basis: 'nearest station within 5m' },
    }));
    expect(missingVisionAndTask.confidence.score).not.toBeNull();
    expect(missingVisionAndTask.confidence.score!).toBeLessThan(full.confidence.score!);
    expect(missingVisionAndTask.confidence.missingSources).toEqual(
      expect.arrayContaining(['exo_imu', 'vision', 'task_context']),
    );
    expect(fused_hasOutput(missingVisionAndTask)).toBe(true);
  });

  it('规则 5：低置信度不向上游生成强建议（机器可读）', () => {
    const fused = fusePerception(input({
      observations: [
        observation({
          source: 'station_semantics',
          sourceId: 'station-map',
          dimension: 'station_presence',
          quality: 'degraded',
          confidence: null,
          value: { stationId: 'ST-9' },
        }),
      ],
      stationFromLocation: null,
      taskContext: null,
    }));
    expect(fused.confidence.level).toBe('low');
    expect(fused.strongAdviceAllowed).toBe(false);
    expect(fused.ruleTrace.find((r) => r.rule === 'rule5_no_strong_advice_at_low_confidence')?.fired).toBe(true);
    expect(validateFusedPerception(fused)).toEqual([]);
  });

  it('没有任何可用源 → insufficient + unknown + score=null（不显示成 0%，也不给空结论当事实）', () => {
    const fused = fusePerception(input({ observations: [], stationFromLocation: null, taskContext: null }));
    expect(fused.agreement).toBe('insufficient');
    expect(fused.confidence.level).toBe('unknown');
    expect(fused.confidence.score).toBeNull();
    expect(fused.position).toBeNull();
    expect(fused.posture).toBeNull();
    expect(fused.station).toBeNull();
    expect(fused.strongAdviceAllowed).toBe(false);
    // 人员主体的"应有源"是人员证据面（5 个），不含环境源——按主体类型判定缺失
    expect(fused.confidence.missingSources).toHaveLength(PERSON_EXPECTED_SOURCES.length);
    expect(fused.confidence.missingSources).not.toContain('env_sensor');
    expect(validateFusedPerception(fused)).toEqual([]);
  });

  it('过期证据被排除且显式登记（不拿旧值当现在）', () => {
    const fused = fusePerception(input({
      observations: [
        observation({ observedAt: '2026-09-12T07:50:00.000Z' }), // 10 分钟前，uwb TTL 60s
      ],
      stationFromLocation: null,
      taskContext: null,
    }));
    expect(fused.confidence.usableSources).toEqual([]);
    expect(fused.confidence.excludedSources).toHaveLength(1);
    expect(fused.confidence.excludedSources[0]).toMatchObject({ source: 'uwb', status: 'stale' });
    expect(fused.confidence.excludedSources[0].reason).toContain('TTL');
    expect(fused.agreement).toBe('insufficient');
  });

  it('质量 invalid 的证据不参与融合（不可信数据不得当事实）', () => {
    const fused = fusePerception(input({
      observations: [
        observation({ quality: 'invalid' }),
        observation({ source: 'exo_imu', sourceId: 'EXO-1', dimension: 'posture', confidence: 0.9, value: { pitchDeg: 5 } }),
      ],
      stationFromLocation: null,
      taskContext: null,
    }));
    expect(fused.confidence.usableSources).toEqual(['exo_imu']);
    expect(fused.confidence.excludedSources[0]).toMatchObject({ source: 'uwb', status: 'untrusted' });
  });

  it('未上报置信度的源被惩罚（不当成完全可信）', () => {
    const withConfidence = fusePerception(input({
      observations: [observation(), observation({ source: 'vision', sourceId: 'CAM-1', dimension: 'station_presence', value: { stationId: 'ST-1' } })],
      taskContext: null,
    }));
    const withoutConfidence = fusePerception(input({
      observations: [observation({ confidence: null }), observation({ source: 'vision', sourceId: 'CAM-1', dimension: 'station_presence', confidence: null, value: { stationId: 'ST-1' } })],
      taskContext: null,
    }));
    expect(withoutConfidence.confidence.score!).toBeLessThan(withConfidence.confidence.score!);
    expect(withoutConfidence.confidence.unknownConfidenceSources.sort()).toEqual(['uwb', 'vision']);
    expect(withoutConfidence.notes.join(' ')).toContain('未上报置信度');
  });

  it('姿态冲突：外骨骼弯腰 vs 视觉站立 → 记录冲突并禁止强建议', () => {
    const fused = fusePerception(input({
      observations: [
        observation(),
        observation({
          source: 'exo_imu',
          sourceId: 'EXO-1',
          dimension: 'posture',
          confidence: 0.9,
          value: { pitchDeg: POSTURE_BEND_DEG + 10, action: 'bending' },
        }),
        observation({ source: 'vision', sourceId: 'CAM-1', dimension: 'action', confidence: 0.8, value: { action: 'standing' } }),
      ],
      taskContext: null,
    }));
    expect(fused.conflicts.some((c) => c.dimension === 'posture')).toBe(true);
    expect(fused.agreement).toBe('conflict');
    expect(fused.strongAdviceAllowed).toBe(false);
  });

  it('任务上下文与实测工位不一致 → 中等冲突（人不在任务期望的工位）', () => {
    const fused = fusePerception(input({
      observations: [observation()],
      taskContext: { stationId: 'ST-7', expectedAction: 'pick', basis: 'task:T-9' },
    }));
    const conflict = fused.conflicts.find((c) => c.dimension === 'station_presence');
    expect(conflict?.severity).toBe('medium');
    expect(conflict?.detail).toContain('不一致');
  });

  it('坐标解析不到工位 → stationId=null 并写明依据（不猜最近工位）', () => {
    const fused = fusePerception(input({
      observations: [observation({ value: { x: 999, y: 999, z: 0 } })],
      stationFromLocation: null,
      taskContext: null,
    }));
    expect(fused.position?.stationId).toBeNull();
    expect(fused.position?.basis.join(' ')).toContain('未解析');
    expect(fused.notes.join(' ')).toContain('工位未知');
  });

  it('确定性：同一输入两次融合结果完全一致', () => {
    const first = fusePerception(input());
    const second = fusePerception(input());
    expect(second).toEqual(first);
  });

  it('可解释性：五条规则逐条留痕且带依据文本', () => {
    const fused = fusePerception(input());
    expect(fused.ruleTrace.map((r) => r.rule)).toEqual([
      'rule1_uwb_vision_same_station',
      'rule2_conflict_recorded',
      'rule3_camera_down_degrade',
      'rule4_missing_source_degrade',
      'rule5_no_strong_advice_at_low_confidence',
    ]);
    expect(fused.ruleTrace.every((r) => r.detail.length > 0)).toBe(true);
    expect(fused.confidence.basis).toContain('不是概率');
  });

  it('容差口径来自契约常量（位置一致性半径）', () => {
    expect(POSITION_TOLERANCE_M).toBeGreaterThan(0);
  });
});

describe('validateFusedPerception（fail-closed）', () => {
  it('无可用源却给了级别/分数 → 拒绝', () => {
    const fused = fusePerception(input({ observations: [], stationFromLocation: null, taskContext: null }));
    expect(validateFusedPerception({ ...fused, confidence: { ...fused.confidence, level: 'high' } }))
      .toContain('no_source_requires_unknown_level');
    expect(validateFusedPerception({ ...fused, confidence: { ...fused.confidence, score: 0 } }))
      .toContain('no_source_requires_null_score');
  });

  it('证据不足/冲突/低置信时声称允许强建议 → 拒绝', () => {
    const conflict = fusePerception(input({
      observations: [observation(), observation({ source: 'vision', sourceId: 'CAM-1', dimension: 'station_presence', value: { stationId: 'ST-2' } })],
      taskContext: null,
    }));
    expect(validateFusedPerception({ ...conflict, strongAdviceAllowed: true }))
      .toContain('strong_advice_not_allowed_with_insufficient_or_conflict');
    const low = fusePerception(input({
      observations: [observation({ source: 'station_semantics', sourceId: 'm', dimension: 'station_presence', quality: 'degraded', confidence: null, value: { stationId: 'S' } })],
      stationFromLocation: null,
      taskContext: null,
    }));
    expect(validateFusedPerception({ ...low, strongAdviceAllowed: true }))
      .toContain('strong_advice_not_allowed_at_low_confidence');
  });

  it('缺字段/非法窗口/非法级别 → 拒绝', () => {
    const fused = fusePerception(input());
    expect(validateFusedPerception(null)).toContain('record_must_be_object');
    expect(validateFusedPerception({ ...fused, windowStart: 'x' })).toContain('bad_window');
    expect(validateFusedPerception({ ...fused, agreement: 'maybe' })).toContain('unknown_agreement');
    expect(validateFusedPerception({ ...fused, ruleTrace: [] })).toContain('missing_rule_trace');
  });
});

describe('perceptionFusionId（确定性快照号）', () => {
  it('同窗口桶 → 同一号；不同桶 → 不同号', () => {
    const a = perceptionFusionId('person:P-1', '2026-09-12T08:00:00.000Z', 300_000);
    const b = perceptionFusionId('person:P-1', '2026-09-12T08:04:59.000Z', 300_000);
    const c = perceptionFusionId('person:P-1', '2026-09-12T08:05:00.000Z', 300_000);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(a).toContain('FUSE-person:P-1-');
  });

  it('非法主体/时间不抛错（退化为 unknown + 0 桶）', () => {
    expect(perceptionFusionId('', 'not-a-date', 300_000)).toBe('FUSE-unknown-0');
  });
});

function fused_hasOutput(fused: { agreement: string; confidence: { level: string } }): boolean {
  return fused.agreement !== undefined && fused.confidence.level !== undefined;
}


/* ── NO-56b：环境多源（区域级同类多源交叉验证）────────────────────────── */

function ambientObservation(channel: string, value: number, sourceId: string): PerceptionObservation {
  return observation({
    source: 'env_sensor',
    sourceId,
    dimension: 'ambient',
    confidence: 0.9,
    value: { channel, ambient: value },
    matchedBy: 'entity_id',
  });
}

describe('summarizeAmbientChannels（同类多源交叉验证）', () => {
  it('多台一致 → consistent + 代表值（均值）；极差可见', () => {
    const channels = summarizeAmbientChannels([
      { sourceId: 'ENV-1', channel: 'temperature', value: 30, quality: 'good' },
      { sourceId: 'ENV-2', channel: 'temperature', value: 31, quality: 'good' },
    ]);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ channel: 'temperature', agreement: 'consistent', spread: 1, unit: '°C' });
    expect(channels[0].value).toBeCloseTo(30.5, 3);
    expect(channels[0].exceedsWatchThreshold).toBe(false);
  });

  it('多台不一致 → conflict + **代表值置空**（不取平均掩盖分歧）', () => {
    const channels = summarizeAmbientChannels([
      { sourceId: 'ENV-1', channel: 'vibration', value: 2, quality: 'good' },
      { sourceId: 'ENV-2', channel: 'vibration', value: 9, quality: 'good' },
    ]);
    expect(channels[0]).toMatchObject({ channel: 'vibration', agreement: 'conflict' });
    expect(channels[0].value).toBeNull();
    expect(channels[0].sensors).toHaveLength(2);
  });

  it('只有一台传感器 → single_source（没有第二个独立源确认，不吹成一致）', () => {
    const channels = summarizeAmbientChannels([
      { sourceId: 'ENV-1', channel: 'noise', value: 90, quality: 'good' },
    ]);
    expect(channels[0]).toMatchObject({ channel: 'noise', agreement: 'single_source', value: 90 });
    expect(channels[0].exceedsWatchThreshold).toBe(true); // 90 >= 85 关注阈值
  });

  it('未登记通道不编单位、不编阈值', () => {
    const channels = summarizeAmbientChannels([{ sourceId: 'X', channel: 'radiation', value: 1, quality: 'good' }]);
    expect(channels[0].unit).toBeNull();
    expect(channels[0].exceedsWatchThreshold).toBe(false);
  });
});

describe('fusePerception 与环境源（区域级）', () => {
  it('环境多源一致 → 整体 consistent（区域级交叉验证成立）', () => {
    const fused = fusePerception(input({
      observations: [ambientObservation('temperature', 30, 'ENV-1'), ambientObservation('temperature', 31, 'ENV-2')],
      stationFromLocation: null,
      taskContext: null,
    }));
    expect(fused.ambient?.[0].agreement).toBe('consistent');
    expect(fused.agreement).toBe('consistent');
    expect(fused.ruleTrace[0].detail).toContain('环境通道交叉验证通过');
    expect(validateFusedPerception(fused)).toEqual([]);
  });

  it('环境多源冲突 → 冲突记录 + 禁止强建议（代表值为 null）', () => {
    const fused = fusePerception(input({
      observations: [ambientObservation('temperature', 20, 'ENV-1'), ambientObservation('temperature', 40, 'ENV-2')],
      stationFromLocation: null,
      taskContext: null,
    }));
    expect(fused.agreement).toBe('conflict');
    expect(fused.strongAdviceAllowed).toBe(false);
    expect(fused.conflicts.some((c) => c.dimension === 'ambient:temperature')).toBe(true);
    expect(fused.ambient?.[0].value).toBeNull();
  });

  it('高温超阈值 → 事实提示（是否停工由现场按规程决定，平台不下结论）', () => {
    const fused = fusePerception(input({
      observations: [ambientObservation('temperature', AMBIENT_WATCH_THRESHOLDS.temperature + 3, 'ENV-1')],
      stationFromLocation: null,
      taskContext: null,
    }));
    expect(fused.notes.join(' ')).toContain('关注阈值');
    expect(fused.notes.join(' ')).toContain('由现场按规程决定');
    expect(fused.ambient?.[0].exceedsWatchThreshold).toBe(true);
  });

  it('只有一台环境传感器 → 部分一致并在 notes 说明', () => {
    const fused = fusePerception(input({
      observations: [ambientObservation('noise', 70, 'ENV-1')],
      stationFromLocation: null,
      taskContext: null,
    }));
    expect(fused.agreement).toBe('partial');
    expect(fused.notes.join(' ')).toContain('只有一台传感器');
  });
});

/* ── NO-58c：视觉骨架 → 躯干俯仰（多模态源策略扩展） ─────────────────── */

describe('deriveVisionTrunkPitch（视觉骨架 → 躯干角，纯几何）', () => {
  const upright = {
    left_shoulder: [100, 100, 0.9],
    right_shoulder: [140, 100, 0.9],
    left_hip: [105, 200, 0.85],
    right_hip: [135, 200, 0.85],
  };

  it('直立骨架 → 接近 0°；纯水平骨架 → 接近 90°', () => {
    const stand = deriveVisionTrunkPitch(upright);
    expect(stand.pitchDeg).not.toBeNull();
    expect(Math.abs(stand.pitchDeg as number)).toBeLessThan(5);
    expect(stand.reason).toBeNull();
    expect(stand.basis).toContain('肩中点');

    const lying = deriveVisionTrunkPitch({
      left_shoulder: [300, 100, 0.9],
      right_shoulder: [300, 140, 0.9],
      left_hip: [100, 105, 0.9],
      right_hip: [100, 135, 0.9],
    });
    expect(Math.abs((lying.pitchDeg as number) - 90)).toBeLessThan(5);
  });

  it('前倾 45° 左右：角度随躯干倾斜增大（确定性、可复算）', () => {
    const bent = deriveVisionTrunkPitch({
      left_shoulder: [170, 100, 0.9],
      right_shoulder: [200, 100, 0.9],
      left_hip: [105, 200, 0.9],
      right_hip: [135, 200, 0.9],
    });
    expect(bent.pitchDeg as number).toBeGreaterThan(30);
    expect(bent.pitchDeg as number).toBeLessThan(60);
    // 确定性：同一输入两次必得同一角度（可复算，不做随机/时间相关判断）
    expect(deriveVisionTrunkPitch({ ...upright }).pitchDeg).toBe(deriveVisionTrunkPitch(upright).pitchDeg);
  });

  it('别名与 COCO 序号都能认出（认不出就说认不出，不猜）', () => {
    const coco = deriveVisionTrunkPitch({
      5: [100, 100, 0.9], 6: [140, 100, 0.9], 11: [105, 200, 0.9], 12: [135, 200, 0.9],
    });
    expect(coco.pitchDeg).not.toBeNull();
    const alias = deriveVisionTrunkPitch({
      l_shoulder: [100, 100, 0.9], r_shoulder: [140, 100, 0.9], l_hip: [105, 200, 0.9], r_hip: [135, 200, 0.9],
    });
    expect(alias.pitchDeg).toBeCloseTo(coco.pitchDeg as number, 5);
    const unknown = deriveVisionTrunkPitch({ nose: [1, 2, 3], ankle_left: [4, 5, 6] });
    expect(unknown.pitchDeg).toBeNull();
    expect(unknown.reason).toContain('缺少关键点');
  });

  it('缺要点 / 置信度不足 / 坐标非法 / 无骨架 → 一律 null + 明确原因（不产出 0）', () => {
    const missingHip = deriveVisionTrunkPitch({
      left_shoulder: [100, 100, 0.9], right_shoulder: [140, 100, 0.9], left_hip: [105, 200, 0.9],
    });
    expect(missingHip.pitchDeg).toBeNull();
    expect(missingHip.reason).toContain('right_hip');

    const lowScore = deriveVisionTrunkPitch({
      left_shoulder: [100, 100, 0.1], right_shoulder: [140, 100, 0.9],
      left_hip: [105, 200, 0.9], right_hip: [135, 200, 0.9],
    });
    expect(lowScore.pitchDeg).toBeNull();
    expect(lowScore.reason).toContain('置信度');

    const badCoords = deriveVisionTrunkPitch({
      left_shoulder: ['x', 100, 0.9], right_shoulder: [140, 100, 0.9],
      left_hip: [105, 200, 0.9], right_hip: [135, 200, 0.9],
    });
    expect(badCoords.pitchDeg).toBeNull();

    expect(deriveVisionTrunkPitch(null).pitchDeg).toBeNull();
    expect(deriveVisionTrunkPitch(undefined).pitchDeg).toBeNull();
  });

  it('三点 score 缺省按最低门槛处理（未知可信度不当成 1）', () => {
    const noScore = deriveVisionTrunkPitch({
      left_shoulder: [100, 100], right_shoulder: [140, 100], left_hip: [105, 200], right_hip: [135, 200],
    });
    expect(noScore.pitchDeg).not.toBeNull();
    const atThreshold = deriveVisionTrunkPitch({
      left_shoulder: [100, 100, VISION_KEYPOINT_MIN_SCORE], right_shoulder: [140, 100, VISION_KEYPOINT_MIN_SCORE],
      left_hip: [105, 200, VISION_KEYPOINT_MIN_SCORE], right_hip: [135, 200, VISION_KEYPOINT_MIN_SCORE],
    });
    expect(atThreshold.pitchDeg).not.toBeNull();
    const below = VISION_KEYPOINT_MIN_SCORE - 0.01;
    const shortScore = deriveVisionTrunkPitch({
      left_shoulder: [100, 100, below], right_shoulder: [140, 100, below],
      left_hip: [105, 200, below], right_hip: [135, 200, below],
    });
    expect(shortScore.pitchDeg).toBeNull();
  });

  it('肩髋中点重合 → 向量退化，角度无定义（不猜 0°）', () => {
    const degenerate = deriveVisionTrunkPitch({
      left_shoulder: [100, 150, 0.9], right_shoulder: [100, 150, 0.9],
      left_hip: [100, 150, 0.9], right_hip: [100, 150, 0.9],
    });
    expect(degenerate.pitchDeg).toBeNull();
    expect(degenerate.reason).toContain('退化');
  });
});

describe('fusePerception 姿态交叉验证（NO-58c：两个独立角度源）', () => {
  const exoPitch = (pitchDeg: number) => observation({
    source: 'exo_imu',
    sourceId: 'EXO-1',
    dimension: 'posture',
    confidence: 0.9,
    value: { pitchDeg },
    matchedBy: 'wearer_binding',
  });
  const visionPitch = (pitchDeg: number) => observation({
    source: 'vision',
    sourceId: 'CAM-1',
    dimension: 'posture',
    confidence: 0.9,
    value: { pitchDeg },
    matchedBy: 'track_id_skeleton',
  });

  it('两源角度一致 → 无姿态冲突（一致性不吹成 consistent：仍需位置/视觉工位交叉）', () => {
    const fused = fusePerception(input({ observations: [observation(), exoPitch(10), visionPitch(18)] }));
    expect(fused.conflicts.filter((c) => c.dimension === 'posture')).toHaveLength(0);
  });

  it('冲突门槛就是契约里的容差：差值 = 容差 - 1° 不冲突，= 容差 即冲突', () => {
    const justUnder = fusePerception(input({
      observations: [observation(), exoPitch(40), visionPitch(40 + POSTURE_PITCH_DISAGREEMENT_DEG - 1)],
    }));
    expect(justUnder.conflicts.filter((c) => c.dimension === 'posture')).toHaveLength(0);
    const atThreshold = fusePerception(input({
      observations: [observation(), exoPitch(40), visionPitch(40 + POSTURE_PITCH_DISAGREEMENT_DEG)],
    }));
    expect(atThreshold.conflicts.filter((c) => c.dimension === 'posture')).toHaveLength(1);
  });

  it('两源角度差值超容差 → 记录姿态角度冲突（两个源都保留）', () => {
    const fused = fusePerception(input({ observations: [observation(), exoPitch(60), visionPitch(5)] }));
    const posture = fused.conflicts.filter((c) => c.dimension === 'posture');
    expect(posture).toHaveLength(1);
    expect(posture[0].detail).toContain('姿态角度冲突');
    expect(posture[0].participants.map((p) => p.source).sort()).toEqual(['exo_imu', 'vision']);
    expect(fused.strongAdviceAllowed).toBe(false);
  });

  it('只有视觉骨架角度（外骨骼缺失）→ 姿态取自视觉并如实标 basis，不冒充外骨骼', () => {
    const fused = fusePerception(input({ observations: [observation(), visionPitch(30)] }));
    expect(fused.posture?.pitchDeg).toBe(30);
    expect(fused.posture?.basis.join(' ')).toContain('vision');
    expect(fused.confidence.missingSources).toContain('exo_imu');
  });

  it('视觉骨架角度与动作词冲突都记（动作词规则保留，数值规则新增）', () => {
    const fused = fusePerception(input({
      observations: [
        observation(),
        exoPitch(70),
        visionPitch(10),
        observation({
          source: 'vision', sourceId: 'CAM-1', dimension: 'action', confidence: 0.9,
          value: { action: 'standing' }, matchedBy: 'track_id',
        }),
      ],
    }));
    expect(fused.conflicts.filter((c) => c.dimension === 'posture').length).toBeGreaterThanOrEqual(2);
  });
});

/* ── NO-59a：外骨骼关节角 → 动作（动作维度的第二个独立源） ─────────────── */

describe('deriveExoAction（关节角 → 动作，封闭词表）', () => {
  it('双膝 ≥ 60° → squatting；双膝不对称且较大侧 ≥ 45° → kneeling', () => {
    const squat = deriveExoAction({ left_knee: 75, right_knee: 80 }, 40);
    expect(squat.action).toBe('squatting');
    expect(squat.reason).toBeNull();
    expect(squat.basis).toContain('膝角');

    const kneel = deriveExoAction({ left_knee: 90, right_knee: 30 }, 20);
    expect(kneel.action).toBe('kneeling');
  });

  it('俯仰 ≥ 45°（膝角不大）→ bending；俯仰小且膝角小 → standing', () => {
    expect(deriveExoAction({ left_knee: 10, right_knee: 12 }, 60).action).toBe('bending');
    expect(deriveExoAction({ left_knee: 5, right_knee: 8 }, 5).action).toBe('standing');
  });

  it('别名与厂商命名都能认（left_knee / l_knee / knee_left）', () => {
    expect(deriveExoAction({ l_knee: 70, r_knee: 72 }, 30).action).toBe('squatting');
    expect(deriveExoAction({ knee_left: 4, knee_right: 6 }, 2).action).toBe('standing');
  });

  it('缺膝角 / 非数值 / 无关节角 → null + 明确原因（绝不默认 standing）', () => {
    expect(deriveExoAction(null, 5).action).toBeNull();
    expect(deriveExoAction(null, 5).reason).toContain('缺少膝角');
    expect(deriveExoAction({ left_knee: 'x' }, 5).action).toBeNull();
    expect(deriveExoAction({ left_knee: 10, right_knee: 12 }, null).action).toBeNull();
    expect(deriveExoAction({ left_knee: 10, right_knee: 12 }, null).reason).toContain('步态周期');
  });

  it('中间态不猜（膝 45°/48°、俯仰未知 → 不判定）', () => {
    const mid = deriveExoAction({ left_knee: 45, right_knee: 48 }, null);
    expect(mid.action).toBeNull();
    expect(mid.reason).toContain('中间态');
  });

  it('uprightnessOf：已知动作给出直立性，未知动作返回 null（不参与交叉验证）', () => {
    expect(uprightnessOf('standing')).toBe(true);
    expect(uprightnessOf('SQUAT')).toBe(false);
    expect(uprightnessOf('弯腰')).toBe(false);
    expect(uprightnessOf('carrying')).toBeNull();
    expect(uprightnessOf('')).toBeNull();
  });
});

describe('fusePerception 动作交叉验证（外骨骼 vs 视觉）', () => {
  const exoAction = (action: string) => observation({
    source: 'exo_imu', sourceId: 'EXO-1', dimension: 'action', confidence: 0.9,
    value: { action }, matchedBy: 'wearer_binding_joint_angles',
  });
  const visionAction = (action: string) => observation({
    source: 'vision', sourceId: 'CAM-1', dimension: 'action', confidence: 0.9,
    value: { action }, matchedBy: 'track_id',
  });

  it('两个独立动作源结论相反 → 记动作冲突（各源取值保留、禁止强建议）', () => {
    const fused = fusePerception(input({
      observations: [observation(), exoAction('standing'), visionAction('squatting')],
    }));
    const actionConflicts = fused.conflicts.filter((c) => c.dimension === 'action');
    expect(actionConflicts).toHaveLength(1);
    expect(actionConflicts[0].detail).toContain('动作冲突');
    expect(actionConflicts[0].participants.map((p) => p.source).sort()).toEqual(['exo_imu', 'vision']);
    expect(fused.strongAdviceAllowed).toBe(false);
  });

  it('两源一致（都直立）→ 不记冲突', () => {
    const fused = fusePerception(input({
      observations: [observation(), exoAction('standing'), visionAction('stand')],
    }));
    expect(fused.conflicts.filter((c) => c.dimension === 'action')).toHaveLength(0);
  });

  it('未知动作词不参与判定（不把"carrying"当成直立或弯腰）', () => {
    const fused = fusePerception(input({
      observations: [observation(), exoAction('standing'), visionAction('carrying')],
    }));
    expect(fused.conflicts.filter((c) => c.dimension === 'action')).toHaveLength(0);
  });

  it('外骨骼动作进入姿态结论的 action 字段（姿态主源是外骨骼时）', () => {
    const fused = fusePerception(input({
      observations: [
        observation(),
        observation({ source: 'exo_imu', sourceId: 'EXO-1', dimension: 'posture', confidence: 0.9, value: { pitchDeg: 50 } }),
        exoAction('bending'),
      ],
    }));
    expect(fused.posture?.pitchDeg).toBe(50);
    expect(fused.posture?.action).toBe('bending');
  });
});

describe('置信度按"源"计权（NO-59a 修正：多维度源不再拿多倍权重）', () => {
  it('同一源报 3 个维度 与 报 1 个维度 → 置信度分数相同（源可用性只计一次）', () => {
    const oneDimension = fusePerception(input({
      observations: [
        observation(),
        observation({ source: 'vision', sourceId: 'CAM-1', dimension: 'station_presence', confidence: 0.8, value: { stationId: 'ST-1', present: true } }),
      ],
    }));
    const threeDimensions = fusePerception(input({
      observations: [
        observation(),
        observation({ source: 'vision', sourceId: 'CAM-1', dimension: 'station_presence', confidence: 0.8, value: { stationId: 'ST-1', present: true } }),
        observation({ source: 'vision', sourceId: 'CAM-1', dimension: 'action', confidence: 0.8, value: { action: 'standing' } }),
        observation({ source: 'vision', sourceId: 'CAM-1', dimension: 'posture', confidence: 0.8, value: { pitchDeg: 5 } }),
      ],
    }));
    expect(threeDimensions.confidence.score).toBe(oneDimension.confidence.score);
    expect(threeDimensions.confidence.score).toBeLessThanOrEqual(1);
    expect(threeDimensions.confidence.basis).toContain('每源只计一次');
  });
});
