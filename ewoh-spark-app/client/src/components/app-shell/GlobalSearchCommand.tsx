import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import type { NavItem } from '@/lib/navigation';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

interface GlobalSearchCommandProps {
  navGroups: Array<{ label: string; items: NavItem[] }>;
}

/**
 * 全局搜索/命令面板：可搜索所有导航项并跳转，支持 Cmd+K / Ctrl+K 快捷键。
 */
const GlobalSearchCommand = ({ navGroups }: GlobalSearchCommandProps) => {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const items = navGroups.flatMap((group) =>
    group.items.map((item) => ({ ...item, group: group.label })),
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="全局搜索（Cmd+K）"
        className="inline-flex h-8 items-center gap-2 rounded-lg border border-[hsl(220_14%_89%)] bg-white px-2.5 text-sm text-[hsl(218_10%_42%)] hover:border-[hsl(220_14%_80%)] hover:text-[hsl(220_14%_14%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(221_83%_53%)]"
      >
        <Search className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">搜索</span>
        <kbd className="hidden rounded border border-[hsl(220_14%_89%)] bg-[hsl(220_14%_96%)] px-1 text-[10px] font-medium sm:inline">
          ⌘K
        </kbd>
      </button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="全局搜索"
        description="搜索并跳转到任意页面"
      >
        <CommandInput placeholder="输入页面名称或关键词…" />
        <CommandList>
          <CommandEmpty>未找到匹配的页面</CommandEmpty>
          <CommandGroup heading="导航">
            {items.map((item) => (
              <CommandItem
                key={item.to}
                value={`${item.label} ${item.to}`}
                onSelect={() => {
                  navigate(item.to);
                  setOpen(false);
                }}
              >
                <item.icon className="h-4 w-4" aria-hidden />
                <span>{item.label}</span>
                <span className="ml-auto text-xs text-[hsl(218_10%_42%)]">
                  {item.group}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
};

export default GlobalSearchCommand;