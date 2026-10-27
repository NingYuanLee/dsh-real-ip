import { createRequire } from "node:module";
import { isIP } from "node:net";
import { classifyAddress, stripIpv6Brackets } from "./classify.js";
import { resolveRealAddresses } from "./real.js";

const require = createRequire(import.meta.url);
const PATCHED = Symbol("dsh-web-fetch-fake-ip-dns");

/**
 * @param {{ address: string, family: number }[]} entries
 * @param {number | undefined} family
 */
function filterFamily(entries, family) {
  if (family !== 4 && family !== 6) return entries;
  return entries.filter((entry) => entry.family === family);
}

/**
 * Replace a fake-ip answer set with public addresses. Private answers and IP literals pass through.
 * @param {string} hostname
 * @param {{ address: string, family: number }[]} entries
 * @param {{ family?: number }} options
 * @param {(hostname: string, signal?: AbortSignal) => Promise<{ address: string, family: number }[]>} realResolver
 */
async function rewriteLookup(hostname, entries, options, realResolver) {
  if (typeof hostname !== "string" || isIP(stripIpv6Brackets(hostname)) !== 0) return entries;
  const publics = [];
  const fakes = [];
  for (const entry of entries) {
    const family = entry?.family;
    const address = entry?.address;
    if ((family !== 4 && family !== 6) || typeof address !== "string" || isIP(address) !== family) return entries;
    const classified = classifyAddress(address);
    if (!classified || classified.kind === "blocked" || !classified.entry) return entries;
    if (classified.kind === "public") publics.push(classified.entry);
    else fakes.push(classified.entry);
  }
  if (publics.length > 0) return filterFamily(publics, options.family);
  if (fakes.length === 0) return entries;
  let recovered = [];
  try {
    const resolved = await realResolver(hostname);
    if (Array.isArray(resolved)) {
      for (const entry of resolved) {
        const family = entry?.family;
        const address = entry?.address;
        if ((family !== 4 && family !== 6) || typeof address !== "string") continue;
        const classified = classifyAddress(address);
        if (classified?.kind === "public" && classified.entry) recovered.push(classified.entry);
      }
    }
  } catch {
    recovered = [];
  }
  const usable = filterFamily(recovered, options.family);
  return usable.length > 0 ? usable : filterFamily(fakes, options.family);
}

/**
 * @param {Function} patched
 * @param {Function} original
 */
function copyLookupMetadata(patched, original) {
  for (const key of [...Object.getOwnPropertyNames(original), ...Object.getOwnPropertySymbols(original)]) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor) Object.defineProperty(patched, key, descriptor);
  }
}

/**
 * Make process-wide DNS lookups prefer a real public address when the system answer is only a
 * known fake-ip. `node:dns` `lookup` and `promises.lookup` are patched in place, which covers
 * Node's global fetch, undici, and `http.request`. Callers that already captured
 * `import { lookup } from "node:dns/promises"` are not affected; web fetch is handled separately.
 *
 * @param {{
 *   lookup?: Function,
 *   promisesLookup?: Function,
 *   realResolver?: (hostname: string, signal?: AbortSignal) => Promise<{ address: string, family: number }[]>,
 * }} [overrides]
 */
export function installProcessLookup(overrides = {}) {
  const dns = require("node:dns");
  if (dns.lookup?.[PATCHED]) return;
  const originalLookup = overrides.lookup ?? dns.lookup;
  const originalPromises = overrides.promisesLookup ?? dns.promises.lookup;
  const realResolver = overrides.realResolver ?? resolveRealAddresses;
  /** @type {Map<string, Promise<{ address: string, family: number }[]>>} */
  const inflight = new Map();
  const recover = (hostname) => {
    const key = hostname.toLowerCase();
    let pending = inflight.get(key);
    if (!pending) {
      pending = Promise.resolve(realResolver(hostname)).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  };
  const resolver = (hostname) => recover(hostname);

  function lookup(hostname, options, callback) {
    let opts = options;
    let done = callback;
    if (typeof opts === "function") {
      done = opts;
      opts = {};
    }
    const normalized = opts ?? {};
    originalLookup(hostname, normalized, (error, address, family) => {
      if (error) {
        done(error);
        return;
      }
      const entries = normalized.all ? address : [{ address, family }];
      rewriteLookup(hostname, entries, normalized, resolver).then((rewritten) => {
        if (normalized.all) {
          done(null, rewritten);
          return;
        }
        const selected = rewritten[0];
        if (!selected) {
          const missing = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
          missing.code = "ENOTFOUND";
          missing.hostname = hostname;
          done(missing);
          return;
        }
        done(null, selected.address, selected.family);
      }, (rewriteError) => {
        done(rewriteError);
      });
    });
  }
  copyLookupMetadata(lookup, originalLookup);
  lookup[PATCHED] = { originalLookup, originalPromises };
  dns.lookup = lookup;

  dns.promises.lookup = async function lookup(hostname, options = {}) {
    const normalized = options ?? {};
    const result = await originalPromises(hostname, normalized);
    const entries = normalized.all ? result : [result];
    const rewritten = await rewriteLookup(hostname, entries, normalized, resolver);
    if (normalized.all) return rewritten;
    const selected = rewritten[0];
    if (!selected) {
      const missing = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      missing.code = "ENOTFOUND";
      missing.hostname = hostname;
      throw missing;
    }
    return selected;
  };
}

/** @returns {boolean} */
export function isProcessLookupInstalled() {
  const dns = require("node:dns");
  return Boolean(dns.lookup?.[PATCHED]);
}

/** Restore the DNS functions replaced by {@link installProcessLookup}. */
export function uninstallProcessLookup() {
  const dns = require("node:dns");
  const meta = dns.lookup?.[PATCHED];
  if (!meta) return;
  dns.lookup = meta.originalLookup;
  dns.promises.lookup = meta.originalPromises;
}
