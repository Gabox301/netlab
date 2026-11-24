# NetLab — Laboratorio de redes interactivo con stack TCP/IP propio

> Runtime: **Bun**. Lenguaje: **TypeScript**.

Setup mínimo del monorepo (Fase 0, slice setup). Ver `netlab-roadmap.md` para visión y roadmap completo.

## Requisitos

- Bun 1.4.5+ (`bun --version`)

## Uso

```sh
bun install
bun test
bunx tsc --noEmit
bunx biome check .
```

## Estructura

- `packages/bytes` — lectura/escritura binaria, checksums, direcciones (F-01 a F-04, pendiente)
- `packages/protocols` — parsers y máquinas de estado (pendiente)
- `packages/core` — reloj virtual, enlaces, dispositivos, trazas (pendiente)
- `packages/shell`, `packages/exercises`, `packages/pcap`, `packages/server`, `packages/web`, `packages/cli` — pendientes
- `docs/adr` — decisiones de diseño
- `fixtures/` — pcaps reales y topologías de ejemplo (pendiente)

## Regla de dependencias

`protocols` nunca importa `core`; `core` nunca importa `server`. Ver ADR-001.
