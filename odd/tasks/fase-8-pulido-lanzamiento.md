# Fase 8 — Pulido, documentación y lanzamiento

Slice vertical ODD sobre netlab-roadmap.md § Fase 8 (líneas 789-800). Sin atajos: lanzamiento v1.0 creíble.

## Specs

- S1: "Si." → alcance = Fase 8 del roadmap: accesibilidad (teclado, contraste, lectores en inspector), tutorial interactivo de bienvenida, benchmarks publicados (eventos/segundo, memoria, throughput TCP), sitio de documentación con teoría por protocolo y enlace a ejercicios, demo pública, post técnico "Implementé TCP desde cero en TypeScript: lo que aprendí", video corto 60-90s. Entregable: lanzamiento público v1.0.
- S2: criterios de aceptación — README ya no dice Fase 0; `netlab bench` existe y corre en CI; a11y con tests; tutorial primera visita; docs enlazan teoría↔ejercicio; demo desplegable desde build estático.

## Tasks

- [x] T1 (S1) Benchmarks: `netlab bench` (eventos/s, memoria RSS, throughput TCP) + tabla publicada + job CI.
- [x] T2 (S1) Accesibilidad: skip-link, `prefers-reduced-motion`, anuncios estado, contraste AA, tests a11y en web.
- [ ] T3 (S1) Tutorial interactivo bienvenida (primera visita persistida, overlay/golden path replay/pcap).
- [ ] T4 (S1) Sitio docs + README: teoría por protocolo enlazada a ejercicios + README actualizado a estado real.
- [ ] T5 (S1) Demo pública: base path configurable + config deploy estático + worker verificado.
- [ ] T6 (S1) Post técnico + guion video 60-90s (consolida odd/tasks/fase-5-tcp.md y fase-7).

## Log

- L1: "Si." (autorización Fase 8, sigue a checkpoint Fases 0-7 completas en 3a470ad)
