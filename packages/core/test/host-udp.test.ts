/**
 * Host UDP sockets (F-51/52): delivery to a bound port and Port Unreachable
 * when nobody listens.
 */

import { describe, expect, test } from "bun:test";
import {
  ICMP_CODE_PORT_UNREACHABLE,
  ICMP_TYPE_DEST_UNREACHABLE,
} from "@netlab/protocols";
import { connect } from "../src/devices";
import { Host, type HostIcmpError, type HostUdpDatagram } from "../src/host";
import { Link } from "../src/link";
import { Simulation } from "../src/sim";
import { TraceBus } from "../src/trace";

const LATENCY_US = 10;
const MASK_24 = "255.255.255.0";
const MAC_A = "02:00:00:00:00:0a";
const MAC_B = "02:00:00:00:00:0b";
const IP_A = "10.0.0.2";
const IP_B = "10.0.0.3";

function directLink(): {
  sim: Simulation;
  a: Host;
  b: Host;
} {
  const sim = new Simulation(41);
  const bus = new TraceBus();
  const a = new Host(sim, "a", bus);
  const b = new Host(sim, "b", bus);
  connect(
    new Link(sim, "l0", { latencyUs: LATENCY_US }, bus),
    a.addInterface("eth0", { mac: MAC_A, ip: IP_A, mask: MASK_24 }),
    b.addInterface("eth0", { mac: MAC_B, ip: IP_B, mask: MASK_24 }),
  );
  return { sim, a, b };
}

describe("Host UDP sockets", () => {
  test("delivers a datagram to the bound port", () => {
    const { sim, a, b } = directLink();
    const atB: Array<HostUdpDatagram> = [];
    b.bindUdp(53, (datagram) => atB.push(datagram));

    a.sendUdp(IP_B, 53, new Uint8Array([1, 2, 3]), { srcPort: 1234 });
    sim.runAll();

    expect(atB).toHaveLength(1);
    expect(atB[0]).toMatchObject({
      srcIp: IP_A,
      dstIp: IP_B,
      srcPort: 1234,
      dstPort: 53,
    });
    expect(atB[0]?.payload).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("answers an unbound port with ICMP Port Unreachable", () => {
    const { sim, a, b } = directLink();
    const errors: Array<HostIcmpError> = [];
    a.onIcmpError = (error) => errors.push(error);
    const atB: Array<HostUdpDatagram> = [];
    b.onUdp = (datagram) => atB.push(datagram);

    a.sendUdp(IP_B, 9999, new Uint8Array([9]), { srcPort: 1111 });
    sim.runAll();

    expect(atB).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: ICMP_TYPE_DEST_UNREACHABLE,
      code: ICMP_CODE_PORT_UNREACHABLE,
    });
  });
});
