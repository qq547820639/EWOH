"""Security regressions for optional spatial modeling tools."""

from __future__ import annotations

from unittest import mock

from edge_platform.edge.modeling import lidar_collector, locator_fusion, splat_collector


def test_locator_push_rejects_plain_http_secret_in_production():
    request = mock.mock_open()
    with mock.patch.object(locator_fusion, "_runtime_mode", return_value="production"), mock.patch.object(
        locator_fusion.urllib_request, "urlopen", request
    ):
        ok = locator_fusion.push_location({"x": 1}, "http://insecure.example", ingest_key="secret")
    assert ok is False
    request.assert_not_called()


def test_lidar_register_rejects_plain_http_secret_in_production():
    request = mock.mock_open()
    with mock.patch.object(lidar_collector, "_runtime_mode", return_value="production"), mock.patch.object(
        lidar_collector.urllib_request, "urlopen", request
    ):
        ok = lidar_collector.register_lidar(
            "WS-1", "https://objects/scan", "http://insecure.example", ingest_key="secret"
        )
    assert ok is False
    request.assert_not_called()


def test_splat_register_rejects_plain_http_secret_in_production():
    request = mock.mock_open()
    with mock.patch.object(splat_collector, "_runtime_mode", return_value="production"), mock.patch.object(
        splat_collector.urllib_request, "urlopen", request
    ):
        ok = splat_collector.register_splat(
            "WS-1", "https://objects/splat", "http://insecure.example", ingest_key="secret"
        )
    assert ok is False
    request.assert_not_called()


def test_lidar_alignment_refuses_to_claim_success_without_target(tmp_path):
    # open3d 不存在时也必须显式“未配准”，不得返回 aligned=true 的占位结果。
    source = tmp_path / "source.pcd"
    source.write_bytes(b"fake")
    result = lidar_collector.align_pointcloud(str(source))
    assert result["aligned"] is False
    assert "error" in result
