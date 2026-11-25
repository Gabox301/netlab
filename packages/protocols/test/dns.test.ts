import { describe, expect, test } from "bun:test";
import {
  DNS_CLASS_IN,
  DNS_TYPE_A,
  type DnsFlags,
  type DnsMessage,
  parseDns,
  serializeDns,
  serializeDnsResponse,
} from "../src/dns";

const QUERY_FLAGS: DnsFlags = {
  qr: false,
  opcode: 0,
  aa: false,
  tc: false,
  rd: true,
  ra: false,
  rcode: 0,
};

function unwrap(result: ReturnType<typeof parseDns>): DnsMessage {
  if (!result.ok) {
    throw new Error(
      `expected ok, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

function queryMessage(): DnsMessage {
  return {
    id: 0x1234,
    flags: { ...QUERY_FLAGS },
    questions: [
      { name: "www.example.com", type: DNS_TYPE_A, class: DNS_CLASS_IN },
    ],
    answers: [],
    authorities: [],
    additionals: [],
  };
}

describe("dns codec (F-70/71)", () => {
  test("round-trips a query", () => {
    const message = queryMessage();
    const parsed = unwrap(parseDns(serializeDns(message)));
    expect(parsed).toEqual(message);
  });

  test("round-trips a response with an A record", () => {
    const message: DnsMessage = {
      id: 0xbeef,
      flags: {
        qr: true,
        opcode: 0,
        aa: true,
        tc: false,
        rd: true,
        ra: false,
        rcode: 0,
      },
      questions: [
        { name: "www.example.com", type: DNS_TYPE_A, class: DNS_CLASS_IN },
      ],
      answers: [
        {
          kind: "a",
          name: "www.example.com",
          type: DNS_TYPE_A,
          class: DNS_CLASS_IN,
          ttl: 120,
          address: "192.0.2.53",
        },
      ],
      authorities: [],
      additionals: [],
    };
    const parsed = unwrap(parseDns(serializeDnsResponse(message)));
    expect(parsed).toEqual(message);
  });

  test("preserves the case of names", () => {
    const message = queryMessage();
    message.questions = [
      { name: "WWW.Example.COM", type: DNS_TYPE_A, class: DNS_CLASS_IN },
    ];
    const parsed = unwrap(parseDns(serializeDns(message)));
    expect(parsed.questions[0]?.name).toBe("WWW.Example.COM");
  });

  test("serializeDns compresses response owner names by default", () => {
    const message: DnsMessage = {
      ...queryMessage(),
      flags: { ...QUERY_FLAGS, qr: true, aa: true },
      answers: [
        {
          kind: "a",
          name: "www.example.com",
          type: DNS_TYPE_A,
          class: DNS_CLASS_IN,
          ttl: 60,
          address: "198.51.100.7",
        },
      ],
    };
    const bytes = serializeDns(message);
    const answerNameOffset = 12 + 17 + 4;
    expect(
      Array.from(bytes.slice(answerNameOffset, answerNameOffset + 2)),
    ).toEqual([0xc0, 0x0c]);
  });

  test("encodes response names as pointers to the question name", () => {
    const message: DnsMessage = {
      ...queryMessage(),
      flags: { ...QUERY_FLAGS, qr: true, aa: true },
      answers: [
        {
          kind: "a",
          name: "www.example.com",
          type: DNS_TYPE_A,
          class: DNS_CLASS_IN,
          ttl: 60,
          address: "198.51.100.7",
        },
        {
          kind: "a",
          name: "www.example.com",
          type: DNS_TYPE_A,
          class: DNS_CLASS_IN,
          ttl: 60,
          address: "198.51.100.8",
        },
      ],
    };
    const bytes = serializeDnsResponse(message);
    // Header (12) + QNAME (17) + QTYPE/QCLASS (4).
    const answerNameOffset = 12 + 17 + 4;
    expect(
      Array.from(bytes.slice(answerNameOffset, answerNameOffset + 2)),
    ).toEqual([0xc0, 0x0c]);
    const parsed = unwrap(parseDns(bytes));
    expect(parsed.answers).toEqual(message.answers);
  });

  test("decodes compressed question names", () => {
    const wire = new Uint8Array([
      0x00, 0x01, 0x01, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      // "a.lab"
      0x01, 0x61, 0x03, 0x6c, 0x61, 0x62, 0x00, 0x00, 0x01, 0x00, 0x01,
      // Pointer back to offset 12, then QTYPE/QCLASS.
      0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01,
    ]);
    const message = unwrap(parseDns(wire));
    expect(message.questions).toEqual([
      { name: "a.lab", type: DNS_TYPE_A, class: DNS_CLASS_IN },
      { name: "a.lab", type: DNS_TYPE_A, class: DNS_CLASS_IN },
    ]);
  });

  test("preserves unknown RR types as opaque RDATA", () => {
    const rdata = new Uint8Array([5, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    const message: DnsMessage = {
      id: 7,
      flags: { ...QUERY_FLAGS, qr: true, aa: true },
      questions: [{ name: "txt.example.com", type: 16, class: DNS_CLASS_IN }],
      answers: [
        {
          kind: "raw",
          name: "txt.example.com",
          type: 16,
          class: DNS_CLASS_IN,
          ttl: 30,
          rdata,
        },
      ],
      authorities: [],
      additionals: [],
    };
    const parsed = unwrap(parseDns(serializeDns(message)));
    const answer = parsed.answers[0];
    expect(answer?.kind).toBe("raw");
    if (answer?.kind !== "raw") {
      return;
    }
    expect(answer.rdata).toEqual(rdata);
  });

  test("reports truncated messages", () => {
    expect(parseDns(new Uint8Array(0)).ok).toBe(false);
    expect(parseDns(new Uint8Array(11)).ok).toBe(false);

    const headerOnly = new Uint8Array(12);
    headerOnly[5] = 1; // QDCOUNT = 1 with no question bytes.
    const truncatedQuestion = parseDns(headerOnly);
    expect(truncatedQuestion.ok).toBe(false);
    if (!truncatedQuestion.ok) {
      expect(truncatedQuestion.error.code).toBe("truncated");
    }

    const truncatedPointer = new Uint8Array(13);
    truncatedPointer[5] = 1;
    truncatedPointer[12] = 0xc0;
    const pointerResult = parseDns(truncatedPointer);
    expect(pointerResult.ok).toBe(false);
    if (!pointerResult.ok) {
      expect(pointerResult.error.code).toBe("truncated");
    }
  });

  test("guards compression pointers against loops", () => {
    const wire = new Uint8Array(14);
    wire[5] = 1; // QDCOUNT = 1.
    wire[12] = 0xc0;
    wire[13] = 0x0c; // Points to itself at offset 12.
    const parsed = parseDns(wire);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("invalid");
    }
  });

  test("never throws on malformed input", () => {
    for (let length = 0; length <= 64; length++) {
      for (const fill of [0x00, 0x01, 0x3f, 0x80, 0xc0, 0xff]) {
        const data = new Uint8Array(length).fill(fill);
        expect(() => parseDns(data)).not.toThrow();
      }
    }
  });

  test("serializer validates ranges with RangeError", () => {
    expect(() => serializeDns({ ...queryMessage(), id: 0x10000 })).toThrow(
      RangeError,
    );
    expect(() =>
      serializeDns({
        ...queryMessage(),
        answers: [
          {
            kind: "a",
            name: "www.example.com",
            type: DNS_TYPE_A,
            class: DNS_CLASS_IN,
            ttl: 60,
            address: "999.0.0.1",
          },
        ],
      }),
    ).toThrow(RangeError);
  });
});
