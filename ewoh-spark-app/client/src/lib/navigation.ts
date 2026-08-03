import type { LucideIcon } from 'lucide-react';
import {
  ArrowUpRight,
  Boxes,
  BrainCircuit,
  Building2,
  CalendarClock,
  Cpu,
  Database,
  Factory,
  LayoutDashboard,
  Map,
  Settings,
  ShieldAlert,
  Smartphone,
  Users,
  Wrench,
} from 'lucide-react';
import { type EwohRole } from '@client/src/types/ewoh';

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  roles: EwohRole[];
};

export const ALL_ROLES: EwohRole[] = [
  'global_admin',
  'dispatcher',
  'workshop_lead',
  'safety_admin',
  'device_ops',
];

export const navGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '态势感知',
    items: [
      {
        to: '/command-center',
        label: '指挥中心',
        icon: LayoutDashboard,
        roles: ['global_admin', 'dispatcher', 'safety_admin'],
      },
      {
        to: '/digital-world',
        label: '数字世界',
        icon: Boxes,
        roles: ['dispatcher', 'workshop_lead'],
      },
      {
        to: '/devices',
        label: '设备中心',
        icon: Cpu,
        roles: ['device_ops', 'dispatcher'],
      },
      {
        to: '/personnel',
        label: '人员与外骨骼',
        icon: Users,
        roles: ['workshop_lead', 'safety_admin'],
      },
      {
        to: '/alerts',
        label: '风险告警',
        icon: ShieldAlert,
        roles: ['safety_admin', 'dispatcher'],
      },
    ],
  },
  {
    label: '运营管理',
    items: [
      {
        to: '/scheduling',
        label: '排产调度',
        icon: CalendarClock,
        roles: ['dispatcher', 'workshop_lead'],
      },
      {
        to: '/mobile-workbench',
        label: '移动工作台',
        icon: Smartphone,
        roles: ['global_admin', 'dispatcher', 'workshop_lead', 'device_ops'],
      },
      {
        to: '/operations',
        label: '运营管理',
        icon: Wrench,
        roles: ['global_admin', 'dispatcher', 'workshop_lead', 'safety_admin', 'device_ops'],
      },
      {
        to: '/organization',
        label: '组织与空间',
        icon: Building2,
        roles: ['global_admin'],
      },
      {
        to: '/model-management',
        label: '模型管理',
        icon: Boxes,
        roles: ['global_admin', 'device_ops'],
      },
      {
        to: '/data-assets',
        label: '数据资产',
        icon: Database,
        roles: ['global_admin'],
      },
      {
        to: '/scale',
        label: '规模化运营',
        icon: Factory,
        roles: ['global_admin', 'dispatcher', 'workshop_lead'],
      },
    ],
  },
  {
    label: '决策支持',
    items: [
      {
        to: '/ai-decision',
        label: 'AI 决策',
        icon: BrainCircuit,
        roles: ['dispatcher', 'global_admin'],
      },
    ],
  },
  {
    label: '基础设施',
    items: [
      {
        to: '/system',
        label: '系统管理',
        icon: Settings,
        roles: ['global_admin', 'safety_admin'],
      },
      {
        to: '/command-map',
        label: '指挥地图',
        icon: Map,
        roles: ALL_ROLES,
      },
    ],
  },
];

export function getAllowedRoles(path: string): EwohRole[] {
  const item = navGroups.flatMap((group) => group.items).find((nav) => nav.to === path);
  return item?.roles ?? [];
}

export function hasRoleAccess(
  userRoles: string[] | null | undefined,
  allowedRoles: EwohRole[] | string[],
): boolean {
  if (!allowedRoles || allowedRoles.length === 0) return true;
  if (!userRoles || userRoles.length === 0) return false;
  const roleSet = new Set(userRoles);
  if (roleSet.has('global_admin')) return true;
  return allowedRoles.some((role) => roleSet.has(role));
}

export function getVisibleNavGroups(userRoles: string[] | null | undefined) {
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => hasRoleAccess(userRoles, item.roles)),
    }))
    .filter((group) => group.items.length > 0);
}
