"""thermal.ThermalEstimator 单测（热积累估计器）。

对抗背景：tools/exo_fleet_sim.py 的设备物理仿真用同族模型产生"真值"（参数独立），
边缘估计器只能从 torque 帧流推算。本文件锁定估计器自身的物理语义：

- 稳态收敛到解析解 ambient + k·tau·τ²（与 steady_state_c 对照）
- 卸载后向环境温度冷却
- dt 上限（dt_cap）：长时间缺帧不允许瞬间冷却到底/加热到顶
- dt<0（时间倒退/补传乱序）与 dt=None（首帧）不改变温度（不伪造物理）
- torque=None（字段缺失/哨兵）按 0 热处理，散热照常
- 非法构造参数 fail-fast
"""

import unittest

from edge_platform.inference.thermal import (
    DEFAULT_AMBIENT_C,
    MODEL_VERSION,
    ThermalEstimator,
    steady_state_c,
)


class TestThermalEstimator(unittest.TestCase):
    def test_steady_state_converges_to_analytic(self):
        """持续负载下收敛到解析稳态（容差 1°C）。"""
        est = ThermalEstimator()
        target = steady_state_c(20.0)
        for _ in range(600):  # 5×tau，足够进入稳态
            est.update(20.0, 1.0)
        self.assertAlmostEqual(est.temperature_c, target, delta=1.0)

    def test_cools_back_to_ambient_after_unload(self):
        """卸载后向环境温度冷却（不全恢复也无妨，但必须单调下降接近）。"""
        est = ThermalEstimator()
        for _ in range(600):
            est.update(20.0, 1.0)
        hot = est.temperature_c
        for _ in range(1200):
            est.update(0.0, 1.0)
        self.assertLess(est.temperature_c, hot - 30.0)
        self.assertLess(est.temperature_c, steady_state_c(20.0) - 40.0)

    def test_dt_cap_bounds_integration(self):
        """dt 超 dt_cap 按上限积分：1h 缺帧 ≈ cap 步进，不允许瞬间跳到稳态。

        上界钉死：cap=5s 步进的净变温必须 ≤ 加热上限（k·τ²·5，冷却只会更低）。
        """
        est = ThermalEstimator()
        before = est.temperature_c
        est.update(20.0, 3600.0)
        single = est.temperature_c - before
        heat_5s = est.k_heat * 20.0 * 20.0 * est.dt_cap_sec
        self.assertLessEqual(single, heat_5s + 1e-9, "5s 步进的加热净效应不得超过纯加热上限")
        self.assertGreater(single, 0.0)
        # 连续多次大间隔也不允许逼近解析稳态（每步最多 5s）
        for _ in range(12):
            est.update(20.0, 3600.0)
        self.assertLessEqual(est.temperature_c, before + 12 * heat_5s + 1e-9)

    def test_negative_dt_and_none_dt_are_noops(self):
        """时间倒退/首帧不改变温度。"""
        est = ThermalEstimator()
        est.update(20.0, 1.0)
        t = est.temperature_c
        self.assertEqual(est.update(20.0, -50.0), t)
        self.assertEqual(est.update(20.0, None), t)

    def test_missing_torque_heats_nothing_but_still_cools(self):
        """torque=None：不加热，散热照常。"""
        est = ThermalEstimator(initial_c=50.0)
        est.update(None, 10.0)
        self.assertLess(est.temperature_c, 50.0)

    def test_non_finite_torque_does_not_poison_estimator(self):
        """torque=NaN/Inf（坏读数）按 0 处理：估计器不得永久变 NaN、
        静默解除 THERMAL_ACCUMULATION 武装（nan>=阈值 恒 False）。"""
        est = ThermalEstimator(initial_c=50.0)
        est.update(float("nan"), 10.0)
        self.assertLess(est.temperature_c, 50.0)  # NaN 当 0：只散热
        est.update(float("inf"), 10.0)
        self.assertLess(est.temperature_c, 60.0)  # 仍是有限温度且在下降
        est.update(20.0, 10.0)
        self.assertGreater(est.temperature_c, est.ambient_c)  # 之后正常加热

    def test_reset_restores_ambient(self):
        est = ThermalEstimator()
        for _ in range(100):
            est.update(30.0, 1.0)
        est.reset()
        self.assertEqual(est.temperature_c, DEFAULT_AMBIENT_C)

    def test_invalid_constructor_args_fail_fast(self):
        with self.assertRaises(ValueError):
            ThermalEstimator(k_heat=-1.0)
        with self.assertRaises(ValueError):
            ThermalEstimator(tau_cool_sec=0)
        with self.assertRaises(ValueError):
            ThermalEstimator(dt_cap_sec=0)

    def test_model_version_declared(self):
        """模型版本必须存在（事件 trigger 要带它，消费方按"模型推算"对待）。"""
        self.assertTrue(MODEL_VERSION)


if __name__ == "__main__":
    unittest.main()
