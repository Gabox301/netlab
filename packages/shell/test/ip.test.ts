/**
 * `ip addr`, `ip link`, `ip route` and the neighbor cache commands (S7),
 * plus shell-side addressing/link-state configuration (S5). Everything is
 * read from the real Host: no shell-owned shadow configuration.
 */

import { describe, expect, test } from "bun:test";
import { Host, Simulation, TraceBus } from "@netlab/core";
import { Shell, type ShellErrorCode } from "../src/index";
import {
  IP_A,
  IP_B,
  IP_B_SAME_SUBNET,
  IP_R1_A,
  MAC_A,
  MAC_B,
  MAC_R1,
  MASK_24,
  sameSubnetLab,
  twoSubnetLab,
} from "./lab";

function shellFor(a: Host, sim: Simulation): Shell {
  return new Shell({ host: a, sim });
}

function shellErrorCode(error: unknown): ShellErrorCode | "not-a-shell-error" {
  if (error instanceof Error && "code" in error) {
    return (error as { code: ShellErrorCode }).code;
  }
  return "not-a-shell-error";
}

describe("ip addr (S7)", () => {
  test("shows name, state, mtu, mac, address and prefix", async () => {
    const sim = new Simulation(41);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    a.addInterface("eth0", { mac: MAC_A, ip: IP_A, mask: MASK_24 });
    a.addInterface("eth1", { mac: "02:00:00:00:00:0c" });

    const shell = shellFor(a, sim);
    expect(await shell.exec("ip addr")).toEqual([
      "1: eth0: state UP mtu 1500",
      `    link/ether ${MAC_A}`,
      "    inet 10.0.0.2/24 brd 10.0.0.255 scope global",
      "2: eth1: state UP mtu 1500",
      "    link/ether 02:00:00:00:00:0c",
    ]);
    expect(await shell.execText("ip addr show dev eth0")).toBe(
      [
        "1: eth0: state UP mtu 1500",
        `    link/ether ${MAC_A}`,
        "    inet 10.0.0.2/24 brd 10.0.0.255 scope global",
      ].join("\n"),
    );
  });

  test("reports prefixed and unprefixed addresses without inventing one", async () => {
    const sim = new Simulation(43);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    a.addInterface("eth0", { mac: MAC_A, ip: "10.0.0.2/30" });
    a.addInterface("eth1", { mac: "02:00:00:00:00:0c" });
    a.addInterface("eth2", { mac: "02:00:00:00:00:0d", ip: "10.0.1.2" });

    const shell = shellFor(a, sim);
    expect(await shell.exec("ip addr show dev eth2")).toEqual([
      "3: eth2: state UP mtu 1500",
      "    link/ether 02:00:00:00:00:0d",
      "    inet 10.0.1.2 scope global",
    ]);
    expect((await shell.exec("ip addr show dev eth0"))[2]).toBe(
      "    inet 10.0.0.2/30 brd 10.0.0.3 scope global",
    );
    expect(await shell.exec("ip addr show dev eth1")).toEqual([
      "2: eth1: state UP mtu 1500",
      "    link/ether 02:00:00:00:00:0c",
    ]);
  });
});

describe("ip link (S7)", () => {
  test("shows state/mtu/mac and applies up/down to the Host interface", async () => {
    const sim = new Simulation(47);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    a.addInterface("eth0", { mac: MAC_A, ip: IP_A, mask: MASK_24 });

    const shell = shellFor(a, sim);
    expect(await shell.exec("ip link")).toEqual([
      "1: eth0: state UP mtu 1500",
      `    link/ether ${MAC_A}`,
    ]);

    expect(await shell.exec("ip link set eth0 down")).toEqual([]);
    expect(a.getInterface("eth0").up).toBe(false);
    expect(await shell.exec("ip link show eth0")).toEqual([
      "1: eth0: state DOWN mtu 1500",
      `    link/ether ${MAC_A}`,
    ]);

    expect(await shell.exec("ip link set eth0 up")).toEqual([]);
    expect(a.getInterface("eth0").up).toBe(true);
  });
});

describe("ip addr set/add (S5)", () => {
  test("writes through Host.setIpConfig and keeps the gateway", async () => {
    const lab = sameSubnetLab(53);
    const shell = shellFor(lab.a, lab.sim);

    expect(await shell.exec("ip addr set 10.0.0.9/24 dev eth0")).toEqual([]);
    expect(lab.a.getIpConfig("eth0")?.ip.toString()).toBe("10.0.0.9");
    expect(lab.a.getIpConfig("eth0")?.prefixLength).toBe(24);

    expect(await shell.exec("ip addr add 10.0.0.10 dev eth0")).toEqual([]);
    const config = lab.a.getIpConfig("eth0");
    expect(config?.ip.toString()).toBe("10.0.0.10");
    // A plain address keeps the previous prefix, exactly like setIpConfig().
    expect(config?.prefixLength).toBe(24);
  });

  test("assigns a gateway and surfaces addressing errors as typed errors", async () => {
    const sim = new Simulation(59);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    a.addInterface("eth0", { mac: MAC_A, ip: IP_A, mask: MASK_24 });

    const shell = shellFor(a, sim);
    await shell.exec("ip addr add 10.0.0.9/24 dev eth0 gateway 10.0.0.1");
    expect(a.getIpConfig("eth0")?.gateway?.toString()).toBe("10.0.0.1");

    let caught: unknown;
    try {
      await shell.exec("ip addr set 10.0.0.9/24 dev wlan0");
    } catch (error) {
      caught = error;
    }
    expect(shellErrorCode(caught)).toBe("invalid_argument");

    caught = undefined;
    try {
      await shell.exec("ip link set wlan0 up");
    } catch (error) {
      caught = error;
    }
    expect(shellErrorCode(caught)).toBe("invalid_argument");
  });
});

describe("ip route (S7)", () => {
  test("derives connected and default routes from Host configuration", async () => {
    const sim = new Simulation(61);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    a.addInterface("eth0", {
      mac: MAC_A,
      ip: IP_A,
      mask: MASK_24,
      gateway: IP_R1_A,
    });
    const shell = shellFor(a, sim);

    expect(await shell.exec("ip route")).toEqual([
      "10.0.0.0/24 dev eth0 proto kernel scope link src 10.0.0.2",
      "default via 10.0.0.1 dev eth0",
    ]);
    expect(await shell.execText("ip route show")).toBe(
      [
        "10.0.0.0/24 dev eth0 proto kernel scope link src 10.0.0.2",
        "default via 10.0.0.1 dev eth0",
      ].join("\n"),
    );
  });

  test("prints nothing when the Host has no IPv4 configuration", async () => {
    const sim = new Simulation(67);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    a.addInterface("eth0", { mac: MAC_A });
    const shell = shellFor(a, sim);
    expect(await shell.exec("ip route")).toEqual([]);
    expect(await shell.execText("ip route")).toBe("");
  });
});

describe("arp -a and ip neigh (S7)", () => {
  test("shows the real Host ARP cache after on-link traffic", async () => {
    const lab = sameSubnetLab(71);
    const shell = shellFor(lab.a, lab.sim);
    expect(await shell.exec("arp -a")).toEqual([]);

    await shell.exec("ping -c 1 10.0.0.3");
    expect(await shell.exec("arp -a")).toEqual([
      `? (${IP_B_SAME_SUBNET}) at ${MAC_B} [ether] on eth0`,
    ]);
    expect(await shell.exec("ip neigh")).toEqual([
      `${IP_B_SAME_SUBNET} dev eth0 lladdr ${MAC_B} REACHABLE`,
    ]);
    expect(await shell.exec("ip neigh dev eth0")).toEqual([
      `${IP_B_SAME_SUBNET} dev eth0 lladdr ${MAC_B} REACHABLE`,
    ]);
  });

  test("shows the gateway as the neighbor for off-subnet traffic", async () => {
    const lab = twoSubnetLab(73);
    const shell = shellFor(lab.a, lab.sim);
    await shell.exec("ping -c 1 10.0.1.2");

    expect(await shell.exec("ip neigh")).toEqual([
      `${IP_R1_A} dev eth0 lladdr ${MAC_R1} REACHABLE`,
    ]);
    expect(await shell.exec("arp -a")).toEqual([
      `? (${IP_R1_A}) at ${MAC_R1} [ether] on eth0`,
    ]);
    // The final destination is never in A's ARP cache.
    expect((await shell.execText("arp -a")).includes(IP_B)).toBe(false);
  });
});
