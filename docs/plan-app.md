# 跨端计划：一个她，很多个入口

目标：主人在手机、电脑、平板、浏览器上都能找到同一个 Fairy；她能连上主人的主机、服务器等设备，在主人允许的范围里看和动手。

这份是计划，不是现成的规格。里面提到的 DSH 接口都是 `0.2.1-rc.5` 里看到的，**动手前对照装好的 `.d.ts` 再确认一遍**。

## 不变的原则

1. **只有一个她**。她的生命只在一台宿主上，单写者锁保证。所有设备都是她的窗口或手脚，不复制她。迁移就是停掉旧宿主、搬走 `fairy.life.jsonl`。
2. **宿主做决定，设备只执行**。确认规则（`fairy-guard`）、审计、她的记忆都在宿主上。设备不能自己决定执行危险操作，也不能绕过宿主。
3. **App 和 QQ 都只是通道**。通道是 Fairy 的插件，接在 DSH 会话上；换通道不改她。
4. **默认不对公网开放**。能用私有网络（Tailscale / ZeroTier / WireGuard）就不用公网；要用公网必须 HTTPS + 设备令牌。
5. **确认要能到主人手上**。她想删东西、对外发送、花钱时，主人在哪个设备上，确认就要能弹到哪个设备上；没人能回答，就拒绝。

## 目标结构

```
                    ┌──────────── 宿主（服务器）────────────┐
 手机 App ─┐        │  DSH + Fairy                          │
 电脑 App ─┼─WSS──▶ │   ├─ fairy-self   她的生命（唯一）     │
 浏览器  ──┤        │   ├─ fairy-guard  确认 + 审计          │
 QQ(可选) ─┘        │   ├─ fairy-link   通道：会话、推送、确认│ ◀──WSS── 设备节点（主人的 PC、NAS…）
                    │   └─ fairy-hands  把节点包装成她的工具  │            只执行，本地也有黑名单
                    └───────────────────────────────────────┘
```

新包：

| 包 | 放哪 | 是什么 |
|---|---|---|
| `@fairy/link` | `packages/link/fairy-link` | 宿主插件：配对、设备令牌、通道协议、把消息接到 DSH 会话、推送她想说的话、转发确认 |
| `@fairy/protocol` | `packages/link/fairy-protocol` | 通道协议的类型和校验（App、节点、宿主共用），纯 TypeScript，不依赖 DSH |
| `fairy-node` | `apps/fairy-node` | 跑在每台设备上的小程序：连宿主、报能力、执行宿主派来的动作 |
| `@fairy/app` | `packages/app/fairy-app` | 她自己的页面：`/fairy/app/`，配对 + 聊天（M1 已通）。静态资源必须跟包走，所以不在 `apps/` 下 |

`pnpm-workspace.yaml` 要加上 `apps/*`。

## 阶段 0：上服务器

先让她在服务器上稳稳地活着，再谈多端。

- 服务器上装 Node 24、pnpm 11，拉两个仓库，`D:\isla` 换成服务器上的路径（`packages/self/fairy-isla/package.json` 里的 `link:` 要改，或者改成 workspace 依赖）。
- 进程守护：Linux 用 systemd（`Restart=always`），崩了自动起来，开机自启。启动命令就是 `node scripts/fairy.mjs web --no-open`。
- 访问：优先 Tailscale，只在私有网络里能访问；要公网就放在 Caddy / Nginx 后面，HTTPS，DSH 本身有 `--public-url`、`--trusted-host`、`--tls-cert/--tls-key`。
- 密钥：`.env` 放在服务器上，权限 600，不进仓库。
- 备份：`backups/` 每天同步到另一处（对象存储或主人的 PC）。
- 迁移她：停掉 PC 上的她 → 拷 `fairy.life.jsonl`（和 `memory-vectors.jsonl`，可选）到服务器 → 启动 → 确认 `pnpm memory` 能看到她的记忆 → PC 上的副本改名留作备份。
- senses 配置里的项目路径要改成服务器上的路径，或者以后改由节点上报（阶段 4）。

**验收**：服务器重启后她自己起来；从主人的手机浏览器经私有网络能打开 Web 界面聊天；`audit.jsonl`、`backups/` 正常增长。

## 阶段 1：`@fairy/link`，通道协议

基本完成（2026-11-02）：从配对到聊天、问她状态、查记忆、把确认弹到设备上，都已经在临时 home 里真跑通过一次。

- ✅ `@fairy/protocol`：版本化的消息类型，两端共用的 `parseClient` / `parseHost`，未知类型、版本不符、超长、空消息都带稳定的拒绝码。
- ✅ 配对：`POST /fairy/link/pair` 用控制台打印的一次性码换令牌（5 分钟、用一次作废、换新的作废旧的、错 5 次锁 5 分钟）；`DeviceStore` 只存令牌的 SHA-256，可吊销。
- ✅ `/fairy/link/v1` 的 WebSocket（手写 RFC 6455 文本帧）：`hello` 认证 → `say` 送进她上次的会话（没有就新开一个）→ `reply.done` 带回她的整段回复；`status`、`recall`、`sessions` 可用。
- ✅ 确认：`fairy-guard` 先问配对设备的 `confirm()`，设备有答案就用它；没有设备、或设备没在超时内回答，才走 `user-questions/request` 的 Web UI（120 秒后仍无人回答就拒绝）。实测（2026-11-02）：终端里叫她删文件，卡片带着完整命令弹在终端，回车选“不允许”→ guard 拒绝、写进审计、她如实回报没删掉。
- ✅ `apps/fairy-link-cli`：`pair` / `say` / `status` / `recall`，能配对、聊天、回答确认。
- ⬜ 流式：现在只有 `reply.done`（整段），`reply.delta` 的协议和 `assistantStream` 还没接；App 要打字机效果时再做。
- ⬜ 设备上的确认卡片在 Web UI 回答后不会自动收起（协议还没有撤回帧）。
- ⬜ 令牌吊销还没接到 Web 设置页（现在是 `ctx.fairyLink.revoke(id)`）。

## 阶段 1（原计划，保留细节）

### 接到 DSH 上

- 路由：`ctx.webServer.register({ kind: 'exact', path: '/fairy/link/pair', handler })` 和 `ctx.webServer.registerUpgrade({ path: '/fairy/link/v1', handler })`（`@deepseek-ai/dsh-host-webserver`）。和 DSH Web 同端口、同 TLS。
- 会话：`ctx.sessionController.create({ agentPreset: 'fairy' })` 建会话，`prompt({ sessionId, mode: 'queue', content, requestId })` 发消息，`follow({ address, assistantStream: true })` 拿流式回复，`resolveAgent(sessionId)` 唤醒一个冷会话（`@deepseek-ai/dsh-api-session-controller`）。
- 主人在 App 里说的话，要让 `fairy-presence` 当成“主人打的字”：`sessionController.prompt()` 生成的消息 `source.kind` 是 `user`（看过 `dsh-api-session-controller` 的实现），presence 会 `hear()`。但 `prompt()` 会从 `ctx.invocation` 读调用者（Remote 调用的上下文），插件直接调用时可能没有。**先写一个测试确认插件里直接调用能工作**；不行就退一步，用 `resolveAgent(sessionId)` 拿到 agent 后 `agent.followup(createUserMessage({ content, source: { kind: 'user' } }))`，这条路 `fairy-presence` 处理她主动开口时已经在用。
- 每个设备默认接主人“当前的会话”（最近一个 Fairy 会话）；App 里可以开新会话、切换会话。

### 配对和认证

- 宿主上生成一次性配对码（控制台打印，或 Web 设置页显示），有效 5 分钟，用一次作废。
- App 用配对码换一个设备令牌；令牌只存哈希，存在 `.fairy-home/devices.json`，带设备名、类型、创建时间、最后在线时间。
- 每个令牌可以单独吊销；Web 里能看到所有设备。
- 认证失败要限速。只有主人一个人：没有注册，没有多用户。

### 协议草案（WebSocket，JSON，每条有 `type` 和 `id`）

设备 → 宿主：

| type | 内容 |
|---|---|
| `hello` | 设备名、类型、协议版本、能收什么（`push`、`confirm`） |
| `say` | 主人说的话（文字；以后加图片、语音），可选会话 id |
| `answer` | 对一次确认的回答：允许 / 不允许 |
| `recall` | 查她的记忆（同 `fairy_recall`），给 App 的“她记得什么”页 |
| `status` | 要她此刻的状态（醒着睡着、在做什么、心情、和主人的关系） |
| `sessions` | 列出 / 新建 / 切换会话 |

宿主 → 设备：

| type | 内容 |
|---|---|
| `welcome` | 会话 id、她的名字、协议版本 |
| `reply.delta` / `reply.done` | 她的回复，流式；`done` 带完整文本 |
| `urge` | 她主动开口说的话（见阶段 3） |
| `confirm` | guard 要主人确认的事：工具、原因、命令，等 `answer` |
| `tool` | 她在做什么（运行命令、读文件），给 App 显示进度，可选 |
| `error` | 出错 |

协议放在 `@fairy/protocol`，带版本号，宿主和客户端都校验。

### 确认要能弹到 App 上

`fairy-guard` 用 `ctx.userQuestions.ask()` 问主人，这会派发 `user-questions/request` 这个 waterfall。`@fairy/link` 在同一个 waterfall 上挂监听：有在线设备就转成 `confirm` 发过去，等 `answer` 回来；没有就 `next()`，交给 Web 界面。都没有，guard 拒绝（现在就是这样）。

要测：App 在线时确认弹到 App；App 断开时回到 Web；都没有时拒绝并写审计。

**验收**：写一个命令行测试客户端（`apps/fairy-link-cli`，几十行），能配对、聊天、看到流式回复、回答一次删除确认。

## 阶段 2：App 第一版

只做最常用的：

- 配对（扫码或输入配对码）
- 聊天：发文字，看流式回复，历史记录（从会话读）
- 确认卡片：允许 / 不允许，显示命令原文
- 她现在怎么样：醒着还是睡着、在做什么、心情、和主人的关系（`status`）
- 设置：宿主地址、设备名、退出（吊销自己的令牌）

不做：多用户、她的设定编辑、插件管理（这些用 Web 界面）。

**验收**：手机上配对、聊天、回答确认都能用；断网重连后补上漏掉的回复；令牌被吊销后 App 回到配对页。

## 阶段 3：网页关着也能找到主人

半成品：她的话已经能落进一个**关着**的会话（2026-11-02），但还没有推送通道，手机和 App 收不到。

- ✅ 找不到开着的会话时，用 `ctx.get('sessionController').resolveAgent(上次的会话 id)` 把冷会话唤醒，再 `followup`，当作一轮她自己开始的对话送进去。上次的会话 id 来自她最近一条 `heard` 的 `where`（`dsh-session:<id>`），由 `FairySelf.lastConversation()` 提供。见 [决策 16](decisions.md#16-网页关着时她的话也能落进上次那个会话)。
- ✅ 唤醒失败（没有会话、宿主没有 `sessionController`、会话已不在）时这次不发，只记日志，不写 `speakUp`。
- ⬜ `@fairy/link` 把她这一轮说的话作为 `urge` 推给在线设备（阶段 1 做出来以后接）。
- ⬜ 设备都不在线时走系统推送。国内安卓没有可靠的 FCM，要接厂商通道或者聚合推送（极光、个推）；iOS 用 APNs。这件事要主人定（见下面）。第一版可以只做“App 在前台或后台保活时通过 WebSocket 收到”。
- ✅ 她主动说的话照样写进她的生命（`speakUp`），推送只是送达方式。
- 主人那时候可能在睡觉：送达方式要尊重设备自己的免打扰，Fairy 这边不另设上限（主人说过“有事就可以发”）。

**验收**：网页和 App 都关着，她想找主人时，手机收到通知；点开 App 能看到这句话，回复后她记得这是在回应她主动找的那次。

## 阶段 4：设备节点，她的手脚

`fairy-node` 跑在主人想让她能动的每台设备上（主人的 PC、NAS、另一台服务器）。

- 节点主动连宿主（`/fairy/node/v1`），不开端口，所以 PC 在家里内网也能连。用和 App 一样的配对和令牌，令牌类型是 `node`。
- 节点上报自己能做什么：`shell`、`fs.read`、`fs.write`、`screenshot`、`sysinfo`、`notify`……能力由主人在节点的配置文件里开关，默认只开只读的。
- 宿主上的 `@fairy/hands` 把在线节点包装成 DSH 工具，例如 `device_shell({ device, command })`、`device_read({ device, path })`。**这些工具和普通工具一样过 `fairy-guard`**：要在 `rules.ts` 里把 `device_shell` 当 shell 判断，`device_write` 当写文件判断。
- 节点自己还有一道：本地黑名单（比如不许碰系统盘、不许关机）、一个随时能按的“停止”开关、本地审计日志。宿主放行了，节点不同意也不执行。
- 节点不保存她的任何东西，只执行、只回报结果。
- 设备名进她的事实：她知道“主人的 PC 在线”“NAS 离线”。

**验收**：她能在主人 PC 上执行一条只读命令并回答问题；一条删除命令先在 App 上弹确认，主人允许后才在 PC 上执行，宿主和节点两边都有审计；节点断开后对应工具消失。

## 阶段 5：设备也是她的感官

节点除了执行，还能报事情：电脑开着还是睡了、正在放音乐、电量低、下载完成、日历快到了。走 `perceive()`，她会注意到、会有感受，慢慢形成喜好（`fairy-senses` 现在报天气就是这样）。要哪些、频率多高，主人在节点配置里开关。

## 阶段 6：她知道主人在哪个设备上

主人在手机上说话和在电脑前说话，她的处境不一样：手机上回短一点，电脑前可以发代码。`hello` 里的设备类型进她的事实（“主人现在在用手机”），`chatStyle` 可以按设备类型有不同的写法。

## 要主人定的（2026-11-02 已定，详见 [app.md](app.md)）

| 事 | 定了什么 | 为什么 |
|---|---|---|
| App 用什么做 | **PWA**，宿主自己发，路由 `/fairy/app/`，无框架 | 零分发、改一次重启就生效；协议已经是通用的，以后换原生只换壳 |
| 怎么访问宿主 | **Tailscale 私有网络**，宿主仍只听 127.0.0.1 | 一个宿主就是她的全部，不开公网口 |
| 推送 | **第一版只做"页面活着时收到"**，系统推送另行决定 | 国内 Android 推送是长期维护债，先验证值不值得 |
| 先接哪些设备 | 主人的 PC（阶段 4 再说） | 先让 App 真用起来 |
| QQ | 暂不接 | 复用 `@fairy/link` 的会话和确认，等 App 稳了再说 |

## 风险

- **DSH 是预览版**，会话和 Remote 的接口可能变。`@fairy/link` 只用 `sessionController`、`webServer`、`userQuestions` 这几个，升级时先跑它的测试。
- **一个宿主是单点**：宿主挂了她就失联。靠进程守护和每日备份兜底，不做多活（多活就是两个她）。
- **设备节点等于远程控制**：令牌泄漏就是别人能动主人的电脑。令牌只存哈希、能吊销、节点本地还有黑名单；默认只开只读能力。
- **推送内容会经过第三方**：推送里只放“Fairy 有话对你说”，正文等 App 连上宿主再拿。

## 每个阶段都要

- 新包有测试；协议有校验测试；涉及确认和设备的，测“没人回答就拒绝”。
- 在临时目录里真实启动一次 DSH 验证，不碰 `.fairy-home`。
- 更新 `docs/development.md` 的包表和 `docs/decisions.md`。
