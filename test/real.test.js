import assert from "node:assert/strict";
import test from "node:test";
import { addressesFromDohJson, resolveRealAddresses } from "../src/real.js";

test("DNS-JSON answers keep A and AAAA records and skip CNAME chains", () => {
  const alidns = {
    Status: 0,
    Question: { name: "github.com.", type: 1 },
    Answer: [{ name: "github.com.", TTL: 20, type: 1, data: "20.205.243.166" }],
  };
  const chain = {
    Status: 0,
    Question: [{ name: "learn.microsoft.com.", type: 1 }],
    Answer: [
      { name: "learn.microsoft.com.", type: 5, data: "learn-public.trafficmanager.net." },
      { name: "e13636.dscb.akamaiedge.net.", type: 1, data: "23.55.98.77" },
    ],
  };
  const soaOnly = {
    Status: 0,
    Authority: [{ name: "github.com.", type: 6, data: "ns.example. hostmaster.example. 1 2 3 4 5" }],
  };
  assert.deepEqual(addressesFromDohJson(alidns), [{ address: "20.205.243.166", family: 4 }]);
  assert.deepEqual(addressesFromDohJson(chain), [{ address: "23.55.98.77", family: 4 }]);
  assert.deepEqual(addressesFromDohJson(soaOnly), []);
  assert.deepEqual(addressesFromDohJson(null), []);
});

test("UDP public answers skip DoH, and a fake UDP answer falls through", async () => {
  let dohCalls = 0;
  const fromUdp = await resolveRealAddresses("github.com", new AbortController().signal, {
    async udp() {
      return [{ address: "20.205.243.166", family: 4 }];
    },
    async doh() {
      dohCalls += 1;
      return [{ address: "1.2.3.4", family: 4 }];
    },
  });
  assert.equal(dohCalls, 0);
  assert.deepEqual(fromUdp, [{ address: "20.205.243.166", family: 4 }]);

  const fromDoh = await resolveRealAddresses("github.com", new AbortController().signal, {
    async udp() {
      return [{ address: "198.18.118.96", family: 4 }];
    },
    async doh() {
      dohCalls += 1;
      return [
        { address: "198.18.0.1", family: 4 },
        { address: "20.205.243.166", family: 4 },
      ];
    },
  });
  assert.equal(dohCalls, 1);
  assert.deepEqual(fromDoh, [{ address: "20.205.243.166", family: 4 }]);
});
