"""Behavioral gates for the local launcher using disposable command doubles."""

import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "local-up.sh"


class TestLocalUp(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.script = self.root / "scripts" / "local-up.sh"
        self.script.parent.mkdir()
        shutil.copyfile(SCRIPT, self.script)
        self.script.chmod(self.script.stat().st_mode | stat.S_IXUSR)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.app = self.root / "ewoh-spark-app"
        self.app.mkdir()
        self.calls = self.root / "calls.log"
        self.calls.touch()
        self.pid_file = self.root / "server.pid"
        self.write_script(
            "standalone-chain.js",
            'const mode = process.argv[2]; if (mode === "--verify") console.log("VERIFY OK");\n',
        )
        self.write_script("run_migrations.js", ";\n")
        self.write_script(
            "create-operator.js",
            'require("fs").appendFileSync(process.env.CALLS, '
            '`create-operator ${process.argv.slice(2).join(" ")}\\n`);\n',
        )
        self.node_bin = shutil.which("node")
        self.write_executable("curl", '#!/bin/sh\nprintf 200\n')
        self.write_executable("lsof", "#!/bin/sh\nexit 0\n")
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "EWOH_TEST_NODE_BIN": self.node_bin,
            "PG_CONTAINER": "fixture-pg",
            "PG_DB": "fixture_ewoh",
            "EWOH_DATABASE_URL": "postgresql://ewoh_owner:secret@127.0.0.1:55498/fixture_ewoh",
            "EWOH_LOCAL_UP_PID_FILE": str(self.pid_file),
            "CALLS": str(self.calls),
        }

    def write_executable(self, name, body):
        path = self.bin / name
        path.write_text(body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        return path

    def write_script(self, relative, body):
        destination = self.root / "db" / "runner" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(body)
        destination.chmod(destination.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    def run_local_up(self, *arguments):
        return subprocess.run(
            [str(self.script), *arguments], cwd=self.root, env=self.env,
            text=True, capture_output=True, timeout=10, check=False,
        )

    def docker_fixture(self):
        self.write_executable("docker", '''#!/bin/sh
echo "docker $*" >> "$CALLS"
case "$1 $2" in
  "inspect fixture-pg") case "$3" in -f) echo running;; *) exit 0;; esac ;;
  "run -d") : ;;
  "exec fixture-pg") case "$3" in
    pg_isready) exit 0 ;;
    psql) echo 1 ;;
  esac ;;
esac
''')

    def test_rejects_database_identifier_injection_before_docker(self):
        self.env["EWOH_DATABASE_URL"] = (
            "postgresql://owner:secret@127.0.0.1:55498/"
            "fixture_ewoh%3B%20DROP%20SCHEMA%20public"
        )
        result = self.run_local_up("--no-server")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("受限 SQL 标识符", result.stderr)
        self.assertFalse((self.root / "bin" / "docker").exists())

    def test_no_server_is_idempotent_and_keeps_database_explicit(self):
        self.docker_fixture()
        result = self.run_local_up("--no-server")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("create-operator --username approver.li", self.calls.read_text())
        self.assertIn("create-operator --username worker.zhangwei", self.calls.read_text())

    def test_operator_failure_stops_startup(self):
        self.docker_fixture()
        self.write_script(
            "create-operator.js",
            'require("fs").appendFileSync(process.env.CALLS, '
            '`create-operator ${process.argv.slice(2).join(" ")}\\n`); process.exit(2);\n',
        )
        result = self.run_local_up("--no-server")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("创建账号 approver.li 失败", result.stderr)
        self.assertNotIn("worker.zhangwei", self.calls.read_text())

    def test_readiness_failure_reports_dead_process_and_stops(self):
        self.docker_fixture()
        self.write_script("create-operator.js", ";\n")
        self.write_executable("node", '''#!/bin/sh
if [ "$1" = "dist/server/main.js" ]; then
  echo "node $*" >> "$CALLS"
  exit 17
fi
exec "$EWOH_TEST_NODE_BIN" "$@"
''')
        result = self.run_local_up("--skip-build")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("服务进程退出", result.stderr)
        self.assertIn("node dist/server/main.js", self.calls.read_text())

    def test_refuses_to_kill_unrelated_recorded_process(self):
        self.docker_fixture()
        unrelated = subprocess.Popen(["/bin/sleep", "30"])
        self.addCleanup(unrelated.kill)
        self.addCleanup(unrelated.wait)
        self.pid_file.write_text(str(unrelated.pid))
        result = self.run_local_up("--skip-build")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("拒绝终止", result.stderr)
        self.assertEqual(unrelated.poll(), None)


if __name__ == "__main__":
    unittest.main()
