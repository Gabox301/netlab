# IPv4 e ICMP

IPv4 entrega datagramas extremo a extremo: cada host decide si el destino es
vecino directo comparando la dirección con su máscara, y si no lo es manda el
paquete a su gateway; cada router elige por dónde sale con la **ruta más
específica** (longest prefix match), decrementa el TTL y descarta el paquete con
un ICMP _Time Exceeded_ cuando llega a cero, que es exactamente lo que arma
`traceroute`. ICMP también reporta lo que el camino no puede entregar —
_Fragmentation Needed_ cuando hay que fragmentar y el bit DF lo impide, con el
MTU del salto que se quedó corto — y por eso un ping que falla cuenta una
historia distinta según el tipo y el código que vuelven.

| Concepto observable               | Dónde verlo en NetLab                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Dirección, máscara y gateway      | `ip addr show` y `ip addr set IP dev IFACE [gateway GW]` en la consola del host.     |
| Tabla de ruteo y LPM              | `ip route show`; las rutas salen del escenario (`routes`) y la /24 le gana a la /16. |
| Vecino directo vs gateway         | `ping` dentro del prefijo resuelve por ARP; fuera del prefijo necesita gateway.      |
| Decremento de TTL                 | Un TTL por salto en el inspector; TTL 0 genera ICMP Time Exceeded y corta el bucle.  |
| `traceroute` como TTLs crecientes | `traceroute DST` imprime un salto por línea con el RTT en microsegundos.             |
| MTU, fragmentación y reensamble   | `ping -s SIZE` y el MTU del enlace: los fragmentos se reensamblan en destino.        |
| DF y Fragmentation Needed         | `ping` grande con DF recibe ICMP tipo 3 código 4 con el MTU del camino.              |
| RTT observable                    | Cada respuesta del `ping` reporta el tiempo virtual con reloj determinista.          |

## Ejercicios

Ruta [`direccionamiento-y-ruteo`](../../packages/exercises/routes/direccionamiento-y-ruteo.json)
— «Máscaras, subredes, gateways y rutas: decidir quién es vecino y por dónde
sale cada paquete.»

Nivel 1 — Subredes y VLSM:

- [`ip-subnetting-basic`](../../packages/exercises/exercises/ip-subnetting-basic.json)
  — Subnetting básico en una /26.
- [`ip-vlsm`](../../packages/exercises/exercises/ip-vlsm.json) — VLSM: tres
  bloques en una /24.
- [`ip-wrong-mask`](../../packages/exercises/exercises/ip-wrong-mask.json) —
  Máscara incorrecta en el mismo cable.

Nivel 2 — Direcciones sanas y gateway:

- [`ip-duplicate`](../../packages/exercises/exercises/ip-duplicate.json) — IP
  duplicada.
- [`ip-missing-gateway`](../../packages/exercises/exercises/ip-missing-gateway.json)
  — Gateway faltante.
- [`rt-two-networks`](../../packages/exercises/exercises/rt-two-networks.json) —
  Dos redes con un router.

Nivel 3 — Elegir el camino:

- [`rt-default-route`](../../packages/exercises/exercises/rt-default-route.json)
  — Ruta por defecto.
- [`rt-specific-route`](../../packages/exercises/exercises/rt-specific-route.json)
  — La ruta más específica gana.
- [`rt-ttl-loop`](../../packages/exercises/exercises/rt-ttl-loop.json) — Bucle de
  ruteo con TTL.

Nivel 4 — Convergencia e ICMP:

- [`rt-convergence`](../../packages/exercises/exercises/rt-convergence.json) —
  Convergencia con rutas estáticas.
- [`icmp-traceroute`](../../packages/exercises/exercises/icmp-traceroute.json) —
  Traceroute a mano.
- [`icmp-mtu-fragmentation`](../../packages/exercises/exercises/icmp-mtu-fragmentation.json)
  — MTU y fragmentación.
- [`icmp-frag-needed-df`](../../packages/exercises/exercises/icmp-frag-needed-df.json)
  — Fragmentation needed con DF.

Anterior: [Capa 2 y ARP](capa-2-arp.md) · Volver al [README](../../README.md) ·
Siguiente: [TCP](tcp.md)
