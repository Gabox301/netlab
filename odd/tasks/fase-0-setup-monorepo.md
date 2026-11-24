# Fase 0 Setup Monorepo — NetLab

Objetivo: estructura base del monorepo para validar toolchain. Branch: `main` (a crear). Delivery: `ask-on-risk`. Test runner: `bun test` + `tsc --noEmit` (vía `bun.exe` en WSL).

## Specs

- S1 — Arranque del proyecto: "Lo que quisiera es arrancar con el proyecto"
- S2 — Alcance inicial elegido: "Solo setup monorepo" — "Solo estructura base para validar toolchain primero."
- S3 — Lint/formato elegido: "Biome (recomendado)" — "Rápido, un solo binario, ideal con Bun."
- S4 — Repo elegido: "Sí, init + commit" — "git init + commit inicial de Fase 0."
- S5 — Base de roadmap Fase 0 (supuesto explícito, derivado de `netlab-roadmap.md`): "Monorepo con `bun workspaces`, TypeScript estricto, lint y formato." + "CI con `bun test` y chequeo de tipos."
- S6 — Restricción: no implementar `@netlab/bytes` F-01 a F-04 en este slice; solo skeleton `packages/*` vacíos que compilen.
- S7 — Aceptación: `bun install`, `bun test`, `tsc --noEmit` y `biome check` pasan en limpio; `git log` muestra commit inicial.

## Tasks

- [x] T1 (S4) — route: inline — git init + .gitignore + main — status: done — commit: pendiente (se incluye en commit inicial)
- [x] T2 (S2,S5) — route: inline — skeleton monorepo: package.json workspaces + bunfig.toml + tsconfig.base.json + packages/* placeholder — status: done — evidencia: tsc --noEmit limpio
- [x] T3 (S3,S5) — route: inline — Biome config + scripts check — status: done — evidencia: biome check . limpio (32 archivos)
- [x] T4 (S5) — route: inline — CI workflow bun test + tipos — status: done — evidencia: .github/workflows/ci.yml con bun 1.4.5
- [x] T5 (S7) — route: inline — verificación RED/GREEN: install/test/typecheck/biome — status: done — evidencia: bun install ok (bun-types 1.4.5), bun test 1 pass, tsc limpio, biome limpio

## Log

- L1 (2026-11-24): "@netlab-roadmap.md Analiza el archivo y dame un veredicto"
- L2 (2026-11-24): "Lo que quisiera es arrancar con el proyecto"
- L3 decisiones 2026-11-24: alcance "Solo setup monorepo" / lint "Biome (recomendado)" / repo "Sí, init + commit"
- Evidencia entorno: WSL sin `bun` en PATH, sí `bun.exe` 1.4.5 en `/mnt/c/Users/gortega/scoop/persist/bun/bin/bun.exe` y `node.exe` v24.22.1; sin git repo. Se usará `bun.exe` desde WSL hasta normalizar PATH.
- 2026-11-24 verificación: `bun install` ok, `bun test` 1 pass (bytes smoke), `tsc --noEmit` limpio tras agregar `bun-types`, `biome check .` limpio (32 archivos, fix de formato en package.json + fix de schema files.includes). Siguiente: commit inicial en main.
- 2026-11-24 commit inicial: `549a8b9 chore: initial monorepo skeleton (fase 0 setup)` en `main`, working tree limpio.
