"""Regression tests for inference/admin data availability honesty."""

from __future__ import annotations

import unittest
from dataclasses import dataclass
from types import SimpleNamespace
from unittest import mock

from edge_platform.routes.admin import api_audit
from edge_platform.routes.health import route_solver_health
from edge_platform.routes.inference import api_inference_metrics, api_models, api_vision_understand


@dataclass
class Req:
    pass


class Handler:
    def __init__(self):
        self.response = None
        self.status = None

    def arg(self, name, default=None):
        return default

    def _limit(self):
        return 100

    def _offset(self):
        return 0

    def _new_error(self, code, message, status):
        self.status = status
        self.response = {"error": {"code": code, "message": message}}
        return self.response

    def send_json(self, payload, status=200):
        self.status = status
        self.response = payload
        return payload


class AvailabilityHonestyTest(unittest.TestCase):
    def test_inference_metrics_degrades_instead_of_zero_faking(self):
        class Storage:
            def list_devices(self):
                return [{"device_id": "D1"}]

            def query_inference(self, *args):
                raise RuntimeError("sqlite busy")

        h = Handler()
        payload = api_inference_metrics(SimpleNamespace(storage=Storage(), metrics=None, pipeline=None), h, Req())
        self.assertEqual(h.status, 200)
        self.assertEqual(payload["data_quality"], "degraded")
        self.assertEqual(payload["window_query_errors"], 1)
        self.assertEqual(payload["window_inference_count"], 0)

    def test_inference_metrics_rejects_reversed_window(self):
        h = Handler()
        original = h.arg

        def arg(name, default=None):
            if name == "start":
                return "2026-01-02T00:00:00+00:00"
            if name == "end":
                return "2026-01-01T00:00:00+00:00"
            return original(name, default)

        h.arg = arg
        payload = api_inference_metrics(SimpleNamespace(storage=None, metrics=None, pipeline=None), h, Req())
        self.assertEqual(h.status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_params")

    def test_model_and_audit_storage_failures_are_not_empty_success(self):
        class Exploding:
            list_models = None
            list_audit_logs = None

        storage = Exploding()
        h = Handler()
        api_models(SimpleNamespace(storage=storage), h, Req())
        self.assertEqual(h.status, 503)
        self.assertEqual(h.response["error"]["code"], "storage_unavailable")

        h = Handler()
        api_audit(SimpleNamespace(storage=storage), h, Req())
        self.assertEqual(h.status, 503)
        self.assertEqual(h.response["error"]["code"], "storage_unavailable")


class EdgeRouteBoundaryTest(unittest.TestCase):
    def test_solver_health_distinguishes_probe_ok_from_solver_availability(self):
        from edge_platform.scheduler.cpsat import solver as cpsat_solver

        for available, status in ((True, "available"), (False, "unavailable")):
            with self.subTest(available=available):
                h = Handler()
                with mock.patch.object(cpsat_solver, "is_available", return_value=available):
                    payload = route_solver_health(SimpleNamespace(), h, Req())
                self.assertEqual(h.status, 200)
                self.assertTrue(payload["ok"])
                self.assertIs(payload["available"], available)
                self.assertEqual(payload["status"], status)
                self.assertEqual(payload["solverVersion"], cpsat_solver.SOLVER_VERSION)
                self.assertIn("ortools", payload["note"])

    def test_vision_route_does_not_allow_client_model_override(self):
        with mock.patch(
            "edge_platform.perception.ark_vision.describe_image",
            return_value={"ok": False, "error": "probe"},
        ) as describe:
            h = Handler()
            h._audit_target_type = None
            h._audit_target_id = None
            payload = api_vision_understand(
                SimpleNamespace(),
                h,
                {"image_url": "https://public.example/x.png", "question": "看什么", "model": "attacker-model"},
            )

        self.assertEqual(h.status, 502)
        self.assertEqual(payload["error"], "probe")
        self.assertEqual(describe.call_count, 1)
        self.assertEqual(describe.call_args.args, ("https://public.example/x.png", "看什么"))
        self.assertEqual(describe.call_args.kwargs, {"api_key": "", "base_url": ""})


if __name__ == "__main__":
    unittest.main()
