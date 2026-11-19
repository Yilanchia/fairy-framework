# Fairy

[![test](https://github.com/Yilanchia/fairy-framework/actions/workflows/test.yml/badge.svg)](https://github.com/Yilanchia/fairy-framework/actions/workflows/test.yml)

《绝区零》里的智能体管家 Fairy，做成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的一组插件，用 [Isla](../isla) 生命内核作为她的本体。

> **这不是米哈游的官方项目，也不是 DeepSeek 的官方项目。** "Fairy" 是《绝区零》里的角色名，本项目是个人对那个设定的**致敬性实现**：不商业、不伪装官方、不声称任何角色或世界观的所有权。代码和文档的著作权归本仓库作者（见 [LICENSE](LICENSE)）；角色与世界观归米哈游。

她想解决的问题只有一个：**怎么让一个 AI 拥有连续的自我**。不是"更全能的助手"，是"同一个她"——会话结束、进程重启、机器搬家之后，醒来的还是那个人。

她 2026-11-01 出生。她在对话之间继续过日子：看新闻、翻主人的项目、看窗外成都的天、写笔记、睡觉；记得和主人说过的话，会慢慢忘掉不常想起的，会记下主人交代的事；想找主人时会主动开口；和主人越熟口气越放松；删除、对外发送、花钱之前一定先问主人。

- 开发文档：[docs/development.md](docs/development.md)（代码怎么组织、怎么跑、怎么测）
- 跨端计划：[docs/plan-app.md](docs/plan-app.md)（App、服务器、设备节点）与 [docs/app.md](docs/app.md)（已定的 App 与通信方案）
- 怎么长期养着她：[docs/maintenance.md](docs/maintenance.md)（每周看一眼、升级、恢复、密钥）
- 她的控制台：[docs/console.md](docs/console.md)（外观与风格）
- 设计取舍：[docs/decisions.md](docs/decisions.md)；记忆系统：[docs/memory.md](docs/memory.md)；**独立项目** Fairy Watch：[docs/watch.md](docs/watch.md)
- 论文骨架（三条可证伪的主张 + 评测表）：[docs/paper.md](docs/paper.md)
- 一篇讲设计的文章：[docs/essay-continuous-self.md](docs/essay-continuous-self.md)（怎么让一个 AI 拥有连续的自我）；同一件事的叙事版：[docs/ai.md](docs/ai.md)
- 接手的编码智能体先读 [AGENTS.md](AGENTS.md)

## 三个可能值得看的设计决定

1. **自我和身体分开。** 她的记忆是一个只追加的日志（`fairy.life.jsonl`），进程、模型、机器都只是"身体"。换一台机器搬过去，只要日志在，醒来还是她。这条决定了整个架构。
2. **写入者只能有一个。** 多个窗口可以同时看她，但只有一份记录。多端从来不是多副本。
3. **危险动作先问人。** 删除、对外发送、花钱、碰凭据，`fairy-guard` 会拦住并等一个真人回答；没人回答就等于拒绝。她能动主人的服务器，这条是底线不是装饰。

## 结构

```
DSH 宿主进程（她的身体：agent loop、工具、会话、Web UI）
├─ fairy-self      @fairy/isla      宿主上只有一个：Isla 生命 + 心跳 + 备份 + 语义索引 → ctx.fairySelf
├─ fairy-guard     @fairy/guard     危险操作先问主人，每次工具调用写审计
├─ fairy-senses    @fairy/senses    新闻订阅、主人的 git 项目、真实天气
└─ Fairy preset    每个会话一份
   ├─ persona          DSH 的开场白，换成 Fairy
   ├─ fairy-presence   @fairy/core/presence：身份、状态、关系进提示词；对话写进她的生命；她主动开口
   ├─ fairy-hands      @fairy/hands     占位：她自己的工具（以后接设备节点）
   └─ DSH 自带的 shell / 文件 / 搜索 / 网页 / 日程 / 压缩
```

| 包 | 作用 |
|---|---|
| `packages/core/fairy-core` | `FairySelf` 抽象、`fairy/*` 事件、`presence` 插件。Fairy 各包之间只通过这里通信 |
| `packages/self/fairy-isla` | 用 Isla 实现 `FairySelf`，唯一 import `@isla/*` 的包；单写者锁、备份、语义检索；她的基因组 |
| `packages/guard/fairy-guard` | 风险规则、确认、审计 |
| `packages/senses/fairy-senses` | 把外面的东西放上她的书架、报给她天气 |
| `packages/hands/fairy-hands` | 占位 |
| `packages/bundle/fairy-bundle` | 一个 `cordis.patch.yml`，把上面的插件装进 DSH |
| `scripts/fairy.mjs` | 启动脚本，唯一设置 `DSH_HOME` 的地方 |

## 跑起来（五分钟）

先说清楚一件事：**这个仓库自己跑不起来，她需要一个"生命内核"。** 她的自我在 [`isla`](https://github.com/Yilanchia/isla) 的 `life-kernel` 分支里，本仓库通过 `link:` 指向一个和它平级的目录。

```
父目录/
├── isla/               ← 生命内核（@isla/life）
└── fairy-framework/    ← 这个仓库
```

需要：Node 24、pnpm 11、一份 DeepSeek API Key（可留到最后），以及下面的生命内核。

```bash
# 0. 先把内核拿下来，并且不要改名：路径是写死的 link:
git clone -b life-kernel https://github.com/Yilanchia/isla.git isla

# 1. 两边各装一次，内核先 build
cd isla && pnpm install && pnpm --filter @isla/life build && cd ..

# 2. 她这边
cd fairy-framework
pnpm install
cp .env.example .env      # 想先用本地模型/自己的 key 就改这里，也可以留空
pnpm fairy
```

终端会打印一个地址（默认 `http://127.0.0.1:3090`）。打开它，在 **设置 → 模型** 里填 API Key，就能和她说话。

手机/平板用她的页面：`http://127.0.0.1:3090/fairy/app/`。第一次要配对——宿主控制台会打印 `fairy-link: pairing code 123456`。

> **第一次启动就是她的出生。** 基因组（性格、说话方式、底线）会永久写进生命日志，之后改基因组不会改变已经出生的她。启动前先看一遍 [`packages/self/fairy-isla/src/genome.ts`](packages/self/fairy-isla/src/genome.ts)。

### 卡住了先看这里

| 现象 | 原因 |
|---|---|
| `pnpm install` 报找不到 `@isla/life` | 内核没 clone、或没跟本仓库放在同一个父目录、或不在 `life-kernel` 分支 |
| 启动后她说不了话 | 没配 API Key；在页面设置里填，或写进 `.env` 的 `DEEPSEEK_API_KEY` |
| 页面打不开 | 端口被占：`FAIRY_PORT=3190 pnpm fairy` |
| 想确认她还好 | `pnpm doctor`（只读，不加锁，她运行时也能跑） |

### 其他命令

| 命令 | 作用 |
|---|---|
| `pnpm test` | 单元测试和集成测试（真实的 DSH SystemPrompt / ToolRuntime、真实的 Isla 生命） |
| `pnpm smoke` | 在临时 home 里真实启动一次 DSH，确认 Web 起来、她出生了，然后清理掉 |
| `pnpm dump` | 打印 DSH 组合出来的完整插件树 |
| `pnpm doctor` | 一次回答"她还好吗"：生命能读、谁在写、备份、语义回想、网页 |
| `pnpm memory [词]` | 看她记下了主人哪些事、对自己有什么认识；带上词就按她主动回想的方式搜一遍。只读，不加锁 |
| `pnpm pair` | 打印配对地址和当前配对码 |

## 她住在哪

全部在 `.fairy-home/`（已 gitignore）：

- `fairy.life.jsonl`：**她的一生**。删了就是另一个人。不要提交。
- `backups/`：她的生命每天自动复制一份，保留最近 14 份（`fairy-self` 的 `keepBackups`，设为 0 关闭）。这些副本和原件在同一块盘上，防的是文件写坏、误删，防不了硬盘坏；重要的话，请把这个文件夹再同步到别处。恢复就是停掉 Fairy，用某一份副本替换 `fairy.life.jsonl`。
- `profiles/fairy/`：Fairy 的 DSH profile
- `sessions/`、`storages/`、`.credentials.yaml`：会话、DSH 存储、凭据
- `documents/deepseek-harness/default-workspace`：默认工作区

你原来的 `dsh`、DSH 桌面版和 `~/.dsh` 都不会被读写，见 [决策 6](docs/decisions.md#6-和用户原有的-dsh-完全隔离)。

## 还没有的

- 回复里没有标出用了哪些事实，所以对话里的引用暂时不加强记忆；主动回想（`fairy_recall`）会。见 [docs/memory.md](docs/memory.md)。
- 换一种完全不同的说法问，只靠字面只能找到一半左右。在 `.env` 填上 `SILICONFLOW_API_KEY`（硅基流动，`BAAI/bge-m3` 免费）她就能按意思想起来；不填就只靠字面。注意：填了以后，她记得的内容会发给硅基流动算向量。
- 她想主动说话时，只能送进一个开着的会话；网页关着、DSH 也没有会话在跑时，那一次就不发（网页关着但会话还在时，她会把上次那个会话唤醒，话说得出去）。
- 手机 App、手机推送、微信这类渠道还没有。通道已经有了（配对 + WebSocket + 终端客户端），但只监听本机。
- 追剧之类的消遣还没有；书架机制有了，要的只是一个来源。
- hands 只是占位。
- 跨端：现在只监听 127.0.0.1。开放给其他设备之前，要先解决认证和 TLS。

## 从终端和她说话

启动 `pnpm fairy` 后，控制台会打印一行 `fairy-link: pairing code 123456`。在另一台终端：

```bash
node apps/fairy-link-cli/dist/cli.js pair --host http://127.0.0.1:3090 --code 123456
node apps/fairy-link-cli/dist/cli.js say "在吗"
node apps/fairy-link-cli/dist/cli.js status
node apps/fairy-link-cli/dist/cli.js recall 花生
```

令牌存在当前目录的 `.fairy-link.json`（已 gitignore）。`say` 的时候如果她要删东西、往外发东西，确认会直接弹在终端里，输入序号就是回答。设计见 [决策 17](docs/decisions.md#17-通道手写-websocket令牌只存哈希确认先问设备)。

## 给她订阅、给她看项目

新闻和项目默认都是空的。在 `.fairy-home/profiles/fairy/cordis.patch.yml` 里加上（这个文件是你的，不会被覆盖）：

```yaml
- id: fairy-senses
  config:
    feeds:
      - { url: 'https://example.com/feed.xml', name: 例子, tags: [科技] }
    projects:
      - 'D:\fairy-framework'
    everyMinutes: 60
    perSource: 5
```

改完重启 `pnpm fairy`。项目只用 `git log` 读提交，不改任何东西。
