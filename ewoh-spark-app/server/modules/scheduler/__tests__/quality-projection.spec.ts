/* NO-05d（ADR-011）：质量发现事实 → 资源投影 + 资格评估 单元测试。
 *
 * 覆盖：
 * 1) ResourceProjectionService.project() / projectForSnapshot()：活跃质量发现
 *    （status ∈ {open, under_review}，links 含 station/device/person 规范身份）
 *    附着到 qualityFindings；不改变资源状态（质量事实不改变物理可用性）；
 *    处置终态（dispositioned/closed）、形状不符行、非资源 kind 链接（order/
 *    material/batch）不参与资源附着（不伪造事实）。
 * 2) EligibilityService：critical/high → *_quality_blocked fail-closed 拒派
 *    （legacy L1-L3 归一化后同样触发；未知严重度按封锁留痕）；medium/low 仅
 *    事实可见不封锁；dispositioned/closed 解除。
 * DB 以 table-aware fake 替换（真实 DDL/RLS 由 standalone_034 verify + CI 承担）。
 */
/// <reference types="jest" />
import { ResourceProjectionService } from '../resource-projection.service';
import {
  ewohPersonnel,
  ewohDevice,
  ewohSpatialEntity,
  ewohMaintenanceCondition,
  ewohQualityFinding,
} from '@server/database/schema';
import { EligibilityService } from '../eligibility.service';
import type { ReservationResult } from '../resource-reservation.service';
import { makeEligibilityCtx } from './scheduler-test-helpers';

function deviceRow(over: Record<string, unknown> = {}) {
  return {
    id: 'D1',
    deviceId: 'D1',
    workerName: null,
    deviceModel: 'exo-lift',
    batteryPct: 90,
    online: true,
    faultCode: null,
    lastTelemetryAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function stationRow(over: Record<string, unknown> = {}) {
  return {
    id: 'S1',
    entityId: 'ST-01',
    entityType: 'station',
    parentId: 'Z-1',
    name: 'Station 1',
    x: 0,
    y: 0,
    status: 'active',
    version: 1,
    updatedAt: new Date(),
    ...over,
  };
}

function qualityRow(over: Record<string, unknown> = {}) {
  return {
    orgId: 'org-1',
    findingId: 'qf:1',
    findingType: 'process_deviation',
    severity: 'critical',
    status: 'open',
    disposition: null,
    links: ['device:D1'],
    detectedAt: new Date('2026-08-16T08:00:00Z'),
    dispositionedAt: null,
    evidenceId: null,
    ...over,
  };
}

function makeSvc(opts: {
  devices?: unknown[];
  spatial?: unknown[];
  maintenance?: unknown[];
  quality?: unknown[];
  reservations?: ReservationResult[];
}) {
  const reservationService = {
    listActive: jest.fn().mockResolvedValue(opts.reservations ?? []),
  };
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn((t: unknown) => {
        if (t === ewohPersonnel) return Promise.resolve([]);
        if (t === ewohDevice) return Promise.resolve(opts.devices ?? []);
        if (t === ewohSpatialEntity) return Promise.resolve(opts.spatial ?? []);
        if (t === ewohMaintenanceCondition) return Promise.resolve(opts.maintenance ?? []);
        if (t === ewohQualityFinding) return Promise.resolve(opts.quality ?? []);
        return Promise.resolve([]);
      }),
    }),
  };
  return new ResourceProjectionService(db as never, reservationService as never);
}

describe('NO-05d：质量发现 → 资源投影（ResourceProjectionService）', () => {
  it('critical 活跃发现（links 含设备）→ 附着事实且状态保持 AVAILABLE', async () => {
    const svc = makeSvc({
      devices: [deviceRow()],
      quality: [qualityRow({ severity: 'critical' })],
    });
    const device = (await svc.getUnifiedResourceState()).find((s) => s.id === 'D1')!;
    expect(device.status).toBe('AVAILABLE');
    expect(device.qualityFindings).toHaveLength(1);
    expect(device.qualityFindings![0]).toEqual(
      expect.objectContaining({
        findingId: 'qf:1',
        findingType: 'process_deviation',
        severity: 'critical',
      }),
    );
  });

  it('无关联发现 → qualityFindings=null（不伪造）', async () => {
    const svc = makeSvc({ devices: [deviceRow()] });
    const device = (await svc.getUnifiedResourceState()).find((s) => s.id === 'D1')!;
    expect(device.qualityFindings).toBeNull();
  });

  it('处置终态（dispositioned/closed）与形状不符行不参与附着', async () => {
    const svc = makeSvc({
      devices: [deviceRow()],
      quality: [
        qualityRow({ status: 'dispositioned', disposition: 'scrap' }),
        qualityRow({ status: 'closed' }),
        { id: 'noise', name: 'not-a-finding' },
      ],
    });
    const device = (await svc.getUnifiedResourceState()).find((s) => s.id === 'D1')!;
    expect(device.qualityFindings).toBeNull();
  });

  it('非资源 kind 链接（order/material/batch）不产生资源附着（不误锁）', async () => {
    const svc = makeSvc({
      devices: [deviceRow()],
      quality: [
        qualityRow({ links: ['order:00000000-0000-4000-8000-00000000000a'] }),
        qualityRow({ links: ['material:00000000-0000-4000-8000-00000000000b'] }),
        qualityRow({ links: ['batch:00000000-0000-4000-8000-00000000000c'] }),
      ],
    });
    const device = (await svc.getUnifiedResourceState()).find((s) => s.id === 'D1')!;
    expect(device.qualityFindings).toBeNull();
  });

  it('projectForSnapshot：station 链接附着事实（供 stationQualityBlockedById 消费）', async () => {
    const svc = makeSvc({
      spatial: [stationRow()],
      quality: [qualityRow({ findingId: 'qf:2', links: ['station:ST-01'], severity: 'high' })],
    });
    const snap = await svc.projectForSnapshot();
    const station = snap.stations.find((s) => s.id === 'ST-01')!;
    expect(station.qualityFindings).toHaveLength(1);
    expect(station.qualityFindings![0].findingId).toBe('qf:2');
  });
});

describe('NO-05d：质量发现 → 资格评估（EligibilityService）', () => {
  const svc = new EligibilityService();

  const basePerson = {
    id: 'p1',
    status: 'AVAILABLE',
    skills: ['work'],
    certifications: [],
    stationId: null,
    loadLevel: 0.1,
    fatigueLevel: 0,
    healthStatus: 'normal',
  };
  const baseTask = {
    id: 't1',
    taskType: 'work',
    requiredSkills: ['work'],
    requiredCertifications: [],
    stationId: 'S1',
    zoneId: null,
    predIds: [],
  };
  const finding = (over: Partial<Record<string, unknown>> = {}) => ({
    findingId: 'qf:1',
    findingType: 'defect',
    severity: 'critical',
    status: 'open',
    disposition: null,
    links: ['device:D1'],
    detectedAt: '2026-08-16T08:00:00Z',
    ...over,
  });

  it('人员 critical 质量发现 → person_quality_blocked（fail-closed）', () => {
    const res = svc.check(
      { ...basePerson, qualityFindings: [finding({ severity: 'critical' })] },
      baseTask,
      null,
      makeEligibilityCtx(),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('person_quality_blocked');
  });

  it('设备 high 质量发现 → device_quality_blocked（fail-closed）', () => {
    const res = svc.check(
      basePerson,
      baseTask,
      {
        id: 'd1',
        batteryPct: 100,
        online: true,
        status: 'AVAILABLE',
        capabilities: [],
        qualityFindings: [finding({ severity: 'high' })],
      },
      makeEligibilityCtx(),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('device_quality_blocked');
  });

  it('medium/low 质量发现 → 不封锁（仅事实可见，工业常态缺陷）', () => {
    for (const severity of ['medium', 'low']) {
      const res = svc.check(
        basePerson,
        baseTask,
        {
          id: 'd1',
          batteryPct: 100,
          online: true,
          status: 'AVAILABLE',
          capabilities: [],
          qualityFindings: [finding({ severity })],
        },
        makeEligibilityCtx(),
      );
      expect(res.eligible).toBe(true);
      expect(res.reasons).not.toContain('device_quality_blocked');
    }
  });

  it('legacy L1 严重度归一化 → 按 critical 封锁', () => {
    const res = svc.check(
      { ...basePerson, qualityFindings: [finding({ severity: 'L1' })] },
      baseTask,
      null,
      makeEligibilityCtx(),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('person_quality_blocked');
  });

  it('未知严重度 → 按封锁处理（fail-closed，不把未知当作安全）', () => {
    const res = svc.check(
      { ...basePerson, qualityFindings: [finding({ severity: 'apocalyptic' })] },
      baseTask,
      null,
      makeEligibilityCtx(),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('person_quality_blocked');
  });

  it('候选工位质量封锁 → station_quality_blocked（fail-closed）', () => {
    const res = svc.check(
      basePerson,
      baseTask,
      null,
      makeEligibilityCtx({
        candidateStationId: 'S1',
        stationQualityBlockedById: new Map([['S1', true]]),
      }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reasons).toContain('station_quality_blocked');
  });

  it('未封锁工位不受影响', () => {
    const res = svc.check(
      basePerson,
      baseTask,
      null,
      makeEligibilityCtx({
        candidateStationId: 'S1',
        stationQualityBlockedById: new Map([['S2', true]]),
      }),
    );
    expect(res.eligible).toBe(true);
  });
});
