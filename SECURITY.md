# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories on this repository
(`Security` → `Report a vulnerability`). Do not open a public issue for a private-network
bypass or a resolver that sends more than a hostname.

Include the DeepSeek Harness version, the profile, whether a fake-ip DNS server is in use, and
reproduction steps. Expected first response within 7 days.

## Scope

`dsh-web-fetch-fake-ip` wraps the desktop `http` web-fetch provider's `resolveAddresses`. It does
not modify `app.asar`, does not register a tool, and does not add a network listener.

- The plugin does not read `$DSH_HOME/.credentials.yaml`, cookies, environment secrets, or request
  headers.
- It does not spawn a process.
- IP literals, including `198.18.x.x`, stay blocked.
- Answers in private, loopback, link-local, CGNAT, or other reserved ranges that are not a known
  fake-ip pool stay blocked. Those names are not sent to public DNS.
- NAT64 failures (`resolves through NAT64 to a non-public IPv4 address`) are not rewritten.
- A known fake-ip is pinned only when public resolution returns nothing usable. The accepted pools
  are IPv4 `198.18.0.0/15`, IPv6 `fc00::/18`, IPv6 `2001:2::/48`, and an IPv4-mapped form of the
  IPv4 pool. They are not LAN ranges.

## Outbound queries

When the system answer for a hostname is only a known fake-ip, the plugin sends that hostname to
public resolvers. It does not send the URL path, headers, or credentials.

- UDP/53: `223.5.5.5`, `119.29.29.29`, `8.8.8.8`, `1.1.1.1`
- DNS over HTTPS, by IP literal: `223.5.5.5` (SNI `dns.alidns.com`), `120.53.53.53` (SNI `doh.pub`),
  then `1.1.1.1` (SNI `cloudflare-dns.com`)

A public unicast answer already present in the system response is kept and the fake-ip is dropped,
with no extra query. The HTTP-proxy fetch path is unchanged and does not use this resolver.

## Supported versions

Security fixes target the latest `0.2.x` release on the `>=0.2.1-rc.2 <0.3.0-0` DeepSeek Harness
range.
