# DNS y DHCP

Los servicios de red son los que hacen que la red _sirva para algo_, y fallan de
formas que no se parecen a un cable cortado: DNS es un protocolo de
pregunta/respuesta sobre UDP/53 (con nombres comprimidos por punteros y
reintentos que se agotan en silencio), DHCP reparte direcciones en cuatro
mensajes — Discover, Offer, Request, ACK — con un pool finito y leases que
expiran y se renuevan a T1 y T2, y HTTP viaja sobre TCP a un puerto concreto que
no tiene por qué ser el 80. Diagnosticar es separar las capas: ¿hay dirección?
¿hay ruta? ¿resuelve el nombre? ¿escucha el servicio en ese puerto?

| Concepto observable            | Dónde verlo en NetLab                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Consulta y respuesta DNS       | `dig [@SERVER] NAME [A]`; sin resolver configurado los intentos se agotan.                            |
| Nombres comprimidos            | El codec DNS acepta y emite punteros `0xc0` a nombres ya escritos (RFC 1035 §4.1.4).                  |
| DHCP DORA y lease              | `dhclient [IFACE]`: Discover, Offer, Request y ACK; el servidor recuerda un lease por MAC.            |
| Pool agotado                   | Sin direcciones libres el cliente reintenta en vez de recibir un ACK.                                 |
| Renovación y expiración        | Al 50% y 87,5% del lease el cliente renueva o hace rebind; al vencer vuelve a descubrir.              |
| Servicio en puerto no estándar | `http-server [PORT]` y `curl http://HOST:PORT/`: el 80 puede estar cerrado mientras el 8080 responde. |
| Servicio vivo, nombre muerto   | `curl` con IP literal funciona mientras `dig` falla: el problema es el resolver.                      |
| Evidencia en captura           | `netlab pcap … -o out.pcap` y `netlab pcap-import out.pcap` describen los mensajes.                   |

## Ejercicios

Ruta [`servicios-de-red`](../../packages/exercises/routes/servicios-de-red.json) —
«DNS, DHCP y HTTP: cuando la red funciona pero el servicio no aparece donde se lo
espera.»

Nivel 1 — Resolver y asignar:

- [`svc-dns-broken`](../../packages/exercises/exercises/svc-dns-broken.json) —
  DNS roto, servicio vivo: no hay resolver y el HTTP de la misma IP responde.
- [`svc-dhcp-exhausted`](../../packages/exercises/exercises/svc-dhcp-exhausted.json)
  — DHCP agotado: dirección estática para salir del paso.

Nivel 2 — Llegar al servicio:

- [`svc-http-port`](../../packages/exercises/exercises/svc-http-port.json) — HTTP
  en un puerto no estándar: descubrir el 8080 y comprobar que el 80 está cerrado.

Anterior: [TCP](tcp.md) · Volver al [README](../../README.md) · Benchmarks:
[`docs/bench.md`](../bench.md)
