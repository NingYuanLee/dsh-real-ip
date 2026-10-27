import assert from "node:assert/strict";
import dns from "node:dns";
import test from "node:test";
import { installProcessLookup, isProcessLookupInstalled, uninstallProcessLookup } from "../src/dns-patch.js";
import { apply } from "../src/index.js";

function fakeSystemLookup(address, family = 4) {
  return (hostname, options, callback) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

async function lookupAll(hostname, options = {}) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, ...options }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

test("a fake-ip lookup is replaced with the recovered public address", async () => {
  installProcessLookup({
    lookup: fakeSystemLookup("198.18.1.29"),
    promisesLookup: async (hostname, options = {}) => (
      options.all
        ? [{ address: "198.18.1.29", family: 4 }]
        : { address: "198.18.1.29", family: 4 }
    ),
    realResolver: async () => [{ address: "20.205.243.166", family: 4 }],
  });
  try {
    assert.deepEqual(await lookupAll("github.com"), [{ address: "20.205.243.166", family: 4 }]);
    const single = await dns.promises.lookup("github.com");
    assert.deepEqual(single, { address: "20.205.243.166", family: 4 });
  } finally {
    uninstallProcessLookup();
  }
});

test("private answers and IP literals are not sent to public DNS", async () => {
  let recovered = false;
  const realResolver = async () => {
    recovered = true;
    return [{ address: "1.1.1.1", family: 4 }];
  };
  installProcessLookup({
    lookup: fakeSystemLookup("10.0.0.1"),
    realResolver,
  });
  try {
    assert.deepEqual(await lookupAll("printer.local"), [{ address: "10.0.0.1", family: 4 }]);
  } finally {
    uninstallProcessLookup();
  }
  installProcessLookup({
    lookup: fakeSystemLookup("198.18.0.1"),
    realResolver,
  });
  try {
    assert.deepEqual(await lookupAll("198.18.0.1"), [{ address: "198.18.0.1", family: 4 }]);
  } finally {
    uninstallProcessLookup();
  }
  assert.equal(recovered, false);
});

test("a public answer mixed with a fake-ip keeps only the public address", async () => {
  let recovered = false;
  installProcessLookup({
    lookup: (hostname, options, callback) => {
      callback(null, [
        { address: "198.18.0.8", family: 4 },
        { address: "140.82.112.3", family: 4 },
      ]);
    },
    realResolver: async () => {
      recovered = true;
      return [];
    },
  });
  try {
    assert.deepEqual(await lookupAll("github.com"), [{ address: "140.82.112.3", family: 4 }]);
    assert.equal(recovered, false);
  } finally {
    uninstallProcessLookup();
  }
});

test("lookup falls back to the fake-ip when recovery finds nothing", async () => {
  installProcessLookup({
    lookup: fakeSystemLookup("fc00::1", 6),
    realResolver: async () => [],
  });
  try {
    const single = await new Promise((resolve, reject) => {
      dns.lookup("github.com", (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    });
    assert.deepEqual(single, { address: "fc00::1", family: 6 });
  } finally {
    uninstallProcessLookup();
  }
});

test("apply installs the process lookup patch", () => {
  apply({ web: undefined });
  try {
    assert.equal(isProcessLookupInstalled(), true);
  } finally {
    uninstallProcessLookup();
  }
  assert.equal(isProcessLookupInstalled(), false);
});
