# Benchmarks NetLab (Fase 8 T1)

Micro-benchmarks deterministas del motor vía `netlab bench`.

## Cómo correr

```sh
bun packages/cli/src/main.ts bench --size small --format human
bun packages/cli/src/main.ts bench --size small --format json
```

`--size tiny|small|medium|large` = 20 / 200 / 1000 / 5000 frames por
workload. `--repeat N` promedia N corridas. Los conteos de eventos y
bytes son deterministas (semilla 42); el tiempo de pared y la RSS varían
por máquina y no se asertan salvo positividad.

## Workloads

- `flood`: N envíos L2 crudos entre dos hosts por un switch
  (mide eventos/segundo de pared).
- `bulk`: mismos N envíos con payload de 1400 B (mide throughput
  simulado en Mbps virtuales = bytes TX × 8 / tiempo virtual).

## Última tabla publicada (2026-11-25, Windows, Bun 1.4.5, `--size small`)

| workload | frames | events | wall_ms | events/s | tx_bytes | sim_Mbps | rss_MB |
| -------- | ------ | ------ | ------- | -------- | -------- | -------- | ------ |
| flood    | 200    | 608    | 16.7    | 36395    | 24480    | 0.01     | 39.8   |
| bulk     | 200    | 608    | 6.6     | 91769    | 567460   | 0.15     | 44.9   |

Referencia `tiny` (misma máquina):

| workload | frames | events | events/s aprox | tx_bytes |
| -------- | ------ | ------ | -------------- | -------- |
| flood    | 20     | 68     | ~3900          | 2880     |
| bulk     | 20     | 68     | ~15000         | 57140    |

## CI

El job `bench` en `.github/workflows/ci.yml` corre `bench --size small`
en humano y JSON y falla si `events <= 0` o `txBytes <= 0` en algún
workload. Es la puerta de humo de rendimiento del motor: falla si algún
workload emite cero eventos, cero bytes o cero eventos/s; no detecta
regresiones de pared (sin umbrales de ms/percentiles) y `bulk` aproxima
el throughput con frames L2 de 1400 B sobre tiempo virtual, no con
flujos TCP reales.
