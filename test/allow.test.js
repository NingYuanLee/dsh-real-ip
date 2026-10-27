import assert from "node:assert/strict";
import test from "node:test";
import { isBenchmarkFakeIp, resolveAllowingBenchmarkRange } from "../src/allow.js";
import { isFakeIpAddress } from "../src/classify.js";
import { installFakeIpAllowance } from "../src/index.js";

const signal = new AbortController().signal;

function blocked(hostname, message = `URL hostname "${hostname}" resolves to a non-public IP address`) {
  const error = new Error(message);
  error.code = "WEB_BLOCKED_URL";
  return error;
}

function throwingOriginal(hostname, message) {
  return async () => {
    throw blocked(hostname, message);
  };
}

function emptyReal() {
  return async () => [];
}

function realMustNotRun() {
  return async () => {
    throw new Error("real resolver should not be called");
  };
}

test("198.18.0.0/15 matches by CIDR and nearby reserved ranges do not", () => {
  assert.equal(isBenchmarkFakeIp("198.18.0.0"), true);
  assert.equal(isBenchmarkFakeIp("198.18.1.29"), true);
  assert.equal(isBenchmarkFakeIp("198.19.255.255"), true);
  assert.equal(isBenchmarkFakeIp("198.17.255.255"), false);
  assert.equal(isBenchmarkFakeIp("198.20.0.0"), false);
  assert.equal(isBenchmarkFakeIp("192.0.2.1"), false);
  assert.equal(isBenchmarkFakeIp("240.0.0.1"), false);
  assert.equal(isBenchmarkFakeIp("10.0.0.1"), false);
  assert.equal(isBenchmarkFakeIp("::ffff:198.18.1.29"), false);
});

test("IPv6 fake-ip pools match and private ULA does not", () => {
  assert.equal(isFakeIpAddress("198.18.1.29"), true);
  assert.equal(isFakeIpAddress("::ffff:198.18.1.29"), true);
  assert.equal(isFakeIpAddress("fc00::1"), true);
  assert.equal(isFakeIpAddress("fc00:3fff::1"), true);
  assert.equal(isFakeIpAddress("fc00:4000::1"), false);
  assert.equal(isFakeIpAddress("fd12:3456::1"), false);
  assert.equal(isFakeIpAddress("2001:2::1"), true);
  assert.equal(isFakeIpAddress("2001:2:1::1"), false);
  assert.equal(isFakeIpAddress("20.205.243.166"), false);
});

test("a fake-ip-only answer is replaced by the recovered public address", async () => {
  const addresses = await resolveAllowingBenchmarkRange(
    "github.com",
    signal,
    throwingOriginal("github.com"),
    async () => [{ address: "198.18.1.29", family: 4 }],
    async () => [{ address: "20.205.243.166", family: 4 }],
  );
  assert.deepEqual(addresses, [{ address: "20.205.243.166", family: 4 }]);
});

test("fake-ip answers inside a recovered set are dropped", async () => {
  const addresses = await resolveAllowingBenchmarkRange(
    "github.com",
    signal,
    throwingOriginal("github.com"),
    async () => [{ address: "198.18.1.29", family: 4 }],
    async () => [
      { address: "198.18.0.9", family: 4 },
      { address: "20.205.243.166", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ],
  );
  assert.deepEqual(addresses, [
    { address: "20.205.243.166", family: 4 },
    { address: "2606:4700::1", family: 6 },
  ]);
});

test("github.com resolved only to 198.18.x.x is pinned when real lookup finds nothing", async () => {
  const addresses = await resolveAllowingBenchmarkRange(
    "github.com",
    signal,
    throwingOriginal("github.com"),
    async () => [{ address: "198.18.1.29", family: 4 }],
    emptyReal(),
  );
  assert.deepEqual(addresses, [{ address: "198.18.1.29", family: 4 }]);
});

test("a public answer mixed with a fake-ip keeps only the public address", async () => {
  let recovered = false;
  const addresses = await resolveAllowingBenchmarkRange(
    "github.com",
    signal,
    throwingOriginal("github.com"),
    async () => [
      { address: "198.18.1.29", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ],
    async () => {
      recovered = true;
      return [{ address: "20.205.243.166", family: 4 }];
    },
  );
  assert.equal(recovered, false);
  assert.deepEqual(addresses, [{ address: "2606:4700::1", family: 6 }]);
});

test("an IPv4-mapped fake-ip is canonicalized and can be replaced", async () => {
  const addresses = await resolveAllowingBenchmarkRange(
    "github.com",
    signal,
    throwingOriginal("github.com"),
    async () => [{ address: "::ffff:198.18.1.29", family: 6 }],
    async () => [{ address: "20.205.243.166", family: 4 }],
  );
  assert.deepEqual(addresses, [{ address: "20.205.243.166", family: 4 }]);
});

test("sing-box IPv6 fake-ip is accepted as a fallback and does not poison the set", async () => {
  const addresses = await resolveAllowingBenchmarkRange(
    "github.com",
    signal,
    throwingOriginal("github.com"),
    async () => [
      { address: "198.18.1.29", family: 4 },
      { address: "fc00::1", family: 6 },
    ],
    emptyReal(),
  );
  assert.deepEqual(addresses, [
    { address: "198.18.1.29", family: 4 },
    { address: "fc00::1", family: 6 },
  ]);
});

test("private and link-local answers still throw and do not ask public DNS", async () => {
  for (const address of ["10.0.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1", "100.64.0.1", "192.0.2.1", "240.0.0.1", "fd12:3456::1"]) {
    await assert.rejects(
      () => resolveAllowingBenchmarkRange(
        "github.com",
        signal,
        throwingOriginal("github.com"),
        async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        realMustNotRun(),
      ),
      (error) => error.code === "WEB_BLOCKED_URL",
    );
  }
});

test("a literal 198.18.0.1 hostname stays blocked and does not use the fake-ip exception", async () => {
  let lookedUp = false;
  await assert.rejects(
    () => resolveAllowingBenchmarkRange(
      "198.18.0.1",
      signal,
      throwingOriginal("198.18.0.1"),
      async () => {
        lookedUp = true;
        return [{ address: "198.18.0.1", family: 4 }];
      },
      realMustNotRun(),
    ),
    (error) => error.code === "WEB_BLOCKED_URL",
  );
  assert.equal(lookedUp, false);
});

test("a public unicast answer from the original resolver is returned unchanged", async () => {
  let lookedUp = false;
  const expected = [{ address: "140.82.112.3", family: 4 }];
  const addresses = await resolveAllowingBenchmarkRange(
    "github.com",
    signal,
    async () => expected,
    async () => {
      lookedUp = true;
      return [];
    },
    realMustNotRun(),
  );
  assert.equal(lookedUp, false);
  assert.deepEqual(addresses, expected);
});

test("NAT64 non-public blocks are not rewritten", async () => {
  let lookedUp = false;
  const message = 'URL hostname "github.com" resolves through NAT64 to a non-public IPv4 address';
  await assert.rejects(
    () => resolveAllowingBenchmarkRange(
      "github.com",
      signal,
      throwingOriginal("github.com", message),
      async () => {
        lookedUp = true;
        return [{ address: "198.18.1.29", family: 4 }];
      },
      realMustNotRun(),
    ),
    (error) => error.code === "WEB_BLOCKED_URL" && error.message === message,
  );
  assert.equal(lookedUp, false);
});

test("a mixed fake-ip and private answer is still blocked", async () => {
  await assert.rejects(
    () => resolveAllowingBenchmarkRange(
      "github.com",
      signal,
      throwingOriginal("github.com"),
      async () => [
        { address: "198.18.1.29", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      realMustNotRun(),
    ),
    (error) => error.code === "WEB_BLOCKED_URL",
  );
});

test("a real resolver failure still falls back to the fake-ip", async () => {
  const addresses = await resolveAllowingBenchmarkRange(
    "github.com",
    signal,
    throwingOriginal("github.com"),
    async () => [{ address: "198.18.0.8", family: 4 }],
    async () => {
      throw new Error("doh down");
    },
  );
  assert.deepEqual(addresses, [{ address: "198.18.0.8", family: 4 }]);
});

test("install wraps the http provider and prefers a recovered public address", async () => {
  const calls = [];
  const resolver = async (hostname) => {
    calls.push(hostname);
    return [{ address: "198.18.0.8", family: 4 }];
  };
  const realResolver = async () => [{ address: "20.205.243.166", family: 4 }];
  const existing = {
    id: "http",
    async resolveAddresses() {
      throw blocked("github.com");
    },
  };
  const web = {
    fetchProviders: new Map([["http", existing]]),
    registerFetchProvider(provider) {
      this.fetchProviders.set(provider.id, provider);
      return () => this.fetchProviders.delete(provider.id);
    },
  };
  installFakeIpAllowance(web, resolver, realResolver);
  installFakeIpAllowance(web, resolver, realResolver);
  const first = await existing.resolveAddresses("github.com", signal);
  assert.deepEqual(first, [{ address: "20.205.243.166", family: 4 }]);

  const later = {
    id: "http",
    async resolveAddresses() {
      throw blocked("learn.microsoft.com");
    },
  };
  web.registerFetchProvider(later);
  const second = await later.resolveAddresses("learn.microsoft.com", signal);
  assert.deepEqual(second, [{ address: "20.205.243.166", family: 4 }]);
  assert.deepEqual(calls, ["github.com", "learn.microsoft.com"]);
});
