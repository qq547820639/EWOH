import type { UserInfo, SearchAvatar } from '@lark-apaas/client-toolkit/tools/services';

import type { AccountType } from '@/components/business-ui/api/users/service';
import type {
  UserSelectItemValue,
  UserSelectValue,
} from '@/components/business-ui/user-select/types';
import { getI18nText } from '@/components/business-ui/utils/user';
import type { Department, User } from '@/components/business-ui/types/user';

export function getUserDisplayName(name: UserInfo['name']): string {
  return name.zh_cn || name.en_us || '';
}

export function getUserId(
  user: Pick<UserInfo, 'userID' | 'larkUserID'>,
  accountType: AccountType,
): string {
  if (accountType === 'lark') {
    return user.larkUserID || `_unknown_${Math.random().toString(36).slice(2)}`;
  }
  // 未注册外部联系人没有 userID，暂用 larkUserID 作为临时标识
  return user.userID || user.larkUserID || `_unknown_${Math.random().toString(36).slice(2)}`;
}

/**
 * 判断用户是否为未注册的外部联系人
 */
export function isUnregisteredExternalContact(user: UserSelectItemValue): boolean {
  const raw = user.raw;
  return !!raw && !raw.user_id && !!raw.larkUserId;
}

export function createUnknownUser(id: string): UserSelectItemValue {
  return {
    id,
    name: '未知用户',
    avatar: undefined,
    raw: undefined,
  };
}

/**
 * CLI-420：lark 侧 department 负载与本地 Department（ItemValue<DepartmentInfo>）
 * 形状不同源，经 unknown 收窄为本地 Department，替代 as any。
 */
function toDepartment(department: unknown): Department | undefined {
  return department ? (department as Department) : undefined;
}

export function userInfoToUser(
  userInfo: UserInfo & SearchAvatar,
  accountType: AccountType,
): UserSelectItemValue {
  // 构建统一的 User 类型作为 raw 数据
  const rawUser: User = {
    user_id: userInfo.userID || undefined,
    larkUserId: userInfo.larkUserID || undefined,
    name: userInfo.name,
    avatar: userInfo.avatar?.image?.large,
    user_type: userInfo.userType,
    department: toDepartment(userInfo.department),
  };

  return {
    id: getUserId(userInfo, accountType),
    name: getI18nText(userInfo.name),
    avatar: userInfo.avatar?.image?.large,
    raw: rawUser,
  };
}

export function searchUserInfoToUser(
  userInfo: UserInfo & { avatar?: string; tenantName?: string },
  accountType: AccountType,
): UserSelectItemValue {
  // 构建统一的 User 类型作为 raw 数据
  const rawUser: User = {
    user_id: userInfo.userID || undefined,
    larkUserId: userInfo.larkUserID || undefined,
    name: userInfo.name,
    avatar: userInfo.avatar,
    user_type: userInfo.userType,
    department: toDepartment(userInfo.department),
    tenantName: userInfo.tenantName,
  };

  return {
    id: getUserId(userInfo, accountType),
    name: getI18nText(userInfo.name),
    avatar: userInfo.avatar,
    raw: rawUser,
  };
}

declare global {
  interface Window {
    MIAODA_APP_ID?: string;
    __platform__?: {
      appId?: string;
    };
    appId?: string;
  }
}

/** appId 的合法字符集（字母/数字/下划线/连字符）。 */
const APP_ID_RE = /^[A-Za-z0-9_-]+$/;

export function getAppId(path: string): string | null | undefined {
  if (window?.__platform__?.appId) {
    return window.__platform__.appId;
  }

  if (window.MIAODA_APP_ID) {
    return window.MIAODA_APP_ID;
  }

  let prefix: string;

  /**
   * 从路径中提取 appId
   * @example "/app/my-app/settings" → "my-app"
   * CLI-415：提取结果经格式校验，非法值（空串/含路径分隔符或特殊字符）
   * 不再直接透出，落回 window.appId 兜底。
   */
  const appMatch = path.match(/\/app\/([^/]+)/);
  if (appMatch && APP_ID_RE.test(appMatch[1])) {
    return appMatch[1];
  }

  // 检查路径是否以固定前缀开头
  if (path.includes('/ai/feida/runtime/')) {
    prefix = '/ai/feida/runtime/';
  } else if (path.includes('/spark/r/')) {
    prefix = '/spark/r/';
  } else {
    prefix = '/ai/miaoda/';
  }

  // 兼容全栈appId挂载在window上，作为兜底
  const windowAppId = window.appId || null;

  if (!path.startsWith(prefix)) {
    return windowAppId;
  }

  // 截取前缀后的部分
  const remainder = path.substring(prefix.length);

  // 找到下一个斜杠的位置
  const nextSlashIndex = remainder.indexOf('/');

  // 如果没有斜杠，返回整个remainder；否则返回斜杠前的部分
  if (nextSlashIndex === -1) {
    return remainder || windowAppId;
  }
  return remainder.substring(0, nextSlashIndex) || windowAppId;
}

/**
 * 从 value 中提取 ID 列表
 * 支持 User 类型（user_id）和 UserSelectItemValue 类型（id）
 */
export function extractIdsFromValue(value: UserSelectValue): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [];
    }
    // 检查第一个元素判断类型
    if (typeof value[0] === 'string') {
      return value as string[];
    }
    // 对象数组：可能是 User[] 或 UserSelectItemValue[]
    // CLI-420：显式判别联合替代 any 断言。
    return (value as Array<User | UserSelectItemValue>)
      .map((item) => {
        // UserSelectItemValue 有 id 字段（内部类型）
        if ('id' in item && item.id) {
          return item.id;
        }
        // User 有 user_id 字段（外部类型）
        if ('user_id' in item && item.user_id) {
          return item.user_id;
        }
        return '';
      })
      .filter(Boolean);
  }
  // 单个对象：可能是 User 或 UserSelectItemValue
  const item = value as User | UserSelectItemValue;
  if ('id' in item && item.id) {
    return [item.id];
  }
  if ('user_id' in item && item.user_id) {
    return [item.user_id];
  }
  return [];
}
