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

## 9. 对话进入她的生命

缺的接口补在 Isla 里，不在 Fairy 里绕：

- `listen()`：主人的话在模型被调用之前记成 `heard`（挂在 DSH 的 `agent/pre-step` 上，等它写完再发请求），所以这一轮的动态上下文已经反映她被叫醒、被勾起的记忆。她自己的心智不回话，不和 DSH agent 抢话。
- `speak()`：一轮结束（`session/event` 的 `turn/end`）时，把这一轮 assistant 的文字记成 `said`，`external: true`，不占她的心智预算。超过 2000 字只记开头，全文在 DSH 会话里。一轮什么都没说出来（比如模型出错），就不记，那句话保持没人回答。
- 睡着时被叫，会醒来，越累越有起床气。管家随叫随到，被叫醒这件事也是她的经历。
- 危机消息：Isla 给出固定回复，`fairy-presence` 要求模型在这一轮第一段一字不差地说出来。
- 只记人打的字（`source.kind === 'user'`），DSH 注入的上下文（文件变化、技能内容、定时提醒）不算她听到的话。
- 写生命日志失败只记警告，不拦对话。宁可漏记一句，不能让她不回话。

还缺外部感知（`life.perceive()`）：`World` 必须是时间的纯函数，外部事件只能作为日志事件进入。

## 10. 记忆是日志的视图

见 [memory.md](memory.md)。记忆不是第二份数据，是 Isla 日志上的索引，删掉可以重建；检索和遗忘不调用模型。Fairy 的 genome 里 `memory: { decay: 0.4, records: ['heard', 'said'] }`：比人忘得慢，和主人说过的话主动查时永远原样可查。

每轮自然想起的几条进动态上下文，主动回想用 `fairy_recall` 工具，记下主人的事用 `fairy_note`（只能引用主人这一轮说的话）。还没办的事是 `pending` 的记录，常驻在她的事实里；到点提醒交给 DSH 的定时任务，不在她的生命里另做一套调度。DSH 的回复还没有标出用了哪些事实，所以对话里的引用暂时不算“用到”这段记忆；只有 `fairy_recall` 找到的会被加强。要标出引用，得先能在显示前处理最终回复。
