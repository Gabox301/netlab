import { describe, expect, test } from "bun:test";
import { Cidr, Ipv4Address, MacAddress } from "../src/addresses";

describe("MacAddress", () => {
  test("parses colon-separated hex case-insensitively", () => {
    const mac = MacAddress.parse("AA:bb:CC:dd:ee:FF");
    expect(mac.toString()).toBe("aa:bb:cc:dd:ee:ff");
    expect(mac.toBytes()).toEqual(
      new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
    );
  });

  test("accepts hyphen-separated form", () => {
    expect(MacAddress.parse("aa-bb-cc-dd-ee-ff").toString()).toBe(
      "aa:bb:cc:dd:ee:ff",
    );
  });

  test("zero-pads short groups when formatting", () => {
    expect(MacAddress.parse("0:0:0:0:0:1").toString()).toBe(
      "00:00:00:00:00:01",
    );
  });

  test("rejects malformed input", () => {
    for (const bad of [
      "",
      "aa:bb:cc:dd:ee",
      "aa:bb:cc:dd:ee:ff:00",
      "aa:bb:cc:dd:ee:zz",
      "aabb.ccdd.eeff",
      "aa:bb:cc:dd:ee:fff",
      " aa:bb:cc:dd:ee:ff",
      "aa:bb:cc:dd:ee:ff ",
    ]) {
      expect(() => MacAddress.parse(bad), bad).toThrow();
    }
  });

  test("compares, and detects broadcast/multicast", () => {
    const a = MacAddress.parse("aa:bb:cc:dd:ee:ff");
    const b = MacAddress.parse("aa:bb:cc:dd:ee:ff");
    const c = MacAddress.parse("aa:bb:cc:dd:ee:00");
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(MacAddress.BROADCAST.toString()).toBe("ff:ff:ff:ff:ff:ff");
    expect(MacAddress.BROADCAST.isBroadcast()).toBe(true);
    expect(a.isBroadcast()).toBe(false);
    // LSB of first octet set => multicast.
    expect(MacAddress.parse("01:00:5e:00:00:01").isMulticast()).toBe(true);
    expect(a.isMulticast()).toBe(false);
    expect(a.isUnicast()).toBe(true);
  });

  test("round-trips through bytes", () => {
    const mac = MacAddress.parse("12:34:56:78:9a:bc");
    expect(MacAddress.fromBytes(mac.toBytes()).equals(mac)).toBe(true);
    expect(() => MacAddress.fromBytes(new Uint8Array(5))).toThrow(/6 bytes/);
    expect(() => MacAddress.fromBytes(new Uint8Array(7))).toThrow(/6 bytes/);
  });
});

describe("Ipv4Address", () => {
  test("parses dotted decimal and formats canonically", () => {
    const ip = Ipv4Address.parse("192.168.1.10");
    expect(ip.toString()).toBe("192.168.1.10");
    expect(ip.toBytes()).toEqual(new Uint8Array([192, 168, 1, 10]));
  });

  test("treats leading zeros as decimal", () => {
    expect(Ipv4Address.parse("010.0.0.1").toString()).toBe("10.0.0.1");
  });

  test("rejects malformed input strictly", () => {
    for (const bad of [
      "",
      "1.2.3",
      "1.2.3.4.5",
      "256.0.0.1",
      "1.2.3.-1",
      "a.b.c.d",
      "1.2.3.4 ",
      " 1.2.3.4",
      "1..3.4",
      "1.2.3.4\n",
      "0x0a.0.0.1",
    ]) {
      expect(() => Ipv4Address.parse(bad), bad).toThrow();
    }
  });

  test("round-trips through u32 including boundaries", () => {
    for (const s of ["0.0.0.0", "127.0.0.1", "255.255.255.255", "10.0.1.20"]) {
      const ip = Ipv4Address.parse(s);
      expect(Ipv4Address.fromU32(ip.toU32()).toString()).toBe(s);
    }
    expect(Ipv4Address.fromU32(0).toString()).toBe("0.0.0.0");
    expect(Ipv4Address.fromU32(0xffffffff).toString()).toBe("255.255.255.255");
    // fromU32 coerces to unsigned 32-bit.
    expect(Ipv4Address.fromU32(-1).toString()).toBe("255.255.255.255");
  });

  test("round-trips through bytes with offset", () => {
    const buf = new Uint8Array([0xff, 192, 168, 0, 1, 0xee]);
    const ip = Ipv4Address.fromBytes(buf, 1);
    expect(ip.toString()).toBe("192.168.0.1");
    expect(() => Ipv4Address.fromBytes(new Uint8Array([1, 2, 3]))).toThrow();
  });

  test("classifies special addresses", () => {
    expect(Ipv4Address.parse("127.0.0.1").isLoopback()).toBe(true);
    expect(Ipv4Address.parse("127.255.0.1").isLoopback()).toBe(true);
    expect(Ipv4Address.parse("128.0.0.1").isLoopback()).toBe(false);
    expect(Ipv4Address.parse("10.1.2.3").isPrivate()).toBe(true);
    expect(Ipv4Address.parse("172.16.0.1").isPrivate()).toBe(true);
    expect(Ipv4Address.parse("172.31.255.255").isPrivate()).toBe(true);
    expect(Ipv4Address.parse("172.32.0.1").isPrivate()).toBe(false);
    expect(Ipv4Address.parse("192.168.9.9").isPrivate()).toBe(true);
    expect(Ipv4Address.parse("8.8.8.8").isPrivate()).toBe(false);
    expect(Ipv4Address.parse("224.0.0.1").isMulticast()).toBe(true);
    expect(Ipv4Address.parse("239.255.255.255").isMulticast()).toBe(true);
    expect(Ipv4Address.parse("223.255.255.255").isMulticast()).toBe(false);
    expect(Ipv4Address.parse("255.255.255.255").isBroadcast()).toBe(true);
    expect(Ipv4Address.parse("255.255.255.254").isBroadcast()).toBe(false);
  });
});

describe("Cidr", () => {
  test("parses and normalizes host bits", () => {
    const c = Cidr.parse("192.168.1.5/24");
    expect(c.toString()).toBe("192.168.1.0/24");
    expect(c.network.toString()).toBe("192.168.1.0");
  });

  test("computes mask, broadcast and size", () => {
    const c = Cidr.parse("10.0.1.0/24");
    expect(c.mask().toString()).toBe("255.255.255.0");
    expect(c.broadcast().toString()).toBe("10.0.1.255");
    expect(c.numAddresses()).toBe(256);
    expect(Cidr.parse("10.0.0.0/8").numAddresses()).toBe(16777216);
    expect(Cidr.parse("10.0.0.1/32").numAddresses()).toBe(1);
  });

  test("contains() respects network boundaries", () => {
    const c = Cidr.parse("10.0.1.0/24");
    expect(c.contains(Ipv4Address.parse("10.0.1.0"))).toBe(true);
    expect(c.contains(Ipv4Address.parse("10.0.1.20"))).toBe(true);
    expect(c.contains(Ipv4Address.parse("10.0.1.255"))).toBe(true);
    expect(c.contains(Ipv4Address.parse("10.0.2.0"))).toBe(false);
    expect(c.contains(Ipv4Address.parse("10.0.0.255"))).toBe(false);
    expect(Cidr.parse("0.0.0.0/0").contains(Ipv4Address.parse("8.8.8.8"))).toBe(
      true,
    );
    const host = Cidr.parse("10.0.0.7/32");
    expect(host.contains(Ipv4Address.parse("10.0.0.7"))).toBe(true);
    expect(host.contains(Ipv4Address.parse("10.0.0.8"))).toBe(false);
  });

  test("rejects invalid CIDR notation", () => {
    for (const bad of [
      "10.0.0.0",
      "10.0.0.0/",
      "10.0.0.0/33",
      "10.0.0.0/-1",
      "10.0.0.0/abc",
      "10.0.0/24",
      "10.0.0.0 /24",
    ]) {
      expect(() => Cidr.parse(bad), bad).toThrow();
    }
  });
});
