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
function resolveBase(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "") {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export default defineConfig({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ precompress: false, strict: true }),
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
