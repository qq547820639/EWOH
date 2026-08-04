import {
  ENV_OPTIONS,
  FACTORY_OPTIONS,
  LINE_OPTIONS,
  ORG_OPTIONS,
  type AppContext,
} from '@/lib/appContext';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface OrgEnvSwitcherProps {
  context: AppContext;
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
const OrgEnvSwitcher = ({ context, onChange }: OrgEnvSwitcherProps) => {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label="组织与运行环境切换"
    >
      <Selector
        label="组织"
        value={context.orgId}
        options={ORG_OPTIONS}
        onValueChange={(v) => onChange({ orgId: v })}
      />
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