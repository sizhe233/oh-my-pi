#!/usr/bin/env python3
"""Import one official stable release without executing imported project code.

Run only from the trusted default-branch workflow. The only remote write is a
non-forced push to a sync/upstream-* branch; PRs and main merges are separate.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import urllib.request

UPSTREAM = "can1357/oh-my-pi"
DESTINATION = "sizhe233/oh-my-pi"
WORKFLOWS = ".github/workflows"
MANIFEST = ".github/upstream-sync.json"
RESOLUTIONS = ".github/upstream-resolutions"
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
TAG_PATTERN = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


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


def tree_file(revision: str, path: str) -> tuple[str, str] | None:
    """Inspect literal Git paths, never dereference a checkout symlink."""
    entries = git("ls-tree", "-z", revision, "--", f":(literal){path}").stdout.split("\0")
    entries = [entry for entry in entries if entry]
    if not entries:
        return None
    if len(entries) != 1:
        raise ValueError(f"Ambiguous reviewed resolution path: {path}")
    metadata, name = entries[0].split("\t", 1)
    mode, kind, blob = metadata.split()
    if name != path or kind != "blob" or mode != "100644" or not SHA_PATTERN.fullmatch(blob):
        raise ValueError(f"Reviewed resolution requires a regular 100644 blob: {path}")
    return mode, blob


def load_resolutions(base: str, upstream_sha: str, merge_base: str, tag: str) -> tuple[str, dict] | None:
    """Only data reviewed in the pre-merge trusted base can authorize a resolution."""
    source = tree_file(base, f"{RESOLUTIONS}/{tag}.json")
    if source is None:
        return None
    data = json.loads(git("cat-file", "blob", source[1]).stdout)
    keys = {"schemaVersion", "releaseTag", "upstreamSha", "mergeBaseSha", "resolutions"}
    if (not isinstance(data, dict) or set(data) not in (keys, keys | {"postMergeTests"})
            or type(data["schemaVersion"]) is not int or data["schemaVersion"] != 1):
        raise ValueError("Invalid reviewed resolution schema")
    if (data["releaseTag"], data["upstreamSha"], data["mergeBaseSha"]) != (tag, upstream_sha, merge_base):
        raise ValueError("Reviewed resolution release or merge-base pin mismatch")
    entries = data["resolutions"]
    if not isinstance(entries, list) or not entries:
        raise ValueError("Reviewed resolutions must contain an exact nonempty conflict set")
    paths = set()
    for entry in entries:
        required = {"path", "mergeBaseBlob", "forkBlob", "upstreamBlob", "resolvedSha256", "content"}
        if not isinstance(entry, dict) or set(entry) != required:
            raise ValueError("Invalid reviewed resolution entry")
        path = entry["path"]
        if (not isinstance(path, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", path)
                or any(part in (".", "..") or part.lower() == ".git" for part in path.split("/"))
                or path in (WORKFLOWS, MANIFEST, RESOLUTIONS)
                or path.startswith((WORKFLOWS + "/", RESOLUTIONS + "/"))):
            raise ValueError("Unsafe reviewed resolution path")
        if path in paths:
            raise ValueError(f"Duplicate reviewed resolution path: {path}")
        paths.add(path)
        for revision, key in ((merge_base, "mergeBaseBlob"), (base, "forkBlob"), (upstream_sha, "upstreamBlob")):
            blob = entry[key]
            if not isinstance(blob, str) or not SHA_PATTERN.fullmatch(blob) or tree_file(revision, path) != ("100644", blob):
                raise ValueError(f"Reviewed resolution input pin mismatch: {path} ({key})")
        check_reviewed_content(entry)
    tests = data.get("postMergeTests", [])
    if not isinstance(tests, list):
        raise ValueError("Invalid reviewed post-merge tests")
    for entry in tests:
        if not isinstance(entry, dict) or set(entry) != {"path", "mergedBlob", "resolvedSha256", "content"}:
            raise ValueError("Invalid reviewed post-merge test entry")
        path, blob = entry["path"], entry["mergedBlob"]
        if (not isinstance(path, str)
                or not re.fullmatch(r"packages/coding-agent/test/tools/browser-[A-Za-z0-9_-]+\.test\.ts", path)
                or path in paths):
            raise ValueError("Unsafe or duplicate reviewed post-merge test path")
        paths.add(path)
        if not isinstance(blob, str) or not SHA_PATTERN.fullmatch(blob):
            raise ValueError(f"Invalid reviewed post-merge test blob: {path}")
        check_reviewed_content(entry)
    return source[1], data


def check_reviewed_content(entry: dict) -> None:
    content, digest = entry["content"], entry["resolvedSha256"]
    if (not isinstance(content, str) or "\0" in content or not isinstance(digest, str)
            or not SHA256_PATTERN.fullmatch(digest)
            or hashlib.sha256(content.encode("utf-8")).hexdigest() != digest):
        raise ValueError(f"Reviewed resolution content hash mismatch: {entry['path']}")


def check_checkout_file(path: str) -> None:
    destination = Path(path)
    for component in (*reversed(destination.parents), destination):
        mode = component.lstat().st_mode
        if stat.S_ISLNK(mode):
            raise RuntimeError(f"Refusing a symlink in reviewed resolution path: {path}")
        if component == destination:
            if not stat.S_ISREG(mode) or mode & 0o111:
                raise RuntimeError(f"Reviewed resolution requires a non-executable regular file: {path}")
        elif not stat.S_ISDIR(mode):
            raise RuntimeError(f"Invalid reviewed resolution directory: {path}")


def apply_resolutions(review: dict | None, conflicts: list[str]) -> list[str]:
    entries = review["resolutions"] if review else None
    if entries is None:
        if conflicts:
            raise RuntimeError("Manual conflict resolution required: " + ", ".join(conflicts))
        return []
    if set(conflicts) != {entry["path"] for entry in entries}:
        raise RuntimeError("Reviewed resolution conflict set mismatch")
    # Validate every stage and checkout component before writing any resolution.
    for entry in entries:
        path = entry["path"]
        expected = {str(stage): ("100644", entry[key]) for stage, key in
                    ((1, "mergeBaseBlob"), (2, "forkBlob"), (3, "upstreamBlob"))}
        actual = {}
        for record in git("ls-files", "--unmerged", "-z", "--", f":(literal){path}").stdout.split("\0"):
            if not record:
                continue
            metadata, name = record.split("\t", 1)
            mode, blob, stage = metadata.split()
            if name != path or stage in actual:
                raise RuntimeError(f"Unexpected reviewed resolution index entry: {path}")
            actual[stage] = (mode, blob)
        if actual != expected:
            raise RuntimeError(f"Reviewed resolution conflict stages mismatch: {path}")
        check_checkout_file(path)
    tests = review.get("postMergeTests", [])
    for entry in tests:
        path = entry["path"]
        expected = f"100644 {entry['mergedBlob']} 0\t{path}\0"
        if git("ls-files", "--stage", "-z", "--", f":(literal){path}").stdout != expected:
            raise RuntimeError(f"Reviewed post-merge test staged blob or mode mismatch: {path}")
        check_checkout_file(path)
    for entry in [*entries, *tests]:
        path = entry["path"]
        Path(path).write_bytes(entry["content"].encode("utf-8"))
        # Bypass attributes/clean filters: the exact reviewed bytes are the blob.
        blob = git("hash-object", "-w", "--no-filters", "--", path).stdout.strip()
        git("update-index", "--add", "--cacheinfo", "100644", blob, path)
    return sorted(conflicts)


def prepare_merge(base: str, upstream_sha: str, release: dict, branch: str) -> str:
    tag = release["tag_name"]
    merge_base = git("merge-base", base, upstream_sha).stdout.strip()
    resolutions = load_resolutions(base, upstream_sha, merge_base, tag)
    workflow_delta = git("diff", "--name-status", merge_base, upstream_sha, "--", WORKFLOWS).stdout.splitlines()
    git("switch", "--create", branch, base)
    result = git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", "merge", "--no-commit", "--no-ff", upstream_sha, check=False)
    conflicts = git("diff", "--name-only", "--diff-filter=U", "-z").stdout.split("\0")
    conflicts = [path for path in conflicts if path]
    outside = [path for path in conflicts if not path.startswith(WORKFLOWS + "/")]
    try:
        resolved = apply_resolutions(resolutions[1] if resolutions else None, outside)
    except (RuntimeError, ValueError, OSError, subprocess.CalledProcessError):
        git("merge", "--abort", check=False)
        raise
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
        "reviewedConflictResolutions": {
            "path": f"{RESOLUTIONS}/{tag}.json",
            "blob": resolutions[0],
            "resolvedPaths": resolved,
            "postMergeTestPaths": sorted(entry["path"] for entry in resolutions[1].get("postMergeTests", [])),
        } if resolutions else None,
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
            reviewed = manifest["reviewedConflictResolutions"]
            if reviewed:
                handle.write(f"Reviewed conflict data from trusted main: `{reviewed['path']}` (Git blob `{reviewed['blob']}`)\n\n")
                handle.write("Resolved paths:\n\n" + "\n".join("- `" + path + "`" for path in reviewed["resolvedPaths"]) + "\n\n")
                if reviewed["postMergeTestPaths"]:
                    handle.write("Reviewed post-merge regression tests:\n\n" + "\n".join("- `" + path + "`" for path in reviewed["postMergeTestPaths"]) + "\n\n")
            handle.write("Upstream workflow changes held for separate review:\n\n")
            handle.write("\n".join("- `" + path + "`" for path in manifest["upstreamWorkflowChanges"]) or "- None")
            handle.write("\n")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
