# NetLab — Laboratorio de redes interactivo con stack TCP/IP propio

> Runtime: **Bun**. Lenguaje: **TypeScript**.

NetLab simula redes Ethernet/IP desde los bytes: implementa Ethernet, ARP, IPv4,
ICMP, UDP, DNS, DHCP y TCP en TypeScript, corre el motor con reloj virtual y
PRNG sembrado (misma semilla, misma secuencia de trazas) y expone el resultado
en una CLI y en una UI web estática con inspector de paquetes, consola por host
y panel de práctica. Ver `netlab-roadmap.md` para la visión completa.

## Estado

- **Fases 0 a 7 completas en `main`**: bytes y checksums, motor y capa 2,
  IPv4/ICMP/ruteo, UI e inspector, UDP/DNS/DHCP, TCP, modo práctica, PCAP/PCAPNG
  y binario único.
- **Fase 8 (pulido y lanzamiento) en curso en la rama
  `fase-8-pulido-lanzamiento`**: benchmarks, accesibilidad, tutorial de
  bienvenida, documentación con teoría por protocolo, demo pública y material
  de lanzamiento.
- El detalle de la fase en curso y sus tareas vive en
  `odd/tasks/fase-8-pulido-lanzamiento.md`.

## Requisitos

- Bun 1.4.5+ (`bun --version`)

## Instalación y chequeos

```sh
bun install         # instala los workspaces @netlab/*
bun test            # suite completa (Bun test)
bun run typecheck   # tsc --noEmit
bun run check       # biome check . (lint + formato)
bun run check:fix   # biome check --write . (aplica lo que biome sepa arreglar)
```

`bun test`, `bun run typecheck` y `bun run check` son también los tres pasos del
job `check` de CI (`.github/workflows/ci.yml`), que además corre `bench` y abre
las capturas con `tshark`.

## CLI

`bun run netlab -- <comando>` equivale a
`bun packages/cli/src/main.ts <comando>`; el binario compilado se llama
`netlab` y acepta lo mismo.

| Comando       | Qué hace                                                                      |
| ------------- | ----------------------------------------------------------------------------- |
| `run`         | Corre un escenario v1 e imprime las trazas (human o JSON por línea).          |
| `replay`      | Reproduce una grabación de `run` sin simular: scrubbing y breakpoints.        |
| `validate`    | Evalúa una solución contra los checks de un ejercicio.                        |
| `pcap`        | Exporta el tráfico de un escenario a `.pcap` o `.pcapng`.                     |
| `pcap-import` | Lee un `.pcap`/`.pcapng` y describe un paquete por línea.                     |
| `bench`       | Benchmarks sintéticos del motor (eventos/s, bytes, RSS). Ver `docs/bench.md`. |
| `serve`       | Sirve la UI estática en un puerto HTTP local.                                 |

Ejemplos con archivos del repo:

```sh
bun run netlab -- run packages/cli/fixtures/dos-subredes.json --until 1s
bun run netlab -- run packages/cli/fixtures/dos-hosts-switch.json --until 1s --snapshot-out run.json
bun run netlab -- replay run.json --until 500ms
bun run netlab -- validate packages/exercises/exercises/tcp-handshake.json packages/exercises/solutions/tcp-handshake.json
bun run netlab -- pcap packages/cli/fixtures/dos-subredes.json -o out.pcap --until 100ms
bun run netlab -- pcap packages/cli/fixtures/dos-subredes.json -o out.pcapng --format pcapng --link l1
bun run netlab -- pcap-import out.pcap
bun run netlab -- bench --size small --format human
bun run netlab -- serve --port 8080
```

Códigos de salida: `0` ok, `1` error de escenario/ejecución o check fallido,
`2` error de uso o de parseo. Todos los comandos salvo `serve` aceptan
`--format human|json` (en `pcap`, además `--format pcap|pcapng` para elegir la
codificación de captura).

## UI

La UI es un build estático de `packages/web`; no hay backend ni WebSocket.

```sh
bun run --cwd packages/web build   # genera packages/web/build
bun run netlab -- serve            # http://127.0.0.1:8080
```

Rutas: `/` landing (qué es NetLab, los tres modos y cómo empezar),
`/workbench` workbench (topología, inspector de paquetes, consola por host),
`/editor` editor de topología y `/practica` rutas de aprendizaje, ejercicios y
trainer de subnetting. `serve` escucha en loopback por defecto.

Para el binario único con la UI embebida: `bun run --cwd packages/cli compile`
(escribe `dist/netlab`); `scripts/verify-binary.sh` verifica arranque, rutas y
TTFB de ese binario.

## Estructura

| Paquete              | Contenido                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `packages/bytes`     | Lectura/escritura binaria, checksums (RFC 1071) y direcciones MAC/IPv4.                     |
| `packages/protocols` | Codecs puros: Ethernet, VLAN, ARP, IPv4, ICMP, UDP, DNS, DHCP, TCP.                         |
| `packages/core`      | Reloj virtual, PRNG, enlaces, hosts, switches, routers, DNS/DHCP, TCP, trazas.              |
| `packages/shell`     | Shell por host: `ip`, `arp`, `ping`, `traceroute`, `dig`, `dhclient`, `nc`, `ss`, `curl`, … |
| `packages/exercises` | Catálogo de ejercicios y rutas, validadores, trainer de subnetting.                         |
| `packages/pcap`      | Lectura y escritura de PCAP y PCAPNG.                                                       |
| `packages/cli`       | `netlab` (`run`, `replay`, `validate`, `pcap`, `pcap-import`, `bench`, `serve`).            |
| `packages/web`       | UI SvelteKit con adaptador estático: landing, workbench, inspector, editor y práctica.      |
| `packages/server`    | Reservado para el backend; hoy solo el marcador del paquete.                                |

Fuera de `packages/`: `docs/` (documentación), `odd/tasks/` (tareas por fase),
`scripts/verify-binary.sh`, `packages/cli/fixtures/` (escenarios de ejemplo) y
`packages/exercises/{exercises,solutions,routes}/` (catálogo y referencias).

## Documentación

- `docs/teoria/` — teoría breve por protocolo, con conceptos observables en
  NetLab y enlaces a ejercicios concretos:
  [`capa-2-arp.md`](docs/teoria/capa-2-arp.md),
  [`ipv4-icmp.md`](docs/teoria/ipv4-icmp.md),
  [`tcp.md`](docs/teoria/tcp.md),
  [`dns-dhcp.md`](docs/teoria/dns-dhcp.md).
- [`docs/bench.md`](docs/bench.md) — cómo correr los benchmarks, workloads y
  última tabla publicada.
- `docs/adr/` — decisiones de diseño
  ([ADR-001](docs/adr/001-monorepo.md) monorepo y dependencias,
  [ADR-002](docs/adr/002-ui-stack.md) stack de UI).
- `netlab-roadmap.md` — visión y roadmap por fases.

## Ejercicios

25 ejercicios en 4 rutas (`capa-2`, `direccionamiento-y-ruteo`,
`servicios-de-red`, `tcp-a-fondo`), con solución de referencia validada en CI.
Se juegan desde `/practica` en la UI o desde la CLI con `netlab validate
<ejercicio.json> <solución.json>`; cada página de `docs/teoria/` enlaza los
suyos por id.

## Regla de dependencias

Grafo permitido: `bytes` ← `protocols` ← `core` ← `shell|exercises|pcap` ←
`server|cli`; `web` solo consume tipos. `protocols` nunca importa `core`; `core`
nunca importa `server`. Ver ADR-001.
