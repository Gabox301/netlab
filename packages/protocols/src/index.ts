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
export {
  ICMP_CODE_FRAG_NEEDED,
  ICMP_CODE_FRAG_REASSEMBLY,
  ICMP_CODE_HOST_UNREACHABLE,
  ICMP_CODE_NET_UNREACHABLE,
  ICMP_CODE_PORT_UNREACHABLE,
  ICMP_CODE_PROTOCOL_UNREACHABLE,
  ICMP_CODE_TTL_EXCEEDED,
  ICMP_HEADER_LENGTH,
  ICMP_TYPE_DEST_UNREACHABLE,
  ICMP_TYPE_ECHO_REPLY,
  ICMP_TYPE_ECHO_REQUEST,
  ICMP_TYPE_TIME_EXCEEDED,
  type IcmpMessage,
  parseIcmp,
  serializeIcmp,
} from "./icmp";
export {
  IPV4_MIN_HEADER_LENGTH,
  IPV4_PROTOCOL_ICMP,
  IPV4_PROTOCOL_TCP,
  IPV4_PROTOCOL_UDP,
  IPV4_VERSION,
  type Ipv4Flags,
  type Ipv4Header,
  type Ipv4Packet,
  parseIpv4,
  serializeIpv4,
} from "./ipv4";
export {
  parseUdp,
  serializeUdp,
  UDP_HEADER_LENGTH,
  type UdpDatagram,
  type UdpSegment,
} from "./udp";
export {
  isVlanId,
  parseEthernetWithVlan,
  parseTaggedEthernet,
  parseVlanTag,
  serializeTaggedEthernet,
  serializeVlanTag,
  type TaggedEthernetHeader,
  VLAN_HEADER_LENGTH,
  VLAN_ID_MAX,
  VLAN_ID_MIN,
  VLAN_MIN_FRAME_LENGTH,
  VLAN_PCP_MAX,
  VLAN_TAG_LENGTH,
  VLAN_TCI_LENGTH,
  VLAN_TPID,
  VLAN_VID_MAX,
  type VlanAwareEthernetFrame,
  type VlanFrame,
  type VlanTag,
} from "./vlan";
