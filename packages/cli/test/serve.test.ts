/**
 * `netlab serve` routing: the fetch handler over an injected asset table.
 *
 * No sockets and no compiled bundle: every case hands the handler a route table
 * built from fixture files under the OS temp dir. Embedded mode reads real
 * paths, exactly as `manifest.gen.ts` does, so the routing rules, the SPA
 * fallback and the MIME table are tested without binding a port. The fixture
 * directory is stable and rewritten on every run: no cleanup step deletes
 * anything.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createFetchHandler,
  diskRoutes,
  embeddedRoutes,
  mimeTypeFor,
  parseServeArgs,
  routeCandidates,
  routesFor,
  SERVE_USAGE,
} from "../src/serve";

const FIXTURES = join(tmpdir(), "netlab-serve-fixtures");

/** Files the UI build ships, relative to its root, with their fixture body. */
const FIXTURE_FILES: Record<string, string> = {
  "index.html": "<!doctype html><title>netlab index</title>",
  "practica.html": "<!doctype html><title>netlab practica</title>",
  "editor.html": "<!doctype html><title>netlab editor</title>",
  "_app/version.json": '{"version":"1"}',
  "_app/immutable/chunks/app.js": "export const app = 1;\n",
  "_app/immutable/assets/app.css": "body{margin:0}\n",
  "_app/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
  "_app/fonts/inter.woff2": "wOF2",
  "_app/data.bin": "\u0000\u0001",
};

function writeFixtures(): Map<string, string> {
  const assets = new Map<string, string>();
  for (const [name, body] of Object.entries(FIXTURE_FILES)) {
    const path = join(FIXTURES, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, "utf8");
    const pathname = `/${name.split("\\").join("/")}`;
    assets.set(pathname, resolve(path));
  }
  return assets;
}

const ASSETS = writeFixtures();

function request(pathname: string, method = "GET"): Request {
  return new Request(`http://127.0.0.1:8080${pathname}`, { method });
}

describe("mimeTypeFor", () => {
  test("maps the extensions the UI build ships", () => {
    expect(mimeTypeFor("/index.html")).toBe("text/html; charset=utf-8");
    expect(mimeTypeFor("/_app/immutable/chunks/app.js")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(mimeTypeFor("/_app/immutable/assets/app.css")).toBe(
      "text/css; charset=utf-8",
    );
    expect(mimeTypeFor("/_app/version.json")).toBe(
      "application/json; charset=utf-8",
    );
    expect(mimeTypeFor("/_app/logo.svg")).toBe("image/svg+xml");
    expect(mimeTypeFor("/_app/fonts/inter.woff2")).toBe("font/woff2");
  });

  test("falls back to octet-stream for unknown or extensionless paths", () => {
    expect(mimeTypeFor("/_app/data.bin")).toBe("application/octet-stream");
    expect(mimeTypeFor("/practica")).toBe("application/octet-stream");
  });

  test("ignores the extension case", () => {
    expect(mimeTypeFor("/INDEX.HTML")).toBe("text/html; charset=utf-8");
  });
});

describe("routeCandidates", () => {
  test("tries the exact path, then .html, then index.html, then the shell", () => {
    expect(routeCandidates("/practica")).toEqual([
      "/practica",
      "/practica.html",
      "/practica/index.html",
      "/index.html",
    ]);
  });

  test("trims a trailing slash so /practica/ is the same page as practica.html", () => {
    expect(routeCandidates("/practica/")).toEqual([
      "/practica/",
      "/practica",
      "/practica.html",
      "/practica/index.html",
      "/index.html",
    ]);
  });

  test("serves the shell at / without a double slash", () => {
    expect(routeCandidates("/")).toEqual(["/", "/index.html"]);
  });

  test("does not fall back to the shell for a missing asset", () => {
    expect(routeCandidates("/_app/missing.js")).toEqual([
      "/_app/missing.js",
      "/_app/missing.js.html",
      "/_app/missing.js/index.html",
    ]);
  });
});

describe("createFetchHandler", () => {
  const handler = createFetchHandler(embeddedRoutes(ASSETS));

  test("GET / serves the shell", async () => {
    const response = handler(request("/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(await response.text()).toContain("netlab index");
  });

  test("GET /practica resolves practica.html", async () => {
    const response = handler(request("/practica"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(await response.text()).toContain("netlab practica");
  });

  test("GET /practica/ resolves the same page", async () => {
    const response = handler(request("/practica/"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("netlab practica");
  });

  test("GET /editor resolves editor.html", async () => {
    const response = handler(request("/editor"));
    expect(await response.text()).toContain("netlab editor");
  });

  test("serves immutable assets with their own MIME type", async () => {
    const response = handler(request("/_app/immutable/chunks/app.js"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(await response.text()).toContain("export const app");
  });

  test("falls back to the shell for an unknown page (SPA)", async () => {
    const response = handler(request("/ruta/inexistente"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(await response.text()).toContain("netlab index");
  });

  test("answers 404 for a missing asset instead of the shell", async () => {
    const response = handler(request("/_app/missing.js"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toContain("not found");
  });

  test("answers 404 when the bundle has no shell", async () => {
    const bare = createFetchHandler(embeddedRoutes(new Map()));
    expect(bare(request("/")).status).toBe(404);
    expect(bare(request("/practica")).status).toBe(404);
  });

  test("HEAD reports the size without a body", async () => {
    const response = handler(request("/practica", "HEAD"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("content-length")).toBe(
      String(Buffer.byteLength(FIXTURE_FILES["practica.html"] as string)),
    );
    expect(await response.text()).toBe("");
  });

  test("rejects methods other than GET and HEAD", async () => {
    const response = handler(request("/practica", "POST"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  test("never reads outside the UI root", async () => {
    // The WHATWG parser collapses plain `..` before routing, so that request is
    // an ordinary navigation: it lands on the shell, never on an outside file.
    const collapsed = handler(request("/%2e%2e/%2e%2e/etc/passwd"));
    expect(collapsed.status).toBe(200);
    expect(await collapsed.text()).toContain("netlab index");
    // Encoded separators survive parsing, so the guard has to reject them.
    expect(handler(request("/%2E%2E%2Fetc%2Fpasswd")).status).toBe(404);
    expect(handler(request("/..%2F..%2Fetc/passwd")).status).toBe(404);
    expect(handler(request("/_app/%00")).status).toBe(404);
    const disk = createFetchHandler(diskRoutes(FIXTURES));
    expect(disk(request("/%2E%2E%2Fsecret.txt")).status).toBe(404);
  });
});

describe("diskRoutes", () => {
  test("serves the same paths from a build directory", async () => {
    const handler = createFetchHandler(diskRoutes(FIXTURES));
    const response = handler(request("/practica"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("netlab practica");
  });

  test("reports a missing file instead of inventing a path", () => {
    expect(diskRoutes(FIXTURES).get("/practica.html")).not.toBeNull();
    expect(diskRoutes(FIXTURES).get("/nope.html")).toBeNull();
    expect(diskRoutes(join(FIXTURES, "nope")).get("/index.html")).toBeNull();
  });
});

describe("routesFor", () => {
  test("prefers the embedded manifest over the disk", () => {
    const routes = routesFor(ASSETS, join(FIXTURES, "nope"));
    expect(routes.get("/practica.html")).not.toBeNull();
  });

  test("serves the build directory when there is no manifest", () => {
    const routes = routesFor(null, FIXTURES);
    expect(routes.get("/practica.html")).not.toBeNull();
  });

  test("explains what to build when neither source exists", () => {
    const missing = join(FIXTURES, "nope");
    expect(() => routesFor(null, missing)).toThrow(/no UI bundle to serve/);
    expect(() => routesFor(null, missing)).toThrow(/index\.html is missing/);
    expect(() => routesFor(null, missing)).toThrow(
      /@netlab\/web build|vite build/,
    );
  });
});

describe("parseServeArgs", () => {
  test("defaults to a loopback host", () => {
    expect(parseServeArgs([])).toEqual({ host: "127.0.0.1", port: 8080 });
  });

  test("reads --port and --host", () => {
    expect(parseServeArgs(["--port", "3000", "--host", "0.0.0.0"])).toEqual({
      host: "0.0.0.0",
      port: 3000,
    });
  });

  test("accepts port 0 for an OS-assigned port", () => {
    expect(parseServeArgs(["--port", "0"]).port).toBe(0);
  });

  test("rejects a port outside the 16-bit range", () => {
    expect(() => parseServeArgs(["--port", "70000"])).toThrow(/--port/);
    expect(() => parseServeArgs(["--port", "http"])).toThrow(/--port/);
  });

  test("rejects flags it does not know", () => {
    expect(() => parseServeArgs(["--watch"])).toThrow(/unknown flag/);
  });

  test("marks --help so the caller prints the usage", () => {
    expect(() => parseServeArgs(["--help"])).toThrow(SERVE_USAGE);
    let code: string | undefined;
    try {
      parseServeArgs(["--help"]);
    } catch (error) {
      code = (error as Error & { code?: string }).code;
    }
    expect(code).toBe("HELP");
  });
});
