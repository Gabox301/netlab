# Codecs IPv4 + ICMP — Fase 2, primer slice

Objetivo: parseo y serialización de IPv4 e ICMP en `@netlab/protocols`, base de `ping`/`traceroute` entre subredes (siguiente slice: Router + reenvío). Branch: `main`. Test runner: `bun test` + `tsc --noEmit` + `biome check .`.

## Specs

- S1 (F-30): "Parseo y serialización del header (versión, IHL, ToS/DSCP, longitud, ID, flags, offset, TTL, protocolo, checksum, direcciones, opciones ignoradas pero preservadas)."
- S2 (F-31): "Validación: checksum, longitud, versión, TTL. Descarte con razón registrada." Alcance de este slice: el parser devuelve error tipado; el descarte con contadores lo hace el device después.
- S3 (F-37): "Echo Request/Reply (base de `ping`)."
- S4 (F-38): "Destination Unreachable (red, host, puerto, fragmentación necesaria con DF)."
- S5 (F-39): "Time Exceeded (base de `traceroute`)."
- S6 (decisión heredada L2): "Los parsers nunca lanzan por entradas inválidas: devuelven errores tipados."
- S7 (alcance): sin tabla de ruteo/LPM, sin fragmentación/reensamblado, sin reenvío con TTL, sin shell (slices siguientes).

## Tasks

- [x] T1 (S1-S7) — route: inline parent — IPv4 + ICMP en `@netlab/protocols` con tests — status: done — evidencia: RED (imports inexistentes) → GREEN 23 pass nuevos (13 ipv4 + 10 icmp), suite total 173 pass, tsc 0, biome 0 errores. Archivos: src/{ipv4,icmp}.ts + test/{ipv4,icmp}.test.ts + index.ts. Vectores verificados a mano: header serie (checksum 0x54ae), eco "hello" (0xb42b/0xbc2b), unreachable (0x77de), time-exceeded (0xf4ff).

## Log

- L1 (2026-11-24): pregunta parent "¿Con qué slice arrancamos la Fase 2?" + autorización "Codecs IPv4+ICMP en protocols".
- L2 (2026-11-24): Fase 2 objetivo "ping y traceroute entre subredes", entregable "topología de dos subredes con un router, donde traceroute muestra cada salto"; criterios "Con DF activado se recibe Fragmentation needed" y "Bucle de ruteo se corta por TTL (test)" (para slices siguientes).
