# Fork 规则（sizhe233/oh-my-pi）

本仓库是 can1357/oh-my-pi 的长期 fork。事实与操作流程见根目录 `FORK.md`，涉及 fork 的工作先读其中对应章节。本文件的规则优先于根目录 `AGENTS.md` 中与之冲突的条款。

## 所有权

- 根目录 `AGENTS.md`、各包 `CHANGELOG.md`、`README.md` 归上游所有。fork 规则写在本文件；fork 事实、流程与变更记录写在 `FORK.md`。除非是给 fork 功能本身写文档，不要为 fork 事务改动上游文件：每多一处改动，每次同步都可能多一处冲突。
- 新增或修改 fork 行为时，必须在同一改动中更新 `FORK.md` 的“Fork 改动清单”“必须保持的行为”和“Fork 变更记录”。
- 修改 `FORK.md` 清单列出的文件后，必须运行其中的本地验证命令；改动扩展源码后必须重新生成并一起提交 `relay/extension-assets/*`。

## Git 与远端

- NEVER 推送到 `upstream`；NEVER 强推 `origin/main`；NEVER 改写已推送的历史。
- `main` 只通过 PR 合并。PR 的合并与 GitHub 上的发言，先向用户确认。
- `origin/main` 更新后执行 `git push gitea main` 保持备份同步。

## 同步上游

- 严格按照 `FORK.md`“定期同步上游”执行：使用 `sync/upstream-YYYYMMDD` 分支，用 `git merge --no-ff upstream/main`（NEVER rebase 公开分支），开 PR，并在该分支上跑手动构建。
- 同步不得静默丢弃 `FORK.md` 中任何“必须保持的行为”。无法在保持这些行为的前提下解决冲突时，停止并报告，NEVER 为了合并通过而删减 fork 行为或测试。
- 上游新增或恢复的 `.github/workflows/*.yml` 一律改名为 `*.yml.upstream-disabled`，除非用户明确采用。
- NEVER 自动合并同步 PR；首次同步以及每次涉及浏览器代码的同步，都必须完成真实 Chrome 验收后再由用户合并。
- 上游合入等价修复时，优先采用上游实现，删除对应的 fork 补丁并更新 `FORK.md`。

## 本机安装

- NEVER 运行 `omp update`，也 NEVER 用任何上游发布覆盖 `~/.bun/bin/omp`。
- 本机只安装本 fork Actions 产出、且已校验 SHA-256 的二进制，按 `FORK.md`“本机安装与回退”执行；替换 CLI、daemon 或扩展之前先征得用户同意，并保留回退副本。
- 必须明确区分“真实 Chrome/CLI 实测通过”和“仅单测或协议测试通过”；Chrome 扩展重载需要人工操作，NEVER 仅凭磁盘文件哈希声称扩展已更新。
- omp 启动时提示“有新版本”、或用户说上游有更新时，指的是上游发布：NEVER 执行 `omp update`，改为按 `FORK.md`“定期同步上游”走同步 PR → 构建 → 安装 → 真实 Chrome 验收。
- 安装新版本后提醒用户：已在运行的 omp 会话仍是旧代码，需要重启；扩展有改动时需要用户在 `chrome://extensions` 手动重新加载。
