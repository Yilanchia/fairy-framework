# 架构决策

每条写清楚选了什么、为什么。推翻一条之前，先在这里改。

## 1. 在 DSH 之上做插件，不 fork

Fairy 是一组 DeepSeek Harness（DSH）插件加一个 bundle，DSH 本身不改。DSH 的 agent loop、工具、会话、提示词组装都是可替换的插件，需要的改动都能通过加插件、挂事件、替换插件做到。DSH 还在预览期，官方明确说会有破坏性更新；fork 之后每次更新都要手工合并。

魔改的手段按侵入程度从低到高：改配置 → 加插件 → 挂事件 → 替换插件 → `pnpm patch`。最后一种必须在本文件写明原因。

## 2. 版本钉死

`@deepseek-ai/dsh` 和各插件的 `engines.dsh` 都钉在 `0.2.1-rc.5`。升级 DSH 就是：改版本号 → `pnpm install` → `pnpm test` → `pnpm smoke`。

## 3. Isla 是她的本体，DSH 是她的身体

她是谁（气质、情绪、精力、经历、对自己的认识）来自 `D:\isla` 的 `@isla/life`：一份只追加的生命日志，状态由日志算出来，每句关于自己的话都能追溯到事件。DSH 提供能做什么（对话、工具、会话、界面）。

- 只有 `@fairy/isla` import `@isla/*`。Isla 的 API 变了，只改这一个包。
- 只依赖 `@isla/life`，不碰正在退役的 `@isla/core` runtime。
- 依赖用 `link:` 指向 `D:\isla\packages\life`，两边同时开发。改了 Isla 之后要在 `D:\isla` 里重新 build。

## 4. 一个本体，多个窗口

她的生命在宿主层只开一次（`fairy-self` 行），每个会话只是一个窗口（`fairy-presence` 挂在 Fairy preset 里，每个会话一份）。将来的跨端部署也是这样：各端都连同一个宿主，不复制她。

生命日志只能有一个写入者，`fairy.life.jsonl.lock` 负责保证：第二个宿主打开同一份生命会直接报错。迁移就是搬走这个文件。

## 5. 身份放 system prompt，状态放动态上下文

名字、来历、说话方式在一条生命里不变，放进 system prompt，保持 KV 缓存稳定。心情、精力、正在做什么每轮都变，走 DSH 的动态上下文，每次请求前刷新。

## 6. 和用户原有的 DSH 完全隔离

- DSH 装在项目的 `node_modules`，不用全局安装，不碰桌面版。
- 启动脚本只给子进程设置 `DSH_HOME`、`DSH_AGENTS_HOME`，不改系统环境变量。
- 端口默认 3090，不用 DSH 默认的 3080。
- 首次使用时的默认工作区在她自己的 home 里，不在系统的“文档”文件夹。
- 凭据各管各的，不读 `~/.dsh`。

## 7. 隐私默认关闭上报

不随模型请求上传会话日志（`session-log-deepseek` 关闭），不发 OpenTelemetry 反馈（`DSH_TELEMETRY_MODE=DISABLED`）。两项都可以在 Web 设置或环境变量里重新打开。

## 8. 路径必须是 ASCII

在这台 Windows 上，pnpm 在中文路径下安装会 `EPERM` 失败，同样的安装放到英文路径就成功。所以项目放在 `D:\fairy-framework`，启动脚本拒绝非 ASCII 的 DSH home。

## 9. 现阶段只读接入 Isla

会话能读她的身份、状态和事实，还不会写回她的生命。下面三个缺口要在 Isla 里补，不在 Fairy 里绕：

1. 外部感知写入（`life.perceive()`）：`World` 必须是时间的纯函数，外部事件只能作为日志事件进入。
2. 记录由外部说出的话：`hear()` 会让 Isla 自己的 Mind 回复，和 DSH agent 抢话。
3. 睡眠语义：Isla 睡着不回话，管家要随叫随到。

在这之前，和她的对话不会进入她的生命日志。
