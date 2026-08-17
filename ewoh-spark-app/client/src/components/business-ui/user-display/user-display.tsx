'use client';

import React from 'react';

import { normalizeUser, isValidUserId } from '@/components/business-ui/utils/user';
import type { UserInput } from '@/components/business-ui/types/user';
import { UserWithAvatar } from '@/components/business-ui/user-display/user-with-avatar';
import { UserProfile } from '@/components/business-ui/user-profile/user-profile';
import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

export interface IUserDisplayProps {
  /**
   * 用户列表
   */
  value?: string | string[] | UserInput | UserInput[];
  size?: 'small' | 'medium' | 'large';
  className?: string;
  style?: React.CSSProperties;
  showLabel?: boolean;
  showUserProfile?: boolean;
  userId?: string;
  user_id?: string;
}

export const UserDisplay: React.FC<IUserDisplayProps> = ({
  userId,
  user_id,
  value,
  size,
  className,
  style,
  showLabel = true,
}) => {
  // 统一规范化为 User[]，兼容所有格式
  const normalizedUsers = React.useMemo(() => {
    let list: UserInput[];

    if (value) {
      // 处理 value 的不同类型
      if (Array.isArray(value)) {
        // string[] 或 UserInput[]
        list = value.map((item: string | UserInput) =>
          typeof item === 'string' ? { user_id: item } : item,
        );
      } else {
        // string 或 UserInput
        list = [typeof value === 'string' ? { user_id: value } : value];
      }
    } else if (userId) {
      // userId 快捷方式：转换为对象
      list = [{ user_id: userId }];
    } else if (user_id) {
      // user_id 快捷方式：转换为对象
      list = [{ user_id }];
    } else {
      return [];
    }

    // 转换为标准 User 类型并过滤无效 ID
    return list
      .map(normalizeUser)
      .filter((user) => isValidUserId(user.user_id));
  }, [value, userId, user_id]);

  if (!normalizedUsers.length) {
    return null;
  }

  return (
    <div className={cn('flex flex-wrap gap-1', className)} style={style}>
      {normalizedUsers.map((user) => (
        <Popover key={user.user_id}>
          <PopoverTrigger asChild>
            <div>
              <UserWithAvatar
                data={user}
                size={size}
                showLabel={showLabel}
                className="cursor-pointer hover:bg-accent active:bg-muted"
              />
            </div>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={8}
            className="w-[320px] border-0 border-border/50 bg-card p-0 shadow-lg"
          >
            <UserProfile value={user} />
          </PopoverContent>
        </Popover>
      ))}
    </div>
  );
};
