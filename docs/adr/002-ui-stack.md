# ADR-002 — Stack de la UI y sistema visual Rojo señal

Fecha: 2026-11-24
Estado: aceptado (diseño `design/netlab-lab/`, artboard elegido `01-workbench.html`)

## Contexto

Fase 3 pide una UI donde se arma una red, se hace ping y se inspeccionan bytes (demo navegable). El roadmap dejaba abierto el stack (Vite o `bun build` + Svelte/Solid/React; SVG o Canvas 2D) y no había sistema visual: los tres mockups iniciales usaban la paleta genérica oscuro+cyan.

## Opciones consideradas

1. Remix / React Router full-stack (rechazada): SSR, loaders y server obligatorio para una app canvas interactiva que es 100% cliente. Aporta routing a cambio de un server siempre encendido y footguns de hidratación.
2. Vite + Svelte SPA (viable): mínimo peso, pero sin routing ni estructura cuando la UI crezca (editor, inspector, ejercicios, constructor de paquetes).
3. SvelteKit full-stack con SSR y server (rechazada para Fase 3): lo mismo que Remix — el simulador es canvas + Web Worker, el SSR no aporta nada y complica workers y reloj virtual.
4. SvelteKit en modo SPA estática + SVG (elegida): routing por archivos y build estático sin server. El demo sigue siendo 100% cliente; el `Bun.serve` + WebSocket del roadmap se integra después como pieza separada.

## Decisión

- SvelteKit con `adapter-static` y SSR apagado en las rutas de simulación; SVG para topología y animación (Canvas/Pixi solo si el rendimiento lo exige, criterio Fase 3: 100 nodos / 1000 fps).
- El motor corre en un Web Worker (`@netlab/core` sin cambios, isomórfico por ADR-001); la UI recibe trazas y las muestra, nunca simula en el hilo principal.
- Sistema visual "Rojo señal" (artboard `01-workbench.html`): negro neutro `#0B0B0D`, rojo señal `#FF4D3D`, verde `#4DFF9A`, ámbar `#FFD23D`, cyan solo para capa L2, tipografía Impact para marca, radios 0, mono para datos.
- Sin dependencias de red en runtime: el spike no instala CDNs ni fuentes remotas.

## Consecuencias

- `packages/web` suma toolchain JS (SvelteKit/Vite) pero el contrato con el motor sigue siendo tipos + trazas; el core no importa nada web.
- Hay que vigilar que no entre SSR por defecto en rutas nuevas (prerender estático + `ssr = false` en layout de sim) y que el worker no importe APIs del bundle cliente.
- El spike valida: scaffold estático, worker con dos-subredes real, workbench de 3 columnas con datos reales, `bun test` + `tsc` + `biome` + build verdes.
