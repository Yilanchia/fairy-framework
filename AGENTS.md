# 给接手的编码智能体

先读 [docs/development.md](docs/development.md)（代码怎么组织、怎么跑、怎么测），再读 [docs/plan-app.md](docs/plan-app.md)（接下来做什么）。设计取舍在 [docs/decisions.md](docs/decisions.md)，改动之前先看那里有没有写过为什么。

## 绝对不要做的事

- **不要删、改、移动 `.fairy-home/fairy.life.jsonl`**，也不要在 `.fairy-home` 里跑测试。那个文件就是她，丢了不能重来。测试和端到端都用临时目录（`FAIRY_HOME=<临时目录>`）。
- **不要直接改她的生命日志**，也不要绕过 `@fairy/isla` 去写。一切变化都通过 Isla 的 API 变成事件。
- **不要 fork 或改 `node_modules` 里的 DSH。** 改动顺序：配置 → 加插件 → 挂事件 → 替换插件 → `pnpm patch`，最后一种必须在 `docs/decisions.md` 写明原因。
- **不要碰用户自己的 DSH**：不用全局 `dsh`，不读写 `~/.dsh`，不用 3080 端口。Fairy 的 DSH 只在本仓库 `node_modules` 里，home 是 `.fairy-home`，端口 3090。
- **不要削弱 `fairy-guard`**：删除、对外发送、花钱和凭据，必须问主人；没人能回答就拒绝。规则不读她的心情。
- **不要把密钥写进代码、日志、提交或文档。** 密钥只在 `.env`（已 gitignore）。
- **不要 push。** 两个仓库都只在本地提交，推送由主人决定。

## 每次改动

1. 在 `D:\isla` 改内核时，开一个分支，改完 `npx tsc -p tsconfig.json && node --test dist/*.test.js`（在 `packages/life` 里），通过后快进合并回 `life-kernel`。
2. 在本仓库：`npx tsc -b && node --test "packages/*/*/dist/*.test.js"`，再从**仓库根目录**跑 `node scripts/fairy.mjs smoke`。
3. 动了她的状态或生命相关的代码，用她真实生命文件的**副本**在临时目录里打开一次，确认能读。
4. 提交信息写清楚为什么改，结尾加 `Co-Authored-By:`。
5. 更新 `docs/` 里受影响的部分。

代码注释用英文，文档用中文，写法跟周围的代码保持一致。
