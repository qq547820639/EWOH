import { normalizeUser, isValidUserId } from '@/components/business-ui/utils/user';
import type { User } from '@/components/business-ui/types/user';
import type { UserInfo } from '@lark-apaas/client-toolkit/tools/services';
import type { AccountType } from '@/components/business-ui/api/users/service';

// 直接导出统一的函数
export { normalizeUser, isValidUserId };

/**
 * CLI-419：avatar 兼容两种负载——完整 UserInfo 的结构化头像
 * （avatar.image.large）与搜索接口的字符串 URL。
 */
type AvatarLike = { image?: { large?: string } } | string | undefined | null;

/** user-display 侧接受的最小用户负载形状（UserInfo 或其搜索变体）。 */
type RawUserLike = {
  userID?: string;
  larkUserID?: string;
  name?: UserInfo['name'];
  avatar?: AvatarLike;
  userType?: User['user_type'];
  department?: unknown;
};

// user-display 专用的转换函数
export function userInfoToUser(
  userInfo: RawUserLike,
  accountType: AccountType,
): User {
  let avatarUrl: string | undefined;

  if (typeof userInfo.avatar === 'string') {
    avatarUrl = userInfo.avatar;
  } else if (userInfo.avatar?.image?.large) {
    avatarUrl = userInfo.avatar.image.large;
  }

  return {
    user_id: accountType === 'lark' ? userInfo.larkUserID : userInfo.userID,
    larkUserId: userInfo.larkUserID,
    name: userInfo.name,
    avatar: avatarUrl,
    user_type: userInfo.userType,
    // CLI-419：unknown 负载收窄为本地 Department，替代 as any。
    department: userInfo.department
      ? (userInfo.department as User['department'])
      : undefined,
  };
}

export function createUnknownUser(user_id: string): User {
  return {
    user_id,
    name: '未知用户',
  };
}
