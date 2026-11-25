# Fase 7 — Captura PCAP y distribución

Slice vertical ODD sobre netlab-roadmap.md § Fase 7. Sin atajos: capturas que `tshark` abre sin errores; binario que arranca sin instalación.

## Specs

- S1: "Avancemos" → alcance = Fase 7 del roadmap: exportación PCAP/PCAPNG (F-120 a F-122) e importación (F-123), validación con `tshark`, scrub hacia atrás con snapshots (F-98) y breakpoints (F-99), ejecutable único con UI embebida, exportación de escenarios y diagramas (F-124, F-125). Entregable: binario descargable.
- S2: criterios de aceptación — `tshark` abre capturas de todos los escenarios sin errores ni warnings de checksum; el binario inicia en <1 s y no requiere instalación.

## Tasks

- [x] T1 (S1) Export PCAP clásico + `netlab pcap` + validación tshark (F-120).
- [x] T2 (S1) PCAPNG + captura por interfaz + import PCAP (F-121 a F-123).
- [x] T3 (S1) Snapshots + scrub atrás + breakpoints (F-98, F-99).
- [ ] T4 (S1) Export de escenarios y diagramas (F-124, F-125). Commit.
- [ ] T5 (S1) Binario único con UI embebida + verificación de arranque (S2). Commit.

## Log

- L1: "Avancemos"
