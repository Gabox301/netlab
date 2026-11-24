# Router + reenvío + shell mínima — Fase 2, slice 2

Objetivo: dos subredes con un router que reenvía IPv4 (fragmenta según MTU, respeta DF, corta bucles por TTL), con Host integrado y shell mínima para `ping`/`traceroute`. Branch: `main`. Test runner: `bun test` + `tsc --noEmit` + `biome check .`.

## Specs

- S1 (F-32): "Tabla de ruteo con longest prefix match; rutas conectadas, estáticas y por defecto; métricas."
- S2 (F-33): "Fragmentación según MTU del enlace de salida y respeto del bit DF."
- S3 (F-34): "Reensamblado con buffer por `(src, dst, id, proto)`, timeout y límite de memoria."
- S4 (F-35): "Reenvío en router: decremento de TTL, recálculo de checksum, ICMP Time Exceeded."
- S5 (F-36): "Configuración de interfaces (IP, máscara, gateway) por UI, shell y DHCP." Alcance de este slice: shell + JSON/CLI; UI y DHCP después.
- S6 (criterios Fase 2): "Con DF activado se recibe `Fragmentation needed`." + "Bucle de ruteo se corta por TTL (test)."
- S7 (5.6 shell, primera parte): "`ip addr`, `ip link`, `ip route`" + "`ping [-c n] [-s size] [-t ttl] dst` con estadísticas (min/avg/max, pérdida)" + "`traceroute dst`" + "`arp -a`, `ip neigh`".
- S8 (entregable Fase 2): "topología de dos subredes con un router, donde `traceroute` muestra cada salto." Vía fixture CLI `dos-subredes.json` + comandos shell.
- S9 (decisiones heredadas): "Los parsers nunca lanzan por entradas inválidas: devuelven errores tipados." + aleatoriedad solo vía `sim.random` + frames inmutables tras `send()`.

## Tasks

- [x] T1 (S1-S6,S9) — route: gentle-ai-worker — Router en `@netlab/core` + Host con IPv4 integrado + tests — status: done — evidencia: RED → GREEN 36 pass nuevos (13 router + 11 fragmentación + 12 host-ipv4), suite 209, tsc 0, biome 0. Verificado por parent + spot check (legacy sin máscara preservado). Sin tocar link/devices/switch.
- [x] T2 (S5,S7,S9) — route: gentle-ai-worker — shell mínima en `@netlab/shell` + tests — status: done — evidencia: RED → GREEN 34 pass, suite 209, tsc 0, biome 0. Parent normalizó imports a `@netlab/*` y eliminó `deps.ts`; re-verificado.
- [x] T3 (S5,S8) — route: inline parent — router + rutas + ping/shell actions en scenario JSON, fixture `dos-subredes.json`, run async con transcripts — status: done — evidencia: 4 tests dos-subredes (eco cruza el router, traceroute 10.0.0.1 → 10.0.1.2, determinismo), suite total 247 pass, tsc 0, biome 0 errores.

## Log

- L1 (2026-11-24): propuesta parent "Router + reenvío (LPM, fragmentación, TTL) con Host integrado, shell mínima (ping/traceroute) y la topología de dos subredes en la CLI" + autorización "Dale".
- L2 (2026-11-24): Fase 2 objetivo "ping y traceroute entre subredes"; codecs IPv4+ICMP ya hechos en `b22dde8` (spec `odd/tasks/ipv4-icmp-codecs.md`).
- L3 (2026-11-24): verificado T1+T2 por parent (suites, tsc, biome, spot checks). Nota CLI/shell: los probes de la shell avanzan el reloj hasta sus timeouts (1s por defecto) consumiendo eventos encolados — determinista y correcto, pero el `until` debe cubrir esas esperas (dos-subredes usa 5s). `processed N` cuenta el loop exterior; el total real está en `traces=N`.
