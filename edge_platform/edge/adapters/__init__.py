"""EWOH 边缘适配层：按设备型号分目录组织（edge/adapters/<model>/）。

每个型号子包提供 adapter / protocol / decoder / quality 等模块。本包仅含真实
设备接入实现，不替代 stub（stub 仍在 edge_platform/stubs.py 中维护）。
"""
