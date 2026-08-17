/* Canonical Exo Configuration Model（ADR-051 / §7，NO-13b）。
 *
 * 权威契约：contracts/exo/exo-config.schema.json +
 * exo-config.test-vectors.json。
 * 语义与 src/edge_platform/contracts/exo_config.py 逐项一致
 * （audit-domain-contracts exo-config 域跨语言仲裁 + Golden 第 25 场景）。
 */

export const EXO_CONFIG_KINDS = [
  'assist_profile',
  'fit',
  'calibration',
] as const;

export const SUPPORT_MODES = [
  'passive',
  'lift_assist',
  'carry_assist',
  'stand_assist',
  'balance_assist',
  'upper_limb_assist',
  'lower_limb_assist',
  'vendor_specific',
] as const;

export const CALIBRATION_KINDS = [
  'zeroing',
  'load_cell',
  'imu',
] as const;

export const PROFILE_STATUSES = ['active', 'superseded', 'retired'] as const;

export const FIT_STATUSES = ['pending', 'fitted', 'adjusted', 'invalidated'] as const;

export const CALIBRATION_STATUSES = ['pending', 'passed', 'failed'] as const;

const KIND_SET: ReadonlySet<string> = new Set(EXO_CONFIG_KINDS);
const MODE_SET: ReadonlySet<string> = new Set(SUPPORT_MODES);
const CAL_KIND_SET: ReadonlySet<string> = new Set(CALIBRATION_KINDS);
const STATUS_BY_KIND: Record<string, ReadonlySet<string>> = {
  assist_profile: new Set(PROFILE_STATUSES),
  fit: new Set(FIT_STATUSES),
  calibration: new Set(CALIBRATION_STATUSES),
};

const CANONICAL_ACTOR = /^[a-z][a-z0-9_]*:[^\s]+$/;
const CONFIG_ID = /^exo-config:[^\s]+$/;
const EXO_ID = /^device:[^\s]+$/;
const PERSON_ID = /^person:[^\s]+$/;

export interface ExoConfigAuditEntry {
  actor: string;
  action: string;
  at: string;
}

/** ExoConfigRecord 形状（与 contracts/exo/exo-config.schema.json 一致）。 */
export interface ExoConfigRecord {
  configId: string;
  kind: string;
  exoId: string;
  tenantId: string;
  status: string;
  supportMode?: string;
  vendorModeName?: string;
  parameters?: { assistLevel?: number; torqueLimitNm?: number };
  effectiveFrom?: string;
  effectiveTo?: string;
  supersededBy?: string;
  setBy?: string;
  personId?: string;
  fittedAt?: string;
  fitter?: string;
  measuredValues?: Record<string, number>;
  calibrationKind?: string;
  result?: string;
  calibratedAt?: string;
  calibratedBy?: string;
  nextDueAt?: string;
  auditTrail: ExoConfigAuditEntry[];
}

const REQUIRED_FIELDS = [
  'configId',
  'kind',
  'exoId',
  'tenantId',
  'status',
  'auditTrail',
] as const;

function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFiniteMap(value: unknown): boolean {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isFiniteNumber);
}

/** ExoConfigRecord 契约校验（fail-closed）；返回错误码列表（空=合法）。 */
export function validateExoConfig(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (typeof r.configId !== 'string' || !CONFIG_ID.test(r.configId)) return ['bad_config_id'];
  const kind = r.kind;
  if (!KIND_SET.has(String(kind))) return ['unknown_kind'];
  if (typeof r.exoId !== 'string' || !EXO_ID.test(r.exoId)) return ['bad_exo_id'];
  if (typeof r.tenantId !== 'string' || r.tenantId.trim() === '') return ['bad_tenant'];
  const status = r.status;
  if (!STATUS_BY_KIND[String(kind)].has(String(status))) return ['unknown_status'];

  if (kind === 'assist_profile') {
    const mode = r.supportMode;
    if (!MODE_SET.has(String(mode))) return ['unknown_support_mode'];
    if (mode === 'vendor_specific') {
      if (typeof r.vendorModeName !== 'string' || r.vendorModeName.trim() === '') {
        return ['vendor_mode_name_required'];
      }
    } else if (r.vendorModeName !== undefined
        && (typeof r.vendorModeName !== 'string' || r.vendorModeName.trim() === '')) {
      return ['bad_vendor_mode_name'];
    }
    const parameters = r.parameters;
    if (parameters !== undefined) {
      if (parameters == null || typeof parameters !== 'object' || Array.isArray(parameters)) {
        return ['bad_parameters'];
      }
      const params = parameters as Record<string, unknown>;
      const level = params.assistLevel;
      if (level !== undefined && (!isFiniteNumber(level) || (level as number) < 0 || (level as number) > 1)) {
        return ['bad_assist_level'];
      }
      const torque = params.torqueLimitNm;
      if (torque !== undefined && (!isFiniteNumber(torque) || (torque as number) < 0)) {
        return ['bad_torque_limit'];
      }
    }
    const fromMs = isoMs(r.effectiveFrom);
    if (fromMs === null) {
      // SH-013：null/undefined 同语义（Python .get() 缺键与显式 None 同归 missing_field）。
      return r.effectiveFrom == null ? ['missing_field:effectiveFrom'] : ['bad_effective_from'];
    }
    if (r.effectiveTo !== undefined) {
      const toMs = isoMs(r.effectiveTo);
      if (toMs === null) return ['bad_effective_to'];
      if (toMs < fromMs) return ['time_order_violation'];
    }
    if (status === 'superseded') {
      if (typeof r.supersededBy !== 'string' || r.supersededBy.trim() === '') {
        return ['superseded_by_required'];
      }
    }
    if (r.setBy !== undefined && (typeof r.setBy !== 'string' || r.setBy.trim() === '')) {
      return ['bad_set_by'];
    }
  } else if (kind === 'fit') {
    const personId = r.personId;
    if (personId === undefined) return ['fit_person_required'];
    if (typeof personId !== 'string' || !PERSON_ID.test(personId)) return ['bad_person_id'];
    if (r.fittedAt === undefined) return ['missing_field:fittedAt'];
    if (isoMs(r.fittedAt) === null) return ['bad_fitted_at'];
    const fitter = r.fitter;
    if (fitter === undefined) return ['fitter_required'];
    if (typeof fitter !== 'string' || !CANONICAL_ACTOR.test(fitter)) return ['bad_fitter'];
    if (r.measuredValues !== undefined && !isFiniteMap(r.measuredValues)) {
      return ['bad_measured_values'];
    }
  } else if (kind === 'calibration') {
    const calKind = r.calibrationKind;
    if (calKind === undefined) return ['missing_field:calibrationKind'];
    if (!CAL_KIND_SET.has(String(calKind))) return ['unknown_calibration_kind'];
    const result = r.result;
    if (result === undefined) return ['calibration_result_required'];
    if (!STATUS_BY_KIND.calibration.has(String(result))) return ['unknown_calibration_result'];
    const atMs = isoMs(r.calibratedAt);
    if (atMs === null) {
      return r.calibratedAt === undefined ? ['missing_field:calibratedAt'] : ['bad_calibrated_at'];
    }
    const calibratedBy = r.calibratedBy;
    if (calibratedBy === undefined) return ['calibrated_by_required'];
    if (typeof calibratedBy !== 'string' || !CANONICAL_ACTOR.test(calibratedBy)) {
      return ['bad_calibrated_by'];
    }
    if (r.nextDueAt !== undefined) {
      const dueMs = isoMs(r.nextDueAt);
      if (dueMs === null) return ['bad_next_due_at'];
      if (dueMs < atMs) return ['time_order_violation'];
    }
  }

  const auditTrail = r.auditTrail;
  if (!Array.isArray(auditTrail) || auditTrail.length === 0) return ['audit_required'];
  for (const entry of auditTrail) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return ['bad_audit_entry'];
    const en = entry as Record<string, unknown>;
    if (typeof en.actor !== 'string' || !CANONICAL_ACTOR.test(en.actor)) return ['bad_audit_entry'];
    if (typeof en.action !== 'string' || en.action.trim() === '') return ['bad_audit_entry'];
    if (isoMs(en.at) === null) return ['bad_audit_entry'];
  }
  return [];
}
