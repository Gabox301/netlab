/**
 * `@netlab/pcap`: classic libpcap (F-120) and pcapng (F-121, F-122) export,
 * plus the parsers `netlab pcap-import` (F-123) reads captures with. Pure
 * bytes in and out; no file system access, no Bun/Node APIs.
 */

export const PACKAGE = "@netlab/pcap";

export {
  PCAP_GLOBAL_HEADER_LENGTH,
  PCAP_LINKTYPE_ETHERNET,
  PCAP_MAGIC,
  PCAP_RECORD_HEADER_LENGTH,
  PCAP_SNAPLEN,
  PCAP_VERSION_MAJOR,
  PCAP_VERSION_MINOR,
  PCAPNG_MAGIC,
  type PcapFile,
  type PcapFrameInput,
  type PcapGlobalHeader,
  type PcapParseError,
  type PcapParseErrorCode,
  type PcapParseResult,
  type PcapRecord,
  parsePcap,
  splitTimestamp,
  writePcap,
} from "./pcap";
export {
  PCAPNG_BLOCK_HEADER_LENGTH,
  PCAPNG_BLOCK_TRAILER_LENGTH,
  PCAPNG_BYTE_ORDER_MAGIC,
  PCAPNG_EPB_MIN_LENGTH,
  PCAPNG_EPB_TYPE,
  PCAPNG_IDB_MIN_LENGTH,
  PCAPNG_IDB_TYPE,
  PCAPNG_MIN_BLOCK_LENGTH,
  PCAPNG_SHB_MIN_LENGTH,
  PCAPNG_SHB_TYPE,
  PCAPNG_TSRESOL_MICROSECONDS,
  PCAPNG_USER_APPLICATION,
  PCAPNG_VERSION_MAJOR,
  PCAPNG_VERSION_MINOR,
  type PcapngByteOrder,
  type PcapngFile,
  type PcapngFrameInput,
  type PcapngInterface,
  type PcapngLink,
  type PcapngPacket,
  type PcapngParseError,
  type PcapngParseErrorCode,
  type PcapngParseResult,
  type PcapngSectionHeader,
  parsePcapng,
  pcapngTimestampParts,
  writePcapng,
} from "./pcapng";
