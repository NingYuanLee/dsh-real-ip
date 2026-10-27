import { lookup as defaultLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { classifyAddress, isBenchmarkFakeIp, isPublicUnicast, stripIpv6Brackets } from "./classify.js";
import { resolveRealAddresses } from "./real.js";

export { isBenchmarkFakeIp, isPublicUnicast, stripIpv6Brackets };

/**
 * The direct-resolution block from `resolvePublicAddresses`.
 * NAT64 uses a different sentence (`resolves through NAT64 to a non-public IPv4 address`)
 * and must not enter this exception: its embedded IPv4 can be private while the IPv6 looks public.
 * @param {unknown} error
 */
export function isDirectNonPublicBlock(error) {
  if (error === null || typeof error !== "object") return false;
  const code = /** @type {{ code?: unknown, message?: unknown }} */ (error).code;
  const message = /** @type {{ code?: unknown, message?: unknown }} */ (error).message;
  return code === "WEB_BLOCKED_URL"
    && typeof message === "string"
    && message.includes("resolves to a non-public IP address");
}

/**
 * @param {unknown} resolved
 * @returns {{ publics: { address: string, family: 4 | 6 }[], fakes: { address: string, family: 4 | 6 }[] } | null}
 */
function partitionAnswers(resolved) {
  if (!Array.isArray(resolved) || resolved.length === 0) return null;
  const publics = [];
  const fakes = [];
  const seenPublic = new Set();
  const seenFake = new Set();
  for (const entry of resolved) {
    const family = entry?.family;
    const address = entry?.address;
    if ((family !== 4 && family !== 6) || typeof address !== "string" || isIP(address) !== family) return null;
    const classified = classifyAddress(address);
    if (!classified || classified.kind === "blocked" || !classified.entry) return null;
    const key = `${classified.entry.family}:${classified.entry.address}`;
    if (classified.kind === "public") {
      if (!seenPublic.has(key)) {
        seenPublic.add(key);
        publics.push(classified.entry);
      }
      continue;
    }
    if (!seenFake.has(key)) {
      seenFake.add(key);
      fakes.push(classified.entry);
    }
  }
  return { publics, fakes };
}

/**
 * @param {string} hostname
 * @param {AbortSignal | undefined} signal
 * @param {(hostname: string, signal: AbortSignal) => Promise<{ address: string, family: number }[]>} realResolver
 */
async function recoverPublicAddresses(hostname, signal, realResolver) {
  if (signal?.aborted) return [];
  try {
    const resolved = await realResolver(hostname, signal);
    return partitionAnswers(resolved)?.publics ?? [];
  } catch {
    return [];
  }
}

/**
 * Keep the package resolver. When it rejects a hostname (never an IP literal) because an answer
 * is not public unicast:
 *
 * - any private, link-local, or other non-fake address rejects the whole set
 * - a public answer mixed with a fake-ip is kept and the fake-ip is dropped, so the pin uses the real address
 * - a set that is only a known fake-ip is sent through a resolver fake-ip does not rewrite;
 *   public answers from that lookup replace the fake-ip
 * - if that lookup finds nothing public, the fake-ip is still returned for a TUN that maps it
 *
 * @param {string} hostname
 * @param {AbortSignal} signal
 * @param {(hostname: string, signal: AbortSignal) => Promise<{ address: string, family: number }[]>} original
 * @param {(hostname: string, options: { all: true, order: "verbatim" }) => Promise<{ address: string, family: number }[]>} [resolver]
 * @param {(hostname: string, signal: AbortSignal) => Promise<{ address: string, family: number }[]>} [realResolver]
 */
export async function resolveAllowingBenchmarkRange(hostname, signal, original, resolver = defaultLookup, realResolver = resolveRealAddresses) {
  try {
    return await original(hostname, signal);
  } catch (error) {
    if (!isDirectNonPublicBlock(error)) throw error;
    const unbracketed = stripIpv6Brackets(hostname);
    if (isIP(unbracketed) !== 0) throw error;
    if (signal?.aborted) throw error;
    const resolved = await resolver(unbracketed, { all: true, order: "verbatim" });
    const partitioned = partitionAnswers(resolved);
    if (!partitioned) throw error;
    if (partitioned.publics.length > 0) return partitioned.publics;
    if (partitioned.fakes.length === 0) throw error;
    if (signal?.aborted) throw error;
    const recovered = await recoverPublicAddresses(unbracketed, signal, realResolver);
    if (signal?.aborted) throw error;
    if (recovered.length > 0) return recovered;
    return partitioned.fakes;
  }
}
