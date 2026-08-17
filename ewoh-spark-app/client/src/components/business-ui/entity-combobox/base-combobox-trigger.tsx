'use client';

import { Plus } from 'lucide-react';

import { useEntityComboboxContext } from '@client/src/components/business-ui/entity-combobox/context';
import { SearchTrigger } from '@client/src/components/business-ui/entity-combobox/search-trigger';
import {
  addButtonIconVariants,
  addButtonVariants,
  type ComboboxSize,
} from '@client/src/components/business-ui/entity-combobox/size-variants';
import type {
  ClassNamesConfig,
  ItemValue,
  TriggerRenderProps,
  TriggerType,
} from '@client/src/components/business-ui/entity-combobox/types';
import { cn } from '@/lib/utils';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@client/src/components/ui/tooltip';

export type BaseComboboxTriggerProps = {
  triggerType?: TriggerType;
  size?: ComboboxSize;
  placeholder?: string;
  renderTrigger?: (props: TriggerRenderProps) => React.ReactNode;
  maxTagCount?: number; // CLI-323: 'responsive' 从未实现，已移除
  maxTagTextLength?: number;
  tagClosable?: boolean;
  classNames?: ClassNamesConfig;
  onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
  renderTag?: (
    value: ItemValue,
    onClose: (value: ItemValue, e: React.MouseEvent) => void,
    disabled?: boolean,
  ) => React.ReactNode;
  /**
   * 判断选项是否禁用
   */
  getOptionDisabled?: (value: ItemValue) => boolean;
  /**
   * button 模式下，自定义渲染加号按钮的包裹器
   * 用于将按钮包裹在 PopoverTrigger 中，使浮层跟随加号按钮而非整个容器
   */
  renderAddButton?: (button: React.ReactNode) => React.ReactNode;
  ref?: React.Ref<HTMLButtonElement>;
} & Omit<React.ComponentPropsWithoutRef<'button'>, 'children'>;

export const BaseComboboxTrigger = ({
  triggerType = 'button',
  size = 'medium',
  placeholder = '请选择',
  renderTrigger,
  maxTagCount,
  maxTagTextLength,
  tagClosable = true,
  classNames,
  onFocus,
  onBlur,
  renderTag,
  getOptionDisabled,
  renderAddButton,
  ref,
  ...props
}: BaseComboboxTriggerProps) => {
  const {
    selectedValue,
    multiple,
    open,
    disabled,
    handleClear,
    handleDeselect,
  } = useEntityComboboxContext();

  // 自定义渲染 (custom 类型)
  if (triggerType === 'custom' && renderTrigger) {
    return <>{renderTrigger({ selectedValue, multiple, open, disabled })}</>;
  }

  // search 类型
  if (triggerType === 'search') {
    return (
      <SearchTrigger
        size={size}
        placeholder={placeholder}
        maxTagCount={maxTagCount}
        maxTagTextLength={maxTagTextLength}
        tagClosable={tagClosable}
        classNames={classNames}
        onFocus={onFocus as (e: React.FocusEvent<HTMLDivElement>) => void}
        onBlur={onBlur as (e: React.FocusEvent<HTMLDivElement>) => void}
        renderTag={renderTag}
        getOptionDisabled={getOptionDisabled}
      />
    );
  }

  // button 类型（默认）
  const hasValue = !multiple
    ? !!selectedValue
    : Array.isArray(selectedValue) && selectedValue.length > 0;

  // 计算最大显示标签数
  const maxDisplayCount =
    typeof maxTagCount === 'number' ? maxTagCount : Infinity;

  const selectedArray = Array.isArray(selectedValue) ? selectedValue : [];

  // 计算隐藏的标签
  const hiddenCount =
    multiple && typeof maxTagCount === 'number'
      ? Math.max(0, selectedArray.length - maxTagCount)
      : 0;

  const hiddenTags =
    multiple && typeof maxTagCount === 'number'
      ? selectedArray.slice(maxTagCount)
      : [];

  // 标签关闭回调
  const handleTagClose = (value: ItemValue, e: React.MouseEvent) => {
    e.stopPropagation(); // 阻止触发按钮点击
    // 禁用的选项不允许关闭
    if (getOptionDisabled?.(value)) return;
    if (!multiple) {
      handleClear(); // 单选模式清空
    } else {
      handleDeselect(value); // 多选模式删除指定项
    }
  };

  // CLI-333：抽取共享渲染（可见标签 + 隐藏标签折叠为 +N tooltip），
  // renderTag 自定义分支与默认 Badge 分支复用同一结构，消除重复代码。
  const renderTagList = (render: (item: ItemValue) => React.ReactNode) => (
    <>
      {selectedArray.slice(0, maxDisplayCount).map(render)}
      {hiddenCount > 0 && (
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <Badge
              variant="secondary"
              className={cn('h-7 cursor-pointer text-xs', classNames?.tag)}
            >
              +{hiddenCount}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="w-auto max-w-80 p-2" align="start">
            <div className="flex flex-wrap gap-1">{hiddenTags.map(render)}</div>
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );

  return (
    <div
      className={cn(
        'flex w-full flex-wrap items-center gap-2',
        classNames?.trigger,
      )}
    >
      {/* 已选择的标签显示区域 */}
      {hasValue && (
        <>
          {!multiple && selectedValue ? (
            renderTag ? (
              renderTag(
                selectedValue as ItemValue,
                handleTagClose,
                getOptionDisabled?.(selectedValue as ItemValue),
              )
            ) : (
              <Badge
                variant="secondary"
                className={cn('h-7 text-xs', classNames?.tag)}
              >
                {(selectedValue as ItemValue).name}
              </Badge>
            )
          ) : multiple && selectedArray.length > 0 ? (
            renderTag ? (
              renderTagList((item) =>
                renderTag(item, handleTagClose, getOptionDisabled?.(item)),
              )
            ) : (
              renderTagList((item) => (
                <Badge
                  key={item.id}
                  variant="secondary"
                  className={cn('h-7 text-xs', classNames?.tag)}
                >
                  {item.name}
                </Badge>
              ))
            )
          ) : null}
        </>
      )}

      {/* 加号按钮 - 紧跟标签 */}
      {(() => {
        const addButton = (
          <Button
            ref={ref}
            variant="secondary"
            size="icon"
            role="combobox"
            aria-expanded={open}
            data-state={open ? 'open' : 'closed'}
            aria-controls="combobox-content"
            disabled={disabled}
            className={addButtonVariants({ size })}
            onFocus={
              onFocus as (e: React.FocusEvent<HTMLButtonElement>) => void
            }
            onBlur={onBlur as (e: React.FocusEvent<HTMLButtonElement>) => void}
            {...props}
          >
            <Plus className={addButtonIconVariants({ size })} />
          </Button>
        );
        return renderAddButton ? renderAddButton(addButton) : addButton;
      })()}
    </div>
  );
};
