"""EWOH 受控数据采集包：采集会话/人工标签管理，数据集切分导出。

collection_session / collection_label 两张表由本包自建于 Storage 同一
SQLite 库文件（经 storage.db_path 访问），与遥测/事件表解耦。
"""
