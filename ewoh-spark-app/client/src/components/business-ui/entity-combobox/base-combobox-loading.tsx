'use client';

import { cn } from '@/lib/utils';
import { Spinner } from '@client/src/components/ui/spinner';

// CLI-334：移除从未使用的 text 参数（loading 文案由 BaseComboboxList 的
// loadingText 承担）。
export const BaseComboboxLoading = ({
  className,
}: {
  className?: string;
}) => {
  return (
    <div
      className={cn('flex items-center justify-center gap-2 py-6', className)}
    >
      <Spinner className="size-4.5 text-primary" />
    </div>
  );
};
