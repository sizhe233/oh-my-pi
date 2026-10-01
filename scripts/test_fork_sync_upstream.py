#!/usr/bin/env python3
"""Exercise the sync importer against temporary Git repositories, without network."""
from __future__ import annotations

from contextlib import redirect_stdout
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
