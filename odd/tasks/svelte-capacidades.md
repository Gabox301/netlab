# Aprovechar capacidades actuales de Svelte/Kit (auditoría MCP)

## Specs

- S1: "Te habilité el mcp de svelte. Necesito que audites el proyecto y verifiques que estamos aprovechando las capacidades más actuales."
- S2: "Los 3" → (a) auditar SSR-safety para prender SSR, (b) `svelte-check` en CI, (c) alinear Pages con la receta oficial (configure-pages, fallback 404.html, job separado).

## Tasks

- [x] C1 (S2a) Auditoría SSR-safety (read-only): APIs de browser fuera de `onMount`/guards en rutas y lib; veredicto prender-SSR vs SPA+fallback.
- [x] C2 (S2b) `svelte-check` en devDeps + job CI; baseline en verde.
- [x] C3 (S2c) `pages.yml` según receta oficial + `fallback: 404.html` + `docs/demo.md` al día.

## Log

- L1: "Te habilité el mcp de svelte. Necesito que audites el proyecto y verifiques que estamos aprovechando las capacidades más actuales."
- L2: "Los 3"
