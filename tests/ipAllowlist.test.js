import { describe, it, expect } from "vitest";
import { parseCIDR, ipToInt, isInRange, normalizeIP } from "../src/middleware/ipAllowlist";

describe("ipToInt", () => {
  it("converts 0.0.0.0 to 0", () => {
    expect(ipToInt("0.0.0.0")).toBe(0);
  });

  it("converts 255.255.255.255 to max uint32", () => {
    expect(ipToInt("255.255.255.255")).toBe(4294967295);
  });

  it("converts 10.0.0.1 correctly", () => {
    expect(ipToInt("10.0.0.1")).toBe(167772161);
  });
});

describe("parseCIDR", () => {
  it("parses a /8 range", () => {
    const result = parseCIDR("10.0.0.0/8");
    expect(result).not.toBeNull();
    expect(result.prefixLen).toBe(8);
  });

  it("parses a single IP as /32", () => {
    const result = parseCIDR("192.168.1.50");
    expect(result).not.toBeNull();
    expect(result.prefixLen).toBe(32);
  });

  it("rejects invalid CIDR", () => {
    expect(parseCIDR("not-an-ip/8")).toBeNull();
    expect(parseCIDR("10.0.0.0/33")).toBeNull();
  });
});

describe("isInRange", () => {
  it("matches IP within a /8 range", () => {
    const range = parseCIDR("10.0.0.0/8");
    expect(isInRange("10.0.0.1", range)).toBe(true);
    expect(isInRange("10.255.255.255", range)).toBe(true);
    expect(isInRange("11.0.0.1", range)).toBe(false);
  });

  it("matches IP within a /24 range", () => {
    const range = parseCIDR("192.168.1.0/24");
    expect(isInRange("192.168.1.1", range)).toBe(true);
    expect(isInRange("192.168.1.254", range)).toBe(true);
    expect(isInRange("192.168.2.1", range)).toBe(false);
  });

  it("matches exact IP with /32", () => {
    const range = parseCIDR("192.168.1.50/32");
    expect(isInRange("192.168.1.50", range)).toBe(true);
    expect(isInRange("192.168.1.51", range)).toBe(false);
  });

  it("handles common private ranges", () => {
    const range10 = parseCIDR("10.0.0.0/8");
    const range172 = parseCIDR("172.16.0.0/12");
    const range192 = parseCIDR("192.168.0.0/16");

    expect(isInRange("10.50.100.200", range10)).toBe(true);
    expect(isInRange("172.20.5.1", range172)).toBe(true);
    expect(isInRange("172.32.0.1", range172)).toBe(false);
    expect(isInRange("192.168.5.10", range192)).toBe(true);
  });

  it("rejects non-IPv4 addresses", () => {
    const range = parseCIDR("10.0.0.0/8");
    expect(isInRange("not-an-ip", range)).toBe(false);
  });
});

describe("normalizeIP", () => {
  it("strips IPv4-mapped IPv6 prefix", () => {
    expect(normalizeIP("::ffff:10.0.0.1")).toBe("10.0.0.1");
  });

  it("converts IPv6 loopback to IPv4", () => {
    expect(normalizeIP("::1")).toBe("127.0.0.1");
  });

  it("passes through normal IPv4", () => {
    expect(normalizeIP("192.168.1.1")).toBe("192.168.1.1");
  });

  it("handles null/undefined", () => {
    expect(normalizeIP(null)).toBeNull();
    expect(normalizeIP(undefined)).toBeNull();
  });
});
