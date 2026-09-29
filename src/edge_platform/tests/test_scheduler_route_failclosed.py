"""Scheduler route readiness and task payload regressions."""

from __future__ import annotations

import unittest
from types import SimpleNamespace

from edge_platform import server
from edge_platform.routes import scheduler as routes

assert server.make_handler is not None  # resolve route/server import cycle before importing scheduler


class Handler:
    def __init__(self):
        self.status = None
        self.payload = None

    def arg(self, name, default=None):
        return default

    def _actor(self):
        return None

    def _new_error(self, code, message, status):
        self.status = status
        self.payload = {"error": {"code": code, "message": message}}
        return self.payload

    def send_json(self, payload, status=200):
        self.status = status
        self.payload = payload
        return payload


class Req:
    path = ""


class SchedulerRouteFailClosedTest(unittest.TestCase):
    def test_unwired_services_do_not_fabricate_empty_success(self):
        cases = [
            (routes.api_resource_state, SimpleNamespace(resource_state_service=None)),
            (routes.api_assignments, SimpleNamespace(scheduler=None)),
            (routes.api_scheduling_plans, SimpleNamespace(scheduler=None)),
        ]
        for function, ctx in cases:
            with self.subTest(function=function.__name__):
                h = Handler()
                function(ctx, h, Req())
                self.assertEqual(h.status, 503)
                self.assertEqual(h.payload["error"]["code"], "not_ready")

        h = Handler()
        routes.route_sched_requests_list(SimpleNamespace(scheduler=None), h, Req())
        self.assertEqual(h.status, 503)
        self.assertEqual(h.payload["error"]["code"], "not_ready")

    def test_invalid_task_collection_and_number_fields_rejected(self):
        h = Handler()
        routes.api_create_task(
            SimpleNamespace(scheduler=object()),
            h,
            {"required_skills": "operator", "task_type": "搬运"},
        )
        self.assertEqual(h.status, 400)
        self.assertEqual(h.payload["error"]["code"], "invalid_params")
        self.assertIn("required_skills", h.payload["error"]["message"])

        h = Handler()
        routes.api_create_task(
            SimpleNamespace(scheduler=object()), h, {"priority": "high", "task_type": "搬运"}
        )
        self.assertEqual(h.status, 400)
        self.assertEqual(h.payload["error"]["code"], "invalid_params")
        self.assertIn("priority", h.payload["error"]["message"])

        h = Handler()
        routes.api_update_task(
            SimpleNamespace(scheduler=object()), h, "T-1", {"load_level": "heavy", "version": 1}
        )
        self.assertEqual(h.status, 400)
        self.assertEqual(h.payload["error"]["code"], "invalid_params")
        self.assertIn("load_level", h.payload["error"]["message"])

    def test_non_object_task_body_rejected(self):
        h = Handler()
        routes.api_create_task(SimpleNamespace(scheduler=object()), h, ["not", "object"])
        self.assertEqual(h.status, 400)
        self.assertEqual(h.payload["error"]["code"], "invalid_params")


if __name__ == "__main__":
    unittest.main()
