import {
  UserService,
  type AccountType,
  type SearchUsersParams,
  type SearchUsersResponse,
  type BatchGetUsersResponse,
  type ConvertExternalContactResponse,
} from '@lark-apaas/client-toolkit/tools/services';

const userService = new UserService();

/**
 * 搜索用户
 */
export async function searchUsers(
  params: SearchUsersParams,
): Promise<SearchUsersResponse> {
  return userService.searchUsers({ ...params, searchExternalContact: true });
}

/**
 * 批量根据用户 ID 查询用户信息。
 *
 * CLI-315：非数字 ID 不再被静默过滤吞掉——显式抛错交由调用方处理
 * （错误信息中只含被拒绝的 ID，避免误导性地返回不完整的用户列表）。
 */
export async function listUsersByIds(
  userIds: string[],
): Promise<BatchGetUsersResponse> {
  const invalidIds = userIds.filter((id) => isNaN(Number(id)));
  if (invalidIds.length > 0) {
    throw new Error(`listUsersByIds: 非数字用户 ID 被拒绝：${invalidIds.join(', ')}`);
  }
  return userService.listUsersByIds(userIds);
}

/**
 * 调用开户接口，将外部联系人的 larkUserID 转换为已注册用户
 */
export async function convertExternalContact(
  larkUserID: string,
): Promise<ConvertExternalContactResponse> {
  return userService.convertExternalContact(larkUserID);
}

export type { AccountType, SearchUsersParams, SearchUsersResponse, BatchGetUsersResponse, ConvertExternalContactResponse };
