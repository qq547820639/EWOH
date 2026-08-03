"""Task 28 角色权限矩阵单元测试。

覆盖：
- Role 枚举：5 个角色、字符串值与 export_allowed_roles 默认值对齐。
- PERMISSIONS 矩阵：每个角色对 9 种动作的权限符合预期。
- is_allowed：Role 枚举与字符串均支持、未知角色/动作返回 False。
- check_export_role：用 Settings.export_allowed_roles 校验、默认名单。

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_rbac -v
"""

import os
import sys
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.config import Settings
from edge_platform.rbac import (
    ALL_ACTIONS,
    EXPORT_DATA,
    HANDLE_EVENTS,
    MANAGE_ASSIGNMENTS,
    MANAGE_DEVICES,
    MANAGE_MODELS,
    MANAGE_RULES,
    PERMISSIONS,
    VIEW_AUDIT,
    VIEW_EVENTS,
    VIEW_TELEMETRY,
    Role,
    check_export_role,
    is_allowed,
)


def _ewoh_keys():
    return {k for k in os.environ if k.startswith("EWOH_")}


class _EnvIsolatedTest(unittest.TestCase):
    def setUp(self):
        self._saved = dict(os.environ)
        for k in _ewoh_keys():
            os.environ.pop(k, None)
        Settings.reset()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved)
        Settings.reset()


class RoleEnumTest(unittest.TestCase):
    def test_five_roles(self):
        self.assertEqual({r.value for r in Role}, {"admin", "safety_officer", "operator", "data_analyst", "viewer"})

    def test_role_is_str_enum(self):
        # str 枚举：Role.ADMIN == "admin"
        self.assertEqual(Role.ADMIN, "admin")
        self.assertEqual(Role.SAFETY_OFFICER, "safety_officer")

    def test_role_values_align_with_default_export_roles(self):
        # 默认 export_allowed_roles = ("admin", "safety_officer")
        roles = Settings.load().export_allowed_roles
        for r in roles:
            # 每个默认导出角色都应是合法 Role 值
            self.assertIn(r, {role.value for role in Role})


class PermissionMatrixTest(unittest.TestCase):
    def test_all_actions_present_in_matrix(self):
        for role in Role:
            perms = PERMISSIONS[role.value]
            for action in ALL_ACTIONS:
                self.assertIn(action, perms, f"{role.value} 缺少动作 {action}")
                self.assertIsInstance(perms[action], bool)

    def test_nine_actions(self):
        self.assertEqual(len(ALL_ACTIONS), 9)

    def test_admin_all_true(self):
        perms = PERMISSIONS[Role.ADMIN.value]
        for action in ALL_ACTIONS:
            self.assertTrue(perms[action], f"admin 应允许 {action}")

    def test_viewer_readonly(self):
        perms = PERMISSIONS[Role.VIEWER.value]
        self.assertTrue(perms[VIEW_TELEMETRY])
        self.assertTrue(perms[VIEW_EVENTS])
        # viewer 不能处置/导出/管理
        for action in (
            HANDLE_EVENTS,
            EXPORT_DATA,
            MANAGE_DEVICES,
            MANAGE_RULES,
            MANAGE_MODELS,
            VIEW_AUDIT,
            MANAGE_ASSIGNMENTS,
        ):
            self.assertFalse(perms[action], f"viewer 不应允许 {action}")

    def test_safety_officer_permissions(self):
        perms = PERMISSIONS[Role.SAFETY_OFFICER.value]
        # 安全官：查看/处置事件、审计、规则/模型建议审批、导出、派工
        for action in (
            VIEW_TELEMETRY,
            VIEW_EVENTS,
            HANDLE_EVENTS,
            EXPORT_DATA,
            MANAGE_RULES,
            MANAGE_MODELS,
            VIEW_AUDIT,
            MANAGE_ASSIGNMENTS,
        ):
            self.assertTrue(perms[action], f"safety_officer 应允许 {action}")
        # 安全官不管理设备
        self.assertFalse(perms[MANAGE_DEVICES])

    def test_operator_permissions(self):
        perms = PERMISSIONS[Role.OPERATOR.value]
        # 运维：设备管理、事件处置、日志导出、审计
        for action in (VIEW_TELEMETRY, VIEW_EVENTS, HANDLE_EVENTS, EXPORT_DATA, MANAGE_DEVICES, VIEW_AUDIT):
            self.assertTrue(perms[action], f"operator 应允许 {action}")
        # 运维不管理规则/模型/派工
        for action in (MANAGE_RULES, MANAGE_MODELS, MANAGE_ASSIGNMENTS):
            self.assertFalse(perms[action])

    def test_data_analyst_permissions(self):
        perms = PERMISSIONS[Role.DATA_ANALYST.value]
        # 数据分析师：查看 + 导出，不能处置/管理/审计
        for action in (VIEW_TELEMETRY, VIEW_EVENTS, EXPORT_DATA):
            self.assertTrue(perms[action])
        for action in (HANDLE_EVENTS, MANAGE_DEVICES, MANAGE_RULES, MANAGE_MODELS, VIEW_AUDIT, MANAGE_ASSIGNMENTS):
            self.assertFalse(perms[action])


class IsAllowedTest(unittest.TestCase):
    def test_enum_and_string_equivalent(self):
        self.assertEqual(is_allowed(Role.ADMIN, MANAGE_DEVICES), is_allowed("admin", MANAGE_DEVICES))
        self.assertTrue(is_allowed(Role.ADMIN, MANAGE_DEVICES))
        self.assertTrue(is_allowed("admin", MANAGE_DEVICES))

    def test_allowed_cases(self):
        self.assertTrue(is_allowed(Role.SAFETY_OFFICER, HANDLE_EVENTS))
        self.assertTrue(is_allowed(Role.OPERATOR, MANAGE_DEVICES))
        self.assertTrue(is_allowed(Role.DATA_ANALYST, EXPORT_DATA))
        self.assertTrue(is_allowed(Role.VIEWER, VIEW_TELEMETRY))

    def test_denied_cases(self):
        self.assertFalse(is_allowed(Role.VIEWER, EXPORT_DATA))
        self.assertFalse(is_allowed(Role.VIEWER, HANDLE_EVENTS))
        self.assertFalse(is_allowed(Role.DATA_ANALYST, MANAGE_MODELS))
        self.assertFalse(is_allowed(Role.OPERATOR, MANAGE_RULES))
        self.assertFalse(is_allowed(Role.SAFETY_OFFICER, MANAGE_DEVICES))

    def test_unknown_role_returns_false(self):
        self.assertFalse(is_allowed("superuser", MANAGE_DEVICES))

    def test_unknown_action_returns_false(self):
        self.assertFalse(is_allowed(Role.ADMIN, "fly_to_moon"))


class CheckExportRoleTest(_EnvIsolatedTest):
    def test_default_allowed_roles(self):
        roles = Settings.load().export_allowed_roles
        self.assertEqual(roles, ("admin", "safety_officer"))

    def test_admin_allowed_by_default(self):
        roles = Settings.load().export_allowed_roles
        self.assertTrue(check_export_role(Role.ADMIN, roles))
        self.assertTrue(check_export_role("admin", roles))

    def test_safety_officer_allowed_by_default(self):
        roles = Settings.load().export_allowed_roles
        self.assertTrue(check_export_role(Role.SAFETY_OFFICER, roles))

    def test_operator_denied_by_default(self):
        roles = Settings.load().export_allowed_roles
        self.assertFalse(check_export_role(Role.OPERATOR, roles))
        self.assertFalse(check_export_role("operator", roles))

    def test_custom_allowed_roles(self):
        # 自定义导出名单包含 data_analyst
        allowed = ("admin", "data_analyst")
        self.assertTrue(check_export_role(Role.DATA_ANALYST, allowed))
        self.assertFalse(check_export_role(Role.SAFETY_OFFICER, allowed))

    def test_env_override_export_roles(self):
        os.environ["EWOH_EXPORT_ALLOWED_ROLES"] = "admin,operator"
        Settings.reset()
        roles = Settings.load().export_allowed_roles
        self.assertTrue(check_export_role(Role.OPERATOR, roles))
        self.assertFalse(check_export_role(Role.SAFETY_OFFICER, roles))


if __name__ == "__main__":
    unittest.main()
