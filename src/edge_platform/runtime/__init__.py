"""EWOH 边缘运行时：真实依赖装配（production / development / simulation）。

- protocols：组件契约（Protocol），生产组件必须满足；
- dependencies：真实组件构造（Storage / MessageBus / RuleEngine / Pipeline / AdapterManager）；
- bootstrap：RuntimeMode 语义 + RuntimeFactory，production 装配失败必须 fail-fast，
  禁止 ImportError 后自动回退 stub。

纯 Python 标准库实现。
"""
