# Fase 4 — UDP y servicios (DNS, DHCP)

Slice vertical ODD sobre netlab-roadmap.md § Fase 4. Sin atajos: parsers totales, tests primero.

## Specs

- S1: "Vamos con la fase 4" → alcance = Fase 4 del roadmap: UDP y sockets (F-50 a F-52), DNS cliente/servidor con compresión (F-70, F-71), DHCP servidor/cliente (F-72, F-73), comandos `dig`, `dhclient`, `nc -u`, filtros del inspector (F-93) y flow graph básico parte UDP (F-95). Entregable: red donde un host obtiene IP por DHCP y resuelve nombres con DNS propio.
- S2: "dime cuantas fases son en total" → informativo, ya respondido: 9 fases (0–8). Sin código.

## Tasks

- [x] T1 (S1) UDP F-50/51/52: `protocols/src/udp.ts` + sockets en core + Port Unreachable.
- [x] T2 (S1) DNS F-70/71: `protocols/src/dns.ts` + resolver con caché/TTL + servidor autoritativo sobre UDP.
- [x] T3 (S1) DHCP F-72/73: `protocols/src/dhcp.ts` + servidor con pool + cliente DORA con `setIpConfig`.
- [ ] T4 (S1) Shell+inspector: `dig`, `dhclient`, `nc -u` en shell + capas/protocolo UDP/DNS/DHCP en `decode.ts`, `flights.ts` y `+page.svelte` (F-93/F-95-UDP). Commit.
- [ ] T5 (S1) Integración: fixture `cli/test/dhcp-dns.test.ts` (host sin IP → `dhclient` → `dig` a la otra subred). Commit.
- [ ] T6 (S1) DHCP renewal/rebind + expiración de leases (criterio roadmap: "renueva leases según temporizadores"; T3 deja leases de por vida). Commit.
- [ ] T7 (S1) F-93 filtro por expresión + F-95 flow graph (T4 solo deja chips por protocolo + capas). Commit.

## Log

- L1: "Vamos con la fase 4, y dime cuantas fases son en total."
