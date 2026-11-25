/**
 * `@netlab/pcap`: classic libpcap export (F-120) and, later, pcapng and
 * import (F-121 to F-123). Pure bytes in and out; no file system access, no
 * Bun/Node APIs.
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
