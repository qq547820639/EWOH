from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
REAL_NODE = shutil.which("node")


@pytest.fixture
def chain_repo(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    root = tmp_path / "repo"
    scripts = root / "scripts"
    scripts.mkdir(parents=True)
    app = root / "ewoh-spark-app"
    app.mkdir()
    shutil.copy2(REPO_ROOT / "scripts/e2e-chain.sh", scripts / "e2e-chain.sh")
    shutil.copy2(REPO_ROOT / "ewoh-spark-app/package.json", app / "package.json")
    makefile = (REPO_ROOT / "Makefile").read_text()
    env_file = root / "fixture-env.sh"
    env_file.write_text("")
    (root / "Makefile").write_text(makefile.replace("/tmp/ewoh-e2e-env.sh", str(env_file)))
    binaries = tmp_path / "bin"
    binaries.mkdir()
    stub = f"#!{sys.executable}\n" + '''
import json
import os
import pathlib
import subprocess
import sys

name = pathlib.Path(sys.argv[0]).name
arguments = sys.argv[1:]
trace = pathlib.Path(os.environ["CHAIN_TRACE"])

def record(kind, **details):
    with trace.open("a") as stream:
        stream.write(json.dumps({"kind": kind, **details}) + "\\n")

if name == "npm":
    scenario = arguments[1] if len(arguments) > 1 else ""
    record("scenario", name=scenario)
    code = json.loads(os.environ.get("CHAIN_EXIT_CODES", "{}")).get(scenario, 0)
    print(f"Fixture: 1 PASS / {int(code == 1)} FAIL / {int(code == 2)} SKIP")
    sys.exit(code)
if name == "curl":
    if any("/api/auth/login" in argument for argument in arguments):
        payload = json.loads(arguments[arguments.index("-d") + 1])
        print(json.dumps({"accessToken": payload["username"]}))
    else:
        header = arguments[arguments.index("-H") + 1]
        username = header.removeprefix("Authorization: Bearer ")
        roles = {"admin": ["global_admin"], "approver.li": ["dispatcher"], "worker.zhangwei": ["worker"]}
        print(json.dumps({"roles": roles.get(username, [])}))
    sys.exit(0)
if name == "node" and any("reset-scenario-data.js" in argument for argument in arguments):
    record("reset", mode="seed", owner=os.environ.get("EWOH_DATABASE_URL"), arguments=arguments)
    print("reset-fixture-diagnostic", file=sys.stderr)
    sys.exit(int(os.environ.get("CHAIN_RESET_EXIT", "0")))
if name == "node":
    os.execv(os.environ["CHAIN_REAL_NODE"], [os.environ["CHAIN_REAL_NODE"], *arguments])
if name == "local-reset":
    record("reset", mode="rebuild", owner=os.environ.get("EWOH_DATABASE_URL"), arguments=arguments)
    print("reset-fixture-diagnostic", file=sys.stderr)
    sys.exit(int(os.environ.get("CHAIN_RESET_EXIT", "0")))
raise RuntimeError(name)
'''
    for name in ("node", "npm", "curl", "local-reset"):
        executable = binaries / name
        executable.write_text(stub)
        executable.chmod(0o755)
    (scripts / "local-up.sh").write_text('#!/usr/bin/env bash\nexec local-reset "$@"\n')
    env = {
        "PATH": f"{binaries}:{os.environ['PATH']}",
        "HOME": str(tmp_path),
        "CHAIN_REAL_NODE": str(REAL_NODE),
        "CHAIN_TRACE": str(tmp_path / "trace.jsonl"),
        "EWOH_E2E_LOG_DIR": str(tmp_path / "logs"),
        "EWOH_E2E_BACKEND_URL": "http://127.0.0.1:3199",
        "EWOH_E2E_OWNER_DATABASE_URL": "postgresql://fixture_owner:secret@127.0.0.1:55499/fixture_chain",
        "EWOH_E2E_RUNTIME_DATABASE_URL": "postgresql://fixture_api:secret@127.0.0.1:55499/fixture_chain",
        "EWOH_E2E_ADMIN_PASS": "admin-fixture",
        "EWOH_E2E_OPERATOR_PASS": "approver-fixture",
        "EWOH_E2E_APPROVER_PASS": "approver-fixture",
        "EWOH_E2E_FIELD_PASS": "worker-fixture",
    }
    return root, env


def run_chain(
    chain_repo: tuple[Path, dict[str, str]], *arguments: str, **overrides: str
) -> subprocess.CompletedProcess[str]:
    root, env = chain_repo
    return subprocess.run(
        ["bash", "scripts/e2e-chain.sh", *arguments],
        cwd=root,
        env={**env, **overrides},
        capture_output=True,
        text=True,
        timeout=30,
    )


def events(chain_repo: tuple[Path, dict[str, str]]) -> list[dict]:
    trace = Path(chain_repo[1]["CHAIN_TRACE"])
    return [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []


@pytest.mark.parametrize("legacy", ["0", "1"])
def test_reset_failure_stops_scenarios_and_retains_evidence(chain_repo, legacy):
    result = run_chain(chain_repo, CHAIN_RESET_EXIT="7", E2E_NO_REBUILD=legacy)
    assert result.returncode == 1, result.stdout + result.stderr
    assert not [event for event in events(chain_repo) if event["kind"] == "scenario"]
    assert "reset-fixture-diagnostic" in "".join(
        path.read_text() for path in Path(chain_repo[1]["EWOH_E2E_LOG_DIR"]).rglob("*.log")
    )


def test_skip_produces_nonpassing_exit(chain_repo):
    result = run_chain(chain_repo, CHAIN_EXIT_CODES=json.dumps({"e2e:golden": 2}))
    assert result.returncode == 2, result.stdout + result.stderr


def test_failure_has_priority_over_skip(chain_repo):
    result = run_chain(
        chain_repo, CHAIN_EXIT_CODES=json.dumps({"e2e:golden": 2, "e2e:receipt": 1})
    )
    assert result.returncode == 1, result.stdout + result.stderr


def test_selected_scenarios_reset_before_each_run(chain_repo):
    result = run_chain(chain_repo, "--scenario", "e2e:golden", "--scenario", "e2e:receipt")
    assert result.returncode == 0, result.stdout + result.stderr
    trace = events(chain_repo)
    assert [event["kind"] for event in trace] == ["reset", "scenario", "reset", "scenario"]
    assert [event["name"] for event in trace if event["kind"] == "scenario"] == [
        "e2e:golden", "e2e:receipt"
    ]


@pytest.mark.parametrize("scenario", ["e2e:closed-loop", "e2e:missing", "build", "--help"])
def test_invalid_scenario_is_rejected_before_mutation(chain_repo, scenario):
    result = run_chain(chain_repo, "--scenario", scenario)
    assert result.returncode == 1, result.stdout + result.stderr
    assert events(chain_repo) == []


@pytest.mark.parametrize("legacy", ["0", "1"])
def test_owner_is_required_even_for_legacy_reset(chain_repo, legacy):
    result = run_chain(chain_repo, EWOH_E2E_OWNER_DATABASE_URL="", E2E_NO_REBUILD=legacy)
    assert result.returncode == 1, result.stdout + result.stderr
    assert events(chain_repo) == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"EWOH_E2E_OWNER_DATABASE_URL": "postgresql://owner:secret@factory.example/production"},
        {"EWOH_E2E_OWNER_DATABASE_URL": "postgresql://owner:secret@127.0.0.1:55499/postgres"},
        {"EWOH_E2E_RUNTIME_DATABASE_URL": "postgresql://api:secret@127.0.0.1:55499/other"},
        {"EWOH_E2E_BACKEND_URL": "https://factory.example"},
        {"EWOH_E2E_INGEST_ORG_ID": "invalid-org"},
    ],
)
def test_unsafe_or_mismatched_target_is_rejected(chain_repo, overrides):
    result = run_chain(chain_repo, **overrides)
    assert result.returncode == 1, result.stdout + result.stderr
    assert events(chain_repo) == []


def test_reset_receives_explicit_owner_url(chain_repo):
    result = run_chain(chain_repo, "--scenario", "e2e:golden")
    assert result.returncode == 0, result.stdout + result.stderr
    resets = [event for event in events(chain_repo) if event["kind"] == "reset"]
    assert resets and all(
        event["owner"] == chain_repo[1]["EWOH_E2E_OWNER_DATABASE_URL"] for event in resets
    )


@pytest.mark.parametrize(
    ("target", "scenario"),
    [
        ("e2e-golden-fresh", "e2e:golden"),
        ("e2e-receipt-fresh", "e2e:receipt"),
        ("e2e-agv-fresh", "e2e:agv-transport"),
    ],
)
def test_fresh_targets_use_the_verified_runner(chain_repo, target, scenario):
    root, env = chain_repo
    result = subprocess.run(
        ["make", target], cwd=root, env=env, capture_output=True, text=True, timeout=30
    )
    assert result.returncode == 0, result.stdout + result.stderr
    trace = events(chain_repo)
    assert [event["kind"] for event in trace] == ["reset", "scenario"]
    assert trace[1]["name"] == scenario
    assert "clear-execution-facts" not in result.stdout + result.stderr


def test_package_closed_loop_uses_isolated_scenarios(chain_repo):
    root, env = chain_repo
    app = root / "ewoh-spark-app"
    command = json.loads((app / "package.json").read_text())["scripts"]["e2e:closed-loop"]
    result = subprocess.run(
        ["bash", "-c", command], cwd=app, env=env, capture_output=True, text=True, timeout=30
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert [event["kind"] for event in events(chain_repo)] == [
        "reset", "scenario", "reset", "scenario"
    ]
