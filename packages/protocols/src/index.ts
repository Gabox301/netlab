/**
 * @netlab/protocols: header codecs for the NetLab stack.
 *
 * Parsers are total: invalid bytes produce a typed `ParseResult` error, never
 * an exception. Serializers return exact `Uint8Array`s ready for a link.
 */

export const PACKAGE = "@netlab/protocols";

export {
  ARP_HARDWARE_ADDRESS_LENGTH,
  ARP_HTYPE_ETHERNET,
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ARP_PACKET_LENGTH,
  ARP_PROTOCOL_ADDRESS_LENGTH,
  ARP_PTYPE_IPV4,
  type ArpPacket,
  parseArp,
  serializeArp,
} from "./arp";
export {
  ETHERNET_HEADER_LENGTH,
  ETHERNET_MIN_FRAME_LENGTH,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ETHERTYPE_VLAN,
  type EthernetFrame,
  type EthernetHeader,
  type MacFilterOptions,
  type ParseError,
  type ParseResult,
  parseErr,
  parseEthernet,
  parseOk,
  serializeEthernet,
  shouldAccept,
} from "./ethernet";
