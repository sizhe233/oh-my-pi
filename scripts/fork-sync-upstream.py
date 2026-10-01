#!/usr/bin/env python3
"""Import one official stable release without executing imported project code.

Run only from the trusted default-branch workflow. The only remote write is a
non-forced push to a sync/upstream-* branch; PRs and main merges are separate.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

UPSTREAM = "can1357/oh-my-pi"
DESTINATION = "sizhe233/oh-my-pi"
WORKFLOWS = ".github/workflows"
MANIFEST = ".github/upstream-sync.json"
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
TAG_PATTERN = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")


def git(*args: str, check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", *args],
        check=check, text=True, capture_output=True, env=env,
    )


def output(key: str, value: str) -> None:
    if "\n" in value or "\r" in value:
        raise ValueError("Invalid multiline workflow output")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as handle:
            handle.write(f"{key}={value}\n")
    print(f"{key}={value}")


def api(path: str) -> dict:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{UPSTREAM}/{path}",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "omp-fork-stable-sync"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def release_info(requested_tag: str = "") -> tuple[dict, str]:
    if requested_tag and not TAG_PATTERN.fullmatch(requested_tag):
        raise ValueError("Only official stable vMAJOR.MINOR.PATCH tags are accepted")
    release = api(f"releases/tags/{requested_tag}" if requested_tag else "releases/latest")
    tag = release.get("tag_name", "")
    if release.get("draft") or release.get("prerelease") or not TAG_PATTERN.fullmatch(tag):
        raise ValueError("Release is not an official stable version")
    if requested_tag and tag != requested_tag:
        raise ValueError("Release tag mismatch")
    obj = api(f"git/ref/tags/{tag}")["object"]
    for _ in range(8):
        if obj["type"] == "commit":
            sha = obj["sha"]
            if not SHA_PATTERN.fullmatch(sha):
                raise ValueError("Malformed upstream commit SHA")
            return release, sha
        if obj["type"] != "tag":
            raise ValueError("Release tag does not resolve to a commit")
        obj = api(f"git/tags/{obj['sha']}")["object"]
    raise ValueError("Too many annotated tag layers")


def is_ancestor(older: str, newer: str) -> bool:
    result = git("merge-base", "--is-ancestor", older, newer, check=False)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr)
    return result.returncode == 0


def restore_workflows(base: str) -> None:
    # Restore the complete path, including deletions of newly introduced workflows.
    # The original upstream workflow bytes remain inspectable in the second parent.
    git("restore", f"--source={base}", "--staged", "--worktree", "--", WORKFLOWS)
    if git("diff", "--cached", "--name-only", base, "--", WORKFLOWS).stdout.strip():
        raise RuntimeError("Fork workflow boundary changed")


def prepare_merge(base: str, upstream_sha: str, release: dict, branch: str) -> str:
    tag = release["tag_name"]
    merge_base = git("merge-base", base, upstream_sha).stdout.strip()
    workflow_delta = git("diff", "--name-status", merge_base, upstream_sha, "--", WORKFLOWS).stdout.splitlines()
    git("switch", "--create", branch, base)
    result = git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "merge", "--no-commit", "--no-ff", upstream_sha, check=False)
    conflicts = git("diff", "--name-only", "--diff-filter=U", "-z").stdout.split("\0")
    conflicts = [path for path in conflicts if path]
    outside = [path for path in conflicts if not path.startswith(WORKFLOWS + "/")]
    if outside:
        git("merge", "--abort", check=False)
        raise RuntimeError("Manual conflict resolution required: " + ", ".join(outside))
    if result.returncode and not conflicts:
        git("merge", "--abort", check=False)
        raise RuntimeError(result.stderr or result.stdout)
    restore_workflows(base)
    manifest = {
        "schemaVersion": 1,
        "upstreamRepository": UPSTREAM,
        "releaseTag": tag,
        "releaseUrl": release["html_url"],
        "releaseId": release["id"],
        "publishedAt": release["published_at"],
        "upstreamSha": upstream_sha,
        "baseSha": base,
        "mergeBaseSha": merge_base,
        "branch": branch,
        "workflowPolicy": "Preserve the complete fork .github/workflows tree; upstream workflow changes remain in the upstream parent and require separate review before adoption.",
        "upstreamWorkflowChanges": workflow_delta,
    }
    if Path(".github").is_symlink() or Path(MANIFEST).is_symlink():
        raise RuntimeError("Refusing a symlink in the sync manifest path")
    Path(MANIFEST).parent.mkdir(parents=True, exist_ok=True)
    Path(MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    git("add", "--", MANIFEST)
    git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit", "--no-gpg-sign", "-m", f"chore: sync official upstream {tag}", "-m", f"Upstream: {upstream_sha}\nPreserve fork workflows; see {MANIFEST} for excluded workflow changes.")
    candidate = git("rev-parse", "HEAD").stdout.strip()
    validate_candidate(candidate, base, upstream_sha, tag)
    return candidate


def validate_candidate(candidate: str, base: str, upstream_sha: str, tag: str) -> None:
    parents = git("show", "-s", "--format=%P", candidate).stdout.strip().split()
    if parents != [base, upstream_sha]:
        raise RuntimeError("Sync candidate must retain exact fork and upstream parents")
    manifest = json.loads(git("show", f"{candidate}:{MANIFEST}").stdout)
    if (manifest.get("baseSha"), manifest.get("upstreamSha"), manifest.get("releaseTag")) != (base, upstream_sha, tag):
        raise RuntimeError("Existing sync branch provenance mismatch")
    if git("diff", "--name-only", base, candidate, "--", WORKFLOWS).stdout.strip():
        raise RuntimeError("Existing candidate modifies the fork workflow boundary")


def main() -> None:
    if os.environ.get("GITHUB_REPOSITORY") != DESTINATION or os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise RuntimeError("Only the approved repository's trusted main workflow may import releases")
    base = git("rev-parse", "HEAD").stdout.strip()
    if base != os.environ.get("GITHUB_SHA") or not SHA_PATTERN.fullmatch(base):
        raise RuntimeError("Trusted workflow checkout SHA mismatch")
    if git("status", "--porcelain").stdout.strip():
        raise RuntimeError("Importer requires a clean checkout")
    destination = f"https://github.com/{DESTINATION}.git"
    current_main = git("ls-remote", "--exit-code", destination, "refs/heads/main").stdout.split()[0]
    if current_main != base:
        raise RuntimeError("Main advanced after this workflow was queued; use a fresh run")
    release, upstream_sha = release_info(os.environ.get("RELEASE_TAG", ""))
    tag = release["tag_name"]
    output("release_tag", tag)
    output("upstream_sha", upstream_sha)
    git("fetch", "--no-tags", f"https://github.com/{UPSTREAM}.git", f"refs/tags/{tag}")
    fetched = git("rev-parse", "FETCH_HEAD^{commit}").stdout.strip()
    if fetched != upstream_sha:
        raise RuntimeError("Release tag moved between API lookup and git fetch")
    upstream_package = json.loads(git("show", f"{upstream_sha}:packages/coding-agent/package.json").stdout)
    if upstream_package.get("version") != tag.removeprefix("v"):
        raise RuntimeError("Upstream package version does not match the release tag")
    if is_ancestor(upstream_sha, base):
        output("changed", "false")
        return
    # Do not roll backward when a manually selected release predates the recorded one.
    previous = git("show", f"{base}:{MANIFEST}", check=False)
    if previous.returncode == 0:
        prior = json.loads(previous.stdout)
        prior_match = TAG_PATTERN.fullmatch(prior["releaseTag"])
        if prior_match and tuple(map(int, TAG_PATTERN.fullmatch(tag).groups())) <= tuple(map(int, prior_match.groups())):
            raise RuntimeError("Release version is not newer than the recorded sync")
    branch = f"sync/upstream-{tag}"
    if not branch.startswith("sync/upstream-"):
        raise RuntimeError("Invalid destination branch")
    destination = f"https://github.com/{DESTINATION}.git"
    remote = git("ls-remote", "--exit-code", destination, f"refs/heads/{branch}", check=False)
    if remote.returncode == 0:
        git("fetch", "--no-tags", destination, f"refs/heads/{branch}")
        candidate = git("rev-parse", "FETCH_HEAD").stdout.strip()
        validate_candidate(candidate, base, upstream_sha, tag)
        # Parent/manifest claims alone are insufficient: reproduce the merge and
        # compare complete trees before adopting an existing sync branch.
        expected = prepare_merge(base, upstream_sha, release, branch)
        if git("rev-parse", f"{candidate}^{{tree}}").stdout != git("rev-parse", f"{expected}^{{tree}}").stdout:
            raise RuntimeError("Existing sync branch differs from the reproducible merge tree")
        # Scheduled polls do not rebuild an existing candidate. Re-run failed jobs
        # or manually dispatch this workflow to retry a transient CI failure.
        if os.environ.get("GITHUB_EVENT_NAME") == "schedule":
            output("changed", "false")
            output("candidate_sha", candidate)
            output("sync_branch", branch)
            return
    elif remote.returncode == 2:
        candidate = prepare_merge(base, upstream_sha, release, branch)
        token = os.environ.get("GH_SYNC_TOKEN", "")
        if not token:
            raise RuntimeError("Missing repository-scoped temporary sync token")
        auth = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        environment = dict(os.environ)
        environment.update({
            "GIT_CONFIG_COUNT": "2",
            "GIT_CONFIG_KEY_0": f"http.{destination}.extraheader",
            "GIT_CONFIG_VALUE_0": "AUTHORIZATION: basic " + auth,
            "GIT_CONFIG_KEY_1": "credential.helper",
            "GIT_CONFIG_VALUE_1": "",
            "GIT_TERMINAL_PROMPT": "0",
        })
        pushed = git("push", destination, f"{candidate}:refs/heads/{branch}", check=False, env=environment)
        if pushed.returncode:
            # Do not work around GitHub workflow/protection restrictions or force push.
            raise RuntimeError("Non-forced sync-branch push failed: " + pushed.stderr)
    else:
        raise RuntimeError("Could not inspect destination branch: " + remote.stderr)
    verified = git("ls-remote", "--exit-code", destination, f"refs/heads/{branch}").stdout.split()[0]
    if verified != candidate:
        raise RuntimeError("Published sync branch SHA mismatch")
    output("changed", "true")
    output("candidate_sha", candidate)
    output("sync_branch", branch)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        manifest = json.loads(git("show", f"{candidate}:{MANIFEST}").stdout)
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(f"## Official {tag} sync candidate\n\n- Candidate: `{candidate}`\n- Upstream: `{upstream_sha}`\n- Branch: `{branch}`\n- Fork workflow boundary preserved; no upstream workflow was enabled\n\n")
            handle.write("Upstream workflow changes held for separate review:\n\n")
            handle.write("\n".join("- `" + path + "`" for path in manifest["upstreamWorkflowChanges"]) or "- None")
            handle.write("\n")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
