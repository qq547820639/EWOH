"""数据治理：授权管理、分层保留、模型与规则版本治理。

对应 spec「数据治理与隐私扩展」：
- 默认不采集强身份信息/长期精确轨迹/持续原始视频/非必要生理数据；边缘推理+中心只保存
  骨架与事件+原始视频短缓存无事件自动覆盖+人脸默认模糊+非必要不跨天身份追踪；
- 分层保留（高频遥测 7—30 天/分钟聚合 6—12 月/事件证据按闭环周期/调度任务按审计周期/
  审计≥180 天/三维底图按版本长期/训练数据单独授权版本管理）；
- 员工数据权利（知情/用途/查看结论/更正/申诉/查询访问记录/撤回授权）；
- 模型与规则版本可追溯、可回滚（模型结果 100% 可追溯到模型和数据版本）。

子模块：
- consent：授权授予/撤回/查询/访问审计，撤回触发删除/匿名化/移交作业；
- retention：分层保留策略，版本化注册、过期判定与到期清理（永不清理底图/训练数据，
  审计日志至少 180 天）；
- model_registry：模型/规则版本治理，CANDIDATE→SHADOW→ACTIVE→RETIRED 生命周期、
  影子运行未达标不得激活、回滚到历史版本，全链路审计。

纯 Python 标准库实现；沿用 edge_platform.spatial 的 new_id / now_iso 与
edge_platform.inference 的 ts_to_ms 约定。
"""

from .consent import (
    ConsentPurpose, ConsentRecord, ConsentManager, RevocationJob,
)
from .retention import (
    DataClass, RetentionPolicy, RetentionManager, DEFAULT_RETENTION,
)
from .model_registry import (
    ModelStatus, ModelRecord, ModelRegistry,
)

__all__ = [
    # 授权管理
    "ConsentPurpose", "ConsentRecord", "ConsentManager", "RevocationJob",
    # 分层保留
    "DataClass", "RetentionPolicy", "RetentionManager", "DEFAULT_RETENTION",
    # 模型与规则版本治理
    "ModelStatus", "ModelRecord", "ModelRegistry",
]
