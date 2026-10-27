import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { classifyAddress } from "./classify.js";

/** Direct resolvers. Port 53 to these is often hijacked; a public answer still skips DoH. */
const UDP_SERVERS = ["223.5.5.5", "119.29.29.29", "8.8.8.8", "1.1.1.1"];
const UDP_TIMEOUT_MS = 1000;
const DOH_TIMEOUT_MS = 2500;
const DOH_MAX_BYTES = 65536;

/**
 * IP literals so the resolver hostname is not itself rewritten to a fake-ip.
 * @type {Array<{ host: string, servername: string, pathFor: (name: string, type: number) => string }>}
 */
const DOH_ENDPOINTS = [
  {
    host: "223.5.5.5",
    servername: "dns.alidns.com",
    pathFor: (name, type) => `/resolve?name=${encodeURIComponent(name)}&type=${type}`,
  },
  {
    host: "120.53.53.53",
    servername: "doh.pub",
    pathFor: (name, type) => `/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
  },
  {
    host: "1.1.1.1",
    servername: "cloudflare-dns.com",
    pathFor: (name, type) => `/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
  },
];

/**
 * A/AAAA records from a DNS-JSON body. CNAME chains are skipped; missing Answer is empty.
 * @param {unknown} payload
 * @returns {{ address: string, family: 4 | 6 }[]}
 */
export function addressesFromDohJson(payload) {
  const answers = payload && typeof payload === "object" && Array.isArray(/** @type {{ Answer?: unknown }} */ (payload).Answer)
    ? /** @type {{ Answer: unknown[] }} */ (payload).Answer
    : [];
  const found = [];
  for (const record of answers) {
    if (!record || typeof record !== "object") continue;
    const data = /** @type {{ data?: unknown }} */ (record).data;
    if (typeof data !== "string") continue;
    const family = isIP(data);
    if (family !== 4 && family !== 6) continue;
    found.push({ address: data, family });
  }
  return found;
}

/**
 * @param {{ address: string, family: number }[]} entries
 */
function usablePublic(entries) {
  const seen = new Set();
  const v4 = [];
  const v6 = [];
  for (const entry of entries) {
    const family = entry?.family;
    const address = entry?.address;
    if ((family !== 4 && family !== 6) || typeof address !== "string" || isIP(address) !== family) continue;
    const classified = classifyAddress(address);
    if (classified?.kind !== "public" || !classified.entry) continue;
    const key = `${classified.entry.family}:${classified.entry.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (classified.entry.family === 4 ? v4 : v6).push(classified.entry);
  }
  return [...v4, ...v6];
}

/**
 * @param {string} hostname
 * @param {AbortSignal | undefined} signal
 */
async function resolveUdp(hostname, signal) {
  if (signal?.aborted) return [];
  const resolver = new Resolver();
  resolver.setServers(UDP_SERVERS);
  let timer;
  const cancel = () => resolver.cancel();
  if (signal) signal.addEventListener("abort", cancel, { once: true });
  try {
    const done = Promise.all([
      resolver.resolve4(hostname).catch(() => []),
      resolver.resolve6(hostname).catch(() => []),
    ]);
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        cancel();
        resolve(/** @type {[string[], string[]]} */ ([[], []]));
      }, UDP_TIMEOUT_MS);
    });
    const [v4, v6] = /** @type {[string[], string[]]} */ (await Promise.race([done, timeout]));
    return [
      ...v4.filter((address) => isIP(address) === 4).map((address) => ({ address, family: /** @type {4} */ (4) })),
      ...v6.filter((address) => isIP(address) === 6).map((address) => ({ address, family: /** @type {6} */ (6) })),
    ];
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", cancel);
  }
}

/**
 * @param {{ host: string, servername: string, pathFor: (name: string, type: number) => string }} endpoint
 * @param {string} hostname
 * @param {number} type
 * @param {AbortSignal | undefined} signal
 */
function dohGet(endpoint, hostname, type, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = httpsRequest({
      host: endpoint.host,
      servername: endpoint.servername,
      method: "GET",
      path: endpoint.pathFor(hostname, type),
      headers: {
        host: endpoint.servername,
        accept: "application/dns-json, application/json",
      },
    }, (res) => {
      const chunks = [];
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (received > DOH_MAX_BYTES) {
          req.destroy();
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          finish(null);
          return;
        }
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          finish(null);
        }
      });
    });
    req.on("error", () => finish(null));
    req.setTimeout(DOH_TIMEOUT_MS, () => {
      req.destroy();
      finish(null);
    });
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        finish(null);
        return;
      }
      const onAbort = () => {
        req.destroy();
        finish(null);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    req.end();
  });
}

/**
 * @param {string} hostname
 * @param {AbortSignal | undefined} signal
 */
async function resolveDoh(hostname, signal) {
  for (const endpoint of DOH_ENDPOINTS) {
    if (signal?.aborted) return [];
    const [v4Body, v6Body] = await Promise.all([
      dohGet(endpoint, hostname, 1, signal),
      dohGet(endpoint, hostname, 28, signal),
    ]);
    const usable = usablePublic([
      ...addressesFromDohJson(v4Body),
      ...addressesFromDohJson(v6Body),
    ]);
    if (usable.length > 0) return usable;
  }
  return [];
}

/**
 * Public unicast addresses for a hostname whose system answer was only a fake-ip.
 * UDP to a public resolver is tried first; a still-fake or empty answer falls through to DoH
 * addressed by IP literal, because fake-ip hijacks port 53 but not the HTTPS body.
 * @param {string} hostname
 * @param {AbortSignal} [signal]
 * @param {{ udp?: typeof resolveUdp, doh?: typeof resolveDoh }} [deps]
 * @returns {Promise<{ address: string, family: 4 | 6 }[]>}
 */
export async function resolveRealAddresses(hostname, signal, deps = {}) {
  const udp = deps.udp ?? resolveUdp;
  const doh = deps.doh ?? resolveDoh;
  try {
    const fromUdp = usablePublic(await udp(hostname, signal));
    if (fromUdp.length > 0) return fromUdp;
  } catch {
    // Fall through to DoH, then to the caller's fake-ip pin.
  }
  if (signal?.aborted) return [];
  try {
    return usablePublic(await doh(hostname, signal));
  } catch {
    return [];
  }
}
