from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


def load_workflow_host():
    module_path = Path(__file__).resolve().parents[1] / "workflow_host.py"
    spec = importlib.util.spec_from_file_location("workflow_host_under_test", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakePool:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


class FakeRpc:
    def __init__(self) -> None:
        self.drained = False

    async def drain_notifications(self) -> None:
        self.drained = True


class WorkflowHostTests(unittest.TestCase):
    def tearDown(self) -> None:
        for name in [
            "api",
            "api.runtime_control",
            "api.vm_metrics",
            "api.workflow_engine",
        ]:
            sys.modules.pop(name, None)

    def test_workflow_result_includes_grouping_identifiers(self) -> None:
        host = load_workflow_host()
        pool = FakePool()
        rpc = FakeRpc()

        async def handler(inp, ctx):
            self.assertEqual(inp, {"input": "value"})
            return {"ok": True, "seen_run_id": ctx.run_id}

        registered = host.RegisteredWorkflow(
            workflow_name="sample_workflow",
            source_path="workflows/sample.py",
            handler=handler,
            input_cls=None,
            webhooks=None,
            schedule=None,
        )

        async def create_pool():
            return pool

        with (
            patch.object(
                host,
                "discover_workflows",
                return_value={"sample_workflow": registered},
            ),
            patch.object(host, "create_pool", create_pool),
        ):
            payload = asyncio.run(
                host.run_workflow(
                    {
                        "type": "workflow.start",
                        "workflow_name": "sample_workflow",
                        "run_id": "run-123",
                        "task_id": "task-456",
                        "input": {"input": "value"},
                    },
                    rpc,
                )
            )

        self.assertEqual(
            payload,
            {
                "type": "workflow.result",
                "workflow_run_id": "run-123",
                "run_id": "run-123",
                "workflow_task_id": "task-456",
                "task_id": "task-456",
                "workflow_name": "sample_workflow",
                "result": {"ok": True, "seen_run_id": "run-123"},
            },
        )
        self.assertTrue(rpc.drained)
        self.assertTrue(pool.closed)

    def test_api_compat_marks_existing_api_module_as_package(self) -> None:
        host = load_workflow_host()
        api_module = types.ModuleType("api")
        sys.modules["api"] = api_module

        host.install_api_compat_module()

        self.assertTrue(hasattr(api_module, "__path__"))
        self.assertIs(sys.modules["api.runtime_control"], api_module.runtime_control)
        self.assertIs(sys.modules["api.vm_metrics"], api_module.vm_metrics)
        self.assertEqual(
            host.canonical_json({"b": 1, "a": 2}),
            '{"a":2,"b":1}',
        )


if __name__ == "__main__":
    unittest.main()
