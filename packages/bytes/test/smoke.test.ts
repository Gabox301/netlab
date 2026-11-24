import { describe, expect, test } from "bun:test";
import { PACKAGE } from "../src/index";

describe("@netlab/bytes skeleton", () => {
  test("exposes package id", () => {
    expect(PACKAGE).toBe("@netlab/bytes");
  });
});
