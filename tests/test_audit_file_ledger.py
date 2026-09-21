"""Exercise the real audit CLI against disposable repository fixtures."""

import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


class TestAuditFileLedger(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.script = self.root / ".audit-test-tool" / "audit-file-ledger.js"
        self.script.parent.mkdir()
        shutil.copyfile(REPO_ROOT / "scripts" / "audit-file-ledger.js", self.script)
        self.audit = self.root / "docs" / "audit" / "current"
        self.ledger = self.audit / "file-ledger.jsonl"
        self.source = self.write_source("src/example.py", "first\nsecond\nthird\n")

    def write_source(self, relative_path, content):
        destination = self.root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")
        return destination

    def run_cli(self, *arguments):
        return subprocess.run(
            ["node", str(self.script), *map(str, arguments)],
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )

    def rows(self):
        return [json.loads(line) for line in self.ledger.read_text(encoding="utf-8").splitlines()]

    def write_rows(self, rows):
        self.audit.mkdir(parents=True, exist_ok=True)
        self.ledger.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

    def sha256(self):
        return hashlib.sha256(self.source.read_bytes()).hexdigest()

    def reviewed_fixture(self, ranges=None):
        generated = self.run_cli("generate")
        self.assertEqual(generated.returncode, 0, generated.stderr)
        row = self.rows()[0]
        row.update(
            reviewed=True,
            content_sha256=self.sha256(),
            reviewed_sha256=self.sha256(),
            reviewed_ranges=[[1, 3]] if ranges is None else ranges,
            findings=["fixture review evidence"],
        )
        self.write_rows([row])
        return row

    def write_partial(self, rows):
        partial = self.root / "partial.jsonl"
        partial.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        return partial

    def test_generate_hashes_current_bytes_without_claiming_review(self):
        self.assertEqual(self.run_cli("generate").returncode, 0)
        row = self.rows()[0]
        self.assertEqual(row.get("content_sha256"), self.sha256())
        self.assertFalse(row["reviewed"])
        self.assertFalse(row.get("reviewed_sha256"))

    def test_generate_invalidates_unhashed_legacy_review_and_keeps_findings(self):
        row = self.reviewed_fixture()
        row.pop("content_sha256")
        row.pop("reviewed_sha256")
        self.write_rows([row])
        self.assertEqual(self.run_cli("generate").returncode, 0)
        current = self.rows()[0]
        self.assertFalse(current["reviewed"])
        self.assertEqual(current["findings"], row["findings"])
        self.assertNotEqual(self.run_cli("report").returncode, 0)

    def test_generate_keeps_only_unchanged_complete_review(self):
        row = self.reviewed_fixture()
        self.assertEqual(self.run_cli("generate").returncode, 0)
        self.assertTrue(self.rows()[0]["reviewed"])
        self.source.write_text("first\nsecond\nchanged\n", encoding="utf-8")
        self.assertEqual(self.run_cli("generate").returncode, 0)
        current = self.rows()[0]
        self.assertFalse(current["reviewed"])
        self.assertEqual(current["content_sha256"], self.sha256())
        self.assertEqual(current["reviewed_sha256"], row["reviewed_sha256"])
        self.assertEqual(current["findings"], row["findings"])

    def test_report_rechecks_current_content_without_generate(self):
        self.reviewed_fixture()
        self.assertEqual(self.run_cli("report").returncode, 0)
        self.source.write_text("first\nsecond\nchanged\n", encoding="utf-8")
        result = self.run_cli("report")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("stale", result.stdout + (self.audit / "coverage-report.md").read_text())

    def test_report_rejects_unhashed_legacy_review(self):
        row = self.reviewed_fixture()
        row.pop("reviewed_sha256")
        self.write_rows([row])
        self.assertNotEqual(self.run_cli("report").returncode, 0)

    def test_report_rejects_nonempty_ranges_with_missing_lines(self):
        self.reviewed_fixture([[1, 1], [3, 3]])
        result = self.run_cli("report")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("partial_review_files = 0 ✓", (self.audit / "coverage-report.md").read_text())

    def test_internal_symlink_is_audited_once_by_real_target(self):
        target = self.write_source("ui/shared-source.py", "linked\nlines\n")
        (self.root / "src" / "linked.py").symlink_to(target)
        self.assertEqual(self.run_cli("generate").returncode, 0)
        self.assertEqual(
            [row["path"] for row in self.rows()],
            ["src/example.py", "ui/shared-source.py"],
        )

    def test_external_symlink_is_rejected(self):
        outside = self.root.parent / "outside-source.py"
        outside.write_text("external\n", encoding="utf-8")
        self.addCleanup(outside.unlink)
        (self.root / "src" / "external.py").symlink_to(outside)
        result = self.run_cli("generate")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("escapes repository", result.stderr)

    def test_report_uses_range_union_and_accepts_legacy_integer_strings(self):
        self.reviewed_fixture([["2", "3"], [1, 2], [2, 2]])
        result = self.run_cli("report")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_report_rejects_invalid_ranges_even_if_other_range_covers_file(self):
        invalid_ranges = [[[1, 3], [0, 1]], [[1, 4]], [[3, 1]], [[1.5, 3]], [[True, 3]], [[1, 3, 4]]]
        for ranges in invalid_ranges:
            with self.subTest(ranges=ranges):
                self.reviewed_fixture(ranges)
                self.assertNotEqual(self.run_cli("report").returncode, 0)

    def test_report_detects_new_active_files_without_generate(self):
        self.reviewed_fixture()
        self.write_source("src/new.py", "unreviewed\n")
        result = self.run_cli("report")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("src/new.py", (self.audit / "coverage-report.md").read_text())

    def test_report_detects_deleted_files_without_generate(self):
        self.reviewed_fixture()
        self.source.unlink()
        result = self.run_cli("report")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("src/example.py", (self.audit / "coverage-report.md").read_text())

    def test_report_cannot_pass_empty_or_missing_ledger(self):
        self.audit.mkdir(parents=True)
        self.assertNotEqual(self.run_cli("report").returncode, 0)
        self.source.unlink()
        self.write_rows([])
        self.assertNotEqual(self.run_cli("report").returncode, 0)

    def test_merge_requires_current_review_hash_and_complete_valid_ranges(self):
        row = self.reviewed_fixture()
        invalid_patches = [
            {"reviewed_sha256": None},
            {"reviewed_sha256": "0" * 64},
            {"reviewed_ranges": [[1, 1], [3, 3]]},
            {"reviewed_ranges": [[1, 4]]},
            {"reviewed_ranges": [[1, 3], [4, 4]]},
            {"reviewed_ranges": [[3, 1]]},
            {"reviewed_ranges": [[True, 3]]},
            {"content_sha256": "0" * 64},
            {"line_count": 4},
        ]
        for patch in invalid_patches:
            with self.subTest(patch=patch):
                original = self.ledger.read_bytes()
                partial = self.write_partial([{**row, **patch}])
                result = self.run_cli("merge", partial)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(self.ledger.read_bytes(), original)

    def test_merge_cannot_reuse_inherited_hash_to_approve_new_ranges(self):
        self.reviewed_fixture()
        partial = self.write_partial([{"path": "src/example.py", "reviewed": True, "reviewed_ranges": [[1, 3]]}])
        self.assertNotEqual(self.run_cli("merge", partial).returncode, 0)

    def test_merge_rechecks_live_hash_without_generate(self):
        row = self.reviewed_fixture()
        self.source.write_text("first\nsecond\nchanged\n", encoding="utf-8")
        original = self.ledger.read_bytes()
        result = self.run_cli("merge", self.write_partial([row]))
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.ledger.read_bytes(), original)

    def test_merge_accepts_current_review_with_union_covering_all_lines(self):
        self.assertEqual(self.run_cli("generate").returncode, 0)
        partial = self.write_partial(
            [{"path": "src/example.py", "reviewed": True, "reviewed_sha256": self.sha256(),
              "reviewed_ranges": [["2", "3"], [1, 2]]}]
        )
        result = self.run_cli("merge", partial)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.run_cli("report").returncode, 0)

    def test_empty_file_requires_explicit_hash_bound_review(self):
        self.source.write_bytes(b"")
        self.assertEqual(self.run_cli("generate").returncode, 0)
        self.assertNotEqual(self.run_cli("report").returncode, 0)
        row = self.rows()[0]
        row.update(reviewed=True, content_sha256=self.sha256(), reviewed_sha256=self.sha256(), reviewed_ranges=[])
        self.write_rows([row])
        self.assertEqual(self.run_cli("report").returncode, 0)
        row["reviewed_ranges"] = [[1, 1]]
        self.write_rows([row])
        self.assertNotEqual(self.run_cli("report").returncode, 0)

    def test_merge_is_all_or_nothing_for_malformed_or_unknown_rows(self):
        row = self.reviewed_fixture()
        original = self.ledger.read_bytes()
        partial = self.write_partial([{**row, "findings": ["changed"]}])
        with partial.open("a", encoding="utf-8") as stream:
            stream.write("not json\n")
        self.assertNotEqual(self.run_cli("merge", partial).returncode, 0)
        self.assertEqual(self.ledger.read_bytes(), original)
        partial = self.write_partial([{**row, "findings": ["changed"]}, {**row, "path": "src/missing.py"}])
        self.assertNotEqual(self.run_cli("merge", partial).returncode, 0)
        self.assertEqual(self.ledger.read_bytes(), original)

    def test_report_rejects_corrupt_or_duplicate_ledger_records(self):
        row = self.reviewed_fixture()
        self.write_rows([row, row])
        self.assertNotEqual(self.run_cli("report").returncode, 0)
        self.write_rows([row])
        with self.ledger.open("a", encoding="utf-8") as stream:
            stream.write("broken\n")
        self.assertNotEqual(self.run_cli("report").returncode, 0)

    def test_stats_does_not_report_stale_review_as_verified(self):
        self.reviewed_fixture()
        self.source.write_text("first\nsecond\nchanged\n", encoding="utf-8")
        result = self.run_cli("stats")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"(?:^|\s)reviewed=0(?:\s|$)")


if __name__ == "__main__":
    unittest.main()
