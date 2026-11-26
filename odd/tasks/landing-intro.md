# Landing e intro (la entrada ya no cae directo al workbench)

## Specs

- S1: "Nos falta una landing. Porque la pantalla inicial es ya directo al tema. Hace falta intro y contexto previo."
- S2: `/` = landing con intro y contexto (qué es NetLab, modos, cómo empezar); el workbench vive en `/workbench`. Toda la navegación interna apunta a las rutas nuevas; `docs/demo.md` y README se actualizan donde nombren rutas.

## Tasks

- [x] L1 (S1) Landing en `/`: hero con qué es NetLab + contexto previo, cards a Workbench/Editor/Práctica, cómo empezar, links a teoría. Datos puros en `lib/landing.ts` con tests.
- [x] L2 (S2) Mover workbench a `/workbench`: mover el archivo, actualizar todos los `resolve(\"/\")` rotulados Workbench y guías, más docs donde nombren rutas.
- [x] L3 Verificación: pins de presencia, `tsc`, biome, suite completa 940/940, build raíz + BASE_PATH verdes (por el worker).

## Log

- L1: "Nos falta una landing. Porque la pantalla inicial es ya directo al tema. Hace falta intro y contexto previo."
