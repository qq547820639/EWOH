"""edge_platform.edge.modeling — 边缘侧场景直接建模采集管线。

多源融合直接建模（spec §5 场景直接建模）：
  - splat_collector: 3D Gaussian Splatting 采集指引
  - lidar_collector: LiDAR 点云扫描与配准
  - locator_fusion: UWB + Wi-Fi + 视觉定位融合

产出推送到 spark-app 的 /api/ingest/spatial-scan 与 /api/ingest/location。
"""
