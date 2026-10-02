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
automation without a push. Existing sync branches are verified and never forced
overwritten. Changed tags, version mismatches and stale-base candidates stop for
review. Re-run failed jobs for transient CI failures; scheduled polls do not
rebuild an already-published candidate.

The complete fork `.github/workflows` tree is deliberately preserved. Official
workflow additions and edits are **not automatically adopted or enabled**:
they can include upstream release publishing, secrets, and runner requirements.
Every candidate records the excluded upstream workflow paths in
`.github/upstream-sync.json` and the import job summary, and retains the original
workflow bytes in its upstream Git parent. The sync PR must disclose this
boundary and link the recorded changes for separate review.

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
