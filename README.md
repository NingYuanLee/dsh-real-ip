# dsh-web-fetch-fake-ip

[![CI](https://github.com/NingYuanLee/dsh-web-fetch-fake-ip/actions/workflows/ci.yml/badge.svg)](https://github.com/NingYuanLee/dsh-web-fetch-fake-ip/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2%20%3C0.3.0--0-6f42c1)](package.json)

> Third-party community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Not an official DeepSeek product. MIT licensed.

English | [中文](README.zh.md)

When Clash or sing-box answers with a fake-ip, web fetch pins the real public address instead of refusing the lookup or connecting to the fake-ip.

## The problem

Desktop web fetch accepts only public unicast addresses. Clash and sing-box fake-ip mode answer hostnames with `198.18.0.0/15` (RFC 2544). sing-box's default IPv6 pool is `fc00::/18`, and `2001:2::/48` is the IPv6 benchmarking block. ipaddr.js 2.5.0 does not classify those as unicast, so the request dies with `WEB_BLOCKED_URL` before a connection is attempted.

Allowing the fake-ip is not enough when port 53 is hijacked. The system resolver and a direct query to a public DNS server can both return `198.18.x.x`, and the fetch then pins that address. A mixed answer that contains both a public address and a fake-ip has the same problem if the fake-ip is kept in the pinned set.

## How it works

The plugin does not modify `app.asar`. It wraps `resolveAddresses` on the registered `http` fetch provider:

- An answer the original resolver already accepted is returned unchanged.
- If that answer was rejected and the set contains any public unicast address, only those public addresses are returned. Fake-ip entries in the same set are dropped.
- If every address is a known fake-ip, the plugin queries UDP/53 on `223.5.5.5`, `119.29.29.29`, `8.8.8.8`, and `1.1.1.1`. A public answer replaces the fake-ip.
- If that UDP answer is empty or still a fake-ip, it queries DNS over HTTPS by IP literal, in order: AliDNS `223.5.5.5` (SNI `dns.alidns.com`), DNSPod `120.53.53.53` (SNI `doh.pub`), Cloudflare `1.1.1.1` (SNI `cloudflare-dns.com`). Using the IP avoids resolving the resolver name itself back into a fake-ip.
- If no public address can be recovered, the known fake-ip is pinned so a TUN that maps it can still carry the connection.
- Private, loopback, link-local, CGNAT, and other non-fake reserved addresses still reject the whole set. Those names are not sent to public DNS.
- A literal IP hostname never takes the exception, so `http://198.18.x.x/` stays blocked.
- A NAT64 failure (`resolves through NAT64 to a non-public IPv4 address`) is rethrown unchanged.

The same recovery is installed on Node's `dns.lookup` and `dns.promises.lookup`. Global `fetch`, undici, and other clients that resolve through those functions get a real public address instead of a fake-ip, including model requests that do not go through web fetch. A hostname that resolves to a private or literal address is left unchanged. Code that captured `import { lookup } from "node:dns/promises"` at load time is outside this patch; the web fetch provider wrapper above still covers that call.

`requestVia` already skips this check when an HTTP proxy is configured. This plugin does not change that path.

## Install

```bash
dsh plugin --profile web add github:NingYuanLee/dsh-web-fetch-fake-ip
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` writes the bundle into the profile. Restart DeepSeek Harness. The running process does not hot-load this plugin.

npm rejects the unscoped name `dsh-web-fetch-fake-ip` as too similar to the existing package `dsh-web-fetch-fakeip`. The published name is scoped:

```bash
dsh plugin --profile web add @liningyuan/dsh-web-fetch-fake-ip
```

A local checkout also works:

```bash
dsh plugin --profile web add ./dsh-web-fetch-fake-ip
```

## Compatibility

| Item | Value |
|---|---|
| dsh | `>=0.2.1-rc.2 <0.3.0-0` |
| Node | `>=22.19.0` |
| Verified on | dsh `0.2.1-rc.3`, Windows x64, desktop host |
| Runtime dependency | `ipaddr.js` `2.5.0` |
| Peers | `@deepseek-ai/cordis` `~4.0.4`, `@deepseek-ai/dsh-tools` `>=0.2.1-0 <0.3.0` |

There is no build step. The package ships plain ESM. Display metadata is `locale/en.json`, `locale/zh.json`, and the exported `./icon`.

## Configuration and limits

The plugin has no configuration keys.

Known fake-ip pools are IPv4 `198.18.0.0/15`, sing-box's default IPv6 range `fc00::/18`, RFC 5180 `2001:2::/48`, and an IPv4-mapped form of the IPv4 pool. `fd00::/8` is not treated as a fake-ip.

Limits:

- A custom fake-ip range that ipaddr.js classifies as public unicast cannot be told apart from a real address, so it is not rewritten.
- A custom pool inside a private range stays blocked and is not replaced by a public lookup.
- Only the `http` fetch provider is wrapped.
- Public resolvers see the hostname only. They do not see the URL path, headers, or credentials.
- Recovery adds up to about one second for UDP and, only if that answer is unusable, up to about 2.5 seconds per DoH endpoint.

## Security

No credentials are read. Private and literal destinations stay blocked. Hostnames whose system answer is only a known fake-ip are sent to the resolvers listed above. Details and the reporting channel are in [SECURITY.md](SECURITY.md).

## Uninstall

```bash
dsh plugin --profile web remove @liningyuan/dsh-web-fetch-fake-ip
```

Restart DeepSeek Harness. The plugin stores no files, cache, or credentials, so removal leaves nothing behind. Web fetch goes back to the host's public-unicast check.

## Development

```bash
node --test test/*.test.js
node --check src/index.js && node --check src/allow.js && node --check src/classify.js && node --check src/real.js
npm run check:pack
```

```text
src/index.js      Cordis entry; wraps the http fetch provider
src/allow.js      accept, filter, or recover addresses
src/classify.js   public unicast and known fake-ip ranges
src/real.js       UDP then DoH, with the transports injectable in tests
locale/           display metadata (en, zh)
test/             node:test suites, including manifest and pack invariants
scripts/          tarball check used by prepublishOnly and locally
```
