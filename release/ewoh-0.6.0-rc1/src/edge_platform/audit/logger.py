"""统一审计日志（Task 29）。

``AuditLogger`` 包装 ``Storage.insert_audit_log`` / ``Storage.list_audit_logs``，
为业务层提供统一的审计写入与查询入口。每次写入自动生成
``audit_id``（``new_id("AUD")`` 约定，由 Storage 完成）与时间戳。

纯 Python 标准库实现，零第三方依赖。
"""

from edge_platform.stubs import Storage


class AuditLogger:
    """审计日志记录器，包装 Storage 的审计日志读写。

    - ``log(...)``：写入一条审计日志，返回新记录字典（含 audit_id / ts）。
    - ``query(...)``：分页查询审计日志，按 ts DESC 排序。
    """

    def __init__(self, storage: Storage):
        self._storage = storage

    def log(
        self,
        action,
        actor_id,
        target_type=None,
        target_id=None,
        before=None,
        after=None,
        result="success",
        request_id=None,
        source_ip=None,
    ):
        """写入一条审计日志。

        audit_id 与 ts 由 Storage.insert_audit_log 自动生成（new_id("AUD") 约定）。
        """
        return self._storage.insert_audit_log(
            action=action,
            actor_id=actor_id,
            target_type=target_type,
            target_id=target_id,
            before=before,
            after=after,
            result=result,
            request_id=request_id,
            source_ip=source_ip,
        )

    def query(self, action=None, actor_id=None, target_type=None, limit=100, offset=0):
        """分页查询审计日志；可选按 action / actor_id / target_type 过滤。"""
        return self._storage.list_audit_logs(
            action=action,
            actor_id=actor_id,
            target_type=target_type,
            limit=limit,
            offset=offset,
        )
