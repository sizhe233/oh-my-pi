# sizhe233/oh-my-pi fork

本仓库是 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 的长期 fork。日常使用的 `omp` 由本 fork 的 GitHub Actions 构建，不使用上游发布。
agent 规则见 `.omp/RULES.md`（omp 会将其作为常驻规则注入每次请求，与根目录 `AGENTS.md` 并存），本文件记录事实与操作流程。

常见请求对应的章节：“同步上游 / 上游有更新” → 定期同步上游；“更新本机 omp / 装新版” → 本机安装与回退（macOS arm64 或 Windows x64）；“改浏览器行为” → Fork 改动清单 + 必须保持的行为；任何安装之后 → 真实 Chrome 验收。

## 仓库与分支

| remote | 地址 | 用途 |
|---|---|---|
| `origin` | `https://github.com/sizhe233/oh-my-pi.git` | 主仓库；`main` 是唯一构建来源 |
| `upstream` | `https://github.com/can1357/oh-my-pi.git` | 只读；fetch refspec 为 `+refs/heads/main:refs/remotes/upstream/main` |
| `gitea` | `http://192.168.71.56:23000/yuyi233/oh-my-pi` | 内网备份；`main` 更新后镜像推送 |

- 首次分叉点：上游 `2e07c170b5`（18.4.1）。查看当前 fork 差异：`git log --oneline upstream/main..main`、`git diff upstream/main...main`。
- `origin/main` 已开启分支保护：必须通过 PR 合并（不要求审批人数，便于单人维护），管理员同样受约束，禁止强推和删除。合并后的 PR 分支要删除。
- 新克隆需要补的本地配置（不在仓库里）：
  ```sh
  git remote add upstream https://github.com/can1357/oh-my-pi.git
  git config remote.upstream.fetch '+refs/heads/main:refs/remotes/upstream/main'
  git remote add gitea http://192.168.71.56:23000/yuyi233/oh-my-pi
  git config remote.origin.proxy http://127.0.0.1:7890; git config remote.upstream.proxy http://127.0.0.1:7890
  ```
  本机访问 GitHub（git、`gh`、artifact 下载）都走 clash 代理 `127.0.0.1:7890`；`gh` 需要 `export HTTPS_PROXY=http://127.0.0.1:7890`。

## Fork 改动清单

| # | 改动 | 提交 | 主要文件 |
|---|---|---|---|
| F1 | Relay 自有标签（移植上游未合并的 [PR #12101](https://github.com/can1357/oh-my-pi/pull/12101)，作者 Koichi Kimura） | `eb8634a408` `e85e9bdca0` `d462f9cff9` | `attach.ts`（`resolveAttachTarget`）、`tab-supervisor.ts`（`ownsTarget`、`closeAbandonedOwnedTarget`）、`tab-worker.ts`、`tab-protocol.ts`、`relay/bridge.ts`（非真实 detach 不再 ban） |
| F2 | 会话隔离：后台建页、claim 互斥、按会话分组、后台截图 | `89e1fb1ec4` | `packages/browser-relay/extension/background.ts`、`relay/bridge.ts`（`#claimTab`、`provisionalClaimConnId`、`#drainGroupQueue`）、`tab-supervisor.ts`（`buildInitPayload`、`groupLabelForTab`）、`tab-worker.ts`（`#claimRelayTarget`、`preparePageForScreenshot`）、`relay/extension-assets/*` |
| F3 | Fork CI：停用上游 workflow，手动构建及独立 Windows 真实扩展集成验证；Windows 安装脚本 | `91c86591b0` … `95617c163b` | `.github/workflows/*.upstream-disabled`、`fork-build-manual.yml`、`fork-build-windows-manual.yml`、`fork-browser-relay-e2e.yml`、`scripts/fork-browser-relay-e2e.ts`、`scripts/fork-install-windows.ps1` |
| F4 | 最小化窗口：建标签指定窗口、截图等帧有上限 | 见变更记录 | `packages/browser-relay/extension/background.ts`（`tabWindowId`）、`packages/browser-relay/extension/chrome.d.ts`、`screenshot.ts`（`waitForRenderFrame`）、`relay/extension-assets/*` |
| F5 | 会话崩溃残留回收、`app.target` 同名复用报错、扩展重连降噪 | 见变更记录 | `relay/owned-targets.ts`（`relayTargetScope`、`closeRelayTarget`、`closeRelayOwnedTarget`）、`relay/bridge.ts`（`ompCreated`、`OMP.closeOwnedTarget`）、`relay/protocol.ts`（hello `ownedTabIds`）、`orphan-registry.ts`（`runtimeDir`、可注入关闭函数）、`registry.ts`（relay 连接时回收）、`tab-supervisor.ts`（`attachTarget`、`sharedScopeOf`、`closeTargetById`）、`packages/browser-relay/extension/background.ts`（`ompCreatedTabIds`、`relayListening`、单一重连定时器）、`relay/extension-assets/*` |
| F6 | 多个浏览器实例连 relay 时，新建标签只发给有标签（有窗口）的实例 | 见变更记录 | `relay/bridge.ts`（`#instanceForNewTab`） |

上表中 `tab-*.ts`、`attach.ts`、`screenshot.ts`、`relay/*` 均位于 `packages/coding-agent/src/tools/browser/`。

### 必须保持的行为

合并上游或修改上述文件后，下列行为都必须仍然成立：

1. 使用 relay 且未给 `app.target` 时，`browser.open()` 新建一个 omp 自有标签，不接管用户当前标签；Chrome 前台标签与焦点不变（`createTab` 使用 `active: false`）。
2. 自有标签的截图不切换前台（`requireVisible: false`，并开启 `emulateFocus`）。
3. 同一个已有标签只能被一个 omp 会话驱动；第二个会话收到 `already driven by another omp session`，不能被静默吞掉。
4. 自有标签进入 `omp/<会话 ID>` 分组（没有会话 ID 时用标签名）；断开连接时解散所有 `omp`、`omp/*` 分组。
5. 关闭会话时关闭自有标签；借用的用户标签保留；没有持有者时 detach，调试提示条消失。
6. `supervisor → worker` 交接新建标签的临时 claim 时不能误报冲突。
7. Chrome 所有窗口都最小化时，`browser.open()` 仍能新建自有标签（放进普通窗口，不恢复窗口），截图仍能完成（不因 `requestAnimationFrame` 不触发而超时）。
8. 同名标签已打开时，`browser.open({ app: { target } })` 的 `target` 与该标签打开时的不同（包括原标签没给 `target`），直接报错 `Tab "<name>" is already open…; pass a distinct name…`，不静默复用别的标签；同名同 `target` 再次打开仍复用。
9. 会话进程被强杀后，它新建的自有标签在其 PID 已死且记录超过 15 秒后，由下一个连接 relay 的 omp 进程（任一会话首次 `browser.open`）关闭；借用的用户标签从不记录、从不关闭；relay 只关闭扩展在本次浏览器会话里建过（`ownedTabIds`）且当前无人驱动的标签，浏览器重启后复用的标签 id 不会被误关。
10. 没有 relay 监听时，扩展先用 `fetch` 探测端口再拨 WebSocket，`chrome://extensions` 不再累积 `ERR_CONNECTION_REFUSED`；重连间隔上限 30 秒且只有一条定时器链，relay 起来后扩展仍在一个 alarm 周期（约 30 秒）内连上。
11. 多个装了扩展的浏览器实例同时连着 relay 时，新建标签发给最后握手且有标签的实例；最后握手的实例没有任何标签（如 `--no-startup-window` 启动的后台 Chrome）时，改发给其他有标签的实例，不报 `No current window`。

回归测试位于 `packages/coding-agent/test/tools/`：`browser-relay-bridge.test.ts`（分组、互斥、交接、ban、`OMP.closeOwnedTarget` 只关自建且无人驱动的标签、新建标签不发给无窗口实例）、`browser-attach.test.ts`（`resolveAttachTarget`、同名标签不同 `app.target` 报错）、`browser-op-tracking.test.ts`（永不触发动画帧时截图仍完成）。

`scripts/fork-browser-relay-e2e.ts` 使用隔离的 Chrome for Testing 配置、实际扩展及实际 relay 检查可自动化的浏览器行为，逐项输出上述 1–11 的覆盖结果。它不调用模型，不使用用户浏览器资料；协议层通过不代表完整 CLI 会话通过，headless 结果也不能替代操作系统前台焦点、最小化窗口和提示条的桌面验收。未覆盖的部分必须保留为 partial/blocked，不得算作通过。

### 已知问题

- 超时回收（`recycleTimedOutWorkerTab`）如果旧 worker 是 inline 回退模式，旧连接的 claim 不会释放，新 worker 可能被互斥拒绝。尚未修复。
- 分组标题取会话 ID 的后 32 个字符，可读性较差。
- 扩展握手不报告构建哈希，无法从 relay 侧确认 Chrome 实际加载的扩展版本；更新后必须人工重载并实测。
- 自有标签归属由扩展记在 `chrome.storage.session`：重载/更新扩展会清空它，重载前遗留的崩溃残留不会被回收（安全方向，只漏不误关）；旧版扩展（hello 不带 `ownedTabIds`）只能回收同一个 relay 进程生命周期内建的标签。
- 回收只在新连接 relay 时触发；一个会话已持有 relay 连接时，其他会话在此之后崩溃留下的标签要等下一次新连接才回收。

## CI 构建

- 继承的上游 workflow 已改名为 `.yml.upstream-disabled`，不会运行。以下 fork workflow 均不发布 release，也不改动本机安装：
  - `fork-build-manual.yml`：GitHub 托管的 `macos-15` arm64 runner，产物名 `omp-fork-darwin-arm64-<sha>`。
  - `fork-build-windows-manual.yml`：Windows x64 baseline（`win32-x64`，不是 32 位 x86）。native addon 和 CLI 在 Linux 上交叉编译，再到托管的 Windows x64 runner 上验证二进制、测试和内嵌扩展。
  - `fork-browser-relay-e2e.yml`：独立 `windows-2025` 真实扩展集成验证，不依赖原生二进制重编译。Bun 固定为 1.4.2，Chrome for Testing 版本取冻结依赖中的 Puppeteer revision；重建扩展并校验与 CLI 内嵌资源一致。可手动运行；此外仅在 `sync/upstream-20260930` 分支且修改该 workflow 或测试脚本时自动运行。产物 `omp-windows-real-extension-<sha>` 保存覆盖 JSON、截图及日志。此任务成功只说明被执行的断言成功，未覆盖的完整 CLI/桌面验收仍待完成。
- 触发方式：`gh workflow run <workflow> --repo sizhe233/oh-my-pi --ref <分支> -f source_sha=<该分支头的完整 SHA>`。`source_sha` 必须等于运行时检出的提交。
- 每次构建都从干净 checkout 编译 native addon、扩展和 CLI，检查生成的扩展资源没有漂移，运行浏览器测试、类型检查、worker smoke、外部 cwd 与显式 `--cwd`，并上传 `SHA256SUMS.txt` 和 `build.json`。
- macOS 构建约 30 分钟，其中 native addon 编译约 29–31 分钟，属正常耗时。用 `gh run watch <run id> --repo sizhe233/oh-my-pi --exit-status` 等待；失败时先用 `gh run view <run id> --log-failed` 看原因，不要盲目重跑。
- workflow 里直接调用 `bun test`，必须显式传 `--timeout`；`OMP_TEST_TIMEOUT` 只被 `scripts/ci-test-ts.ts` 读取。

## 定期同步上游

频率：每周一次；上游有浏览器相关提交时尽快同步。当前还是手动流程，没有自动化。

1. 准备：`git fetch upstream && git fetch origin`，确认工作树干净且 `main == origin/main`。没有新提交（`git rev-list --count main..upstream/main` 为 0）就结束。
2. 建分支：`git switch -c sync/upstream-$(date +%Y%m%d) main`，然后 `git merge --no-ff upstream/main`。使用 merge，不使用 rebase，以保留公开历史，也不需要强推。
3. 解决冲突时优先保留 fork 行为：
   - `packages/coding-agent/src/tools/browser/**`、`packages/browser-relay/extension/**`：逐条对照上文“必须保持的行为”。上游若改了同一逻辑，把 fork 语义重新实现在上游的新结构上，不要整块回退上游代码。
   - `relay/extension-assets/*` 是生成物：不要手工合并，冲突时执行 `bun run --cwd packages/browser-relay build` 重新生成。
   - `.github/workflows/`：上游新增或恢复的 `*.yml` 一律改名为 `*.yml.upstream-disabled`，除非明确决定采用。上游对已停用 workflow 的修改接受其内容即可，文件名保持停用。
   - `bun.lock`、`package.json`：以上游为准，然后执行 `bun install`。
4. 本地验证（全部通过才能推送）：
   ```sh
   bun install --frozen-lockfile
   bun run --cwd packages/browser-relay build
   git diff --exit-code -- packages/coding-agent/src/tools/browser/relay/extension-assets
   bun --cwd=packages/coding-agent run check:types
   bun --cwd=packages/browser-relay run check:types
   cd packages/coding-agent && bun test test/tools/browser-relay-bridge.test.ts test/tools/browser-relay-daemon.test.ts \
     test/tools/browser-relay-server.test.ts test/tools/browser-relay-probe.test.ts test/tools/browser-relay-kind.test.ts \
     test/tools/browser-attach.test.ts test/tools/browser-op-tracking.test.ts test/tools/browser-screenshot-plus.test.ts \
     test/tools/browser-tab-worker-startup.test.ts test/tools/browser-launch-cwd.test.ts
   ```
5. 推送并开 PR：`git push origin sync/upstream-YYYYMMDD`，然后 `gh pr create --repo sizhe233/oh-my-pi --base main`。PR 描述写明上游区间、冲突文件及解决方式、测试结果。
6. 在同步分支上跑构建：`gh workflow run fork-build-manual.yml --repo sizhe233/oh-my-pi --ref sync/upstream-YYYYMMDD -f source_sha=<分支头完整 SHA>`。需要 Windows 产物时，同样再跑 `fork-build-windows-manual.yml`。
7. 按下文“本机安装与回退”装上该分支的产物，再按“真实 Chrome 验收”逐条核对行为 1–11。验收通过后由用户合并 PR，然后执行 `git push gitea main`。
8. 冲突无法在保持 fork 行为的前提下解决，或任何检查失败：停止，不合并，在 PR 中报告。

如果上游合入了等价修复（例如 PR #12101），优先采用上游实现，删掉对应的 fork 补丁，并更新上文改动清单。

## 本机安装与回退（macOS arm64）

`~/.bun/bin/omp` 只安装本 fork 的构建产物。**不要运行 `omp update`**：它会下载上游发布并覆盖本 fork 构建（2026-09-29 已发生过两次，备份文件形如 `omp.<时间戳>.<pid>.0.bak`）。
启动时的新版本提示（`startup.checkUpdate`）只是提示，可用 `omp config set startup.checkUpdate false` 关闭。

1. 确认没有 omp 会话在使用浏览器：`lsof -nP -iTCP:9224 -sTCP:ESTABLISHED` 里除了 relay 进程自己，只剩 Chrome（`Google`）的扩展连接。
2. 下载并校验产物：
   ```sh
   sha=<完整 SHA>; run=<run id>; dir=~/.omp/fork-builds/$sha
   export HTTPS_PROXY=http://127.0.0.1:7890  # 本机直连 GitHub 下载 artifact 极慢，走 clash 代理
   gh run download "$run" -R sizhe233/oh-my-pi -n "omp-fork-darwin-arm64-$sha" -D "$dir"
   cd "$dir" && while read -r sum name; do printf '%s  %s\n' "$sum" "$(find . -type f -name "$name")"; done \
     < coding-agent/binaries/SHA256SUMS.txt | shasum -a 256 -c
   ```
3. 替换：先 `cp -p ~/.bun/bin/omp ~/.bun/bin/omp.fork-prev`，再 `install -m 755 "$dir/coding-agent/binaries/omp-darwin-arm64" ~/.bun/bin/omp.new && mv -f ~/.bun/bin/omp.new ~/.bun/bin/omp`。
4. 冒烟：在其他项目目录运行 `omp --version && omp --smoke-test`，确认工作目录仍是调用者目录，显式 `--cwd` 也仍然生效。
5. 扩展：运行 `omp browser-relay install`，然后在 `chrome://extensions` 中点“OMP Browser Relay”卡片上的**重新加载**。这一步必须人工完成，磁盘哈希不能证明 Chrome 已加载新代码。
6. daemon：停止旧的 relay 进程（`pkill -f 'browser-relay.*--port'`；编译版进程名是 `omp browser-relay --port 9224`，源码版是 `browser-relay serve --port 9224`）。下一次 `browser.open()` 会用新二进制自动拉起；9224 端口上已有任何 relay 都会被直接复用，不检查版本，所以必须先停掉旧的。
7. 按“真实 Chrome 验收”核对行为 1–11。

已经在运行的 omp 会话仍在执行旧代码，需要用户重启会话才会用上新版；安装完成后要提醒用户。

回退：`mv -f ~/.bun/bin/omp.fork-prev ~/.bun/bin/omp`，然后重复第 5、6 步，让扩展与 daemon 跟随旧版本。

Actions 产物只保留 14 天；需要长期保留的版本，保存在 `~/.omp/fork-builds/<sha>`。

## 本机安装与回退（Windows x64）

Windows 用 `scripts/fork-install-windows.ps1`，同样**不要运行 `omp update`**。脚本支持 Windows PowerShell 5.1 和 PowerShell 7，只安装 `fork-build-windows-manual.yml` 产出、`build.json` 为 `passed` 且 SHA-256 全部匹配的构建。

1. 前提：安装并登录 `gh`（`gh auth login`）。需要代理时加 `-Proxy http://127.0.0.1:7890`。没有 `gh` 时，可在 Actions 运行页面下载 `omp-fork-windows-x64-<sha>` 的 ZIP，用 `-ArtifactDir <zip 或解压目录>` 安装。
2. 关闭所有使用浏览器的 omp 会话。脚本会检查 9224 上的连接，发现有 omp 进程仍连着 relay 就拒绝安装（`-Force` 可跳过）。
3. 运行（仓库根目录，或把脚本单独下载下来）：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fork-install-windows.ps1
   ```
   默认安装 `main` 上最新一次成功的 Windows 构建；`-RunId <id>` 指定某次构建。
4. 脚本做的事：下载到 `%LOCALAPPDATA%\omp-fork-builds\<sha>` 并校验；安装位置取当前 `omp` 命令所在目录下的 `omp.exe`（没有安装过时是 `%LOCALAPPDATA%\omp\omp.exe`，`-InstallDir` 可覆盖）；旧的 `omp.exe` 保存为 `omp.exe.fork-prev`；把同目录下 npm/bun 的 `omp`、`omp.cmd`、`omp.ps1`、`omp.bunx` 改名为 `*.fork-retired`（否则 PowerShell 仍会启动旧版）；把目录加入用户 PATH；停止旧的 relay；运行 `--version`、`--smoke-test`；执行 `omp browser-relay install` 写入扩展文件。
5. 在 Chrome 的 `chrome://extensions` 中重新加载 “OMP Browser Relay”（首次使用则“加载已解压的扩展程序”，目录是 `%USERPROFILE%\.omp\browser-relay\extension`），然后重启 omp 会话。
6. 按“真实 Chrome 验收”核对行为 1–11（Windows 上前台与窗口状态用肉眼确认即可）。

回退：`scripts\fork-install-windows.ps1 -Rollback`，恢复 `omp.exe.fork-prev` 和被改名的启动器，然后同样重新加载扩展。

## 真实 Chrome 验收

单测和 CI 通过不等于验收通过。验收要用日常 `omp` 驱动用户真实 Chrome，并与“仅单测/协议测试通过”分开汇报。

- 驱动方式：在临时目录启动 `omp --mode rpc --no-ui --auto-approve --no-session`，通过 stdin 发送 JSONL 命令 `{"id":…,"type":"prompt","message":…}`，让它只调用一次 `eval(language: js)` 执行指定代码（如 `const tab = await browser.open(); await tab.goto(url); await tab.screenshot()`）。同时起两个进程就是两个会话。
- 前台未被切走：`osascript -e 'tell application "System Events" to get name of (first process whose frontmost is true)'` 在操作前后保持不变。用户 Chrome 进程由 `--user-data-dir=…/Library/Application Support/Google/Chrome` 识别；按 PID 查询窗口标题 `name of every window` 和 `value of attribute "AXMinimized"`。
- 分组与调试提示条：读取 Chrome 辅助功能树（Swift `AXUIElement` 遍历窗口），查找 `AXTabGroup` 名称是否含 `omp/<会话 ID>`，以及文本“已开始调试此浏览器”。提示条在最后一个会话退出后几秒内消失。
- 截图结果：打开返回的截图文件，确认是目标页面的真实画面。
- 最小化场景（行为 7）：先设置 `AXMinimized` 为 true，再执行开标签和截图；结束后把窗口状态恢复到验收前的样子。
- 借用标签只做只读操作（`app.target` 指向用户已打开的页面，不导航、不点击、不关闭）；验收时新建的标签必须在结束前全部关闭。
- 验收前用 `lsof -nP -iTCP:9224 -sTCP:ESTABLISHED` 确认只有用户的 Chrome 连着 relay：其他装了扩展的 Chrome 实例（如 `~/.omp/browser-profiles/*` 下残留的后台 Chrome）也会握手，参与新建标签的路由。

## Fork 变更记录

fork 专有变更记在这里，不写进上游拥有的 `packages/*/CHANGELOG.md`，以免每次同步都产生冲突。

### 2026-09-29

- Relay 未给 `app.target` 时，改为在后台新建 omp 自有标签，不再接管当前可见标签；自有标签在释放时关闭，截图不切换前台。（F1、F2）
- 新建标签的临时 claim 交接给 worker；其他会话驱动同一标签时返回可读错误。（F2）
- 按会话分组被驱动的标签；扩展断开时解散所有 `omp`、`omp/*` 分组。（F2）
- 新增手动触发的 macOS arm64、Windows x64 构建 workflow，停用继承的上游 workflow。（F3）
- Chrome 窗口最小化时，`browser.open()` 可以新建标签，自有标签也能截图：扩展建标签时显式指定普通窗口，截图前等动画帧最多 250ms。（F4）
- 手动构建里的浏览器测试显式传 `bun test --timeout=120000`：`OMP_TEST_TIMEOUT` 只对 `scripts/ci-test-ts.ts` 生效，直接 `bun test` 时 `beforeAll` 启动 Chromium 会被 5 秒默认超时误判失败。（F3）
- 新增 `scripts/fork-install-windows.ps1`：Windows x64 一键安装、重装与回退 fork 构建，Windows 构建会在托管 runner 上实际跑一遍安装、重装、回退。（F3）

### 2026-09-30

- 新增独立 Windows 真实扩展集成 workflow 和脚本，使用临时配置及实际 Chrome for Testing/扩展/relay，保存 1–11 的显式覆盖证据；不将 headless 或协议层验证冒充完整真实 Chrome/CLI 桌面验收。（F3）
- 同名标签已打开时，`app.target` 不同的 `browser.open` 改为报错，不再静默复用别的标签。（F5）
- 会话被强杀后遗留的自有标签，由下一个连接 relay 的 omp 进程回收：自建标签写入全局 relay 运行目录下的 PID 归属记录，扩展在 hello 里报告本次浏览器会话建过的标签，relay 只关闭其中无人驱动的。（F5）
- 修复 relay 上关闭标签的兜底路径：relay 没有 browser target，`browser.target()` 直接抛错，导致 open 被放弃时的 `closeAbandonedOwnedTarget` 与强制回收时的 `closeOrphanTarget` 从未生效；改为直接向 relay 根会话发 `Target.closeTarget`。（F1、F5）
- 扩展没有 relay 时先 `fetch` 探测再拨 WebSocket，不再在扩展错误列表里每 10 秒累积一条 `ERR_CONNECTION_REFUSED`；重连只保留一条定时器链，上限 30 秒；点击工具栏图标时立即重连。（F5）
- 多个浏览器实例连着 relay 时，新建标签不再发给没有任何标签的实例：`~/.omp/browser-profiles/*` 下一个 `--no-startup-window` 后台 Chrome 也装了扩展，轮到它最后握手时 `browser.open()` 报 `No current window`。（F6）
