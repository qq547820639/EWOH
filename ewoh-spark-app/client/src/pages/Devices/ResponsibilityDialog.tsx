import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { errorDescription } from '@client/src/lib/errorContract';
import {
  clearDeviceResponsibility,
  listDeviceResponsibilities,
  setDeviceResponsibility,
  type DeviceResponsibilityKind,
} from '@client/src/api/deviceResponsibility';
import { listPersonnel } from '@client/src/api/organization';
import { listShifts } from '@client/src/api/shift';
import {
  buildDeviceResponsibilityView,
  RESPONSIBILITY_ORDER,
  responsibilityLabel,
} from './responsibilityLogic';

/**
 * 设备责任人设置（NO-50a）。
 *
 * 页面职责：
 *   · 让班组长一眼看出**哪个职责还空着**（空位保留，不做"智能合并"）；
 *   · 设置/收回都要说明影响面——责任人会**直接收到该设备的安灯与升级提醒**
 *     （点名到人），没有绑定账号的人只会进缺口清单（不发通知）；
 *   · 缺失显式：没登记就写"未登记责任人（提醒只能发到角色）"，不留白。
 */
export default function ResponsibilityDialog({
  deviceId,
  onClose,
}: {
  deviceId: string;
  onClose: () => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<DeviceResponsibilityKind>('owner');
  // NO-51a：班次维度——空串 = 全天（同一职责的"本班"与"全天"是两条独立责任关系）
  const [shiftId, setShiftId] = useState('');
  const [personId, setPersonId] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');

  const responsibilityQuery = useQuery({
    queryKey: ['device-responsibilities', deviceId],
    queryFn: () => listDeviceResponsibilities([deviceId]),
  });
  const personnelQuery = useQuery({ queryKey: ['exo', 'personnel'], queryFn: () => listPersonnel({}) });
  /** 班次清单（用于"本班责任人"；取不到时空串=全天仍可用，不阻塞设置）。 */
  const shiftsQuery = useQuery({ queryKey: ['shifts', 'active'], queryFn: () => listShifts(true) });
  const personnel = (personnelQuery.data ?? []) as Array<{ personId?: string; id?: string; name?: string }>;

  const nameByPersonId = useMemo(() => {
    const map = new Map<string, string>();
    for (const person of personnel) {
      const id = String(person.personId ?? person.id ?? '').replace(/^person:/, '');
      if (id && person.name) map.set(id, String(person.name));
    }
    return map;
  }, [personnel]);

  const view = useMemo(
    () => buildDeviceResponsibilityView(deviceId, responsibilityQuery.data ?? [], nameByPersonId),
    [deviceId, responsibilityQuery.data, nameByPersonId],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['device-responsibilities'] });
  };

  const setMutation = useMutation({
    mutationFn: () =>
      setDeviceResponsibility(deviceId, {
        personId: personId.trim(),
        responsibility: kind,
        ...(shiftId ? { shiftId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: () => {
      toast.success(`已设置${responsibilityLabel(kind)}`, {
        description: '该责任人会直接收到本设备的安灯与升级提醒（点名到人）；未绑定登录账号时只能进缺口清单。',
      });
      setPersonId('');
      setNote('');
      invalidate();
    },
    onError: (error: unknown) => toast.error('设置责任人失败', { description: errorDescription(error) }),
  });

  const clearMutation = useMutation({
    mutationFn: (target: DeviceResponsibilityKind) =>
      clearDeviceResponsibility(deviceId, target, {
        ...(shiftId ? { shiftId } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: (_data, target) => {
      toast.success(`已收回${responsibilityLabel(String(target))}`, {
        description: '收回后该设备的提醒将退回角色兜底（历史保留，审计可查）。',
      });
      setReason('');
      invalidate();
    },
    onError: (error: unknown) => toast.error('收回责任人失败', { description: errorDescription(error) }),
  });

  const canSubmit = personId.trim().length > 0 && !setMutation.isPending;

  return (
    <section className="rounded-lg border border-border bg-card p-4" data-testid="responsibility-dialog">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">设备责任人：{deviceId}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            责任人会**直接收到**本设备的安灯与升级提醒（点名到人）；角色提醒照旧作为兜底。
          </p>
          <p className="mt-1 text-xs text-foreground" data-testid="responsibility-summary">
            {responsibilityQuery.isLoading ? '加载中…' : view.summaryLabel}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onClose} data-testid="responsibility-close">
          关闭
        </Button>
      </div>

      {responsibilityQuery.isError && (
        <p className="mt-2 text-xs text-risk-degraded-foreground" data-testid="responsibility-error">
          责任人数据读取失败（{errorDescription(responsibilityQuery.error)}）——这里不会显示成"未登记"。
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {view.slots.map((slot) => (
          <li
            key={slot.kind}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2"
            data-testid={`responsibility-slot-${slot.kind}`}
          >
            <div className="text-xs">
              <span className="text-muted-foreground">{slot.label}：</span>
              {slot.personLabel ? (
                <span className="text-foreground">{slot.personLabel}</span>
              ) : (
                <span className="text-muted-foreground">未登记（提醒发不到人）</span>
              )}
              {slot.personLabel && <span className="ml-1 text-muted-foreground">·{slot.shiftLabel}</span>}
              {slot.note && <span className="ml-1 text-muted-foreground">｜{slot.note}</span>}
            </div>
            {slot.personLabel && (
              <Button
                size="sm"
                variant="ghost"
                data-testid={`responsibility-clear-${slot.kind}`}
                disabled={clearMutation.isPending}
                onClick={() => clearMutation.mutate(slot.kind)}
              >
                收回
              </Button>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-4 rounded border border-border p-3">
        <h3 className="text-xs font-medium text-foreground">设置 / 换人</h3>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
            data-testid="responsibility-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as DeviceResponsibilityKind)}
          >
            {RESPONSIBILITY_ORDER.map((option) => (
              <option key={option} value={option}>
                {responsibilityLabel(option)}
              </option>
            ))}
          </select>
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
            data-testid="responsibility-shift"
            value={shiftId}
            onChange={(event) => setShiftId(event.target.value)}
          >
            <option value="">全天（不限班次）</option>
            {(shiftsQuery.data ?? []).map((shift) => (
              <option key={shift.shiftId} value={shift.shiftId}>
                {shift.name}（{shift.shiftId}）
              </option>
            ))}
          </select>
          <select
            className="min-w-[180px] rounded-md border border-border bg-background px-2 py-1 text-xs"
            data-testid="responsibility-person"
            value={personId}
            onChange={(event) => setPersonId(event.target.value)}
          >
            <option value="">选择人员…</option>
            {personnel.map((person) => {
              const id = String(person.personId ?? person.id ?? '');
              return (
                <option key={id} value={id}>
                  {person.name ? `${person.name}（${id}）` : id}
                </option>
              );
            })}
          </select>
          <Input
            className="h-8 w-56 text-xs"
            placeholder="备注（可选）"
            data-testid="responsibility-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button
            size="sm"
            data-testid="responsibility-submit"
            disabled={!canSubmit}
            onClick={() => setMutation.mutate()}
          >
            设置责任人
          </Button>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          同一个人重复设置同一职责（同一班次）是幂等的；换人时旧记录会保留（带停用时间），审计可查"当时是谁负责"。
          班次留空 = 全天责任人（各班的兜底）；登记了"本班"责任人时**本班优先**。
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Input
            className="h-8 w-56 text-xs"
            placeholder="收回理由（可选）"
            data-testid="responsibility-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <span className="text-[11px] text-muted-foreground">收回前请先选择上方职责的「收回」</span>
        </div>
      </div>
    </section>
  );
}
