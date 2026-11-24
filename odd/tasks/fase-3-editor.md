# Editor de topología — Fase 3, slice 1

Objetivo: dibujar la red en el browser y exportar un JSON v1 que la CLI corre sin edición: palette con drag&drop, cables con validación, panel de propiedades e import/export versionado. Branch: `main`. Runner: `bun test` + `tsc --noEmit` + `biome check .` + build web.

## Specs

- S1 (F-80): "Lienzo con arrastrar y soltar de dispositivos (host, switch, router, hub, servidor)." Alcance del slice: host/switch/router/hub dibujables y simulables; servidor solo como nodo dibujable (sin comportamiento).
- S2 (F-81): "Conexión de interfaces por cables; validación (no conectar dos puntas a la misma interfaz)."
- S3 (F-82): "Panel de propiedades por dispositivo (nombre, interfaces, IP, VLAN, rutas, servicios)." Alcance: nombre, interfaces (nombre/MAC/IP/máscara/gateway/puertos/VLAN/rutas según tipo); sin servicios.
- S4 (F-85): "Importar y exportar topología en JSON versionado." El exportado debe ser scenario v1 válido: `netlab run` lo ejecuta sin edición manual.
- S5 (alcance): sin presets de enlace (F-83), sin deshacer/rehacer/copiar/alinear/zoom (F-84), sin plantillas (F-86), sin persistencia en servidor.
- S6 (diseño): extiende la dirección 02 (lienzo protagonista + toolbar + panel flotante) con tokens Rojo señal; sin mockup nuevo (el editor ES la dirección 02 con herramientas).
- S7 (decisiones heredadas): SvelteKit estático, SSR off, worker sim intacto, sin CDNs.

## Tasks

- [x] T1 (S1-S3,S6,S7) — route: gentle-ai-worker — editor (palette, canvas drag&drop, cables validados, panel props, estado en memoria) — status: done — evidencia: RED no activo (spike UI), 17 tests topology (validación, estructura, export, import, round-trip), suite 303, tsc 0, biome 0. Preview /editor 200 + CDP smoke OK.
- [x] T2 (S4,S6,S7) — route: gentle-ai-worker (mismo) — export JSON v1 validado + import + round-trip — status: done — evidencia: export gateado por parseScenarioJson, round-trip dos-subredes/dos-hosts-switch/vlan-aislamiento → run verde. Parent normalizó imports relativos a @netlab/cli (+dep workspace, +exports ScenarioHostOpts/ScenarioInterfaceDef) y re-verificó todo.
- [ ] T3 — route: parent — verificación total + commit del slice — status: pending

## Log

- L1 (2026-11-24): usuario "Avanza con lo siguiente" tras el spike; editor es el siguiente paso natural de Fase 3 sobre la base del workbench.
- L2 (2026-11-24): verificado por parent (suite 303, tsc 0, biome 0, +page diff solo nav link). Normalizado import cruzado CLI→web a @netlab/cli. Pendiente conocido: nodo servidor dibujable (v1 no tiene tipo server), F-83/84/86 fuera de slice.
