"""EWOH 边缘适配层：按设备型号分目录组织（edge/adapters/<model>/）。

本包为受控试点阶段 1 的设备接入层，首阶段为只读模式：
- 设备主动 TCP 连接平台，平台仅接收遥测/心跳/故障/身份/补传，不向设备发送任何业务控制命令；
- 急停、限扭、关节实时控制等安全闭环能力全部归属设备本地控制器，平台不得实现任何指向这些能力的写入路径。

对外契约（与 edge_platform/stubs.py 对齐，便于 run.py 在真实/stub 间切换）：
- edge.storage.Storage
- edge.bus.Bus
- edge.manager.AdapterManager
- edge.adapters.ny_exo_a1.adapter.NYExoA1Adapter（兼容路径 edge.adapter.NYExoA1Adapter）
"""
