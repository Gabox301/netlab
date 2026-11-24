# VLANs 802.1Q — Fase 2 resto

Objetivo: switches con puertos access y trunk, etiquetado/desetiquetado 802.1Q, VLAN nativa y aislamiento entre VLANs. Branch: `main`. Test runner: `bun test` + `tsc --noEmit` + `biome check .`.

## Specs

- S1 (F-17): "VLANs 802.1Q: puertos access y trunk, etiquetado y desetiquetado, VLAN nativa, aislamiento entre VLANs."
- S2 (decisión previa S12, alcance nuevo): "frames 802.1Q (EtherType 0x8100) se rechazan con error explícito `unsupported-tagged`" — sigue valiendo para hosts y parsers estrictos; el switch aprende a procesarlos en puertos trunk.
- S3 (diseño): aprendizaje MAC por (VLAN, MAC); inundación solo dentro de la VLAN de ingreso; egress access des-etiqueta; egress trunk etiqueta salvo VLAN nativa.
- S4 (alcance): sin STP (F-18), sin configuración por UI/shell (CLI JSON sí), sin QinQ.
- S5 (decisiones heredadas): parsers nunca lanzan (errores tipados); aleatoriedad solo vía `sim.random`; frames inmutables tras `send()`.

## Tasks

- [x] T1 (S1-S3,S5) — route: gentle-ai-worker — 802.1Q en `@netlab/protocols` + puertos access/trunk en Switch + tests — status: done — evidencia: RED → GREEN 33 pass nuevos (19 codec + 14 switch), suite 280, tsc 0, biome 0. `parseEthernet` intacto; hosts/router sin cambios; sin tocar tests viejos.
- [x] T2 (S1,S4) — route: inline parent — puertos VLAN en scenario JSON (`access {vlan}` / `trunk {allowed, native?}`, validación con path, hub rechaza vlan) + fixture `vlan-aislamiento.json` + VID en reporte human/JSON — status: done — evidencia: RED (5/6 fallan sin soporte) → GREEN 6 tests dos-VLAN (aislamiento, trunk, unreachable, tabla con VID), suite total 286 pass, tsc 0, biome 0 errores.

## Log

- L1 (2026-11-24): propuesta parent "VLANs F-17 (puertos access/trunk, 802.1Q)" + autorización "Avancemos".
- L2 (2026-11-24): verificado T1 por parent (suite 280, tsc, biome, solo archivos permitidos). Trunk sin `native` no acepta untagged (decisión del worker, documentada en switch.ts); la CLI lo deja explícito.
