import { describe, expect, it } from "vitest";

import { getAllowedDevOrigins } from "./dev-origins";

// A minimal stand-in for one entry of `networkInterfaces()`. The helper reads
// only these three fields, so the fixtures stay readable.
function entry(address: string, family: "IPv4" | "IPv6", internal = false) {
  return { address, family, internal };
}

describe("getAllowedDevOrigins", () => {
  it("keeps the non-internal IPv4 addresses and drops loopback and IPv6", () => {
    const interfaces = {
      lo0: [entry("127.0.0.1", "IPv4", true), entry("::1", "IPv6", true)],
      en0: [entry("192.168.1.42", "IPv4"), entry("fe80::1c2b", "IPv6")],
    };

    expect(getAllowedDevOrigins(interfaces)).toEqual(["192.168.1.42"]);
  });

  it("de-duplicates an address reported on more than one interface", () => {
    const interfaces = {
      en0: [entry("10.0.0.5", "IPv4")],
      en1: [entry("10.0.0.6", "IPv4"), entry("10.0.0.5", "IPv4")],
    };

    expect(getAllowedDevOrigins(interfaces)).toEqual(["10.0.0.5", "10.0.0.6"]);
  });

  it("returns an empty list when there is no non-internal IPv4 address", () => {
    expect(getAllowedDevOrigins({})).toEqual([]);
    expect(getAllowedDevOrigins({ lo0: [entry("127.0.0.1", "IPv4", true)] })).toEqual([]);
    // `networkInterfaces()` leaves a key undefined when the interface went away.
    expect(getAllowedDevOrigins({ en0: undefined })).toEqual([]);
  });

  it("defaults to this machine's interfaces, returning only IPv4 literals", () => {
    const origins = getAllowedDevOrigins();

    expect(Array.isArray(origins)).toBe(true);
    for (const origin of origins) {
      expect(origin).toMatch(/^\d{1,3}(?:\.\d{1,3}){3}$/);
    }
  });
});
