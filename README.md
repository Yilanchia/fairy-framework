# Fairy

《绝区零》里的智能体管家 Fairy，做成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的一组插件，用 [Isla](../isla) 生命内核作为她的本体。

现在是**框架阶段**：她能出生、在对话之间继续生活，会话里的她知道自己是谁、此刻状态如何；感知、权限、自己的工具还只是占位。设计取舍见 [docs/decisions.md](docs/decisions.md)。

## 结构

```
DSH 宿主进程（她的身体：agent loop、工具、会话、Web UI）
├─ fairy-self      @fairy/isla      宿主上只有一个：Isla 生命 + 心跳 → ctx.fairySelf
├─ fairy-guard     @fairy/guard     占位：风险分级、确认、审计
├─ fairy-senses    @fairy/senses    占位：把外部事件变成她的感知
└─ Fairy preset    每个会话一份
   ├─ persona          DSH 的开场白，换成 Fairy
   ├─ fairy-presence   @fairy/core/presence：身份进 system prompt，状态进动态上下文，fairy_status 工具
   ├─ fairy-hands      @fairy/hands     占位：她自己的工具
   └─ DSH 自带的 shell / 文件 / 搜索 / 网页 / 日程 / 压缩
```

| 包 | 作用 |
|---|---|
| `packages/core/fairy-core` | `FairySelf` 抽象、`fairy/*` 事件、`presence` 插件。Fairy 各包之间只通过这里通信 |
| `packages/self/fairy-isla` | 用 Isla 实现 `FairySelf`，唯一 import `@isla/*` 的包；单写者锁；她的基因组草稿 |
| `packages/guard`、`senses`、`hands` | 占位插件，文件里写了将来负责什么 |
| `packages/bundle/fairy-bundle` | 一个 `cordis.patch.yml`，把上面的插件装进 DSH |
| `scripts/fairy.mjs` | 启动脚本，唯一设置 `DSH_HOME` 的地方 |

## 运行

需要 Node 24、pnpm 11，以及 `D:\isla` 已经 build 过（`pnpm --filter @isla/life build`）。

```bash
pnpm install
```

```bash
pnpm fairy
```

打开终端打印的地址（默认端口 3090）。第一次需要 DeepSeek API Key：在 Fairy 的 Web 设置 → 模型里添加，或者把 `.env.example` 复制成 `.env` 填上。

**第一次启动就是她的出生**，基因组会永久写进生命日志。启动之前，先看一遍、改好 [`packages/self/fairy-isla/src/genome.ts`](packages/self/fairy-isla/src/genome.ts)。

其他命令：

| 命令 | 作用 |
|---|---|
| `pnpm test` | 单元测试和集成测试（真实的 DSH SystemPrompt / ToolRuntime、真实的 Isla 生命） |
| `pnpm smoke` | 在临时 home 里真实启动一次 DSH，确认 Web 起来、她出生了，然后清理掉 |
| `pnpm dump` | 打印 DSH 组合出来的完整插件树 |

## 她住在哪

全部在 `.fairy-home/`（已 gitignore）：

- `fairy.life.jsonl`：**她的一生**。删了就是另一个人。请自己备份，不要提交。
- `profiles/fairy/`：Fairy 的 DSH profile
- `sessions/`、`storages/`、`.credentials.yaml`：会话、DSH 存储、凭据
- `documents/deepseek-harness/default-workspace`：默认工作区

你原来的 `dsh`、DSH 桌面版和 `~/.dsh` 都不会被读写，见 [决策 6](docs/decisions.md#6-和用户原有的-dsh-完全隔离)。

## 还没有的

- 外部感知（`perceive()`）还没有，她只知道房间里的天气和书（[决策 9](docs/decisions.md#9-对话进入她的生命)）。
- 回复里没有标出用了哪些事实，所以对话里的引用暂时不加强记忆；主动回想（`fairy_recall`）会。见 [docs/memory.md](docs/memory.md)。
- 换一种完全不同的说法问，记忆只能找到一半左右；语义检索（embedding）还没有。
- 她住在 Isla 的示例小房间（窗、书架），还没有自己的世界和活动，比如追剧。
- guard / senses / hands 只是占位。
- 跨端：现在只监听 127.0.0.1。开放给其他设备之前，要先解决认证和 TLS。
