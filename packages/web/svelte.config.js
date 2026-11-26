import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/**
 * Normalize the static-hosting prefix (Fase 8 T5).
 *
 * `BASE_PATH` is the path the site is served from, e.g. `/Net-Lab/` for a
 * GitHub Pages project site. SvelteKit stores it without a trailing slash, and
 * an empty value (or `/`) keeps the root-relative default: `bun run build` with
 * no `BASE_PATH` produces exactly the same site as before this option existed.
 *
 * @param {string | undefined} raw
 * @returns {string}
 */
function resolveBase(raw) {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "") {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** @type {import("@sveltejs/kit").Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    paths: { base: resolveBase(process.env.BASE_PATH) },
    adapter: adapter({ precompress: false, strict: true }),
  },
};

export default config;
