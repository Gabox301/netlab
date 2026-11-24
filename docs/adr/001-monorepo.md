# ADR-001 — Monorepo y reglas de dependencias

Fecha: 2026-11-24
Estado: aceptado (slice setup)

## Contexto

NetLab necesita un stack de protocolos puro e isomórfico (`bytes`, `protocols`, `core`) que corra en Bun, navegador y Node sin cambios, más un servidor/producto (`server`, `web`, `cli`) atado a Bun. Sin una regla explícita, el core termina importando APIs del servidor y se pierde la portabilidad y el determinismo testeable.

## Opciones consideradas

1. Monorepo con workspaces y regla direccional estricta (elegida).
2. Repos separados por paquete (rechazada: fricción de versionado para una persona a tiempo parcial).
3. Monolito sin paquetes (rechazada: no hay frontera que impida importar `bun:sqlite` desde el motor).

## Decisión

- Monorepo `bun workspaces` con paquetes `@netlab/*`.
- Grafo permitido: `bytes` ← `protocols` ← `core` ← `shell|exercises|pcap` ← `server|cli`; `web` solo consume tipos del protocolo WS.
- `bytes`, `protocols`, `core`: cero APIs de Bun/Node/DOM. PRNG y reloj inyectados, nunca `Math.random()` ni `Date.now()` en el hot path.
- TypeScript estricto + Biome como única herramienta de lint/formato.

## Consecuencias

- El core se puede testear con `bun test` en modo instantáneo y correr en un Web Worker sin cambios.
- El servidor puede usar `Bun.serve`, `bun:sqlite`, `bun build --compile` sin contaminar el motor.
- Costo: hay que vigilar imports con `biome`/`tsc` y, más adelante, un lint de fronteras (ej. `no-restricted-imports` o chequeo en CI).
