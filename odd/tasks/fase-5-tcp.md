# Fase 5 — TCP

Slice vertical ODD sobre netlab-roadmap.md § Fase 5. Sin atajos: parsers totales, tests primero, trials con pérdida aleatoria.

## Specs

- S1: "Dale. Vamos con la fase 5" → alcance = Fase 5 del roadmap por hitos 5.1–5.6 (F-53 a F-59, F-61, F-74, F-75). Entregable: transferencia de 1 MB entre dos hosts con 5 % de pérdida y reordenamiento, integridad verificada y gráfico de `cwnd`.
- S2: criterios de aceptación del roadmap: datos idénticos bajo pérdida/reordenamiento; handshake y cierre según RFC 793/9293; `cwnd` en diente de sierra; throughput coherente con Mathis (sanity check).

## Tasks

- [x] T1 (S1) Hito 5.1: segmentos, máquina de estados, handshake y cierre (F-53 a F-55).
- [x] T2 (S1) Hito 5.2: buffers, envío/recepción ordenados, ACKs acumulativos (F-56).
- [x] T3 (S1) Hito 5.3: ventana deslizante y control de flujo (F-57).
- [ ] T4 (S1) Hito 5.4: RTO, retransmisión y fast retransmit (F-58). Commit.
- [ ] T5 (S1) Hito 5.5: Reno — slow start, congestion avoidance, fast recovery (F-59). Commit.
- [ ] T6 (S1) Hito 5.6: API de sockets, `nc`, `ss`, HTTP sobre TCP (F-61, F-74, F-75). Commit.

## Log

- L1: "Dale. Vamos con la fase 5"
