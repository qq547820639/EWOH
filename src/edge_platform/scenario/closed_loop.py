"""A repeatable local factory scenario using the real Edge HTTP and SQLite services."""

import json
import queue
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from http.client import HTTPConnection
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from uuid import uuid4

from edge_platform import server
from edge_platform.edge.storage import Storage
from edge_platform.run import build_scheduler
from edge_platform.scheduler.events import EventBus
from edge_platform.scheduler.repository import SchedulingRepository
from edge_platform.spatial import now_iso
from edge_platform.spatial.topology import Topology, TopologyEdge, TopologyNode
from edge_platform.stubs import seed_base


class SimulatedFactoryStorage(Storage):
    def __init__(self, path):
        super().__init__(path)
        self.seeded_at = now_iso()
        seed_base(self)

    def list_people(self):
        return [
            {**person, "location": {"station_id": "DOCK"}, "source_type": "simulated"}
            for person in super().list_people()
        ]

    def list_devices(self):
        return [
            {**device, "status": "AVAILABLE" if device["online"] else "OFFLINE"}
            for device in super().list_devices()
        ]

    def list_stations(self):
        return [
            {"station_id": "DOCK", "status": "available", "capacity": 1, "current_occupancy": 0},
            {"station_id": "PACKING", "status": "available", "capacity": 1, "current_occupancy": 0},
        ]

    def get_topology(self):
        topology = Topology()
        for station_id in ("DOCK", "PACKING"):
            topology.add_node(TopologyNode(station_id))
        topology.add_edge(TopologyEdge("DOCK", "PACKING", 20))
        return topology

    def people_updated_at(self):
        return self.seeded_at

    def devices_updated_at(self):
        return max(device["last_seen"] for device in self.list_devices())

    def observe_device_fault(self, observation):
        if observation.get("source_type") != "simulated":
            raise ValueError("本场景仅接受显式 simulated 观测")
        timestamp = datetime.fromisoformat(observation["timestamp"].replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            raise ValueError("观测时间必须包含时区")
        age = (datetime.now(timezone.utc) - timestamp).total_seconds()
        if observation.get("quality", {}).get("status") != "good" or age < -5 or age > 60:
            return {"accepted": False, "reason": "数据质量不足或时间过期", "age_seconds": age}
        previous = self.get_event(observation["record_id"])
        if previous:
            if previous["trigger"] != observation:
                raise ValueError("同一观测 ID 的内容冲突")
            return {"accepted": True, "duplicate": True, "event": previous}
        device = next((item for item in self.list_devices() if item["device_id"] == observation["device_id"]), None)
        if device is None:
            raise ValueError("模拟设备不存在")
        self.insert_telemetry(observation)
        self.upsert_device(**{**device, "online": 0, "last_seen": observation["timestamp"]})
        event = {
            "event_id": observation["record_id"], "event_code": "device_fault",
            "severity": "high", "status": "open", "device_id": observation["device_id"],
            "start_time": observation["timestamp"], "source_type": "simulated",
            "trigger": observation, "evidence": {"record_id": observation["record_id"]},
        }
        self.insert_event(event)
        return {"accepted": True, "duplicate": False, "event": event}


@contextmanager
def local_factory():
    with TemporaryDirectory(prefix="ewoh-closed-loop-") as directory:
        storage = SimulatedFactoryStorage(Path(directory) / "simulation.db")
        repository = SchedulingRepository(storage)
        event_bus = EventBus()
        scheduler, resources = build_scheduler(storage, repository, event_bus, mode="simulation")
        context = server.Context(
            storage, scheduler=scheduler, scheduling_repository=repository,
            resource_state_service=resources, event_bus=event_bus, kafka=event_bus,
        )
        httpd = server.build_server(("127.0.0.1", 0), context)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{httpd.server_address[1]}", context
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)
            storage.close()


def run_closed_loop(on_ready=None):
    correlation_id = str(uuid4())
    operations = []
    with local_factory() as (base_url, context):
        def request(method, path, body=None, expected_status=200):
            data = json.dumps(body).encode() if body is not None else None
            connection = HTTPConnection("127.0.0.1", urlsplit(base_url).port, timeout=10)
            try:
                connection.request(
                    method, path, body=data,
                    headers={"Content-Type": "application/json", "X-Request-ID": correlation_id},
                )
                with connection.getresponse() as response:
                    status = response.status
                    payload = json.loads(response.read())
            finally:
                connection.close()
            operations.append({"method": method, "path": path, "status": status, "response": payload})
            if status != expected_status:
                raise RuntimeError(f"{method} {path}: expected {expected_status}, got {status}: {payload}")
            return payload

        task = request("POST", "/api/tasks", {
            "task_type": "故障后恢复搬运", "station_id": "PACKING", "priority": 8,
            "required_skills": ["搬运"], "estimated_duration_sec": 600,
            "earliest_start": now_iso(),
        })["task"]
        context.storage.upsert_assignment(
            assignment_id="SIM-INTERRUPTED", task_id=task["task_id"], person_id="P-001",
            device_id="EXO-001", status="exception",
        )
        observation = {
            "record_id": "SIM-FAULT-001", "device_id": "EXO-001", "timestamp": now_iso(),
            "sequence": 1, "source_type": "simulated", "quality": {"status": "good"},
            "telemetry": {"fault": "drive_unavailable"}, "correlation_id": correlation_id,
        }
        quality = context.storage.observe_device_fault(observation)
        duplicate = context.storage.observe_device_fault(observation)
        affected = sorted({
            assignment["task_id"] for assignment in context.storage.list_assignments()
            if assignment["device_id"] == observation["device_id"] and assignment["status"] == "exception"
        })
        subscription = context.event_bus.subscribe()
        result = request("POST", "/api/scheduling/requests", {
            "task_ids": affected, "trigger_type": "device_fault", "created_by": "sim-dispatcher",
        })
        plan_id = result["plans"][0]["plan_id"]
        request("POST", f"/api/scheduling/plans/{plan_id}/execute", {}, expected_status=409)
        request("POST", f"/api/scheduling/plans/{plan_id}/confirm", {
            "actor_id": "sim-supervisor", "reason": "影子方案禁止直接批准",
        }, expected_status=409)
        evaluated = request("POST", f"/api/scheduling/plans/{plan_id}/simulate", {
            "actor_id": "sim-dispatcher", "reason": "检查备用外骨骼、技能、路径和时间窗",
        })["plan"]
        if evaluated["status"] != "pending_review":
            raise RuntimeError(f"场景评估未通过: {evaluated['constraint_summary']}")
        request("POST", f"/api/scheduling/plans/{plan_id}/confirm", {
            "actor_id": "sim-supervisor", "reason": "模拟授权：使用备用外骨骼恢复搬运",
            "world_state_version": evaluated["world_state_version"],
        })
        assignments = request("POST", f"/api/scheduling/plans/{plan_id}/execute", {})["assignments"]
        if not assignments or any(assignment["device_id"] == "EXO-001" for assignment in assignments):
            raise RuntimeError("派工必须使用已知可用的备用设备")
        for assignment in assignments:
            for action in ("start", "complete"):
                request("POST", f"/api/assignments/{assignment['assignment_id']}/{action}", {
                    "actor_id": "sim-worker", "reason": "加速模拟现场回执",
                })
        feedback_body = {"actor_id": "sim-supervisor", "idempotency_key": correlation_id}
        feedback = request("POST", f"/api/scheduling/plans/{plan_id}/feedback", feedback_body)["feedback"]
        repeated = request("POST", f"/api/scheduling/plans/{plan_id}/feedback", feedback_body)["feedback"]
        if feedback["feedback_id"] != repeated["feedback_id"] or len(context.scheduler.list_feedback()) != 1:
            raise RuntimeError("重复反馈产生了重复记录")
        final_task = request("GET", f"/api/tasks/{task['task_id']}")["task"]
        if final_task["status"] != "completed":
            raise RuntimeError("派工完成后任务事实未收敛")
        events = []
        while True:
            try:
                events.append(subscription.get_nowait())
            except queue.Empty:
                break
        context.event_bus.unsubscribe(subscription)
        restarted, _ = build_scheduler(context.storage, context.scheduling_repository, None, mode="simulation")
        restarted.hydrate_from_repository()
        restored = restarted.list_feedback(plan_id)
        if len(restored) != 1 or restored[0].to_dict() != feedback:
            raise RuntimeError("执行反馈未能从 SQLite 恢复")
        evidence = {
            "schema_version": "1.0.0", "scenario": "device_fault_recovery",
            "source_type": "simulated", "is_simulation": True, "correlation_id": correlation_id,
            "execution_boundary": "local_task_records_only", "status": "completed",
            "observation": observation, "quality": quality, "duplicate_observation": duplicate,
            "affected_task_ids": affected, "candidate_plans": result["plans"],
            "evaluation": evaluated["constraint_summary"]["evaluation"],
            "feedback": feedback, "restored_feedback_count": len(restored),
            "learning": {
                "status": "recorded_for_review", "production_training_eligible": False,
                "note": "加速模拟中的运行时长仅用于验证反馈计算；不能作为生产节拍或模型训练证据。",
            },
            "events": events, "operations": operations,
        }
        if on_ready is not None:
            on_ready(base_url, evidence)
        return evidence
