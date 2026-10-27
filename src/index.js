import { resolveAllowingBenchmarkRange } from "./allow.js";

/** Cordis plugin name. */
export const name = "dsh-web-fetch-fake-ip";

/** The web seam whose HTTP fetch provider this plugin wraps. */
export const inject = ["web"];

const PATCHED = Symbol("dsh-web-fetch-fake-ip");

/**
 * Replace the `http` provider's resolver. `requestOnce` then pins whatever this returns.
 * A recovered public address is preferred over a fake-ip. The proxy path is untouched
 * because it never calls the resolver.
 * @param {{ id?: string, resolveAddresses?: Function }} provider
 * @param {Function} [resolver] system lookup used after the original resolver rejects the name
 * @param {Function} [realResolver] public-DNS lookup used when that answer is only a fake-ip
 */
export function patchHttpFetchProvider(provider, resolver, realResolver) {
  if (!provider || provider.id !== "http" || typeof provider.resolveAddresses !== "function") return;
  if (provider.resolveAddresses[PATCHED]) return;
  const original = provider.resolveAddresses.bind(provider);
  function resolveAddresses(hostname, signal) {
    return resolveAllowingBenchmarkRange(hostname, signal, original, resolver, realResolver);
  }
  resolveAddresses[PATCHED] = true;
  provider.resolveAddresses = resolveAddresses;
}

/**
 * Patch an already registered HTTP provider and any one registered later on this web service.
 * @param {{ fetchProviders?: Map<string, unknown>, registerFetchProvider?: Function }} web
 * @param {Function} [resolver] test seam; production uses system DNS.
 * @param {Function} [realResolver] test seam; production uses UDP then DoH.
 */
export function installFakeIpAllowance(web, resolver, realResolver) {
  if (!web || typeof web.registerFetchProvider !== "function") return;
  if (!web.registerFetchProvider[PATCHED]) {
    const originalRegister = web.registerFetchProvider.bind(web);
    function registerFetchProvider(provider) {
      patchHttpFetchProvider(provider, resolver, realResolver);
      return originalRegister(provider);
    }
    registerFetchProvider[PATCHED] = true;
    web.registerFetchProvider = registerFetchProvider;
  }
  if (web.fetchProviders && typeof web.fetchProviders.values === "function") {
    for (const provider of web.fetchProviders.values()) patchHttpFetchProvider(provider, resolver, realResolver);
  }
}

/**
 * @param {{ web?: object }} ctx
 */
export function apply(ctx) {
  installFakeIpAllowance(ctx.web);
}
