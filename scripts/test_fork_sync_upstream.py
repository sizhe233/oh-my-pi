#!/usr/bin/env python3
"""Exercise the sync importer against temporary Git repositories, without network."""
from __future__ import annotations

from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("fork_sync_upstream", Path(__file__).with_name("fork-sync-upstream.py"))
SYNC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SYNC)


class SyncFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fork-sync-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.original_cwd = Path.cwd()
        self.addCleanup(os.chdir, self.original_cwd)
        self.env = patch.dict(os.environ, {
            "PATH": os.environ["PATH"], "HOME": str(self.root),
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
            "GITHUB_REPOSITORY": SYNC.DESTINATION, "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GH_SYNC_TOKEN": "fixture-token-not-a-secret",
        }, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.upstream = self.root / "upstream"
        self.upstream.mkdir()
        self.run_git(self.upstream, "init", "-b", "main")
        self.write(self.upstream, ".github/workflows/common.yml", "fork-safe workflow\n")
        self.write(self.upstream, ".github/workflows/removed.yml", "keep this fork workflow\n")
        self.write(self.upstream, "packages/coding-agent/package.json", '{"version":"1.0.0"}\n')
        self.write(self.upstream, "shared.txt", "base\n")
        self.write(self.upstream, "packages/coding-agent/test/tools/browser-fixture.test.ts", "base test\n")
        self.commit(self.upstream, "common ancestor")
        self.fork = self.root / "fork"
        self.run_git(self.root, "clone", str(self.upstream), str(self.fork))
        self.write(self.fork, ".github/workflows/common.yml", "reviewed fork workflow\n")
        self.write(self.fork, "fork.txt", "fork feature\n")
        self.base = self.commit(self.fork, "fork feature and workflow policy")
        self.remote = self.root / "destination.git"
        self.run_git(self.root, "clone", "--bare", str(self.fork), str(self.remote))
        self.write(self.upstream, ".github/workflows/common.yml", "upstream workflow changes\n")
        self.write(self.upstream, ".github/workflows/new.yml", "unreviewed upstream workflow\n")
        (self.upstream / ".github/workflows/removed.yml").unlink()
        self.write(self.upstream, "packages/coding-agent/package.json", '{"version":"1.1.0"}\n')
        self.write(self.upstream, "upstream.txt", "upstream feature\n")
        self.upstream_sha = self.commit(self.upstream, "stable upstream release")
        self.run_git(self.upstream, "tag", "-a", "v1.1.0", "-m", "official stable release")
        self.tag_sha = self.run_git(self.upstream, "rev-parse", "v1.1.0").stdout.strip()
        self.release = {
            "tag_name": "v1.1.0", "draft": False, "prerelease": False,
            "html_url": "https://github.com/can1357/oh-my-pi/releases/tag/v1.1.0",
            "id": 42, "published_at": "2026-10-01T00:00:00Z",
        }
        self.calls = []
        self.api_calls = []
        self.checkout()
        self.original_git = SYNC.git
        self.git_patch = patch.object(SYNC, "git", side_effect=self.route_git)
        self.git_patch.start()
        self.addCleanup(self.git_patch.stop)
        self.api_patch = patch.object(SYNC, "api", side_effect=self.api)
        self.api_patch.start()
        self.addCleanup(self.api_patch.stop)

    def run_git(self, cwd, *args, check=True):
        return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *args], cwd=cwd,
                              text=True, capture_output=True, check=check)

    def write(self, repo, path, contents):
        destination = repo / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(contents, encoding="utf-8")

    def commit(self, repo, message):
        self.run_git(repo, "add", "--all")
        self.run_git(repo, "commit", "-m", message)
        return self.run_git(repo, "rev-parse", "HEAD").stdout.strip()

    def checkout(self):
        work = self.root / f"work-{len(list(self.root.glob('work-*')))}"
        self.run_git(self.root, "clone", str(self.remote), str(work))
        self.work = work
        os.chdir(work)
        os.environ["GITHUB_SHA"] = self.run_git(work, "rev-parse", "HEAD").stdout.strip()

    def route_git(self, *args, check=True, env=None):
        self.calls.append((args, env))
        replacements = {
            f"https://github.com/{SYNC.UPSTREAM}.git": str(self.upstream),
            f"https://github.com/{SYNC.DESTINATION}.git": str(self.remote),
        }
        return self.original_git(*(replacements.get(arg, arg) for arg in args), check=check, env=env)

    def api(self, path):
        self.api_calls.append(path)
        if path in ("releases/latest", "releases/tags/v1.1.0"):
            return self.release
        if path == "git/ref/tags/v1.1.0":
            return {"object": {"type": "tag", "sha": self.tag_sha}}
        if path == f"git/tags/{self.tag_sha}":
            return {"object": {"type": "commit", "sha": self.upstream_sha}}
        raise AssertionError(f"Unexpected API request: {path}")

    def invoke(self):
        stream = io.StringIO()
        with redirect_stdout(stream):
            SYNC.main()
        return dict(line.split("=", 1) for line in stream.getvalue().splitlines())

    def remote_refs(self):
        return self.run_git(self.remote, "show-ref").stdout

    def assert_no_push(self):
        self.assertFalse(any(args[0] == "push" for args, _ in self.calls))
        self.assertEqual(self.run_git(self.remote, "rev-parse", "main").stdout.strip(), self.base)
        self.assertNotIn("refs/heads/sync/", self.remote_refs())

    def reviewed_conflict(self):
        """Prepare different fork/upstream edits and review a combined UTF-8 result."""
        self.write(self.work, "shared.txt", "fork change\n")
        self.base = self.commit(self.work, "fork shared change")
        self.write(self.upstream, "shared.txt", "upstream change\n")
        self.upstream_sha = self.commit(self.upstream, "upstream shared change")
        self.run_git(self.upstream, "tag", "-f", "v1.1.0")
        self.run_git(self.work, "fetch", str(self.upstream), self.upstream_sha)
        merge_base = self.run_git(self.work, "merge-base", self.base, self.upstream_sha).stdout.strip()
        content = "reviewed fork + upstream change, café\r\n"
        self.review_path = f"{SYNC.RESOLUTIONS}/v1.1.0.json"
        self.review = {
            "schemaVersion": 1, "releaseTag": "v1.1.0", "upstreamSha": self.upstream_sha,
            "mergeBaseSha": merge_base,
            "resolutions": [{
                "path": "shared.txt",
                "mergeBaseBlob": self.run_git(self.work, "rev-parse", f"{merge_base}:shared.txt").stdout.strip(),
                "forkBlob": self.run_git(self.work, "rev-parse", f"{self.base}:shared.txt").stdout.strip(),
                "upstreamBlob": self.run_git(self.work, "rev-parse", f"{self.upstream_sha}:shared.txt").stdout.strip(),
                "content": content, "resolvedSha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            }],
        }
        self.save_review()

    def save_review(self):
        self.write(self.work, self.review_path, json.dumps(self.review, indent=2) + "\n")
        self.publish_fixture_main()

    def publish_fixture_main(self):
        self.base = self.commit(self.work, "review exact conflict inputs and result")
        self.run_git(self.work, "push", "origin", "main")
        os.environ["GITHUB_SHA"] = self.base

    def test_reviewed_conflict_preserves_exact_bytes_history_and_replays_deterministically(self):
        """Reviewed combined bytes are published with audit provenance and reproduce on retries."""
        self.reviewed_conflict()
        self.write(self.work, ".gitattributes", "shared.txt text eol=lf\n")
        self.publish_fixture_main()
        os.environ["GITHUB_STEP_SUMMARY"] = str(self.root / "summary.md")
        output = self.invoke()
        candidate = output["candidate_sha"]
        entry = self.review["resolutions"][0]
        self.assertEqual((self.work / "shared.txt").read_bytes(), entry["content"].encode("utf-8"))
        content = subprocess.run(["git", "show", f"{candidate}:shared.txt"], cwd=self.work,
                                 capture_output=True, check=True).stdout
        self.assertEqual(hashlib.sha256(content).hexdigest(), entry["resolvedSha256"])
        self.assertEqual(self.run_git(self.work, "show", "-s", "--format=%P", candidate).stdout.strip().split(),
                         [self.base, self.upstream_sha])
        self.assertEqual(self.run_git(self.work, "diff", "--name-only", self.base, candidate, "--", SYNC.WORKFLOWS).stdout, "")
        manifest = json.loads(self.run_git(self.work, "show", f"{candidate}:{SYNC.MANIFEST}").stdout)
        source_blob = self.run_git(self.work, "rev-parse", f"{self.base}:{self.review_path}").stdout.strip()
        self.assertEqual(manifest["reviewedConflictResolutions"], {
            "path": self.review_path, "blob": source_blob, "resolvedPaths": ["shared.txt"], "postMergeTestPaths": [],
        })
        summary = (self.root / "summary.md").read_text()
        self.assertIn(source_blob, summary)
        self.assertIn("shared.txt", summary)
        self.checkout()
        self.calls.clear()
        self.assertEqual(self.invoke()["candidate_sha"], candidate)
        self.assertFalse(any(args[0] == "push" for args, _ in self.calls))

    def test_reviewed_conflict_rejects_changed_fork_input_without_publishing(self):
        """A later fork edit cannot be overwritten by an older reviewed resolution."""
        self.reviewed_conflict()
        self.write(self.work, "shared.txt", "new unreviewed fork change\n")
        self.publish_fixture_main()
        with self.assertRaisesRegex(ValueError, "input pin mismatch"):
            self.invoke()
        self.assert_no_push()
        self.assertEqual((self.work / "shared.txt").read_text(), "new unreviewed fork change\n")

    def test_reviewed_conflict_rejects_altered_release_and_merge_base_pins(self):
        """Approval for one release or ancestor cannot be reused against another."""
        self.reviewed_conflict()
        for field in ("releaseTag", "upstreamSha", "mergeBaseSha"):
            with self.subTest(field=field):
                original = self.review[field]
                self.review[field] = "v9.9.9" if field == "releaseTag" else "0" * 40
                self.save_review()
                with self.assertRaisesRegex(ValueError, "release or merge-base pin mismatch"):
                    self.invoke()
                self.assert_no_push()
                self.review[field] = original

    def test_reviewed_conflict_rejects_altered_input_pins_and_output_hash(self):
        """Input blob identity and reviewed output bytes are both mandatory before writing."""
        self.reviewed_conflict()
        entry = self.review["resolutions"][0]
        for field in ("mergeBaseBlob", "forkBlob", "upstreamBlob", "resolvedSha256"):
            with self.subTest(field=field):
                original = entry[field]
                entry[field] = "0" * (64 if field == "resolvedSha256" else 40)
                self.save_review()
                with self.assertRaisesRegex(ValueError, "pin mismatch|hash mismatch"):
                    self.invoke()
                self.assert_no_push()
                entry[field] = original

    def test_reviewed_conflict_rejects_extra_conflicts_and_aborts(self):
        """An unreviewed application conflict stops the whole merge, including reviewed paths."""
        self.reviewed_conflict()
        self.write(self.work, "extra.txt", "fork extra\n")
        self.publish_fixture_main()
        self.write(self.upstream, "extra.txt", "upstream extra\n")
        self.upstream_sha = self.commit(self.upstream, "additional conflicting file")
        self.run_git(self.upstream, "tag", "-f", "v1.1.0")
        self.review["upstreamSha"] = self.upstream_sha
        self.save_review()
        with self.assertRaisesRegex(RuntimeError, "conflict set mismatch"):
            self.invoke()
        self.assert_no_push()
        self.assertFalse((self.work / ".git/MERGE_HEAD").exists())
        self.assertEqual((self.work / "shared.txt").read_text(), "fork change\n")

    def test_reviewed_conflict_rejects_missing_conflicts(self):
        """A resolution whose target no longer conflicts cannot overwrite an ordinary merge."""
        self.reviewed_conflict()
        self.write(self.upstream, "shared.txt", "fork change\n")
        self.upstream_sha = self.commit(self.upstream, "upstream independently agrees with fork")
        self.run_git(self.upstream, "tag", "-f", "v1.1.0")
        self.review["upstreamSha"] = self.upstream_sha
        self.review["resolutions"][0]["upstreamBlob"] = self.review["resolutions"][0]["forkBlob"]
        self.save_review()
        with self.assertRaisesRegex(RuntimeError, "conflict set mismatch"):
            self.invoke()
        self.assert_no_push()
        self.assertFalse((self.work / ".git/MERGE_HEAD").exists())

    def test_resolution_data_is_read_from_trusted_base_not_imported_tree(self):
        """Upstream cannot replace trusted review contents during the merge."""
        self.reviewed_conflict()
        self.write(self.upstream, self.review_path, '{"unreviewed":"replacement"}\n')
        self.upstream_sha = self.commit(self.upstream, "upstream attempts to replace review data")
        self.run_git(self.upstream, "tag", "-f", "v1.1.0")
        self.review["upstreamSha"] = self.upstream_sha
        self.save_review()
        with self.assertRaisesRegex(RuntimeError, "conflict set mismatch"):
            self.invoke()
        self.assert_no_push()
        self.assertEqual(json.loads((self.work / self.review_path).read_text()), self.review)

    def test_upstream_only_resolution_data_cannot_authorize_conflicts(self):
        """A resolution introduced by upstream has no authority in the write-capable importer."""
        self.reviewed_conflict()
        self.write(self.upstream, self.review_path, json.dumps(self.review))
        self.upstream_sha = self.commit(self.upstream, "upstream-only review data")
        self.run_git(self.upstream, "tag", "-f", "v1.1.0")
        (self.work / self.review_path).unlink()
        self.publish_fixture_main()
        with self.assertRaisesRegex(RuntimeError, "Manual conflict resolution required"):
            self.invoke()
        self.assert_no_push()

    def test_reviewed_resolution_rejects_unsafe_and_reserved_paths(self):
        """Review data cannot write outside the checkout or authorize workflow/policy changes."""
        self.reviewed_conflict()
        entry = self.review["resolutions"][0]
        for path in ("../escape", "/tmp/escape", "packages/./escape", "packages//escape", "packages\\escape", ".git/config", SYNC.WORKFLOWS + "/ci.yml", SYNC.MANIFEST, self.review_path):
            with self.subTest(path=path):
                entry["path"] = path
                self.save_review()
                with self.assertRaisesRegex(ValueError, "Unsafe reviewed resolution path"):
                    self.invoke()
                self.assert_no_push()

    def test_reviewed_resolution_rejects_executable_and_symlink_input_modes(self):
        """Matching content hashes cannot authorize executable or symlink conflict targets."""
        self.reviewed_conflict()
        (self.work / "shared.txt").chmod(0o755)
        self.publish_fixture_main()
        with self.assertRaisesRegex(ValueError, "regular 100644 blob"):
            self.invoke()
        self.assert_no_push()
        (self.work / "shared.txt").unlink()
        target = self.root / "must-not-overwrite.txt"
        target.write_text("untouched\n")
        (self.work / "shared.txt").symlink_to(target)
        self.publish_fixture_main()
        with self.assertRaisesRegex(ValueError, "regular 100644 blob"):
            self.invoke()
        self.assert_no_push()
        self.assertEqual(target.read_text(), "untouched\n")

    def test_reviewed_resolution_rejects_duplicate_paths_and_unknown_fields(self):
        """An ambiguous target or non-schema directive cannot expand a reviewed operation."""
        self.reviewed_conflict()
        self.review["resolutions"].append(dict(self.review["resolutions"][0]))
        self.save_review()
        with self.assertRaisesRegex(ValueError, "Duplicate reviewed resolution path"):
            self.invoke()
        self.assert_no_push()
        self.review["resolutions"].pop()
        self.review["resolutions"][0]["command"] = "do not execute"
        self.save_review()
        with self.assertRaisesRegex(ValueError, "Invalid reviewed resolution entry"):
            self.invoke()
        self.assert_no_push()

    def test_reviewed_resolution_checks_checkout_symlinks_after_merge(self):
        """Even matching regular Git blobs never authorize following a checkout symlink."""
        self.reviewed_conflict()
        target = self.root / "must-not-overwrite.txt"
        target.write_text("untouched\n")

        def replace_checkout(*args, check=True, env=None):
            result = self.route_git(*args, check=check, env=env)
            if "merge" in args and "--no-commit" in args:
                (self.work / "shared.txt").unlink()
                (self.work / "shared.txt").symlink_to(target)
            return result

        with patch.object(SYNC, "git", side_effect=replace_checkout):
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                self.invoke()
        self.assertEqual(target.read_text(), "untouched\n")
        self.assert_no_push()
        self.assertFalse((self.work / ".git/MERGE_HEAD").exists())

    def test_reviewed_resolution_data_must_be_regular_nonexecutable_blob(self):
        """A review file itself cannot be executable or a symlink to another source."""
        self.reviewed_conflict()
        (self.work / self.review_path).chmod(0o755)
        self.publish_fixture_main()
        with self.assertRaisesRegex(ValueError, "regular 100644 blob"):
            self.invoke()
        self.assert_no_push()
        (self.work / self.review_path).unlink()
        (self.work / self.review_path).symlink_to(self.root / "outside-review.json")
        self.publish_fixture_main()
        with self.assertRaisesRegex(ValueError, "regular 100644 blob"):
            self.invoke()
        self.assert_no_push()

    def reviewed_post_merge_tests(self):
        self.reviewed_conflict()
        paths = ["packages/coding-agent/test/tools/browser-fixture.test.ts",
                 "packages/coding-agent/test/tools/browser-added.test.ts"]
        for path in paths:
            self.write(self.upstream, path, "upstream regression test\n")
        self.upstream_sha = self.commit(self.upstream, "upstream browser test changes")
        self.run_git(self.upstream, "tag", "-f", "v1.1.0")
        self.review["upstreamSha"] = self.upstream_sha
        self.review["postMergeTests"] = []
        for path in paths:
            content = "upstream regression test\nreviewed fork regression test\n"
            self.review["postMergeTests"].append({
                "path": path,
                "mergedBlob": self.run_git(self.upstream, "rev-parse", f"HEAD:{path}").stdout.strip(),
                "content": content,
                "resolvedSha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            })
        self.save_review()

    def test_reviewed_post_merge_tests_preserve_pinned_automatic_merge_and_replay(self):
        """Reviewed regression coverage may extend exact cleanly merged browser tests."""
        self.reviewed_post_merge_tests()
        os.environ["GITHUB_STEP_SUMMARY"] = str(self.root / "summary.md")
        candidate = self.invoke()["candidate_sha"]
        manifest = json.loads(self.run_git(self.work, "show", f"{candidate}:{SYNC.MANIFEST}").stdout)
        self.assertEqual(manifest["reviewedConflictResolutions"]["postMergeTestPaths"],
                         sorted(entry["path"] for entry in self.review["postMergeTests"]))
        self.assertEqual(manifest["reviewedConflictResolutions"]["resolvedPaths"], ["shared.txt"])
        summary = (self.root / "summary.md").read_text()
        for entry in self.review["postMergeTests"]:
            self.assertEqual(self.run_git(self.work, "show", f"{candidate}:{entry['path']}").stdout, entry["content"])
            self.assertIn(entry["path"], summary)
        self.checkout()
        self.calls.clear()
        self.assertEqual(self.invoke()["candidate_sha"], candidate)
        self.assertFalse(any(args[0] == "push" for args, _ in self.calls))

    def test_reviewed_post_merge_tests_reject_changed_staged_blob_before_any_write(self):
        """Test approval for different automatic merge bytes aborts every reviewed write."""
        self.reviewed_post_merge_tests()
        self.review["postMergeTests"][0]["mergedBlob"] = "0" * 40
        self.save_review()
        with self.assertRaisesRegex(RuntimeError, "staged blob or mode mismatch"):
            self.invoke()
        self.assert_no_push()
        self.assertFalse((self.work / ".git/MERGE_HEAD").exists())
        self.assertEqual((self.work / "shared.txt").read_text(), "fork change\n")

    def test_reviewed_post_merge_tests_reject_unrelated_paths_and_duplicate_targets(self):
        """The post-merge exception cannot edit production code or duplicate a test target."""
        self.reviewed_post_merge_tests()
        entry = self.review["postMergeTests"][0]
        original_path = entry["path"]
        entry["path"] = "packages/coding-agent/src/tools/browser/browser-fixture.test.ts"
        self.save_review()
        with self.assertRaisesRegex(ValueError, "post-merge test path"):
            self.invoke()
        self.assert_no_push()
        entry["path"] = original_path
        self.review["postMergeTests"].append(dict(entry))
        self.save_review()
        with self.assertRaisesRegex(ValueError, "post-merge test path"):
            self.invoke()
        self.assert_no_push()

    def test_reviewed_post_merge_tests_reject_executable_mode_and_changed_output(self):
        """Post-merge test edits require both regular stage-zero mode and exact reviewed output."""
        self.reviewed_post_merge_tests()
        entry = self.review["postMergeTests"][0]
        original_content = entry["content"]
        entry["content"] = "unreviewed replacement\n"
        self.save_review()
        with self.assertRaisesRegex(ValueError, "content hash mismatch"):
            self.invoke()
        self.assert_no_push()
        entry["content"] = original_content
        (self.upstream / entry["path"]).chmod(0o755)
        self.upstream_sha = self.commit(self.upstream, "upstream executable mode")
        self.run_git(self.upstream, "tag", "-f", "v1.1.0")
        self.review["upstreamSha"] = self.upstream_sha
        self.save_review()
        with self.assertRaisesRegex(RuntimeError, "staged blob or mode mismatch"):
            self.invoke()
        self.assert_no_push()

    def test_merge_preserves_history_fork_files_workflow_boundary_and_scoped_push(self):
        """Consumers get the exact two-parent source merge, without enabling upstream CI."""
        output = self.invoke()
        candidate = output["candidate_sha"]
        self.assertEqual(output["changed"], "true")
        self.assertEqual(self.run_git(self.remote, "show", "-s", "--format=%P", candidate).stdout.strip().split(),
                         [self.base, self.upstream_sha])
        self.assertEqual(self.run_git(self.remote, "show", f"{candidate}:fork.txt").stdout, "fork feature\n")
        self.assertEqual(self.run_git(self.remote, "show", f"{candidate}:upstream.txt").stdout, "upstream feature\n")
        self.assertEqual(self.run_git(self.remote, "diff", "--name-only", self.base, candidate, "--", SYNC.WORKFLOWS).stdout, "")
        manifest = json.loads(self.run_git(self.remote, "show", f"{candidate}:{SYNC.MANIFEST}").stdout)
        self.assertEqual(manifest["upstreamSha"], self.upstream_sha)
        self.assertEqual(set(manifest["upstreamWorkflowChanges"]), {
            "M\t.github/workflows/common.yml", "A\t.github/workflows/new.yml", "D\t.github/workflows/removed.yml"})
        self.assertEqual(self.run_git(self.remote, "rev-parse", "main").stdout.strip(), self.base)
        self.assertEqual(self.run_git(self.remote, "rev-parse", "sync/upstream-v1.1.0").stdout.strip(), candidate)
        self.assertNotIn("refs/tags/", self.remote_refs())
        pushes = [(args, env) for args, env in self.calls if args[0] == "push"]
        self.assertEqual(len(pushes), 1)
        args, environment = pushes[0]
        self.assertEqual(args, ("push", f"https://github.com/{SYNC.DESTINATION}.git", f"{candidate}:refs/heads/sync/upstream-v1.1.0"))
        self.assertEqual(environment["GIT_CONFIG_KEY_0"], f"http.https://github.com/{SYNC.DESTINATION}.git.extraheader")
        self.assertFalse(any(env is not None for command, env in self.calls if command[0] != "push"))

    def test_manual_retry_reuses_exact_candidate_and_schedule_skips_rebuild(self):
        """Retries preserve the published SHA and do not rewrite or rebuild a scheduled candidate."""
        original = self.invoke()["candidate_sha"]
        self.checkout()
        self.calls.clear()
        retried = self.invoke()
        self.assertEqual(retried["candidate_sha"], original)
        self.assertEqual(retried["changed"], "true")
        self.assertFalse(any(args[0] == "push" for args, _ in self.calls))
        self.checkout()
        os.environ["GITHUB_EVENT_NAME"] = "schedule"
        self.assertEqual(self.invoke()["changed"], "false")
        self.assertEqual(self.run_git(self.remote, "rev-parse", "sync/upstream-v1.1.0").stdout.strip(), original)

    def test_code_conflict_aborts_merge_without_publishing(self):
        """An overlapping application change is surfaced for review, never guessed or pushed."""
        self.write(self.work, "shared.txt", "fork change\n")
        self.base = self.commit(self.work, "fork shared change")
        self.run_git(self.work, "push", "origin", "main")
        os.environ["GITHUB_SHA"] = self.base
        self.write(self.upstream, "shared.txt", "upstream change\n")
        self.upstream_sha = self.commit(self.upstream, "upstream shared change")
        self.run_git(self.upstream, "tag", "-f", "v1.1.0")
        with self.assertRaisesRegex(RuntimeError, "Manual conflict resolution required: shared.txt"):
            self.invoke()
        self.assert_no_push()
        self.assertFalse((self.work / ".git/MERGE_HEAD").exists())
        self.assertEqual((self.work / "shared.txt").read_text(), "fork change\n")

    def test_dirty_checkout_and_wrong_ref_are_rejected_before_remote_access(self):
        """Local edits and non-main execution cannot become imported trusted commits."""
        self.write(self.work, "untracked.txt", "local data\n")
        with self.assertRaisesRegex(RuntimeError, "clean checkout"):
            self.invoke()
        self.assertFalse(self.api_calls)
        self.assert_no_push()
        (self.work / "untracked.txt").unlink()
        os.environ["GITHUB_REF"] = "refs/heads/sync/untrusted"
        self.calls.clear()
        with self.assertRaisesRegex(RuntimeError, "trusted main"):
            self.invoke()
        self.assertFalse(self.calls)

    def test_stale_main_is_rejected_before_upstream_lookup(self):
        """A queued run cannot create a candidate that silently omits a newer fork commit."""
        self.write(self.fork, "later.txt", "new main\n")
        newer = self.commit(self.fork, "main advanced")
        self.run_git(self.fork, "push", str(self.remote), "main")
        with self.assertRaisesRegex(RuntimeError, "Main advanced"):
            self.invoke()
        self.assertFalse(self.api_calls)
        self.assertFalse(any(args[0] == "push" for args, _ in self.calls))
        self.assertEqual(self.run_git(self.remote, "rev-parse", "main").stdout.strip(), newer)

    def test_moved_tag_and_mismatched_package_version_stop_without_pushing(self):
        """Release metadata cannot identify one commit while Git imports another version."""
        old_sha = self.upstream_sha
        self.write(self.upstream, "later.txt", "tag replacement\n")
        actual_sha = self.commit(self.upstream, "move tag")
        self.run_git(self.upstream, "tag", "-f", "v1.1.0")
        with self.assertRaisesRegex(RuntimeError, "Release tag moved"):
            self.invoke()
        self.assert_no_push()
        self.upstream_sha = actual_sha
        self.write(self.upstream, "packages/coding-agent/package.json", '{"version":"9.9.9"}\n')
        self.upstream_sha = self.commit(self.upstream, "wrong package version")
        self.run_git(self.upstream, "tag", "-f", "v1.1.0")
        with self.assertRaisesRegex(RuntimeError, "package version"):
            self.invoke()
        self.assert_no_push()
        self.assertNotEqual(old_sha, self.upstream_sha)

    def test_release_already_in_main_is_a_read_only_noop(self):
        """An already imported release does not create another branch or rebuild."""
        candidate = self.invoke()["candidate_sha"]
        self.run_git(self.remote, "update-ref", "refs/heads/main", candidate)
        self.checkout()
        self.calls.clear()
        result = self.invoke()
        self.assertEqual(result["changed"], "false")
        self.assertNotIn("candidate_sha", result)
        self.assertFalse(any(args[0] == "push" for args, _ in self.calls))

    def test_existing_nonmerge_branch_is_never_overwritten(self):
        """A name collision with a user branch stops instead of force-pushing."""
        self.run_git(self.remote, "update-ref", "refs/heads/sync/upstream-v1.1.0", self.base)
        with self.assertRaisesRegex(RuntimeError, "exact fork and upstream parents"):
            self.invoke()
        self.assertFalse(any(args[0] == "push" for args, _ in self.calls))
        self.assertEqual(self.run_git(self.remote, "rev-parse", "sync/upstream-v1.1.0").stdout.strip(), self.base)

    def test_forged_existing_candidate_tree_is_rejected_even_with_valid_parents(self):
        """Matching provenance cannot authorize unrelated source changes on an existing branch."""
        candidate = self.invoke()["candidate_sha"]
        self.write(self.work, "fork.txt", "forged feature replacement\n")
        self.run_git(self.work, "add", "fork.txt")
        self.run_git(self.work, "commit", "--amend", "--no-edit")
        forged = self.run_git(self.work, "rev-parse", "HEAD").stdout.strip()
        self.run_git(self.work, "push", str(self.remote), f"{forged}:refs/fixture/forged")
        self.run_git(self.remote, "update-ref", "refs/heads/sync/upstream-v1.1.0", forged)
        self.checkout()
        self.calls.clear()
        with self.assertRaisesRegex(RuntimeError, "reproducible merge tree"):
            self.invoke()
        self.assertNotEqual(candidate, forged)
        self.assertFalse(any(args[0] == "push" for args, _ in self.calls))
        self.assertEqual(self.run_git(self.remote, "rev-parse", "sync/upstream-v1.1.0").stdout.strip(), forged)

    def test_repository_hooks_do_not_execute_in_write_job(self):
        """Git merge and commit cannot execute a hook while the importer holds its token."""
        marker = self.root / "hook-ran"
        for name in ("pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-merge"):
            hook = self.work / ".git/hooks" / name
            hook.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 1\n")
            hook.chmod(0o755)
        for key in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"):
            os.environ.pop(key)
        self.assertEqual(self.invoke()["changed"], "true")
        self.assertFalse(marker.exists())

    def test_manifest_symlink_cannot_write_outside_checkout(self):
        """An imported symlink cannot redirect trusted manifest writes into another file."""
        target = self.root / "must-not-change.txt"
        target.write_text("untouched\n")
        (self.upstream / SYNC.MANIFEST).symlink_to(target)
        self.upstream_sha = self.commit(self.upstream, "malicious manifest path")
        self.run_git(self.upstream, "tag", "-f", "v1.1.0")
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            self.invoke()
        self.assertEqual(target.read_text(), "untouched\n")
        self.assert_no_push()

    def test_prerelease_and_invalid_explicit_tags_cannot_reach_git(self):
        """The stable-only contract rejects prereleases and shell-like tag input."""
        self.release["prerelease"] = True
        with self.assertRaisesRegex(ValueError, "not an official stable"):
            self.invoke()
        self.assert_no_push()
        self.api_calls.clear()
        os.environ["RELEASE_TAG"] = "v1.1.0;echo unsafe"
        with self.assertRaisesRegex(ValueError, "Only official stable"):
            self.invoke()
        self.assertFalse(self.api_calls)
        self.assert_no_push()


if __name__ == "__main__":
    unittest.main(verbosity=2)
