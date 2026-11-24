/**
 * @netlab/bytes: binary primitives for the NetLab protocol stack.
 *
 * No runtime dependencies and no Bun/Node/DOM APIs: this package runs in
 * any JS engine (Bun, browser workers, Node). Frames travel as
 * `Uint8Array`; `bytes()` views never copy.
 */

export { Cidr, Ipv4Address, MacAddress } from "./addresses";
export { BufferReader, BufferWriter, TruncatedError } from "./buffer";
export {
  ChecksumAccumulator,
  crc32,
  internetChecksum,
  ipv4PseudoHeader,
  transportChecksum,
} from "./checksum";
export { type HexdumpOptions, hexdump } from "./hexdump";
