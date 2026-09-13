"""Demo simulator shutdown, repeated start/stop, and restart regressions."""

import threading
import unittest
from unittest.mock import Mock

from edge_platform.stubs import DemoSimulator


class DemoSimulatorLifecycleTest(unittest.TestCase):
    def test_start_is_idempotent_and_stop_joins_pending_writes(self):
        writing = threading.Event()
        release_write = threading.Event()
        stopped = threading.Event()
        workers = []
        storage = Mock()

        def insert_telemetry(message):
            workers.append(threading.current_thread())
            writing.set()
            release_write.wait(2)

        storage.insert_telemetry.side_effect = insert_telemetry
        simulator = DemoSimulator(storage, device_ids=("device",), hz=100)
        stopper = threading.Thread(target=lambda: (simulator.stop(), stopped.set()))
        try:
            simulator.start()
            self.assertTrue(writing.wait(2))
            simulator.start()
            stopper.start()
            self.assertFalse(stopped.wait(0.05), "stop must wait for pending storage writes")
            release_write.set()
            self.assertTrue(stopped.wait(2))
            self.assertEqual(storage.insert_telemetry.call_count, 1)
            self.assertEqual(storage.insert_inference.call_count, 1)
            self.assertTrue(all(not worker.is_alive() for worker in workers))
        finally:
            release_write.set()
            simulator.stop()
            if stopper.ident is not None:
                stopper.join(2)
            for worker in workers:
                worker.join(2)

    def test_stop_before_start_and_restart_keep_one_worker(self):
        written = threading.Event()
        storage = Mock()
        storage.insert_inference.side_effect = lambda message: written.set()
        simulator = DemoSimulator(storage, device_ids=("device",), hz=100)
        simulator.stop()
        simulator.stop()
        try:
            simulator.start()
            self.assertTrue(written.wait(2), "start must reset a previous stop")
            simulator.stop()
            first_sequence = storage.insert_telemetry.call_args.args[0]["sequence"]
            written.clear()
            simulator.start()
            self.assertTrue(written.wait(2), "a stopped simulator must restart")
            simulator.stop()
            self.assertGreater(storage.insert_telemetry.call_args.args[0]["sequence"], first_sequence)
            self.assertTrue(all(call.args[0]["source_type"] == "simulated" for call in storage.insert_telemetry.call_args_list))
        finally:
            simulator.stop()

    def test_stop_interrupts_long_sampling_wait(self):
        written = threading.Event()
        storage = Mock()
        storage.insert_event.side_effect = lambda message: written.set()
        simulator = DemoSimulator(storage, device_ids=("device",), hz=0.01)
        try:
            simulator.start()
            self.assertTrue(written.wait(2))
            worker = simulator._thread
            simulator.stop()
            self.assertFalse(worker.is_alive())
        finally:
            simulator.stop()
