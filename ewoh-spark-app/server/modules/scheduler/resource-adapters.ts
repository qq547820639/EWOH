/* 资源投影适配器（Task 3 / 3.3）。
 *
 * 统一的资源 → 投影入口抽象：调度候选/资源池/命令图按资源类型消费同一份
 * ResourceState，不再各自拼装。person/device/station 适配器委托
 * ResourceProjectionService（复用现有投影数据源，不重复 DB 查询）；
 * tool/material/vehicle 无对应表，返回显式 NOT_AVAILABLE 占位（空投影，
 * 不查询不存在的表、不虚构资源行）。
 */
import type { ResourceState } from '@shared/api.interface';
import { ResourceProjectionService } from './resource-projection.service';

/** 资源投影适配器接口：统一各资源类型的投影入口。 */
export interface ResourceProjectionAdapter {
  /** 资源类型标识（person / device / station / tool / material / vehicle）。 */
  adapterType(): string;
  /** 返回该类型的统一资源投影（person/device/station 为真实投影；其余为占位空投影）。 */
  getResources(): Promise<ResourceState[]>;
}

/**
 * 显式占位语义：该资源类型暂无真实数据源时使用。
 * 消费方必须把 NOT_AVAILABLE 视为「不可用 / 无已知资源」，绝不虚构可用资源。
 */
export const RESOURCE_NOT_AVAILABLE = 'NOT_AVAILABLE';

/** Person 适配器：委托 ResourceProjectionService 的 person 投影。 */
export class PersonnelAdapter implements ResourceProjectionAdapter {
  constructor(private readonly service: ResourceProjectionService) {}

  adapterType(): string {
    return 'person';
  }

  getResources(): Promise<ResourceState[]> {
    return this.service.projectByType('person');
  }
}

/** Device 适配器：委托 ResourceProjectionService 的 device 投影。 */
export class DeviceAdapter implements ResourceProjectionAdapter {
  constructor(private readonly service: ResourceProjectionService) {}

  adapterType(): string {
    return 'device';
  }

  getResources(): Promise<ResourceState[]> {
    return this.service.projectByType('device');
  }
}

/** Station 适配器：委托 ResourceProjectionService 的 station 投影。 */
export class StationAdapter implements ResourceProjectionAdapter {
  constructor(private readonly service: ResourceProjectionService) {}

  adapterType(): string {
    return 'station';
  }

  getResources(): Promise<ResourceState[]> {
    return this.service.projectByType('station');
  }
}

/**
 * NOT_AVAILABLE 占位适配器基类：tool/material/vehicle 无对应数据表，
 * 返回空投影并显式标注 RESOURCE_NOT_AVAILABLE，不查询不存在的表、不虚构资源行。
 */
abstract class NotAvailableAdapter implements ResourceProjectionAdapter {
  abstract adapterType(): string;

  getResources(): Promise<ResourceState[]> {
    return Promise.resolve([]);
  }
}

/** Tool 适配器：NOT_AVAILABLE 占位（无资源行）。 */
export class ToolAdapter extends NotAvailableAdapter {
  adapterType(): string {
    return 'tool';
  }
}

/** Material 适配器：NOT_AVAILABLE 占位（无资源行）。 */
export class MaterialAdapter extends NotAvailableAdapter {
  adapterType(): string {
    return 'material';
  }
}

/** Vehicle 适配器：NOT_AVAILABLE 占位（无资源行）。 */
export class VehicleAdapter extends NotAvailableAdapter {
  adapterType(): string {
    return 'vehicle';
  }
}