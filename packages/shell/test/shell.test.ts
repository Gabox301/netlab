/**
 * Shell execution contract: exec/execText shapes, typed failures on the
 * public entry point, and coexistence with pre-existing Host callbacks.
 */

import { describe, expect, test } from "bun:test";
import type { HostEchoReply } from "@netlab/core";
import { Shell, type ShellErrorCode } from "../src/index";
import { IP_B_SAME_SUBNET, sameSubnetLab } from "./lab";

function errorCode(error: unknown): ShellErrorCode | "not-a-shell-error" {
  if (error instanceof Error && "code" in error) {
    return (error as { code: ShellErrorCode }).code;
  }
  return "not-a-shell-error";
}

describe("Shell API", () => {
  test("exec returns lines and execText joins them", async () => {
    const lab = sameSubnetLab(121);
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    const lines = await shell.exec("ip link");
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBe(2);
    expect(await shell.execText("ip link")).toBe(lines.join("\n"));
    expect(lines.join("\n").includes("\u001b[")).toBe(false);
  });

  test("exec rejects unknown commands and flags with typed errors", async () => {
    const lab = sameSubnetLab(123);
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    for (const [line, code] of [
      ["nope", "unknown_command"],
      ["ping -z 10.0.0.3", "unknown_flag"],
    ] as const) {
      let caught: unknown;
      try {
        await shell.exec(line);
      } catch (error) {
        caught = error;
      }
      expect(errorCode(caught)).toBe(code);
    }
  });

  test("keeps a Host callback installed before the shell working", async () => {
    const lab = sameSubnetLab(127);
    const observed: Array<HostEchoReply> = [];
    lab.a.onEchoReply = (reply) => observed.push(reply);

    const shell = new Shell({ host: lab.a, sim: lab.sim });
    const lines = await shell.exec(`ping -c 1 ${IP_B_SAME_SUBNET}`);
    expect(lines.filter((line) => line.includes("bytes from"))).toHaveLength(1);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.srcIp).toBe(IP_B_SAME_SUBNET);
  });
});
