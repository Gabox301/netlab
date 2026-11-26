# TCP

TCP convierte un flujo de bytes en segmentos confiables y ordenados sobre un
camino que puede perder, duplicar y reordenar: abre con un three-way handshake
(SYN, SYN-ACK, ACK) que sincroniza números de secuencia y ventanas, numera cada
byte, acumula ACKs y retransmite cuando vence el RTO o cuando los ACKs
duplicados delatan un hueco. Encima de eso conviven dos controles distintos que
NetLab mantiene separados: el **flow control** (la ventana anunciada por el
receptor, que puede llegar a cero y dispara window probes) y el **control de
congestión** estilo Reno (`cwnd` y `ssthresh`: slow start que duplica por RTT,
evitación aditiva y fast recovery al detectar pérdida), que es lo que fija el
throughput que se observa en una descarga.

| Concepto observable             | Dónde verlo en NetLab                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| Handshake y estados             | `ss` muestra el socket en `ESTABLISHED`; `nc HOST PORT` completa el saludo.                  |
| Flags por segmento              | SYN, ACK, FIN y RST viajan en cada segmento y se leen en la captura y en las trazas.         |
| Números de secuencia y ACKs     | Cada byte enviado aparece una vez; los ACKs son acumulativos, no por segmento.               |
| Retransmisión por pérdida       | Enlace con pérdida: la conexión se establece igual y las trazas muestran la retransmisión.   |
| Ventana anunciada y zero window | El campo window de cada segmento (legible con `netlab pcap` + `tshark`) puede llegar a cero. |
| `Cwnd` / `Ssthresh`             | `ss` imprime ambas columnas del socket en `ESTABLISHED`; la forma es la de Reno.             |
| Throughput y cuello de botella  | `curl http://HOST:PORT/` sobre un enlace limitado: el ancho de banda manda.                  |
| Puerto cerrado                  | `nc HOST 81` devuelve un RST inmediato, sin handshake ni timeout.                            |
| Captura para terceros           | `netlab pcap … -o out.pcap` escribe el tráfico y `tshark` lo decodifica.                     |

## Ejercicios

Ruta [`tcp-a-fondo`](../../packages/exercises/routes/tcp-a-fondo.json) — «Handshake,
retransmisión, ventana y cuello de botella: seguir una conexión byte por byte.»

Nivel 1 — Abrir la conexión:

- [`tcp-handshake`](../../packages/exercises/exercises/tcp-handshake.json) —
  Handshake TCP paso a paso: servidor HTTP en el 80 y conexión hasta
  `ESTABLISHED`.

Nivel 2 — Lo que TCP repara:

- [`tcp-retransmission`](../../packages/exercises/exercises/tcp-retransmission.json)
  — Retransmisión con pérdida: 10% de frames perdidos y la sesión se establece.
- [`tcp-zero-window`](../../packages/exercises/exercises/tcp-zero-window.json) —
  Ventana TCP observable: leer `Cwnd`/`Ssthresh` con `ss`.

Nivel 3 — Rendimiento y bordes:

- [`tcp-congestion`](../../packages/exercises/exercises/tcp-congestion.json) —
  Cuello de botella y throughput: subir el ancho de banda para que la descarga
  complete.
- [`tcp-closed-port`](../../packages/exercises/exercises/tcp-closed-port.json) —
  Puerto cerrado: distinguir el 80 abierto del 81 con RST inmediato.

Anterior: [IPv4 e ICMP](ipv4-icmp.md) · Volver al [README](../../README.md) ·
Siguiente: [DNS y DHCP](dns-dhcp.md)
