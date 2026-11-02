# 服务器上的那份配置

这三个文件是服务器上**正在跑**的那一份的副本，放在仓库里是为了可复核、可重建。改了它们不等于改了服务器，要按下面的步骤应用。

| 文件 | 服务器上的位置 |
|---|---|
| `fairy.service` | `/etc/systemd/system/fairy.service` |
| `fairy.service.d/sandbox.conf` | `/etc/systemd/system/fairy.service.d/sandbox.conf` |
| `fairy.lycoreco.cn.conf` | `/www/server/panel/vhost/nginx/fairy.lycoreco.cn.conf`（宝塔的 vhost 目录） |

## 应用

```bash
# 她的进程
cp fairy.service /etc/systemd/system/
mkdir -p /etc/systemd/system/fairy.service.d
cp fairy.service.d/sandbox.conf /etc/systemd/system/fairy.service.d/
systemctl daemon-reload && systemctl restart fairy

# 她的入口：先测再 reload，失败就回滚
cp fairy.lycoreco.cn.conf /www/server/panel/vhost/nginx/
if /www/server/nginx/sbin/nginx -t; then /www/server/nginx/sbin/nginx -s reload; else
  echo "config bad: nothing reloaded"; fi
```

**永远先 `nginx -t` 再 reload。** 博客和她在同一个 nginx 上，配置写错会一起挂。

## 这几条配置为什么是这样

- **单元里 `MemoryMax=768M`**：机器只有 2G，博客（PHP + MySQL）已经在用一半。她跑飞了不能把博客拖下水。
- **沙箱 drop-in**：她能在宿主上跑命令。`InaccessiblePaths=/www` 让博客源码、数据库、宝塔面板在她的命名空间里**根本不存在**；`/root` 是主人的备份。注意 `InaccessiblePaths` 里的路径必须**存在**，否则 systemd 拒绝启动（我们踩过：`/etc/nginx`、`/var/lib/mysql` 在这台机器上都不存在，nginx 和 MySQL 都是宝塔装的，全在 `/www` 下）。
- **vhost 只反代三条路径**：`/fairy/app`（她的页面）、`/fairy/link/v1`（WebSocket）、`/fairy/link/pair`（配对）。其余一律 404——DSH 的界面和 `/api` 不出公网。
- **证书**：certbot webroot，证书在 `/etc/letsencrypt/live/fairy.lycoreco.cn/`，续期靠 `certbot.timer`，deploy hook 放在 `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`。
