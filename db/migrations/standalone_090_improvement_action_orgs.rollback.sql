-- 090 rollback：移除行动项租户清单函数（worker 需一并停用，否则会因函数缺失报错并留痕）。

DROP FUNCTION IF EXISTS __EWOH_SCHEMA__.ewoh_improvement_action_orgs();
