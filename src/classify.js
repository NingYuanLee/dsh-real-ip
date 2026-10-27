import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

/** RFC 2544 / RFC 5737 benchmarking block. Clash and sing-box default IPv4 fake-ip pool. */
const BENCHMARK_V4 = ipaddr.IPv4.parse("198.18.0.0");
const BENCHMARK_V4_PREFIX = 15;

/** RFC 5180 IPv6 benchmarking block, the v6 pair of 198.18.0.0/15. */
const BENCHMARK_V6 = ipaddr.IPv6.parse("2001:2::");
const BENCHMARK_V6_PREFIX = 48;

/** sing-box default `inet6_range`. Not the whole fc00::/7 ULA block. */
const SINGBOX_V6 = ipaddr.IPv6.parse("fc00::");
const SINGBOX_V6_PREFIX = 18;

/**
 * WHATWG URL keeps brackets on IPv6 hostnames; IP parsers do not.
 * @param {string} hostname
 */
export function stripIpv6Brackets(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * @param {string} address
 * @returns {ipaddr.IPv4 | ipaddr.IPv6 | null}
 */
function parseAddress(address) {
  try {
    return ipaddr.parse(stripIpv6Brackets(address));
  } catch {
    return null;
  }
}

/**
 * Same unicast test as `isPublicIpAddress`. Not widened: fake-ip pools stay non-unicast.
 * @param {string} input
 */
export function isPublicUnicast(input) {
  const parsed = parseAddress(input);
  if (!parsed) return false;
  if (parsed instanceof ipaddr.IPv4) return parsed.range() === "unicast";
  if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === "unicast";
  return parsed.range() === "unicast";
}

/**
 * IPv4 address inside 198.18.0.0/15. IPv6, including IPv4-mapped forms, is never this predicate.
 * @param {string} address
 */
export function isBenchmarkFakeIp(address) {
  if (isIP(address) !== 4) return false;
  const parsed = parseAddress(address);
  return parsed instanceof ipaddr.IPv4 && parsed.match(BENCHMARK_V4, BENCHMARK_V4_PREFIX);
}

/**
 * Address a proxy may have synthesized: 198.18.0.0/15, RFC 5180 2001:2::/48, or sing-box fc00::/18.
 * IPv4-mapped fake-ip counts. Private LAN ranges do not.
 * @param {string} address
 */
export function isFakeIpAddress(address) {
  return classifyAddress(address)?.kind === "fake";
}

/**
 * @param {ipaddr.IPv4 | ipaddr.IPv6} parsed
 * @returns {{ address: string, family: 4 | 6 } | null}
 */
function fakeEntry(parsed) {
  if (parsed instanceof ipaddr.IPv4 && parsed.match(BENCHMARK_V4, BENCHMARK_V4_PREFIX)) {
    return { address: parsed.toString(), family: 4 };
  }
  if (!(parsed instanceof ipaddr.IPv6)) return null;
  if (!parsed.match(BENCHMARK_V6, BENCHMARK_V6_PREFIX) && !parsed.match(SINGBOX_V6, SINGBOX_V6_PREFIX)) return null;
  const address = parsed.toString();
  return isIP(address) === 6 ? { address, family: 6 } : null;
}

/**
 * Split one DNS answer into a public unicast destination, a known fake-ip, or a blocked address.
 * IPv4-mapped answers are reduced to the embedded IPv4 address before classification.
 * @param {string} address
 * @returns {{ kind: "public" | "fake" | "blocked", entry: { address: string, family: 4 | 6 } | null } | null}
 */
export function classifyAddress(address) {
  const parsed = parseAddress(address);
  if (!parsed) return null;
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    const embedded = parsed.toIPv4Address();
    const fake = fakeEntry(embedded);
    if (fake) return { kind: "fake", entry: fake };
    if (embedded.range() === "unicast") return { kind: "public", entry: { address: embedded.toString(), family: 4 } };
    return { kind: "blocked", entry: null };
  }
  const fake = fakeEntry(parsed);
  if (fake) return { kind: "fake", entry: fake };
  if (parsed instanceof ipaddr.IPv4) {
    if (parsed.range() !== "unicast") return { kind: "blocked", entry: null };
    return { kind: "public", entry: { address: parsed.toString(), family: 4 } };
  }
  if (parsed.range() !== "unicast") return { kind: "blocked", entry: null };
  const literal = stripIpv6Brackets(address);
  if (isIP(literal) !== 6) return null;
  return { kind: "public", entry: { address: literal, family: 6 } };
}
