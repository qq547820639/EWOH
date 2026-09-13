/* 通知处置结果词表测试（NO-44a）。
 *
 * 钉死：三种处置都有中文文案；未登记值/空值**不翻译**（原则 7：未知不当已知）；
 * 类型守卫只接受登记值（防止调用方写错字符串却"看起来通过了"）。
 */
/// <reference types="jest" />
import {
  NOTIFICATION_RESOLUTIONS,
  isNotificationResolution,
  notificationResolutionLabel,
} from './notification-resolution';

describe('notificationResolutionLabel', () => {
  it('三种登记处置都有明确中文文案，且互不相同', () => {
    const labels = NOTIFICATION_RESOLUTIONS.map((r) => notificationResolutionLabel(r));
    expect(labels.every((l) => typeof l === 'string' && l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(NOTIFICATION_RESOLUTIONS.length);
    expect(notificationResolutionLabel('session_corrected')).toContain('更正');
    expect(notificationResolutionLabel('session_aborted')).toContain('中止');
    expect(notificationResolutionLabel('session_ended')).toContain('收工');
  });

  it('NO-45a 新增的审批侧处置码同样有明确文案（授权失效 / 被新审批取代）', () => {
    expect(notificationResolutionLabel('approval_expired')).toContain('失效');
    expect(notificationResolutionLabel('approval_superseded')).toContain('新审批');
    // 文案必须能区分两者：一个说"前提消失"，一个说"重新申请成功"
    expect(notificationResolutionLabel('approval_expired')).not.toBe(
      notificationResolutionLabel('approval_superseded'),
    );
  });

  it('空值/未登记值不翻译（返回 null，由调用方原样展示）', () => {
    expect(notificationResolutionLabel(null)).toBeNull();
    expect(notificationResolutionLabel(undefined)).toBeNull();
    expect(notificationResolutionLabel('')).toBeNull();
    expect(notificationResolutionLabel('  ')).toBeNull();
    expect(notificationResolutionLabel('something_new')).toBeNull();
  });
});

describe('isNotificationResolution', () => {
  it('只接受封闭词表内的值', () => {
    for (const value of NOTIFICATION_RESOLUTIONS) expect(isNotificationResolution(value)).toBe(true);
    expect(isNotificationResolution('session_ended_v2')).toBe(false);
    expect(isNotificationResolution('')).toBe(false);
    expect(isNotificationResolution(null)).toBe(false);
    expect(isNotificationResolution(42)).toBe(false);
  });
});
