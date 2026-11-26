# Capa 2 y ARP

La capa 2 es la que decide **quién escucha el frame**: Ethernet entrega tramas
por dirección MAC dentro de un mismo dominio de broadcast, el switch aprende qué
MAC vive en qué puerto mirando el origen de cada trama e inunda el destino
mientras no lo conoce, y VLAN/trunk (802.1Q) parten ese dominio en segmentos
lógicos que solo se cruzan por un puerto trunk con la VLAN transportada. ARP
resuelve el paso de IP a MAC dentro del segmento: un `ARP request` en broadcast,
un `ARP reply` en unicast y una entrada en la caché del host; si esa entrada se
envenena, el tráfico sale hacia la MAC equivocada aunque la IP sea correcta.

| Concepto observable           | Dónde verlo en NetLab                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Aprendizaje de MAC            | Tabla `MAC tables:` al final de `netlab run`: `02:00:… -> p1 vlan 10 (expires t=…)`.                                         |
| Inundar la primera trama      | Un destino desconocido se emite por todos los enlaces del switch menos el de origen.                                         |
| Reenvío unicast tras aprender | Siguiente trama con el mismo destino: sale solo por el puerto aprendido.                                                     |
| Hub vs switch                 | El hub repite a todos los puertos siempre; el switch aprende y filtra.                                                       |
| VLAN de acceso y aislamiento  | Puertos en VLANs distintas del mismo switch no se alcanzan aunque compartan prefijo.                                         |
| Trunk 802.1Q y VLAN nativa    | La VLAN que el trunk no transporta queda aislada; la nativa mal puesta asigna el tráfico sin etiquetar a la VLAN equivocada. |
| Caché ARP                     | Comandos `arp` e `ip neigh show` en la consola del host.                                                                     |
| ARP spoofing                  | Entrada del gateway apuntando a una MAC ajena: el ping sale y no vuelve.                                                     |
| Tramas a mano                 | `send IFACE DSTMAC ETHERTYPE HEX` construye el frame byte por byte.                                                          |

## Ejercicios

Ruta [`capa-2`](../../packages/exercises/routes/capa-2.json) — «Switches que
aprenden, VLANs y trunks: la red empieza en el cable y en la tabla MAC.»

Nivel 1 — Aprender e inundar:

- [`l2-flood-vs-learn`](../../packages/exercises/exercises/l2-flood-vs-learn.json)
  — Hub que inunda vs switch que aprende: reemplazar el hub por un switch y ver
  las MACs aprendidas en el puerto correcto.
- [`l2-vlan-isolated`](../../packages/exercises/exercises/l2-vlan-isolated.json)
  — VLAN aislada: dos hosts en la misma red IP pero en VLANs distintas.

Nivel 2 — Trunks y vecinos falsos:

- [`l2-trunk-misconfigured`](../../packages/exercises/exercises/l2-trunk-misconfigured.json)
  — Trunk mal configurado: falta la VLAN 10 y la nativa está equivocada.
- [`l2-arp-spoofing`](../../packages/exercises/exercises/l2-arp-spoofing.json)
  — ARP spoofing en el laboratorio: recuperar la conectividad y dejar la entrada
  del gateway correcta.

Volver al [README](../../README.md) · Siguiente: [IPv4 e ICMP](ipv4-icmp.md)
