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
import tempfile
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
    # A fork-deleted/upstream-modified file has no stage 2; restore alone
    # cannot remove that unmerged path. Remove the tracked subtree first,
    # then recreate only the trusted fork tree (including its deletions).
    git("rm", "-r", "--force", "--ignore-unmatch", "--", WORKFLOWS)
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


OVERLAYS = ".github/upstream-overlays"
EXTENSION_MANIFESTS = (
    "packages/browser-relay/extension/manifest.json",
    "packages/coding-agent/src/tools/browser/relay/extension-assets/manifest.json.txt",
)


def product_digest(tree: str) -> str:
    rows = git("ls-tree", "-r", "-z", tree).stdout.split("\0")
    product = [row for row in rows if row and not row.split("\t", 1)[1].startswith(".github/")]
    return hashlib.sha256(("\0".join(product) + "\0").encode()).hexdigest()


def check_extension_boundary(base: str, candidate: str) -> None:
    # Only version stamps may differ. Unknown/new manifest fields fail closed too.
    for path in EXTENSION_MANIFESTS:
        before, after = tree_file(base, path), tree_file(candidate, path)
        if before is None and after is None:
            continue
        if before is None or after is None:
            raise RuntimeError(f"Extension manifest presence changed: {path}")
        manifests = []
        for entry in (before, after):
            value = json.loads(git("cat-file", "blob", entry[1]).stdout)
            if not isinstance(value, dict):
                raise RuntimeError("Invalid extension manifest")
            for key in ("version", "version_name"):
                value.pop(key, None)
            manifests.append(value)
        if manifests[0] != manifests[1]:
            raise RuntimeError(f"Extension authority or manifest fields changed: {path}")


SCRIPT_PRESERVATION_RELEASE = ("v18.18.8", "679691a78141de0dd6ba1b7a5d5c1b1d7d967a63")
SCRIPT_PRESERVATION_RELEASE_200 = ("v18.20.0", "c308970263ae13744ea15ab67302e3dac840e266")
SCRIPT_PRESERVATION_SOURCE = "e325ffc73ab86e03bdd20a91b77d8e2b3964c906"

# Explicit preservation scope; no glob or importer/metadata paths.
SCRIPT_PRESERVATION_PATHS = frozenset(('scripts/ci-build-upload.test.ts', 'scripts/ci-build-upload.ts', 'scripts/ci-release-build-binaries.test.ts', 'scripts/ci-release-checksums.test.ts', 'scripts/ci-release-checksums.ts', 'scripts/ci-release-publish.test.ts', 'scripts/ci-release-publish.ts', 'scripts/ci-update-brew-formula.test.ts', 'scripts/ci-update-brew-formula.ts', 'scripts/fix-changelogs.test.ts', 'scripts/fix-changelogs.ts', 'scripts/fix-dt-verdef.test.ts', 'scripts/gen-nix-bun.test.ts', 'scripts/gen-nix-bun.ts', 'scripts/inline-functions.test.ts', 'scripts/inline-functions.ts', 'scripts/install-tests/native-version.test.ts', 'scripts/install-tests/native-version.ts', 'scripts/install.test.ts', 'scripts/merge-pr.test.ts', 'scripts/merge-pr.ts', 'scripts/musl-release.test.ts', 'scripts/release.test.ts', 'scripts/release.ts', 'scripts/run-rs-task.test.ts', 'scripts/session-stats/audit.test.ts', 'scripts/session-stats/audit.ts', 'scripts/stamp-native-version.test.ts', 'scripts/stamp-native-version.ts'))


def script_record(revision: str, path: str) -> dict | None:
    rows = [r for r in git("ls-tree", "-z", revision, "--", f":(literal){path}").stdout.split("\0") if r]
    if not rows:
        return None
    if len(rows) != 1:
        raise ValueError("Ambiguous script path")
    metadata, name = rows[0].split("\t", 1)
    mode, kind, blob = metadata.split()
    if name != path or kind != "blob" or mode not in ("100644", "100755") or not SHA_PATTERN.fullmatch(blob):
        raise ValueError("Invalid script file kind")
    return {"mode": mode, "blob": blob}


def validate_script_preservation(entry: dict, base: str, upstream: str, merged: str, tag: str) -> str:
    if (tag, upstream) not in (SCRIPT_PRESERVATION_RELEASE, SCRIPT_PRESERVATION_RELEASE_200):
        raise ValueError("Script preservation release mismatch")
    if entry["path"] not in SCRIPT_PRESERVATION_PATHS:
        raise ValueError("Script outside explicit preservation scope")
    proof = entry["scriptPreservation"]
    if not isinstance(proof, dict) or set(proof) != {"base", "upstream", "merged", "source", "outputMode"}:
        raise ValueError("Invalid script preservation pins")
    for key, revision in (("base", base), ("upstream", upstream), ("merged", merged), ("source", SCRIPT_PRESERVATION_SOURCE)):
        if script_record(revision, entry["path"]) != proof[key]:
            raise ValueError("Script preservation input mismatch: " + key)
    git("merge-base", "--is-ancestor", SCRIPT_PRESERVATION_SOURCE, upstream)
    before = proof["merged"]
    if entry["mergedBlob"] != (before["blob"] if before else None):
        raise ValueError("Script merged blob mismatch")
    mode = proof["outputMode"]
    if mode not in ("100644", "100755") or entry["content"] is None:
        raise ValueError("Invalid script preservation output")
    if before is None and (not entry["path"].endswith(".test.ts") or proof["source"] is None or proof["source"]["mode"] != "100644" or mode != "100644"):
        raise ValueError("Only pinned historical non-executable tests may be restored")
    if before and mode != before["mode"]:
        raise ValueError("Script chmod is forbidden")
    if mode == "100755" and any(proof[key] is None or proof[key]["mode"] != mode for key in ("base", "upstream", "merged")):
        raise ValueError("Executable creation or mode transition is forbidden")
    return mode


def apply_product_overlay(base: str, upstream: str, merge_base: str, tag: str) -> dict | None:
    source = tree_file(base, f"{OVERLAYS}/{tag}.json")
    merged = git("write-tree").stdout.strip()
    if source is None:
        check_extension_boundary(base, merged)
        return None
    data = json.loads(git("cat-file", "blob", source[1]).stdout)
    required = {"schemaVersion", "releaseTag", "upstreamSha", "mergeBaseSha", "mergedProductSha256", "finalProductSha256", "entries"}
    if (not isinstance(data, dict) or set(data) != required
            or type(data["schemaVersion"]) is not int or data["schemaVersion"] != 1
            or (data["releaseTag"], data["upstreamSha"], data["mergeBaseSha"]) != (tag, upstream, merge_base)):
        raise ValueError("Invalid reviewed product overlay identity")
    for key in ("mergedProductSha256", "finalProductSha256"):
        if not isinstance(data[key], str) or not SHA256_PATTERN.fullmatch(data[key]):
            raise ValueError("Invalid reviewed product digest")
    if product_digest(merged) != data["mergedProductSha256"]:
        raise RuntimeError("Reviewed overlay complete input product mismatch")
    entries = data["entries"]
    if not isinstance(entries, list) or not entries:
        raise ValueError("Empty reviewed product overlay")
    seen = set()
    output_modes = {}
    for entry in entries:
        normal_keys = {"path", "mergedBlob", "content", "resolvedSha256"}
        if not isinstance(entry, dict) or set(entry) not in (normal_keys, normal_keys | {"scriptPreservation"}):
            raise ValueError("Invalid reviewed product overlay entry")
        path = entry["path"]
        if (not isinstance(path, str) or not re.fullmatch(r"(?:package\.json|docs/tools/(?:browser|ask)\.md|(?:packages|crates|scripts)/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*)", path)
                or any(part in (".", "..") or part.lower() == ".git" for part in path.split("/"))
                or (path.startswith("scripts/") and path not in ("scripts/fork-browser-minimized-e2e.ts", "scripts/fork-browser-relay-e2e.ts", "scripts/run-rs-task.ts") and not ("scriptPreservation" in entry and path in SCRIPT_PRESERVATION_PATHS)) or path in seen):
            raise ValueError("Unsafe or duplicate reviewed overlay path")
        seen.add(path)
        blob = entry["mergedBlob"]
        if blob is not None and (not isinstance(blob, str) or not SHA_PATTERN.fullmatch(blob)):
            raise ValueError("Invalid overlay input blob")
        expected = None if blob is None else ("100644", blob)
        if "scriptPreservation" in entry:
            output_modes[path] = validate_script_preservation(entry, base, upstream, merged, tag)
        else:
            if tree_file(merged, path) != expected:
                raise RuntimeError(f"Overlay input mismatch: {path}")
            output_modes[path] = "100644"
        # No checkout writes: reject symlink/gitlink/non-directory ancestors in the Git tree.
        for parent in Path(path).parents:
            if str(parent) == ".":
                continue
            record = git("ls-tree", "-z", merged, "--", f":(literal){parent.as_posix()}").stdout
            if record and not record.startswith("040000 tree "):
                raise RuntimeError(f"Unsafe overlay ancestor: {parent}")
        if entry["content"] is None:
            if blob is None or entry["resolvedSha256"] is not None:
                raise ValueError("Invalid reviewed overlay deletion")
        else:
            check_reviewed_content(entry)
    # Build entirely in a private index. Failure leaves the real index untouched.
    with tempfile.TemporaryDirectory(prefix="fork-reviewed-overlay-") as directory:
        environment = dict(os.environ, GIT_INDEX_FILE=str(Path(directory) / "index"))
        git("read-tree", merged, env=environment)
        for number, entry in enumerate(entries):
            if entry["content"] is None:
                git("update-index", "--force-remove", "--", entry["path"], env=environment)
            else:
                file = Path(directory) / str(number)
                file.write_bytes(entry["content"].encode("utf-8"))
                blob = git("hash-object", "-w", "--no-filters", "--", str(file)).stdout.strip()
                git("update-index", "--add", "--cacheinfo", output_modes[entry["path"]], blob, entry["path"], env=environment)
        final = git("write-tree", env=environment).stdout.strip()
        if product_digest(final) != data["finalProductSha256"]:
            raise RuntimeError("Reviewed overlay complete output product mismatch")
        if git("diff", "--name-only", merged, final, "--", ".github").stdout.strip():
            raise RuntimeError("Reviewed overlay changed trusted metadata")
        check_extension_boundary(base, final)
        # Only now replace the real index. No intermediate candidate is committed or pushed.
        git("read-tree", final)
    return {"path": f"{OVERLAYS}/{tag}.json", "blob": source[1],
            "mergedProductSha256": data["mergedProductSha256"], "finalProductSha256": data["finalProductSha256"],
            "paths": sorted(seen)}


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
    try:
        overlay = apply_product_overlay(base, upstream_sha, merge_base, tag)
    except (RuntimeError, ValueError, OSError, subprocess.CalledProcessError):
        git("merge", "--abort", check=False)
        raise
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
    if overlay is not None:
        manifest["reviewedProductOverlay"] = overlay
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
    check_extension_boundary(base, candidate)
    parents = git("show", "-s", "--format=%P", candidate).stdout.strip().split()
    if parents != [base, upstream_sha]:
        raise RuntimeError("Sync candidate must retain exact fork and upstream parents")
    manifest = json.loads(git("show", f"{candidate}:{MANIFEST}").stdout)
    if (manifest.get("baseSha"), manifest.get("upstreamSha"), manifest.get("releaseTag"), manifest.get("branch")) != (
            base, upstream_sha, tag, f"sync/upstream-{tag}-{base}"):
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
    # Bind each candidate to the complete trusted base; keep older candidates intact.
    branch = f"sync/upstream-{tag}-{base}"
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
