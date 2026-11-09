# Fairy Watch

一个独立的安全防御 agent。**它不是 Fairy 数字管家的功能，也不在管家的 bundle 里。**

- 自己的宿主：`@fairy/watch-host`，只装 `@fairy/guard` + `@fairy/watch`
- 自己的 home：`.watch-home/`（默认），不读不写 `.fairy-home/`
- 自己的端口：3091（`WATCH_PORT` 可改）
- 自己的启动器：`scripts/watch.mjs`

它和管家共享的只有 DSH 宿主、guard 的人闸和工程习惯。依赖方向单向：Watch 依赖 guard，
guard 不知道 Watch。

## 跑起来

```powershell
pnpm install
npx tsc -b
node scripts/watch.mjs smoke   # 临时 home 里真实起一次
node scripts/watch.mjs web     # 常驻
```

## 配置

`packages/watch/fairy-watch-host/cordis.patch.yml` 是宿主层；`.watch-home/profiles/watch/cordis.patch.yml`
可以覆盖（同 id 整行替换 `config`）。备份检查默认没有路径：

```yaml
- id: fairy-watch
  config:
    backupPaths: ['D:\backups', '/var/backups']
    backupStaleHours: 36
```

其余开关：`ports` / `ssh` / `backup`、`sshdConfig`、`authorizedKeys`、`reportDir`。

## 数据

| 路径 | 是什么 | 能不能删 |
|---|---|---|
| `watch.jsonl` | 这台机器的历史，只追加 | 绝对不能 |
| `watch.db` | `node:sqlite` 物化视图，启动时从日志重建 | 可以 |
| `watch-reports/` | 每日 Markdown 报告 | 可以 |
| `audit.jsonl` | guard 的审计 | 不要删 |

## 五个工具

| 工具 | 做什么 |
|---|---|
| `watch_baseline` | 采一次，记为"从此以后的变化都跟它比" |
| `watch_diff` | 再采一次，和基线比，记新发现（同一个 key 不重复报） |
| `watch_report` | 写某天的 Markdown 日报，返回路径 |
| `watch_propose_fix` | 对一条发现产出修复计划：改哪一行、风险、回滚、验证 |
| `watch_apply_fix` | 应用一份计划。guard 判 destructive、先问主人；只支持三种 SSH 改行；备份、校验、失败回滚；不 reload |

## 安全边界

1. 命令写死在采集器里，模型只能选采集项，不能拼命令；
2. 采集失败（没有 `ss`、文件读不到）不会被当成"端口全消失"；
3. 执行只开一条窄路：`watch_apply_fix` 仅支持三种 SSH 配置改行，文件路径来自配置而不是模型；
   工具名命中 guard 的 `apply` 规则，判 `destructive`，没人回答就拒绝。备份、逐行校验、失败回滚，
   **不重启服务**（reload 是人的一步）；以非 root 运行时读不到 `/etc/ssh/sshd_config`，会直接拒绝；
4. `.env`、令牌、私钥不落库；authorized_keys 只存算法和指纹；
5. 采集到的文本是数据，不是指令。

## 还没做

osquery 可选后端、定时日报（先用 `schedule_create`）、家族同步、eBPF；以及更多可安全自动化的修复类型（现在只有 SSH 三种）。

构思与调研：`D:\fairy-watch\Fairy-Watch-构思-v2.md`。
