# dsh-real-ip

[![CI](https://github.com/NingYuanLee/dsh-real-ip/actions/workflows/ci.yml/badge.svg)](https://github.com/NingYuanLee/dsh-real-ip/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2%20%3C0.3.0--0-6f42c1)](package.json)

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的第三方社区插件，不是 DeepSeek 官方产品。MIT 许可。

[English](README.md) | 中文

Clash 或 sing-box 返回 fake-ip 时，DSH 改为钉死真实公网地址，而不是拒绝解析或连到假地址。

## The problem

桌面版网页获取只接受公网 unicast。Clash 和 sing-box 的 fake-ip 会把主机名解析到 `198.18.0.0/15`（RFC 2544）。sing-box 默认的 IPv6 池是 `fc00::/18`，`2001:2::/48` 是 IPv6 基准测试段。ipaddr.js 2.5.0 不把这些当成 unicast，请求在连接前就以 `WEB_BLOCKED_URL` 失败。

只放行 fake-ip 不够。53 端口被劫持时，系统解析和直连公共 DNS 都会返回 `198.18.x.x`，获取就会钉死这个假地址。同一组答案里既有公网地址又有 fake-ip 时，如果假地址也被留下，结果一样。

## How it works

插件不修改 `app.asar`。它包住已注册的 `http` fetch provider 的 `resolveAddresses`：

- 原解析已经接受的答案原样返回。
- 原解析拒绝后，如果答案里有公网 unicast，只返回这些公网地址，同组 fake-ip 丢掉。
- 如果每个地址都是已知 fake-ip，先向 `223.5.5.5`、`119.29.29.29`、`8.8.8.8`、`1.1.1.1` 发 UDP/53。查到公网地址就替换假地址。
- 如果 UDP 答案为空或仍是 fake-ip，再按 IP 字面量做 DoH，顺序是阿里 `223.5.5.5`（SNI `dns.alidns.com`）、DNSPod `120.53.53.53`（SNI `doh.pub`）、Cloudflare `1.1.1.1`（SNI `cloudflare-dns.com`）。用 IP 是为了避免解析器自己的域名又被改写成 fake-ip。
- 仍然没有公网地址时，才钉死已知 fake-ip，让靠 TUN 映射的环境还能连通。
- 私网、回环、链路本地、CGNAT，以及其他不属于已知 fake-ip 的保留地址，整组拒绝，也不会把这些名字发给公共 DNS。
- 主机名本身是 IP 字面量时不走例外，所以 `http://198.18.x.x/` 仍然被拒绝。
- NAT64 失败（`resolves through NAT64 to a non-public IPv4 address`）原样抛出。

同样的恢复也会装到 Node 的 `dns.lookup` 和 `dns.promises.lookup` 上。全局 `fetch`、undici，以及其他走这两个函数解析的客户端（包括不经过网页获取的模型请求）都会拿到真实公网地址，而不是 fake-ip。解析到私网或字面量地址的主机名保持原样。启动时就已经拿到 `import { lookup } from "node:dns/promises"` 的代码不在这次补丁里；上面的网页获取包装仍然覆盖那条调用。

配置了 HTTP 代理时，`requestVia` 本来就会跳过这道检查。这条路径本插件不改。

## Install

```bash
dsh plugin --profile web add dsh-real-ip
```

包里声明了 `dsh.bundle.patch`，所以 `dsh plugin add` 会把 bundle 写进 profile。然后完全退出并重新打开 DeepSeek Harness。当前进程不会热加载这个插件。

`@liningyuan/dsh-web-fetch-fake-ip` 是旧名，已经废弃。npm 不接受 `dsh-web-fetch-fake-ip`，因为它和已有包 `dsh-web-fetch-fakeip` 太像。

GitHub 或本地目录也可以：

```bash
dsh plugin --profile web add github:NingYuanLee/dsh-real-ip
dsh plugin --profile web add ./dsh-real-ip
```

## Compatibility

| 项目 | 值 |
|---|---|
| dsh | `>=0.2.1-rc.2 <0.3.0-0` |
| Node | `>=22.19.0` |
| 已验证 | dsh `0.2.1-rc.3`，Windows x64，桌面宿主 |
| 运行时依赖 | `ipaddr.js` `2.5.0` |
| peer | `@deepseek-ai/cordis` `~4.0.4`，`@deepseek-ai/dsh-tools` `>=0.2.1-0 <0.3.0` |

没有构建步骤，发布的是普通 ESM。展示信息来自 `locale/en.json`、`locale/zh.json` 和导出的 `./icon`。

## Configuration and limits

插件没有配置项。

已知 fake-ip 池是 IPv4 `198.18.0.0/15`、sing-box 默认 IPv6 段 `fc00::/18`、RFC 5180 的 `2001:2::/48`，以及 IPv4 池的 IPv4-mapped 形式。`fd00::/8` 不算 fake-ip。

限制：

- 自定义 fake-ip 段如果被 ipaddr.js 标成公网 unicast，就无法和真实地址区分，因此不会被改写。
- 落在私网里的自定义池仍然拒绝，也不会改去查公网地址。
- 只包住 `http` 这一个 fetch provider。
- 公共解析器只看得到主机名，看不到 URL 路径、请求头或凭据。
- 额外查询最多大约 1 秒 UDP；只有这份答案不可用时，每个 DoH 端点再最多大约 2.5 秒。

## Security

不读取凭据。私网和字面量地址仍然拒绝。只有系统答案全是已知 fake-ip 的主机名，才会发给上面列出的解析器。细节和报告渠道见 [SECURITY.md](SECURITY.md)。

## Uninstall

```bash
dsh plugin --profile web remove dsh-real-ip
```

重新打开 DeepSeek Harness。插件不保存文件、缓存或凭据，卸掉后没有残留。网页获取回到宿主自己的公网 unicast 检查。

## Development

```bash
node --test test/*.test.js
node --check src/index.js && node --check src/allow.js && node --check src/classify.js && node --check src/real.js
npm run check:pack
```

```text
src/index.js      Cordis 入口，包住 http fetch provider
src/allow.js      接受、过滤或恢复地址
src/classify.js   公网 unicast 与已知 fake-ip 段
src/real.js       先 UDP 再 DoH，测试里可以换掉传输
locale/           展示元信息（en、zh）
test/             node:test，含清单与打包不变量
scripts/          prepublishOnly 和本地使用的 tarball 检查
```
