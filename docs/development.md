# 开发文档

写给接手开发的人和编码智能体。讲清楚代码怎么组织、怎么跑、怎么测、哪些地方不能碰。为什么这样设计见 [decisions.md](decisions.md)，记忆系统见 [memory.md](memory.md)，接下来的计划见 [plan-app.md](plan-app.md)。

## 一句话

Fairy 是《绝区零》里的智能体管家，做成 DeepSeek Harness（DSH）的一组插件。她的“本体”（她是谁、经历过什么、记得什么、心情和精力）是 Isla 生命内核里的一份只追加日志；DSH 是她的“身体”（模型调用、工具、会话、Web 界面）。

## 两个仓库

| 仓库 | 位置 | 是什么 | 分支 |
|---|---|---|---|
| fairy-framework | `D:\fairy-framework` | 本仓库：DSH 插件、启动脚本、文档 | `main` |
| isla | `D:\isla` | 生命内核 `@isla/life`（以及正在退役的 `@isla/core`） | `life-kernel` |

`packages/self/fairy-isla` 用 `link:` 指向 `D:\isla\packages\life`。**改了 Isla 必须在 `D:\isla\packages\life` 里重新 build**，Fairy 才看得到。只有 `@fairy/isla` 这一个包可以 import `@isla/*`。

两个仓库都没有远端，只在本地提交。

## 运行起来是什么样

```
DSH 宿主进程（node node_modules/@deepseek-ai/dsh/lib/bin.js --profile fairy）
├─ fairy-self     @fairy/isla     宿主上只有一个：Isla 生命 + 心跳 + 备份 + 语义索引 → ctx.fairySelf
├─ fairy-guard    @fairy/guard    每次工具调用先过这里：危险操作问主人，全部写审计
├─ fairy-senses   @fairy/senses   新闻订阅、主人的 git 项目、成都天气 → 她的书架和窗外
└─ Fairy preset（每个会话一份）
   ├─ persona          DSH 开场白换成 Fairy
   ├─ fairy-presence   @fairy/core/presence：身份、状态、关系口气进提示词；对话写进她的生命；
   │                   fairy_status / fairy_recall / fairy_note 工具；把她想说的话变成一轮对话
   ├─ fairy-hands      @fairy/hands  她自己的工具：blog_publish（WordPress XML-RPC）
   └─ DSH 自带的 shell / 文件 / 搜索 / 网页 / 日程 / 压缩
```

装配在 `packages/bundle/fairy-bundle/cordis.patch.yml`。主人自己的覆盖在 `.fairy-home/profiles/fairy/cordis.patch.yml`（不在仓库里，后加载，同 id 的行整行替换 `config`）。

## 数据都在哪（`.fairy-home/`，已 gitignore）

| 路径 | 是什么 | 能不能删 |
|---|---|---|
| `fairy.life.jsonl` | **她的一生**，只追加的事件日志 | 绝对不能 |
| `fairy.life.jsonl.lock` | 单写者锁，存着持有进程的 pid | 进程死了才能删 |
| `backups/` | 每天一份生命副本，保留 14 份 | 可以，但别全删 |
| `memory-vectors.jsonl` | 语义检索的向量缓存 | 可以，会重建 |
| `audit.jsonl` | 每次工具调用的审计记录 | 不要删，主人要看 |
| `devices.json` | 配过对的设备；只存令牌的 SHA-256 | 删了就要重新配对 |
| `workspace/` | 从设备新开的会话所在的目录 | 可以 |
| `profiles/fairy/` | DSH profile；`cordis.patch.yml` 是主人的配置 | 别覆盖 |
| `sessions/` | DSH 会话日志（zstd 多帧拼接） | 别删 |
| `.credentials.yaml` | DSH 存的凭据 | 别读别打印 |

## 包和职责

| 包 | 关键文件 | 负责什么 |
|---|---|---|
| `@fairy/core` | `src/index.ts` | `FairySelf` 抽象类和所有 `Fairy*` 类型、`fairy/*` 事件。Fairy 各包之间**只通过这里**通信 |
| | `src/presence.ts` | 会话里的她：提示词段、`agent/pre-step` 里 `hear()`、`turn/end` 时 `speak()`、`fairy/urge` → 一轮她自己开始的对话（没有开着的会话时用 `sessionController.resolveAgent()` 唤醒上次那个）、三个工具 |
| | `src/render.ts` | 所有给模型看的文字：身份、聊天样子 `DEFAULT_CHAT_STYLE`、关系口气 `DEFAULT_BOND_TONES`、事实、回忆 |
| `@fairy/isla` | `src/index.ts` | `IslaSelf`：打开生命、心跳、备份、语义索引，把 `FairySelf` 的每个方法翻译成 Isla 调用 |
| | `src/genome.ts` | 她出生时的基因组。**她已经出生，改这里不影响她**，只影响新生命 |
| | `src/semantic.ts` | 硅基流动 embedding 和向量缓存 |
| | `src/lock.ts` `backup.ts` `inspect.ts` | 单写者锁、每日备份、`pnpm memory` 的只读查看 |
| `@fairy/guard` | `src/rules.ts` | 纯函数规则：一次调用属于 routine / destructive / outward / money |
| | `src/index.ts` | `tools/pre-execute` 里先问设备（`ctx.get('fairyLink')`），再问 Web UI（`userQuestions`，默认 120 秒没人答就拒绝）、写审计 |
| `@fairy/senses` | `feed.ts` `projects.ts` `weather.ts` | RSS/Atom 解析、`git log` 读项目、wttr.in 天气 |
| | `index.ts` | 定时读，`stock()` 放上书架，`perceive()` 报天气 |
| `@fairy/hands` | `src/index.ts` | 她自己的工具：今天只有 `blog_publish`（走 WordPress REST API 发文章，默认存草稿） |
| `@fairy/protocol` | `src/index.ts` | 她和设备之间的线：版本化的消息类型 + 两端共用的校验（`parseClient` / `parseHost`）。纯 TypeScript，不 import DSH |
| `@fairy/link` | `src/devices.ts` `src/pairing.ts` | 已配对设备（令牌只存哈希）、一次性配对码 |
| | `src/socket.ts` | 手写的 WebSocket：握手、文本帧、分片、ping/close。服务端和 CLI 客户端共用 |
| | `src/index.ts` | `FairyLink` service：`/fairy/link/pair` 配对、`/fairy/link/v1` 通道（`hello` / `say` / `status` / `recall` / `sessions` / `answer`）、把 `reply.done` 推回设备、`fairy/urge` 转推送、`user-questions/request` 转 `confirm` |
| `fairy-link-cli` | `apps/fairy-link-cli/src/cli.ts` | 终端设备：`pair` / `say` / `status` / `recall`，也是阶段 1 的验收客户端 |
| `@fairy/app` | `src/index.ts` | 在 `/fairy/app/` 发她的页面：`web/index.html`、`web/app.js`，以及从 `@fairy/protocol` 读出来的 `protocol.js`。只发这三个文件，按名字 |
| | `web/app.js` | 页面本身：配对、连接、收发。手写 ESM，没有构建步骤 |
| `@fairy/bundle` | `cordis.patch.yml` | 把以上装进 DSH |
| `scripts/fairy.mjs` | | 启动脚本：唯一设置 `DSH_HOME` 的地方；读 `.env`；`setup` / `web` / `smoke` / `dump` / `memory` |

Isla 这边（`D:\isla\packages\life\src`）：

| 文件 | 负责什么 |
|---|---|
| `events.ts` | 所有事件类型。**加新事件从这里开始** |
| `state.ts` | `fold()`：事件 → 状态。状态只是日志的折叠，`replay()` 能精确重建 |
| `life.ts` | `Life` 类：心跳、决策点、`listen/speak/perceive/stock/note/remember/recall`、睡眠整理、关系 |
| `activities.ts` | 她能做的事（`ActivityKind`）、`shelfActivity()` |
| `facts.ts` | `gatherFacts()`：给模型看的事实。**她能说的关于自己的话都从这里来** |
| `recall.ts` | 记忆索引：ACT-R 激活、BM25、时间词、清晰度、语义线索 |
| `consolidate.ts` | 睡眠时把一天切成片段、周和月写成章节 |
| `mind.ts` | `InnerMind`：不调模型的保底心智，写笔记和日记 |
| `world.ts` | 她的房间：窗、天（`sky: "host"` 时由宿主报）、书架 |

## 怎么扩展

按侵入程度从低到高，能用前面的就别用后面的：

1. **改配置**：主人的 `cordis.patch.yml`，或 bundle 里的默认值。
2. **加插件**：新建 `packages/<分类>/fairy-<名字>`，在 bundle 里 `insert`。宿主级插件放在顶层 `insert`，每会话插件放进 `preset-fairy` 的 `plugins`。
3. **挂事件**：`ctx.on('agent/pre-step' | 'session/event' | 'tools/pre-execute' | 'user-questions/request' | ...)`。
4. **替换插件**：同 id 换 `name`。
5. **`pnpm patch`**：最后手段，必须在 `decisions.md` 写原因。

需要她的本体做新的事（新的事件、新的状态），改 Isla，不在 Fairy 里绕。Isla 的改动要保持：

- **生命是日志的折叠**：新状态字段必须能从事件算出来；`replay(events)` 和活着的状态必须一致（测试 `rebuilds the exact same state from the log alone`）。
- **决策只看状态、世界和种子**，不看墙上时间，这样同一段人生重放结果一样。外部的东西只能通过事件进来（`perceive`、`stock`、`listen`）。
- **她说的关于自己的话都有依据**：新信息要能进 `gatherFacts`，并且带着来源事件的 id。
- **内核不调用模型**。模型只在 `Mind` 里（可替换），语义检索由宿主算好作为 `similar` 传进来。
- 旧的生命文件要能打开：新字段给默认值，`fold` 对旧事件不报错。

DSH 的 API 文档就在依赖里：`node_modules/.pnpm/@deepseek-ai+<包名>*/node_modules/@deepseek-ai/<包名>/README.md` 和 `lib/types/*.d.ts`。DSH 是预览版，**用之前先读装好的 `.d.ts`**，不要凭记忆。版本钉在 `0.2.1-rc.5`。

## 日常命令

**在 PowerShell 里用 pnpm**。这台机器的 cmd.exe 找不到 pnpm（系统 PATH 有一项断开了），所以脚本里不要嵌套调用 `pnpm`；在 bash 或 cmd 里直接用 `npx tsc` 和 `node`。

| 做什么 | 命令 |
|---|---|
| 装依赖 | `pnpm install`（PowerShell） |
| 编译 | `npx tsc -b` |
| 测试 | `npx tsc -b && node --test "packages/*/*/dist/*.test.js"` |
| 冒烟（真实启动一次 DSH，临时 home） | `node scripts/fairy.mjs smoke`，**必须在仓库根目录** |
| 启动她 | `pnpm fairy`，不想弹浏览器加 `-- --no-open` |
| 看她记得什么 | `pnpm memory [词]`，只读 |
| 看她还好吗 | `pnpm doctor`，只读：生命、写入者、备份、语义回想、设备、网页 |
| 看 DSH 组合出的插件树 | `pnpm dump` |
| 编译测试 Isla | `cd D:\isla\packages\life && npx tsc -p tsconfig.json && node --test dist/*.test.js` |
| Isla 一年记忆评测 | `cd D:\isla\evals && npx tsc -p tsconfig.json && node --test dist/memory.eval.test.js`（约 30 秒） |
| Isla 全仓类型检查 | PowerShell：`pnpm -r typecheck`（在 `D:\isla`） |

`.env`（已 gitignore）里放 `DEEPSEEK_API_KEY`，可选 `SILICONFLOW_API_KEY`。启动脚本只把它传给 DSH 子进程，不改系统环境变量。

## 测试的规矩

- **新行为要有测试**，测的是行为（“她睡着时听不到”），不是实现细节。测试名写成一句话。
- **用真的 DSH 组件**：`ToolRuntime`、`SystemPrompt`、`UserQuestionService` 都能在一个 `new Context()` 里装起来（见 `guard.test.ts`、`presence.test.ts`）。DSH 的事件用 `ctx.waterfall` / `ctx.emit` 派发，和真实运行时一样。
- **Isla 的测试用 `MemoryArchive` 和假时钟**，一天几百毫秒就能模拟完。不要真的等时间。
- **端到端只在临时目录里做**：`FAIRY_HOME=<临时目录> FAIRY_PORT=<别的端口> node scripts/fairy.mjs web --no-open`。做完杀掉进程、删目录。需要额外插件时直接调 `node node_modules/@deepseek-ai/dsh/lib/bin.js --profile fairy --patch <yml>`，因为启动脚本把多余参数放在 `--port` 后面，DSH 会把它们当成应用参数。
- **碰了她的生命相关代码**，把 `.fairy-home/fairy.life.jsonl` **复制**到临时目录，用新代码打开一次，确认能读、状态对。
- 要用她的模型做真实验证时，花的是主人的钱，能用单元测试证明的就别跑模型。

## 踩过的坑

- **`tsc -b` 和编辑同时进行会编出旧代码**。测试结果和刚改的不一致时，先重新编译再看。
- **改了 Isla 忘了 build**，Fairy 用的还是旧的 `dist`。
- **从子目录跑 `node scripts/fairy.mjs`** 会找不到脚本，必须在仓库根目录。
- **同一份生命只能有一个进程打开**。端口被占或锁被占时，先查 `--profile fairy` 的 node 进程；不要删锁，除非确认那个 pid 已经没了。
- **DSH 会话日志是多个 zstd 帧拼接的**，`zlib.zstdDecompressSync` 只解第一帧，要按魔数 `28 b5 2f fd` 切开逐帧解。
- **schemastery 的可选对象**：`z.object({ a: z.string().required() })` 作为可选字段时，默认值 `{}` 会因为缺 `a` 而校验失败，整个插件起不来。可选对象里的字段都不要 `required()`，在代码里判断。
- **`assert.deepEqual` 会把变量的类型收窄**成被比较的字面量类型，之后再访问别的字段会报类型错。
- **DSH 的审批策略设成 never 时，`tools/pre-execute` 返回 `ask` 会被直接拒绝**。要问主人只能走 `userQuestions`，guard 就是这样做的。
- **Windows 上 `/tmp` 不是 `C:\tmp`**。Node 里用 `os.tmpdir()`；bash 里用 `$LOCALAPPDATA/Temp` 并用 `cygpath -w` 转路径。

## 现在的状态（2026-11-02）

- 她 2026-11-01 出生；**2026-11-02 搬到了服务器 `38.244.14.207`**，以 `fairy` 账号 + `fairy.service` 常驻。PC 上那份 `.fairy-home/` 留作回滚，不再启动。部署细节见 [maintenance.md](maintenance.md)。
- 测试：Fairy 164 个，Isla 64 个，一年记忆评测通过，冒烟通过。
- 已有：对话进入生命、会忘会记的记忆、睡眠整理、记下的事、主动找主人（网页关着时也会唤醒上次那个会话）、新闻和项目两样消遣、成都真实天气、安全确认和审计、聊天样子、关系随相处变深、按意思回想、通道（配对 + WebSocket + 终端客户端）、她自己的页面 `/fairy/app/`（配对、聊天、历史记录、发图片、发文本文件）。
- 没有：手机和别的设备上的 App、网页和 App 都关着时把话推到手机上、进程守护、设备上的手脚。这些是 [plan-app.md](plan-app.md) 的内容。
- 已知小问题：回复里没有标出用了哪些事实，所以对话里的引用不加强记忆，只有 `fairy_recall` 会。
