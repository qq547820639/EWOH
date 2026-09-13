import { ENV_OPTIONS, FACTORY_OPTIONS, LINE_OPTIONS, type AppContext } from '@/lib/appContext';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface OrgEnvSwitcherProps {
  context: AppContext;
  orgLabel: string;
  onChange: (partial: Partial<AppContext>) => void;
}

function Selector({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string;
  value: string;
  options: Array<{ id: string; label: string }>;
  onValueChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger size="sm" aria-label={label} className="h-7 px-2 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * 组织/工厂/产线/环境切换器。选择结果持久化到 localStorage，
 * 由父级（ContextBar）负责写入并回传最新上下文。
 */
const OrgEnvSwitcher = ({ context, orgLabel, onChange }: OrgEnvSwitcherProps) => {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label="组织与运行环境切换"
    >
      <span aria-label="已认证组织" title="组织由服务端认证会话决定" className="inline-flex h-7 items-center rounded-md border border-border bg-muted px-2 text-xs text-muted-foreground">
        组织：{orgLabel}
      </span>
      <Selector
        label="工厂"
        value={context.factoryId}
        options={FACTORY_OPTIONS}
        onValueChange={(v) => onChange({ factoryId: v })}
      />
      <Selector
        label="产线"
        value={context.lineId}
        options={LINE_OPTIONS}
        onValueChange={(v) => onChange({ lineId: v })}
      />
      <Selector
        label="环境"
        value={context.env}
        options={ENV_OPTIONS}
        onValueChange={(v) => onChange({ env: v as AppContext['env'] })}
      />
    </div>
  );
};

export default OrgEnvSwitcher;
