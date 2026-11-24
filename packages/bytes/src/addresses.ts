/**
 * MAC (EUI-48) and IPv4 address types plus CIDR blocks.
 *
 * Parsing is strict: malformed text throws a plain `Error` with a clear
 * message. Callers that parse untrusted input (protocol headers, user forms)
 * must catch and convert to their own typed error. Numeric edge rules:
 * IPv4 leading zeros are always decimal (never octal); MAC accepts `:` or
 * `-` separators, case-insensitively. CIDR parsing normalizes host bits, so
 * `192.168.1.5/24` becomes `192.168.1.0/24`.
 */

const HEX_BYTE = /^[0-9a-fA-F]{1,2}$/;
const DEC_OCTET = /^[0-9]{1,3}$/;

function hexByte(token: string): number {
  return Number.parseInt(token, 16);
}

/** 48-bit Ethernet address. */
export class MacAddress {
  private readonly octets: Uint8Array;

  private constructor(octets: Uint8Array) {
    this.octets = octets;
  }

  /** The all-ones broadcast address `ff:ff:ff:ff:ff:ff`. */
  static readonly BROADCAST: MacAddress = new MacAddress(
    new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
  );

  /**
   * Parse `aa:bb:cc:dd:ee:ff` (or hyphen-separated). Each group is 1-2 hex
   * digits; single digits are zero-padded (`0:...:1`).
   */
  static parse(text: string): MacAddress {
    if (text.length === 0 || text !== text.trim()) {
      throw new Error(`invalid MAC address: ${JSON.stringify(text)}`);
    }
    const usesColon = text.includes(":");
    const usesHyphen = text.includes("-");
    if (usesColon === usesHyphen) {
      throw new Error(`invalid MAC address: ${JSON.stringify(text)}`);
    }
    const sep = usesColon ? ":" : "-";
    const parts = text.split(sep);
    if (parts.length !== 6 || parts.some((p) => !HEX_BYTE.test(p))) {
      throw new Error(`invalid MAC address: ${JSON.stringify(text)}`);
    }
    return new MacAddress(new Uint8Array(parts.map((p) => hexByte(p))));
  }

  /** Copy 6 bytes into an address. Throws unless the input is exactly 6 bytes. */
  static fromBytes(data: Uint8Array): MacAddress {
    if (data.length !== 6) {
      throw new RangeError(
        `MAC address requires exactly 6 bytes, got ${data.length}`,
      );
    }
    return new MacAddress(data.slice());
  }

  /** A copy of the 6 octets. */
  toBytes(): Uint8Array {
    return this.octets.slice();
  }

  /** Lowercase colon-separated form, zero-padded (`aa:0b:...`). */
  toString(): string {
    return Array.from(this.octets, (b) => b.toString(16).padStart(2, "0")).join(
      ":",
    );
  }

  equals(other: MacAddress): boolean {
    for (let i = 0; i < 6; i++) {
      if (this.octets[i] !== other.octets[i]) {
        return false;
      }
    }
    return true;
  }

  isBroadcast(): boolean {
    return this.equals(MacAddress.BROADCAST);
  }

  /** IEEE group bit: least-significant bit of the first octet. */
  isMulticast(): boolean {
    return ((this.octets[0] as number) & 0x01) === 0x01;
  }

  isUnicast(): boolean {
    return !this.isMulticast();
  }
}

/** 32-bit IPv4 address. */
export class Ipv4Address {
  private readonly value: number;

  private constructor(value: number) {
    this.value = value >>> 0;
  }

  /** Strict dotted decimal: exactly 4 groups of 1-3 ASCII digits, 0-255. */
  static parse(text: string): Ipv4Address {
    const parts = text.split(".");
    if (parts.length !== 4 || parts.some((p) => !DEC_OCTET.test(p))) {
      throw new Error(`invalid IPv4 address: ${JSON.stringify(text)}`);
    }
    let value = 0;
    for (const part of parts) {
      // Leading zeros are decimal by definition here (never octal).
      const octet = Number.parseInt(part, 10);
      if (octet > 255) {
        throw new Error(`invalid IPv4 address: ${JSON.stringify(text)}`);
      }
      value = value * 256 + octet;
    }
    return new Ipv4Address(value);
  }

  /** Build from a 32-bit word (coerced unsigned). */
  static fromU32(value: number): Ipv4Address {
    if (!Number.isFinite(value)) {
      throw new RangeError(`invalid IPv4 u32: ${value}`);
    }
    return new Ipv4Address(value);
  }

  /** Read 4 bytes big-endian at `offset`. */
  static fromBytes(data: Uint8Array, offset = 0): Ipv4Address {
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > data.length) {
      throw new RangeError(
        `IPv4 address needs 4 bytes at offset ${offset} of ${data.length}`,
      );
    }
    const value =
      (((data[offset] as number) << 24) |
        ((data[offset + 1] as number) << 16) |
        ((data[offset + 2] as number) << 8) |
        (data[offset + 3] as number)) >>>
      0;
    return new Ipv4Address(value);
  }

  /** Canonical dotted decimal. */
  toString(): string {
    const v = this.value;
    return (
      `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.` +
      `${(v >>> 8) & 0xff}.${v & 0xff}`
    );
  }

  /** The address as an unsigned 32-bit word. */
  toU32(): number {
    return this.value;
  }

  /** The 4 octets big-endian. */
  toBytes(): Uint8Array {
    const v = this.value;
    return new Uint8Array([
      (v >>> 24) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 8) & 0xff,
      v & 0xff,
    ]);
  }

  equals(other: Ipv4Address): boolean {
    return this.value === other.value;
  }

  /** `127.0.0.0/8`. */
  isLoopback(): boolean {
    return this.value >>> 24 === 127;
  }

  /** `224.0.0.0/4`. */
  isMulticast(): boolean {
    return this.value >>> 28 === 0b1110;
  }

  /** The all-ones limited broadcast. */
  isBroadcast(): boolean {
    return this.value === 0xffffffff;
  }

  /** RFC 1918 private ranges: `10/8`, `172.16/12`, `192.168/16`. */
  isPrivate(): boolean {
    const v = this.value;
    if (v >>> 24 === 10) {
      return true;
    }
    if (v >>> 20 === 0xac1) {
      // 172.16.0.0/12: top 12 bits are 1010_1100_0001.
      return true;
    }
    return v >>> 16 === 192 * 256 + 168;
  }
}

/** An IPv4 network in CIDR notation with normalized host bits. */
export class Cidr {
  readonly network: Ipv4Address;
  readonly prefixLength: number;

  private constructor(network: Ipv4Address, prefixLength: number) {
    this.network = network;
    this.prefixLength = prefixLength;
  }

  /** Parse `192.168.1.0/24`. Host bits are masked off (normalized). */
  static parse(text: string): Cidr {
    const slash = text.indexOf("/");
    if (slash < 0) {
      throw new Error(`invalid CIDR: ${JSON.stringify(text)}`);
    }
    const addrText = text.slice(0, slash);
    const prefixText = text.slice(slash + 1);
    if (!/^[0-9]{1,2}$/.test(prefixText)) {
      throw new Error(`invalid CIDR: ${JSON.stringify(text)}`);
    }
    const prefix = Number.parseInt(prefixText, 10);
    if (prefix < 0 || prefix > 32) {
      throw new Error(`invalid CIDR: ${JSON.stringify(text)}`);
    }
    const addr = Ipv4Address.parse(addrText);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return new Cidr(Ipv4Address.fromU32(addr.toU32() & mask), prefix);
  }

  /** Subnet mask as an address (`/24` -> `255.255.255.0`). */
  mask(): Ipv4Address {
    const p = this.prefixLength;
    return Ipv4Address.fromU32(p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
  }

  /** Last address in the block (all host bits set). */
  broadcast(): Ipv4Address {
    const mask = this.mask().toU32();
    return Ipv4Address.fromU32(this.network.toU32() | (~mask >>> 0));
  }

  /** Total addresses in the block (`/24` -> 256). Always exact: max 2^32. */
  numAddresses(): number {
    return 2 ** (32 - this.prefixLength);
  }

  /** True when `ip` falls inside `[network, broadcast]`. */
  contains(ip: Ipv4Address): boolean {
    const mask = this.mask().toU32();
    return (ip.toU32() & mask) === this.network.toU32();
  }

  toString(): string {
    return `${this.network.toString()}/${this.prefixLength}`;
  }
}
