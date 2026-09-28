# @oh-my-pi/browser-relay

Chrome extension that lets omp's Eval `browser` API drive **your real Chrome tabs** — logged-in sessions included — without relaunching Chrome with `--remote-debugging-port` (which Chrome 136+ refuses on the default profile anyway). By default omp opens its own tab; `app.target` opts into an existing tab.

The companion relay server lives in the omp CLI (`omp browser-relay`, see `packages/coding-agent/src/tools/browser/relay/`). It impersonates Chrome's CDP discovery endpoint, synthesizes the browser target and `Target.*` hierarchy that `chrome.debugger` doesn't expose, and multiplexes any number of downstream puppeteer connections (omp opens one per tab worker) over the single debugger attachment Chrome allows per tab.

## Setup

1. `omp browser-relay install` — writes the bundled extension to `~/.omp/browser-relay/extension`, then load it via `chrome://extensions` → Developer mode → *Load unpacked*. (Or grab `omp-browser-relay-extension.zip` from GitHub releases.)
2. Opt in, one of two ways:
   - **Per call** — pass `app: { relay: true }` to `browser.open(...)` in Eval. Works without any setting and persists nothing: the configured default for every other call and session stays whatever it already was.
   - **As the default** — `omp config set browser.relay true` makes the relay the default for **every session using this profile, in every project** (project-level settings, `PI_BROWSER_RELAY`, and an explicit `app` choice still take precedence). Each session's `browser.open(...)` creates a separate background tab; an optional `url` navigates only that new tab, not the page you are reading.

That's it: the relay server auto-starts under omp's profile-independent global daemon broker the first time Eval's browser API needs it. Every relay consumer holds a broker lease, so one project exiting cannot interrupt another; the server stops after the last consumer across all projects exits. The extension badge turns **on** when connected. Run `omp browser-relay` manually only for `--token`, `--no-group`, or a non-default port — a relay already serving the port is adopted, never fought over.

Without `app.target`, omp creates a tab it owns and closes it when released. Creation and screenshots leave the foreground tab alone; an explicit `tab.bringToFront()` still activates the agent tab. `app.target` deliberately adopts a tab by URL/title substring instead; only one omp session can drive it at a time, and closing the session leaves that borrowed tab open.

Driven tabs join cyan `omp/<session ID>` groups within each Chrome window (the tab name is used when a caller has no session ID). The initial creation claim may briefly use the default `omp` group before the worker assigns the session group. Group labels are trimmed to 32 characters; groups dissolve on disconnect, and debugger attachments/infobars are released when no session holds the tab. Other tabs, pinned tabs, tabs in unrelated user groups, and tabs deliberately dragged out are left alone. The `omp` and `omp/*` group titles are reserved for the relay and are dissolved on disconnect. Disable grouping with `omp browser-relay --no-group`.

## Development

- `bun run build` — bundles the extension into `dist/extension/`, zips it for GH releases, and regenerates the embedded CLI install assets under `packages/coding-agent/src/tools/browser/relay/extension-assets/` (**commit those**).
- `bun scripts/smoke.ts [relay-url] [target-substring]` — end-to-end smoke replicating omp's supervisor + tab-worker double-connection pattern against a live relay.
- This GitHub fork parks inherited workflows as `.yml.upstream-disabled` files. Only `.github/workflows/fork-build-manual.yml` (macOS arm64) and `fork-build-windows-manual.yml` (Windows x64) are active, and both require `workflow_dispatch` on `main` with `source_sha` set to its full commit SHA. They build from that checkout, run browser/type/cwd/worker checks, and upload checksums plus build provenance; neither publishes a release or updates a local installation.
- Windows uses the supported x86-64 baseline target (`win32-x64`), not 32-bit x86: its native addon and CLI are cross-built on Linux, then the binary, tests, and embedded extension are checked on hosted Windows x64.

## Limitations

- `chrome://`, DevTools, Web Store, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- Anything that can reach the relay port can drive your logged-in browser. The relay binds loopback only; use `omp browser-relay --token <secret>` (mirrored in the extension options) if untrusted local processes are a concern.
