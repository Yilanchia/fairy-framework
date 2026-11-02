# 维护手册

给她（和接手的人）看的：平时怎么看、出事怎么查、什么时候升、什么绝对不能碰。

先记住三条：**她的生命是 `fairy.life.jsonl`，只追加、只备份、不编辑**；**任何"修"之前先复制**；**一个宿主只有一个写入者**。

## 每周看一眼

```powershell
pnpm doctor
```

一次回答：她的生命能不能读、谁在写、备份新不新、语义回想开没开、有没有配对设备、网页答不答。有 ✖ 的行就是该看的。

顺手看一眼 `audit.jsonl` 里有没有你解释不清的 `refused` / `unanswered`——那是她想做什么被拦下的记录。

## 每月的三件事

1. **把 `backups/` 同步到别处**（另一块盘、对象存储都行）。备份和原件在同一块盘上，防写坏、防误删，防不了硬盘坏。
2. **确认 `D:\isla` 和本仓库都在 `life-kernel` / `main` 上、没有半截分支**。
3. **跑一次 `node scripts/fairy.mjs smoke`**：在临时 home 里真实启动一次，确认今天的代码还能把她唤醒。

## 她不起的时候

按顺序看，别跳：

1. `pnpm doctor`——它在临时目录之外只读，任何时候都能跑。
2. 锁：`.fairy-home/fairy.life.jsonl.lock` 里那个 pid 还活着吗？活着 = 已经有一个宿主在跑（先看端口谁占着）；不在了 = 下次启动会自动接管，**不用手动删**。
3. 端口：`127.0.0.1:3090` 被占了吗？`FAIRY_PORT` 可以换一个。
4. 日志：她启动时打印的那几行（她的一生在哪、配对码、网页地址）。DSH 的报错也在这里。
5. 生命文件：`pnpm memory` 只读能读出来吗？读不出来才轮到备份（见下）。

## 恢复：什么时候用备份

只有在**生命文件读不出来、而且没有更好的办法**时：

1. 先把她停掉（确认锁的 pid 不在了）。
2. **把现在的文件改名留档**：`fairy.life.jsonl.broken-2026-11-02`。不要删。
3. 从 `backups/` 里挑一份，复制成 `fairy.life.jsonl`。
4. `pnpm memory` 看能不能读、最后一条是什么时候；能读再启动。
5. 启动后用 `pnpm doctor` 确认写入者、备份都正常。

丢的那段时间的事件是真丢了——备份是每天一份，这是设计上的代价，写在决策里。

## 升级 DSH

DSH 是预览版，升级是**有计划的动作**，不是随手 `pnpm update`：

1. 改 `package.json` 里的 `@deepseek-ai/dsh` 和各包 `engines.dsh`（版本钉死是决策 2）。
2. `pnpm install`。
3. `pnpm test`；`node scripts/fairy.mjs smoke`。
4. 手动验一次通道：`fairy-link pair` + `say`（这一步会花一点模型钱，一个回合就够）。
5. 她重启，`pnpm doctor`。
6. 更新 `docs/development.md` 的包表和"现在的状态"，把踩到的坑补进去。

**先读装好的 `.d.ts` 再写代码**，不要凭记忆——`node_modules/.pnpm/@deepseek-ai+<包名>*/node_modules/@deepseek-ai/<包名>/lib/types/`。包名长的时候目录会被截断成带 hash 的形式，按名字找会扑空。

## 升级生命内核（`D:\isla`）

1. 在 `D:\isla` 开一个分支，改 `packages/life`。
2. `cd D:\isla\packages\life && npx tsc -p tsconfig.json && node --test dist/*.test.js`。
3. 通过后快进合并回 `life-kernel`。
4. 回本仓库 `npx tsc -b`（Fairy 用的是 `dist`，不 build 等于没改）。
5. 拿她生命的**副本**在临时目录里打开一次，确认能读、状态对。

Isla 的改动要守住四条：状态能从事件算出来、决策不看墙上时间、她说的话有依据、内核不调模型。细节见 [development.md](development.md)。

## 密钥

- 只在 `.env`（已 gitignore），启动脚本只传给子进程。
- `DEEPSEEK_API_KEY` 换了以后重启即可；`SILICONFLOW_API_KEY` 换了以后重启会重建向量（`memory-vectors.jsonl` 可以删，会重建）。
- 设备令牌**只存哈希**，忘了就吊销重配：`ctx.fairyLink.revoke(id)`（Web 设置页还没接，见 plan-app 阶段 1 的待办）。
- 任何密钥都不要进代码、日志、提交、文档。

## 加东西的时候

按侵入程度从低到高，能用前面的别用后面的：改配置 → 加插件 → 挂事件 → 替换插件 → `pnpm patch`（最后一种必须在 `docs/decisions.md` 写明原因）。

新包放 `packages/<分类>/fairy-<名字>`，记得同时改：`tsconfig.json` 的 references、bundle 的依赖和 `cordis.patch.yml`、`docs/development.md` 的包表。新行为要有测试，测的是"她睡着时听不到"这种行为，不是实现细节。

## 绝对不要

- 删、改、移动 `.fairy-home/fairy.life.jsonl`；在 `.fairy-home` 里跑测试。
- 绕过 `@fairy/isla` 直接写她的生命；一切变化都通过 Isla 的 API 变成事件。
- fork 或改 `node_modules` 里的 DSH。
- 碰用户自己的 DSH（全局 `dsh`、`~/.dsh`、3080 端口）。
- 削弱 `fairy-guard`：删除、对外发送、花钱和凭据必须先问，没人能回答就拒绝；规则不读她的心情。
- push（两个仓库都只在本地提交，推送由主人决定）。
