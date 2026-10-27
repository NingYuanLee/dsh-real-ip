# Changelog

## 未发布（Unreleased）

## 0.1.0

- 包名改为 `dsh-real-ip`。旧名 `@liningyuan/dsh-web-fetch-fake-ip` 与已有包 `dsh-web-fetch-fakeip` 太接近，而且现在不只处理网页获取。
- 行为与旧包 `0.3.0` 相同：网页获取和进程里的 `dns.lookup` 在只拿到已知 fake-ip 时改用真实公网地址。

## 0.3.0

- 不只包住网页获取。进程里的 `dns.lookup` / `dns.promises.lookup` 也会在系统答案只是已知 fake-ip 时改成真实公网地址，因此全局 `fetch`、undici 和走默认 DNS 的模型请求同样生效。
- 已经提前拿走 `node:dns/promises` 的 `lookup` 函数的调用方改不到；网页获取仍由原来的 provider 包装处理。
- 私网答案和 IP 字面量不会被这次进程级改写换成公网地址。

- npm 包名是 `@liningyuan/dsh-web-fetch-fake-ip`。无作用域名 `dsh-web-fetch-fake-ip` 与已有包 `dsh-web-fetch-fakeip` 过于相似，注册表拒绝发布。
- 系统 DNS 只返回已知 fake-ip 时，先向公共 DNS 查询真实公网地址，查到就钉死真实地址，而不是连接 `198.18.x.x`。
- 53 端口仍返回 fake-ip 时，改用 IP 字面量访问 DoH（阿里 `223.5.5.5`、DNSPod `120.53.53.53`、Cloudflare `1.1.1.1`）。
- 同一组答案里同时有公网地址和 fake-ip 时，只保留公网地址。
- 识别 IPv6 fake-ip：sing-box 默认 `fc00::/18`，以及 RFC 5180 的 `2001:2::/48`。IPv4-mapped 的 `198.18.0.0/15` 也算 fake-ip。
- 私网、回环、链路本地、CGNAT、IP 字面量和 NAT64 失败仍然拒绝，并且不会为这些名字去查公共 DNS。
- 公共查询没有可用公网地址时，才退回钉死已知 fake-ip，供 TUN 映射继续工作。

## 0.1.0

- 首次本地版本。仅放行主机名解析到 IPv4 `198.18.0.0/15` 的结果，并原样钉死该 fake-ip。
