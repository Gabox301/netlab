# L2 Connectivity — Ethernet + ARP + dispositivos

Objetivo: dos hosts que se resuelven por ARP a través de un switch (Fase 1, slice L2). Branch: `main`. Delivery: `ask-on-risk`. Test runner: `bun test` + `tsc --noEmit` + `biome check .` (vía `bun.exe` en WSL).

## Specs

- S1 (F-10): "Parseo y serialización de Ethernet II (destino, origen, EtherType, payload)."
- S2 (F-11): "Padding a 60 bytes mínimos y FCS opcional." Alcance de este slice: padding a 60; sin FCS en el cable.
- S3 (F-12): "Filtrado por MAC en la interfaz (unicast propio, broadcast, multicast suscripto, modo promiscuo)."
- S4 (F-13): "Contadores por interfaz (rx/tx frames, bytes, errores, descartes)."
- S5 (F-14): "Aprendizaje de MAC por puerto de origen, con envejecimiento (aging time configurable)."
- S6 (F-15): "Reenvío unicast conocido, inundación de unknown-unicast y broadcast (excluyendo el puerto de entrada)."
- S7 (F-16): "Tabla MAC visible en UI y por comando (`show mac-table`)." Alcance de este slice: API `getMacTable()`; UI/comando después.
- S8 (F-19): "Request y Reply con parseo y serialización."
- S9 (F-20): "Caché ARP con TTL, estados (incompleto, alcanzable, obsoleto) y reintentos." Alcance de este slice (supuesto de arquitectura): estados incompleto/resuelto con TTL y reintentos; obsoleto periódico completo después.
- S10 (F-21): "Cola de paquetes pendientes mientras se resuelve la MAC, con límite y timeout (`host unreachable`)."
- S11 (decisión): "Los parsers nunca lanzan por entradas inválidas: devuelven errores tipados." `parseEthernet`/`parseArp` devuelven `ParseResult<T>`; `BufferReader.TruncatedError` se atrapa en el borde del parser.
- S12 (decisión): frames 802.1Q (EtherType 0x8100) se rechazan con error explícito `unsupported-tagged`; VLANs (F-17) es Fase 2.
- S13 (decisión): ARP sin promesas. `Host.sendTo()` hace resolve + cola sincrónica; los tests avanzan con `sim.runUntil()`. Nada de microtareas contra reloj virtual.
- S14 (decisión): MAC automática `02:<random×5>` vía `sim.random` al crear la interfaz; tests con MAC explícitas.
- S15 (decisión): orden de descarte en `Link.send()` ya fijado (down → mtu → queue → loss); el host/switch solo agrega filtrado MAC y errores de parseo a contadores.
- S16 (alcance): sin IPv4 todavía (Fase 2). El host usa direcciones IP solo como identidad ARP; sin `ping`.

## Tasks

- [x] T1 (S1,S2,S8,S11,S12) — route: gentle-ai-worker — Ethernet + ARP en `@netlab/protocols` con tests — status: done — evidencia: RED (imports inexistentes) → GREEN 30 pass/119 expects; tsc 0; biome clean. Archivos: src/{ethernet,arp,index}.ts + test/{ethernet,arp}.test.ts. Verificado por parent: 30 pass + tsc + biome + suite total 113 pass.
- [x] T2 (S3-S7,S9,S10,S13-S16) — route: gentle-ai-worker — Dispositivos + integración L2 en `@netlab/core` — status: done — evidencia: RED (imports inexistentes) → GREEN 25 pass nuevos, suite total 138 pass/3491 expects; tsc 0; biome clean. Archivos: src/{devices,host,switch}.ts + test/devices.test.ts + index.ts extendido. Verificado por parent: suite 138 + tsc + biome + spot check (host.ts ARP, switch.ts forwarding). Desviaciones aceptadas: addInterface con options object (compatibilidad TS); puertos switch promiscuos por construcción; sendTo estricto ante puerto caído; conflicto ARP se loguea, no se aprende.

## Log

- L1 (2026-11-24): propuesta parent "dispositivos + Ethernet: Host/Switch/Hub mínimos con interfaces, switch con aprendizaje MAC e inundación, y ARP request/reply" + autorización "Dale".
- L2 (2026-11-24): `packages/protocols` depende de `@netlab/bytes`; `packages/core` de ambos. Baseline 83 pass antes del slice.
- L3 (2026-11-24): T1 completada por worker mwu8l1f2-1-300r y verificada por parent (suite 113 pass, tsc 0, biome 0). Nota worker: `EthernetFrame.payload` es vista sin copia; IPv4 (Fase 2) debe usar su propia longitud. T2 delegada a worker (superficies: `packages/core/src/devices.ts|host.ts|switch.ts`, tests y `index.ts`).
- L4 (2026-11-24): T2 completada por worker mwu8r50t-2-9lf1 y verificada por parent (suite 138 pass, tsc 0, biome 0). Slice L2 completo. Pendiente: commitear en unidades (motor sim/prng, link/trace, protocols eth/arp + deps, devices L2).
