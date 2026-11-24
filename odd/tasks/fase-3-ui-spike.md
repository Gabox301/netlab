# Spike UI Fase 3 — workbench Rojo señal en SvelteKit

Objetivo: workbench de 3 columnas corriendo en el browser con la simu real en un Web Worker (escenario dos-subredes), replicando el artboard elegido `design/netlab-lab/01-workbench.html`. Branch: `main`. Runner: `bun test` + `tsc --noEmit` + `biome check .` + build web.

## Specs

- S1 (diseño): implementar el artboard `design/netlab-lab/01-workbench.html` (handoff gentle-design) sin copiar el HTML verbatim: topología + lista de paquetes con timeline + tabs inspector/terminal/tablas + barra de estado.
- S2 (stack, ADR-002): SvelteKit con `adapter-static`, SSR apagado en rutas de sim, SVG para topología, sistema Rojo señal.
- S3 (motor): escenario dos-subredes real (`@netlab/core` sin cambios) ejecutado en un Web Worker; la UI muestra trazas, inspector (Ethernet/IPv4/ICMP + hex), terminal con el transcript real y tablas MAC/rutas.
- S4 (controles): Run/Pause/Step + scrubber de timeline sobre el replay determinista (seed 11).
- S5 (verificación): suite `bun test` verde, `tsc --noEmit` 0, `biome check` 0 errores, build estático verde y app corriendo en loopback para comparar con el artboard.
- S6 (alcance): sin persistencia, sin editor (solo lectura del escenario fijo), sin shell interactiva (transcript pregrabado del run), sin tests de UI (spike).

## Tasks

- [x] T1 — scaffold SvelteKit estático en `packages/web` + deps workspace + ADR-002 — status: done — evidencia: scaffold manual (adapter-static, ssr=false, prerender), @netlab/core como workspace:*, bun install ok.
- [x] T2 — Web Worker con dos-subredes real + streaming de trazas — status: done — evidencia: sim.worker.ts arma dos-subredes (seed 11, 10ms), un postMessage con todo (24 eventos / 48 trazas / 20 frames), verificado por CDP (kind:result).
- [x] T3 — workbench 3 columnas con datos reales + verificación total — status: done — evidencia: topology SVG, lista filtrable ARP/ICMP, scrubber, tabs inspector/terminal/tablas reales, Run/Pause/Step; suite 286 pass, tsc 0, biome 0 errores, build estático ok, preview 200 en loopback (verificado vía Windows: curl + Chrome headless).

## Log

- L1 (2026-11-24): diseño elegido por usuario "Ahora si. Vamos con ese" (artboard 01-workbench Rojo señal) + handoff `implement` de gentle-design. Stack fijado: SvelteKit SPA estática + SVG (ADR-002).
- L2 (2026-11-24): usuario pidió diseñar antes de codear ("no queremos un slop"): 3 direcciones en `design/netlab-lab/`, paleta propia tras dos iteraciones, ejemplo Rojo señal del usuario adoptado como sistema y como 01 (interactivo).
- L3 (2026-11-24): T1-T3 por worker mwuvgs2j-8-bu6c, verificado por parent (suite 286, tsc 0, biome 0, build ok, preview 200). Notas: Kit 2 + TS 7 (peer declara ^5/^6, deuda al actualizar); worker.format=es requerido; biome ignora plantillas Svelte (override en packages/web/biome.json) y `design/` (mockups, biome.json raíz); preview WSL/Windows loopback no se ven entre sí en este setup.
