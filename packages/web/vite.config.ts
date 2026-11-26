import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

/**
 * Normalize the static-hosting prefix (Fase 8 T5).
 *
 * `BASE_PATH` is the path the site is served from, e.g. `/Net-Lab/` for a
 * GitHub Pages project site. SvelteKit stores it without a trailing slash, and
 * an empty value (or `/`) keeps the root-relative default: `bun run build` with
 * no `BASE_PATH` produces exactly the same site as before this option existed.
 */
function resolveBase(raw: string | undefined): "" | `/${string}` {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "") {
    return "";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash as `/${string}`;
}

export default defineConfig({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      // SPA fallback: GitHub Pages serves `404.html` for any path it does not
      // find, and SvelteKit boots the client router from that shell. Every
      // route is still prerendered to its own HTML file (the `pages.yml`
      // smoke asserts the five of them), so `404.html` only covers deep links
      // a static host cannot resolve. Note that passing `fallback` skips
      // adapter-static's dynamic-routes check, hence that CI assertion.
      adapter: adapter({
        precompress: false,
        strict: true,
        fallback: "404.html",
      }),
      paths: { base: resolveBase(process.env.BASE_PATH) },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  worker: {
    format: "es",
  },
});
