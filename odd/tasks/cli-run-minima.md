# CLI mínima `netlab run` — Fase 1 resto

Objetivo: correr `netlab run escenario.json --seed 42 --until 10s` sin UI: carga JSON versionado, arma Simulation + Hosts/Switch/Hub + Links, ejecuta y muestra trazas + tabla MAC. Branch: `main`. Test runner: `bun test` + `tsc --noEmit` + `biome check .`.
Decisiones UI del usuario (2026-11-24): alcance Full Fase 1, salida ambas con --format, ejecución con bin local.

## Specs

- S1 (roadmap Fase 1): "CLI mínima `netlab run` que carga un JSON y muestra trazas por consola."
- S2 (roadmap §5.11 forma): "netlab run escenario.json --seed 42 --until 10s"
- S3 (usuario, alcance): "Full Fase 1: + hub y host opts" — JSON soporta nodes host/switch/hub, interfaces con mac/ip, links con impairments, hostOpts (arpTtlUs/arpTimeoutUs/arpRetries/arpQueueLimit), actions sendTo.
- S4 (usuario, salida): "Ambas con --format" — "Texto humano legible" por defecto ("Una línea por evento: [t=...] frame_tx/rx/drop + tabla MAC final"), "Un objeto Trace por línea, apto para replay/diff por semilla" con `--format json`.
- S5 (usuario, ejecución): "Bin netlab local" — "Agrega bin + script root para correr como netlab run" (Bun, `packages/cli/src/main.ts` + `bin`).
- S6 (criterio Fase 1): "misma semilla ⇒ misma secuencia de trazas (determinismo)".
- S7 (criterio Fase 1): "switch inunda primer frame luego unicast".
- S8 (criterio Fase 1): "cola ARP expira" (timeout → host unreachable visible en trazas/state).
- S9 (contrato core): frames viajan por referencia; la CLI nunca persiste la vista — para imprimir hex usa copia/`hexdump`, nunca guarda el `Uint8Array` original.
- S10 (contrato core): orden de descarte en `Link.send()` ya fijado (down → mtu → queue → loss); la CLI solo reporta `frame_drop{where,reason}`.
- S11 (alcance): sin `validate`/`replay`/`bench`/`pcap` todavía (solo `run`); sin shell ni IPv4 (Fase 2).

## Tasks

- [x] T1 (S1,S2,S3,S6,S9,S10) — route: inline parent — loader JSON versionado + `run` (Simulation/TraceBus/Host/Switch/Hub/Link/connect/sendTo/runUntil) con tests — status: done — evidencia: `scenario.ts` + `run.ts`, 12 tests CLI nuevos, suite total 150 pass, tsc 0, biome 0 errores.
- [x] T2 (S4) — route: inline parent — impresoras texto + jsonl + `getMacTable()` final, flag `--format human|json` — status: done — evidencia: `format.ts`, human muestra TX/RX/DROP + tabla MAC, json deja stdout puro JSONL y MAC va a stderr.
- [x] T3 (S5) — route: inline parent — `packages/cli/src/main.ts` + `bin netlab` + `dependencies workspace:*` + script root + fixture dos-hosts-switch — status: done — evidencia: `bun packages/cli/src/main.ts run fixtures/dos-hosts-switch.json` exit 0, `--format json` + `--seed/--until` + error ENOENT exit 1 verificados. Sin commitear (decisión de commit del usuario pendiente).

## Log

- L1 (2026-11-24): propuesta parent "CLI mínima `netlab run` (carga JSON, muestra trazas)" + autorización "Dale".
- L2 (2026-11-24): scope usuario vía cuestionario — "Full Fase 1: + hub y host opts" / "Ambas con --format" / "Bin netlab local".
- L3 (2026-11-24): mapa explorer mwunoatk-1-rucm — sin esquema JSON previo (TopologyJSON indefinido, ADR-013 no existe), sin CLI/deps/bin, Trace real `{frame_tx,frame_rx,frame_drop,state,log}` en `packages/core/src/trace.ts:19-58`, patrón armado en `packages/core/test/devices.test.ts:166-182`.
