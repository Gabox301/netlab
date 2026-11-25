/**
 * `nc` (TCP), `ss` and the minimal HTTP/1.0 stack (Fase 5 / T6): the shell
 * surface of the TCP sockets, the accept queue and the HTTP client/server.
 *
 * Every fixture reuses the shared lab (`@netlab/shell/test/lab.ts`), so the
 * commands ride the same deterministic topologies as the rest of the shell
 * suite. Nothing here touches wall-clock time: the clock is `sim.now`, and a
 * TCP command always runs to its virtual deadline, exactly like `nc -u`.
 */

import { describe, expect, test } from "bun:test";
import { TcpSocket } from "@netlab/core";
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_NC_TIMEOUT_US,
  parseCommandLine,
  Shell,
  type ShellCommand,
  type ShellError,
  type ShellErrorCode,
} from "../src/index";
import {
  IP_A,
  IP_B_SAME_SUBNET,
  LATENCY_US,
  type SameSubnetLab,
  sameSubnetLab,
} from "./lab";

const TCP_ECHO_PORT = 9091;
const DARK_PORT = 9099;
const HTTP_PORT = 8080;
const HEX_HELLO = "68656c6c6f";
const DEADLINE_US = 500;

function accepted(line: string): ShellCommand {
  const result = parseCommandLine(line);
  if (!result.ok) {
    throw new Error(
      `expected ${JSON.stringify(line)} to parse: ${result.error.message}`,
    );
  }
  return result.value;
}

function rejected(line: string): ShellError {
  const result = parseCommandLine(line);
  if (result.ok) {
    throw new Error(`expected ${JSON.stringify(line)} to be rejected`);
  }
  return result.error;
}

function errorCode(error: unknown): ShellErrorCode | "not-a-shell-error" {
  if (error instanceof Error && "code" in error) {
    return (error as { code: ShellErrorCode }).code;
  }
  return "not-a-shell-error";
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return errorCode(error);
  }
  return "resolved";
}

/**
 * TCP echo server of the lab: the historical single-connection listener
 * (`backlog` defaults to 1), so the listening socket is the connection and
 * `onData` is enough. A test that needs the accept queue asks for it.
 */
function tcpEcho(lab: SameSubnetLab, port = TCP_ECHO_PORT): TcpSocket {
  const server = new TcpSocket({ host: lab.b, sim: lab.sim });
  server.onData = (data) => server.send(data);
  server.listen(port);
  return server;
}

describe("parse: nc TCP grammar (T6)", () => {
  test("accepts host, port and an optional hex payload", () => {
    expect(accepted(`nc ${IP_B_SAME_SUBNET} ${TCP_ECHO_PORT}`)).toEqual({
      kind: "nc.tcp",
      host: IP_B_SAME_SUBNET,
      port: TCP_ECHO_PORT,
      payload: "",
    });
    expect(
      accepted(`nc ${IP_B_SAME_SUBNET} ${TCP_ECHO_PORT} ${HEX_HELLO}`),
    ).toEqual({
      kind: "nc.tcp",
      host: IP_B_SAME_SUBNET,
      port: TCP_ECHO_PORT,
      payload: HEX_HELLO,
    });
    expect(accepted(`nc ${IP_B_SAME_SUBNET} ${TCP_ECHO_PORT} 4A4B`)).toEqual({
      kind: "nc.tcp",
      host: IP_B_SAME_SUBNET,
      port: TCP_ECHO_PORT,
      payload: "4a4b",
    });
    // UDP stays opt-in and keeps its own command kind.
    expect(accepted(`nc -u ${IP_B_SAME_SUBNET} ${TCP_ECHO_PORT}`)).toEqual({
      kind: "nc.udp",
      host: IP_B_SAME_SUBNET,
      port: TCP_ECHO_PORT,
      payload: "",
    });
  });

  test("rejects bad flags, ports, hosts and hex", () => {
    expect(rejected(`nc -l ${TCP_ECHO_PORT}`).code).toBe("unknown_flag");
    expect(rejected(`nc -t ${IP_B_SAME_SUBNET} ${TCP_ECHO_PORT}`).code).toBe(
      "unknown_flag",
    );
    expect(rejected(`nc ${IP_B_SAME_SUBNET}`).code).toBe("missing_argument");
    expect(rejected(`nc ${IP_B_SAME_SUBNET} 0`).code).toBe("invalid_argument");
    expect(rejected(`nc ${IP_B_SAME_SUBNET} 65536`).code).toBe(
      "invalid_argument",
    );
    expect(rejected(`nc localhost ${TCP_ECHO_PORT}`).code).toBe(
      "invalid_argument",
    );
    expect(rejected(`nc ${IP_B_SAME_SUBNET} ${TCP_ECHO_PORT} abc`).code).toBe(
      "invalid_argument",
    );
    expect(
      rejected(`nc ${IP_B_SAME_SUBNET} ${TCP_ECHO_PORT} ${HEX_HELLO} x`).code,
    ).toBe("unexpected_argument");
  });
});

describe("parse: ss, http-server and curl grammar (T6)", () => {
  test("ss takes no arguments", () => {
    expect(accepted("ss")).toEqual({ kind: "ss" });
    expect(rejected("ss -t").code).toBe("unknown_flag");
    expect(rejected("ss eth0").code).toBe("unexpected_argument");
  });

  test("http-server takes an optional port", () => {
    expect(accepted("http-server")).toEqual({ kind: "http.server" });
    expect(accepted(`http-server ${HTTP_PORT}`)).toEqual({
      kind: "http.server",
      port: HTTP_PORT,
    });
    expect(rejected(`http-server ${DEFAULT_HTTP_PORT} ${HTTP_PORT}`).code).toBe(
      "unexpected_argument",
    );
    expect(rejected("http-server -p 8080").code).toBe("unknown_flag");
    expect(rejected("http-server 0").code).toBe("invalid_argument");
    expect(rejected("http-server 65536").code).toBe("invalid_argument");
    expect(rejected("http-server http").code).toBe("invalid_argument");
  });

  test("curl takes an http URL or a bare authority", () => {
    expect(accepted(`curl http://${IP_B_SAME_SUBNET}:${HTTP_PORT}/`)).toEqual({
      kind: "http.get",
      host: IP_B_SAME_SUBNET,
      port: HTTP_PORT,
      path: "/",
    });
    expect(accepted(`curl ${IP_B_SAME_SUBNET}`)).toEqual({
      kind: "http.get",
      host: IP_B_SAME_SUBNET,
      port: DEFAULT_HTTP_PORT,
      path: "/",
    });
    expect(accepted(`curl ${IP_B_SAME_SUBNET}:${HTTP_PORT}/missing`)).toEqual({
      kind: "http.get",
      host: IP_B_SAME_SUBNET,
      port: HTTP_PORT,
      path: "/missing",
    });
    expect(accepted(`curl http://${IP_B_SAME_SUBNET}/a/b`)).toEqual({
      kind: "http.get",
      host: IP_B_SAME_SUBNET,
      port: DEFAULT_HTTP_PORT,
      path: "/a/b",
    });
  });

  test("curl rejects missing, unsupported and malformed targets", () => {
    expect(rejected("curl").code).toBe("missing_argument");
    expect(rejected("curl -O http://10.0.0.3/").code).toBe("unknown_flag");
    expect(rejected(`curl https://${IP_B_SAME_SUBNET}/`).code).toBe(
      "unsupported",
    );
    expect(rejected("curl localhost/").code).toBe("invalid_argument");
    expect(rejected(`curl ${IP_B_SAME_SUBNET}:0/`).code).toBe(
      "invalid_argument",
    );
    expect(rejected(`curl ${IP_B_SAME_SUBNET}:65536/`).code).toBe(
      "invalid_argument",
    );
    expect(rejected(`curl http://${IP_B_SAME_SUBNET}/ extra`).code).toBe(
      "unexpected_argument",
    );
  });

  test("never throws, always returns a typed result", () => {
    const lines = [
      "",
      "   ",
      "ss",
      "ss -a",
      "nc",
      "nc 10.0.0.3",
      "nc ::1 80",
      "http-server",
      "http-server -1",
      "http-server 99999999999999999999",
      "curl",
      "curl http://",
      "curl http://:80/",
      "curl http://10.0.0.3:/",
      "curl http://10.0.0.3:abc/",
      "\u0000",
    ];
    for (const line of lines) {
      const result = parseCommandLine(line);
      expect(typeof result.ok).toBe("boolean");
      if (!result.ok) {
        expect(result.error.kind).toBe("shell_error");
        expect(typeof result.error.message).toBe("string");
      }
    }
  });
});

describe("nc (TCP) over the lab (T6)", () => {
  test("sends the hex payload, prints the echo and waits for the deadline", async () => {
    const lab = sameSubnetLab(181);
    const echo = tcpEcho(lab);
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      ncTimeoutUs: DEADLINE_US,
    });

    const lines = await shell.exec(
      `nc ${IP_B_SAME_SUBNET} ${TCP_ECHO_PORT} ${HEX_HELLO}`,
    );
    expect(lines).toEqual([
      `TCP ${IP_B_SAME_SUBNET}:${TCP_ECHO_PORT}`,
      `sent 5 bytes: ${HEX_HELLO}`,
      `received 5 bytes: ${HEX_HELLO}`,
      `--- ${IP_B_SAME_SUBNET}:${TCP_ECHO_PORT} tcp ---`,
      "state ESTABLISHED, 5 bytes received",
    ]);
    // The command holds the connection open for the whole virtual window.
    expect(lab.sim.now).toBe(DEADLINE_US);
    echo.close();
  });

  test("sends an empty payload when no hex is given", async () => {
    const lab = sameSubnetLab(183);
    const echo = tcpEcho(lab);
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      ncTimeoutUs: DEADLINE_US,
    });

    const lines = await shell.exec(`nc ${IP_B_SAME_SUBNET} ${TCP_ECHO_PORT}`);
    expect(lines).toEqual([
      `TCP ${IP_B_SAME_SUBNET}:${TCP_ECHO_PORT}`,
      "sent 0 bytes",
      "received 0 bytes",
      `--- ${IP_B_SAME_SUBNET}:${TCP_ECHO_PORT} tcp ---`,
      "state ESTABLISHED, 0 bytes received",
    ]);
    echo.close();
  });

  test("reports a refused connection when nobody listens", async () => {
    const lab = sameSubnetLab(185);
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      ncTimeoutUs: DEADLINE_US,
    });

    const lines = await shell.exec(
      `nc ${IP_B_SAME_SUBNET} ${DARK_PORT} ${HEX_HELLO}`,
    );
    expect(lines).toEqual([
      `TCP ${IP_B_SAME_SUBNET}:${DARK_PORT}`,
      "connect: refused",
      "received 0 bytes",
      `--- ${IP_B_SAME_SUBNET}:${DARK_PORT} tcp ---`,
      "state CLOSED, 0 bytes received",
    ]);
    expect(lab.sim.now).toBe(DEADLINE_US);
  });

  test("reports a timeout when the listener is busy and drops the SYN", async () => {
    const lab = sameSubnetLab(189);
    const echo = tcpEcho(lab);
    // The default listener holds one connection: a second SYN is discarded
    // without a RST, so the connect simply never completes.
    const first = new TcpSocket({ host: lab.a, sim: lab.sim });
    first.connect(IP_B_SAME_SUBNET, TCP_ECHO_PORT, { localPort: 49300 });
    lab.sim.runUntil(lab.sim.now + 10 * LATENCY_US);
    expect(first.state).toBe("ESTABLISHED");

    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      ncTimeoutUs: DEADLINE_US,
    });
    const from = lab.sim.now;
    const lines = await shell.exec(`nc ${IP_B_SAME_SUBNET} ${TCP_ECHO_PORT}`);
    expect(lines).toEqual([
      `TCP ${IP_B_SAME_SUBNET}:${TCP_ECHO_PORT}`,
      "connect: timeout",
      "received 0 bytes",
      `--- ${IP_B_SAME_SUBNET}:${TCP_ECHO_PORT} tcp ---`,
      "state SYN_SENT, 0 bytes received",
    ]);
    expect(lab.sim.now).toBe(from + DEADLINE_US);
    first.close();
    echo.close();
  });

  test("turns a routing failure into a typed execution error", async () => {
    const lab = sameSubnetLab(187);
    lab.a.setIpConfig("eth0", { ip: IP_A, mask: "255.255.255.0" });
    lab.a.getInterface("eth0").up = false;
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    expect(
      await rejection(shell.exec(`nc ${IP_B_SAME_SUBNET} ${TCP_ECHO_PORT}`)),
    ).toBe("execution_failed");
    expect(lab.sim.now).toBe(0);
  });
});

describe("ss over the lab (T6)", () => {
  test("lists the listening socket and its ESTABLISHED connection", async () => {
    const lab = sameSubnetLab(191);
    const shell = new Shell({ host: lab.b, sim: lab.sim });

    const installed = await shell.exec(`http-server ${HTTP_PORT}`);
    expect(installed[0]).toBe(
      `HTTP/1.0 server listening on 0.0.0.0:${HTTP_PORT}`,
    );
    expect(installed[1]).toContain("GET /");
    // Installing a server is state, not traffic: the clock does not move.
    expect(lab.sim.now).toBe(0);

    const client = new TcpSocket({
      host: lab.a,
      sim: lab.sim,
      initialSequence: 5000,
    });
    client.connect(IP_B_SAME_SUBNET, HTTP_PORT, { localPort: 49300 });
    // Both ends: the client sees ESTABLISHED on the SYN+ACK, the server one
    // one-way delay later, when the final ACK arrives.
    lab.sim.runUntil(lab.sim.now + 10 * LATENCY_US);
    expect(client.state).toBe("ESTABLISHED");

    const lines = await shell.exec("ss");
    expect(lines[0]).toContain("State");
    expect(lines[0]).toContain("Local Address");
    expect(lines[0]).toContain("Peer Address");
    expect(lines[0]).toContain("Cwnd");
    expect(lines[0]).toContain("Ssthresh");

    const listenRow = lines.find((line) => line.includes("LISTEN"));
    expect(listenRow).toBeDefined();
    expect(listenRow).toContain(`0.0.0.0:${HTTP_PORT}`);

    const establishedRow = lines.find((line) => line.includes("ESTABLISHED"));
    expect(establishedRow).toBeDefined();
    expect(establishedRow).toContain(`${IP_B_SAME_SUBNET}:${HTTP_PORT}`);
    expect(establishedRow).toContain(`${IP_A}:49300`);
    // A fresh connection advertises cwnd = 1 MSS and ssthresh = 4 MSS.
    expect(establishedRow).toContain("1460");
    expect(establishedRow).toContain("5840");
    client.close();
  });

  test("prints only the header when the host has no TCP sockets", async () => {
    const lab = sameSubnetLab(193);
    const shell = new Shell({ host: lab.a, sim: lab.sim });
    const lines = await shell.exec("ss");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("State");
    expect(lab.sim.now).toBe(0);
  });
});

describe("HTTP over the lab (T6)", () => {
  test("serves a fixed page to a GET request", async () => {
    const lab = sameSubnetLab(197);
    const server = new Shell({ host: lab.b, sim: lab.sim });
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      ncTimeoutUs: DEADLINE_US,
    });

    await server.exec(`http-server ${HTTP_PORT}`);
    const body = await shell.exec(
      `curl http://${IP_B_SAME_SUBNET}:${HTTP_PORT}/`,
    );
    expect(body[0]).toBe("<!doctype html>");
    expect(body).toContain("<h1>netlab</h1>");
    expect(body.at(-1)).toBe("</html>");
    expect(body.join("\n")).not.toContain("HTTP/1.0 200");
    // The client collects until its deadline, like `nc`.
    expect(lab.sim.now).toBe(DEADLINE_US);
  });

  test("answers 404 for an unknown path", async () => {
    const lab = sameSubnetLab(199);
    const server = new Shell({ host: lab.b, sim: lab.sim });
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      ncTimeoutUs: DEADLINE_US,
    });

    await server.exec(`http-server ${HTTP_PORT}`);
    const lines = await shell.exec(
      `curl ${IP_B_SAME_SUBNET}:${HTTP_PORT}/missing`,
    );
    expect(lines[0]).toBe("curl: HTTP 404 Not Found");
    expect(lines).toContain("<h1>404 Not Found</h1>");
  });

  test("fails with a typed error when nobody listens", async () => {
    const lab = sameSubnetLab(201);
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      ncTimeoutUs: DEADLINE_US,
    });

    expect(
      await rejection(shell.exec(`curl http://${IP_B_SAME_SUBNET}:9/`)),
    ).toBe("execution_failed");
  });
});

describe("fase 5 shell determinism (T6)", () => {
  test("identical labs and seeds produce identical TCP output", async () => {
    async function run(): Promise<Array<string>> {
      const lab = sameSubnetLab(203);
      const echo = tcpEcho(lab);
      const server = new Shell({ host: lab.b, sim: lab.sim });
      const client = new Shell({
        host: lab.a,
        sim: lab.sim,
        ncTimeoutUs: DEADLINE_US,
      });
      const installed = await server.exec(`http-server ${HTTP_PORT}`);
      const echoed = await client.exec(
        `nc ${IP_B_SAME_SUBNET} ${TCP_ECHO_PORT} ${HEX_HELLO}`,
      );
      const refused = await client.exec(
        `nc ${IP_B_SAME_SUBNET} ${DARK_PORT} ${HEX_HELLO}`,
      );
      const page = await client.exec(`curl ${IP_B_SAME_SUBNET}:${HTTP_PORT}/`);
      const listing = await server.exec("ss");
      echo.close();
      return [...installed, ...echoed, ...refused, ...page, ...listing];
    }

    const left = await run();
    const right = await run();
    expect(left).toEqual(right);
    expect(left.length).toBeGreaterThan(10);
    // No wall-clock timestamp ever leaks into the output.
    expect(left.join("\n")).not.toMatch(/\b(19|20)\d\d-\d\d-\d\d\b/);
  });

  test("the default TCP deadline mirrors nc -u", () => {
    expect(DEFAULT_NC_TIMEOUT_US).toBe(1_000_000);
    expect(DEFAULT_HTTP_PORT).toBe(80);
  });
});
