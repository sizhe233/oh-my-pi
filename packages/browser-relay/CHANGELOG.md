# Changelog

## [Unreleased]

### Fixed

- Relay opens without `app.target` now create an omp-owned Chrome tab in the background instead of adopting the visible tab; owned tabs close on release and can be screenshotted without switching foreground focus.
- Transferred each newly created tab's provisional supervisor claim to its worker, while rejecting concurrent claims from other sessions on the same target with an actionable error.
- Grouped driven tabs by owning session (with a tab-name fallback when no session ID exists), migrated provisional groups after worker claims, and dissolved all `omp`/`omp/*` groups when the extension disconnects.

## [18.3.1] - 2026-09-25

### Fixed

- Fixed browser relay support when multiple browser instances, such as Chrome and Edge, are connected simultaneously, ensuring tabs and relay requests remain associated with the correct browser while preserving single-browser compatibility for extensions without an instance identifier.

## [18.0.7] - 2026-08-26

### Changed

- Clarified the scope of the two browser relay opt-in paths: per-call `app.relay: true` enables relay access for an individual call, while the `browser.relay` setting enables it by default across projects in a profile.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
