# Fork stable-release sync and packages

The fork tracks published, non-draft, non-prerelease `vMAJOR.MINOR.PATCH` releases
from `can1357/oh-my-pi`. It does not follow every upstream commit.

## Trust and merge boundary

`Fork stable upstream sync` checks hourly at minute 24 UTC (GitHub may delay
scheduled runs). Every push to main also checks for the next stable release,
so a release published while the previous candidate was being validated does
not have to wait for another scheduled poll. Already-integrated releases are
no-ops; a sync-branch push does not trigger another import.
The importer uses the workflow and script from the exact trusted main SHA.
Only its import job receives this repository's temporary `GITHUB_TOKEN` with
`contents: write`. This capability is technically repository-wide; the script
restricts writes to a non-forced push to `sync/upstream-vX.Y.Z`. It never pushes
main, creates tokens, changes repository permissions, or runs imported project
scripts. All compilation, dependencies, smoke tests and integration tests run
in separate read-only jobs with checkout credential persistence disabled.

The candidate is a real merge commit with the previous fork main as its first
parent and the official release commit as its second parent. Fork customizations
are retained through normal Git merging. Conflicts outside workflow files stop
automation without a push unless their exact inputs and combined resolutions
were reviewed and committed on trusted main as described below. Unknown or
changed conflicts always stop. Existing sync branches are verified and never
force-overwritten. Changed tags, version mismatches and stale-base candidates stop for
review. Re-run failed jobs for transient CI failures; scheduled polls do not
rebuild an already-published candidate.

The complete fork `.github/workflows` tree is deliberately preserved. Official
workflow additions and edits are **not automatically adopted or enabled**:
they can include upstream release publishing, secrets, and runner requirements.
Every candidate records the excluded upstream workflow paths in
`.github/upstream-sync.json` and the import job summary, and retains the original
workflow bytes in its upstream Git parent. The sync PR must disclose this
boundary and link the recorded changes for separate review.

## Reviewed conflict resolutions

An overlapping fork/upstream change must be resolved and reviewed before the
write-capable importer runs. Commit a data-only JSON file at
`.github/upstream-resolutions/vMAJOR.MINOR.PATCH.json` through the protected-main
review process. This approval is specific to one release and exact file inputs;
it is not permission to prefer every fork or upstream version automatically.
For v18.5.1 the official upstream commit is
`d0cc52397dc2a68d39cba49b0009b9e50ffd643e`.

The schema is:

```json
{
  "schemaVersion": 1,
  "releaseTag": "v18.5.1",
  "upstreamSha": "<exact official release commit, 40 lowercase hex>",
  "mergeBaseSha": "<exact merge-base commit, 40 lowercase hex>",
  "resolutions": [
    {
      "path": "packages/example/source.ts",
      "mergeBaseBlob": "<blob at the merge base, 40 lowercase hex>",
      "forkBlob": "<blob at trusted fork main, 40 lowercase hex>",
      "upstreamBlob": "<blob at the release commit, 40 lowercase hex>",
      "resolvedSha256": "<SHA-256 of content encoded as UTF-8, 64 lowercase hex>",
      "content": "complete reviewed file contents\n"
    }
  ]
}
```

The importer reads the JSON from the original trusted base's Git object before
merging, never from the merged checkout or an upstream copy. It does not execute
resolution scripts or patch commands. Review data and all three input versions
must be regular non-executable files (Git mode `100644`). The exact non-workflow
conflict set must equal the listed unique paths, and each unmerged index stage
must match its reviewed input blob and mode. Add/delete/rename conflicts,
symlinks, executable files, traversal, Git metadata, workflow paths and sync
manifest/resolution paths are not supported resolution targets. Any mismatch
stops without a push; conflicts are never guessed with blanket ours/theirs.
The importer checks checkout path components before writing and stages the exact
reviewed UTF-8 bytes without applying Git clean filters.

A review may also contain an optional `postMergeTests` array for directly related
regression coverage in cleanly merged browser tests:

```json
{
  "path": "packages/coding-agent/test/tools/browser-example.test.ts",
  "mergedBlob": "<exact automatic-merge stage-0 blob, 40 lowercase hex>",
  "resolvedSha256": "<SHA-256 of content encoded as UTF-8, 64 lowercase hex>",
  "content": "complete reviewed test file contents\n"
}
```

These entries are limited to `packages/coding-agent/test/tools/browser-*.test.ts`
with simple alphanumeric, underscore or hyphen filename suffixes. Each must be
distinct from every conflict target and other test entry. Before any reviewed
file is written, the test's stage-0 blob must match `mergedBlob` exactly and its
mode must be `100644`; checkout symlinks and executable files are rejected too.
The importer stores the reviewed test bytes but never executes them. This narrow
test-only option does not relax the exact conflict-set check or permit unrelated
production edits. Test execution remains in the separate read-only jobs.

Pin the input blobs, not a future maintenance-PR merge SHA: merging the reviewed
data onto main may change that SHA without changing the reviewed source files.
The existing current-main check still rejects stale queued runs. A candidate
retains the exact trusted-main and official-upstream parents and the complete
fork workflow tree. Existing candidate branches must reproduce the full same
merge tree, including these resolutions, before they can be reused.

`.github/upstream-sync.json` records `reviewedConflictResolutions` with the
review-data `path`, its trusted Git `blob` hash, the sorted conflict
`resolvedPaths`, and separate `postMergeTestPaths` (or `null` for ordinary merges).
The import summary also lists this provenance.
Reviewers should inspect the combined changes and the read-only validation jobs;
valid hashes only establish which reviewed bytes were used, not their correctness.

Run the network-free importer regression suite with:

```sh
python3 scripts/test_fork_sync_upstream.py
```

## Validation and final packages

The importer calls the existing macOS arm64, Windows x64 and real-extension
workflows directly, passing the exact candidate SHA. A `GITHUB_TOKEN` push does
not trigger ordinary push workflows, so these explicit dependencies are required.
The caller's workflow `head_sha` identifies the trusted orchestrator and may
differ from the candidate. Review the candidate output and the packages'
`build.json` `sourceSha` instead of assuming these identities are equal.

After all three validation workflows succeed, the owner's existing GitHub
connection creates a PR and merges only the tested candidate with the expected
head SHA. Branch protections remain unchanged. If main changed since candidate
creation, update and revalidate the candidate before merging. This process does
not enable GitHub's repository-wide auto-merge feature or Actions PR approvals.

The main merge triggers separate final macOS arm64 and Windows x64 builds and
Windows extension integration checks. Final download artifacts include
`build.json`, SHA-256 hashes, and the matching browser-relay extension ZIP. Both
package manifests must identify the same final main merge SHA before delivery.
Artifacts are retained for 14 days; they are not GitHub Releases or npm publishes.
macOS Intel and Windows ARM64 are outside the currently validated fork targets.

## Operational failures

Conflicts, GitHub push restrictions, failed validations, and provenance mismatches
stop automatic merging. Do not force-push, bypass main protection, grant new token
scopes, or enable upstream workflows to make a run pass. Report the precise
failure for owner review. The owner's hourly monitor handles PRs, merge decisions,
progress and final package links; the GitHub workflow itself only imports and
validates candidate code.

## Reviewed v18.5.1 compatibility changes (2026-10-03)

The reviewed data for official `d0cc52397dc2a68d39cba49b0009b9e50ffd643e`
resolves four browser conflicts while retaining both sides' behavior:

- Keep fresh, background, fork-owned relay tabs; explicit target adoption;
  per-session claims/groups; minimized-window screenshots and orphan recovery.
- Pass upstream discarded-tab metadata and cancellation through the fork target
  selection path, preserving transient attach retry and claim handoff.
- Propagate confirmed-close booleans through relay cleanup. Unconfirmed closes
  retain durable ownership for later reaping. Shared Chromium recovery is limited
  to OMP-owned headless daemons, never the user's relay browser.
- Extend the exact automatically merged attach/shared-cleanup regression tests,
  pinned separately through `postMergeTests` rather than relaxing conflict checks.

Independent reproduction also found that the fork `closeRelayTarget` fallback
incorrectly treated filtered discovery as proof of closure after an extension
disconnected. The prerequisite maintenance change accepts only an explicit
`Target.closeTarget` success; errors, false, or missing acknowledgements remain
unconfirmed. The separate owned-target reaper continues to resolve genuinely
closed or stale records. Tests exercise the actual bridge with an in-memory
WebSocket transport, including reconnect and retry.

There are no upstream workflow changes between v18.5.0 and v18.5.1. The complete
fork workflow tree remains byte-identical; this does not claim execution of the
disabled upstream full matrix, Nix, publishing or signing workflows.

Upgrade the CLI, relay and bundled extension together: restart old relay and OMP
sessions, run `omp browser-relay install`, and reload the extension in Chrome.
The new relay and extension both require discarded-tabs protocol version 1.
Files matching on disk do not prove that the running browser loaded them.
User-computer installation and manual extension reload remain separate authorized
actions; this synchronization only delivers verified packages.

## Reviewed v18.6.3 compatibility changes (2026-10-06)

The version-specific review data pins official commit
`093275112f7adff207608673c0e33c7f3d16e27f`, merge base
`2a2c6dcbbb558c0f8145f67f28b3370984f2bf60`, and all three input blobs for
six overlapping files. This data authorizes only their reviewed combined bytes;
the importer safety contracts, temporary-token boundary and workflow files are
unchanged. The candidate still requires all read-only platform validations before
its normal protected-main PR merge.

- Keep fork claim exclusivity, session labels and provisional ownership handoff,
  while satisfying the upstream relay forwarding success/failure contract used
  by cross-origin iframe auto-attach and nested child-session routing.
- Keep the exported global relay scope and default daemon name, while preserving
  upstream per-port daemon identity so different relay ports do not replace each
  other.
- Keep ownership-only orphan recording, fresh background relay tabs, owned-target
  focus emulation and cleanup, while preserving upstream post-initialization
  navigation and back/forward-cache element invalidation.
- Retain both the fork same-name/different-target regression and the upstream
  refused-websocket error regression. Add pinned, observable composition tests
  for temporary claim sessions, child routing and owned-versus-borrowed targets
  during failed or cancelled open navigation.
- Regenerate the embedded extension from the combined source. Its new debugger
  ownership probe coexists with fork background creation, minimized screenshots,
  session-owned IDs, group cleanup and reconnect handling.

The v18.6.1 to v18.6.3 range includes 569 upstream commits and 599 changed files.
There are no upstream `.github` or workflow changes in this range. v18.6.2 has a
Git tag but no published stable release; its commits are included through the
published v18.6.3 history. No upstream workflow is enabled by this review.

Local checks use Bun 1.4.2, frozen dependencies and the official same-version
Linux native addon only for preliminary tests. They do not substitute for the
clean source-built macOS arm64 and Windows x64 candidates, compiled CLI smoke,
installer checks, or Windows real-extension and minimized-window evidence.
Cloud host socket restrictions prevent local Chromium/Unix-socket acceptance;
those skipped or blocked checks must be reported and verified on the CI runners.

Upgrade the CLI, native addon, relay and extension together. The upstream desktop
adapter now rejects an outdated native addon rather than simulating missing new
methods. Noninteractive session restore fails closed for unavailable models;
SDK callers must account for the queued-message withdrawal rename, asynchronous
`isoResolve`, and the snapcompact/TUI API changes. The macOS capture helper uses
macOS 14+ APIs; that helper requirement is not a claim that the entire CLI now
requires macOS 14. User-device installation and extension reload remain separate.

## v18.6.3 native sort compatibility correction

Post-sync validation reproduced upstream issue [#14606](https://github.com/can1357/oh-my-pi/issues/14606)
with the official same-version Linux native addon: under `LANG=en_US.UTF-8`,
with `LC_ALL` and `LC_COLLATE` unset, both calls to native `sort -u` retained one
of four punctuation-distinct paths while exiting successfully. Per-command
`LC_COLLATE=C`, `LC_ALL=C`, and the system sort retained all four.

The fork correction matches the production strategy of upstream [PR #14610](https://github.com/can1357/oh-my-pi/pull/14610):
it retains shifted locale collation and explicitly includes its quaternary
punctuation/space weights. It does not add a whole-line byte
fallback to unique key comparison, alter the caller's global locale, or claim
complete GNU/Unicode equivalence. Canonically equivalent or locale-tailored
strings may still compare equal. Explicit key selection, dictionary/case/numeric
modes and stable ordering retain their existing contracts.

The existing compiled CLI smoke entry now exercises these native contracts and
reports whether real `en_US.UTF-8` collation or the host's unavailable-locale byte
fallback was used. macOS/Windows release verification must confirm the locale
branch was exercised. Rust core comparison/key tests do not depend on host
locale installation; any unexecuted Cargo tests must still be disclosed. No
workflow, token permission, release publishing, or device installation change
is required for this compatibility repair.

## Reviewed v18.7.0 compatibility changes (2026-10-06)

The review pins official `e0fc1cf4ea354b445a359b37fa5eb58deaa85598`,
merge base `093275112f7adff207608673c0e33c7f3d16e27f`, and the exact
three-way inputs for `sort.rs`, the relay bridge, and its regression suite.
This is prerequisite review data, not a claim that the release has been imported.

- Retain fork tab ownership, claims, grouping, background/minimized behavior and
  orphan protection while adopting upstream child-session replay and detach cleanup.
- Exercise the combined path where an iframe predates the owning worker, a
  temporary claim hands off, and repeated auto-attach must not duplicate events.
- Adopt upstream's equivalent quaternary sort fix without losing the fork's
  deterministic sort-key, explicit-filter and compiled-native smoke contracts.
- Use upstream's new in-memory native archive/manifest embedding. Existing fork
  builds request explicit native targets, so the aggregate target rename requires
  no workflow change. Clean candidate and final-SHA package builds remain required.

Upstream changes to `bazel-cache-warm.yml`, `bun-cache-warm.yml`, and `ci.yml`
are deliberately excluded from the fork workflow tree and recorded by the importer.
No permissions, publishing, branch protection, or user-computer installation changes
are part of this review.
