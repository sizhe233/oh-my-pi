# @oh-my-pi/browser-relay

Chrome extension that lets omp's Eval `browser` API drive **your real Chrome tabs** — logged-in sessions included — without relaunching Chrome with `--remote-debugging-port` (which Chrome 136+ refuses on the default profile anyway). By default omp opens its own tab; `app.target` opts into an existing tab.

The companion relay server lives in the omp CLI (`omp browser-relay`, see `packages/coding-agent/src/tools/browser/relay/`). It impersonates Chrome's CDP discovery endpoint, synthesizes the browser target and `Target.*` hierarchy that `chrome.debugger` doesn't expose, and multiplexes any number of downstream puppeteer connections (omp opens one per tab worker) over the single debugger attachment Chrome allows per tab.

## Setup

1. `omp browser-relay install` — writes the bundled extension to `~/.omp/browser-relay/extension`, then load it via `chrome://extensions` → Developer mode → _Load unpacked_. (Or grab `omp-browser-relay-extension.zip` from GitHub releases.)
2. Opt in, one of two ways:
   - **Per call**: pass `app: "relay"` to `browser.open(...)` in Eval. This does not change the profile default.
   - **As the default**: `omp config set browser.relay true` applies to every top-level session using this profile, including background sessions. The default opens a separate background tab in your logged-in profile. Subagents skip the default and require explicit `app: "relay"`.

The relay normally starts as an omp daemon unit for the configured port. A relay that is already serving manually is left alone. Each consumer has a lease so one project leaving does not stop another project's relay. The extension badge shows **on** when connected.

Without `target`, omp owns the background tab it opens and closes it only after ownership is confirmed. Passing `target` deliberately borrows an existing tab by URL or title substring; closing the omp session leaves that tab open. Screenshots do not activate the selected tab. Driven tabs can join the relay's cyan `omp/<session ID>` tab groups. Unrelated groups and tabs are not taken over.

This fork does not use Chrome's downloads or scripting permissions. Use the extension bundled with your exact build. Finish active browser work before manually reloading it in the intended profile; a reload invalidates old omp tab handles even if Chrome leaves those tabs open. A simple reconnect without reloading is a separate operation. Do not grant extra permissions to make the relay connect.

## Development

- `bun run build` — bundles the extension into `dist/extension/`, zips it for GH releases, and regenerates the embedded CLI install assets under `packages/coding-agent/src/tools/browser/relay/extension-assets/` (**commit those**).
- `bun scripts/smoke.ts [relay-url] [target-substring]` — end-to-end smoke replicating omp's supervisor + tab-worker double-connection pattern against a live relay.

## Limitations

- `chrome://`, DevTools, Web Store, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- Chrome refuses the debugger in a tab while another extension's frame, such as a password manager's inline menu, is in it. In a tab omp drives, the extension empties and hides that frame so omp can continue; your other tabs keep theirs. The call that ran into the frame, or a later one on that tab, names the extension and the frame's page, so the agent can tell you what was hidden.
- Anything that can reach the relay port can drive your logged-in browser. The relay binds loopback only; use `omp browser-relay --token <secret>` (mirrored in the extension options) if untrusted local processes are a concern.
