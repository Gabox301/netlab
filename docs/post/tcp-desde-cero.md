# Implementé TCP desde cero en TypeScript: lo que aprendí

NetLab es un simulador de redes que corre el stack desde los bytes, un módulo
por protocolo en TypeScript (`packages/protocols/src/`: `ethernet.ts`, `arp.ts`,
`ipv4.ts`, `icmp.ts`, `udp.ts`, `dns.ts`, `dhcp.ts` y `tcp.ts`), con reloj
virtual y PRNG sembrado. Cuando terminé la fase de TCP, la máquina quedó en un
archivo de casi 2 000 líneas (`packages/core/src/tcp.ts`) y los tests en otro
del mismo tamaño (`packages/core/test/tcp.test.ts`). Esto es lo que me llevé de
escribirla.

## El problema

El motor entrega tramas Ethernet entre hosts, switches y routers sobre un reloj
de eventos discretos. TCP tenía que resolver, sobre ese motor, el problema de
siempre: convertir un canal que pierde, reordena, duplica y bloquea al receptor
en un flujo de bytes ordenado, con handshake, cierre y control de congestión.

El criterio de aceptación que me puse fue exigente: bytes idénticos bajo
pérdida y reordenamiento aleatorio, handshake y cierre según RFC 793/9293,
`cwnd` en diente de sierra y throughput coherente con la fórmula de Mathis como
_sanity check_ (`odd/tasks/fase-5-tcp.md:8`).

Los números de partida son los de cualquier stack razonable: MSS de 1 460 B
(`packages/core/src/tcp.ts:154`), tope de envío por defecto de 4 MSS = 5 840 B
(`packages/core/src/tcp.ts:164`), buffer de recepción de 65 535 B —el máximo que
entra en el campo de 16 bits— (`packages/core/src/tcp.ts:170`), RTO base de 1 s
con techo de 60 s (`packages/core/src/tcp.ts:196`,
`packages/core/src/tcp.ts:199`), TIME_WAIT de 60 s
(`packages/core/src/tcp.ts:151`) y sonda de zero window cada 1 s
(`packages/core/src/tcp.ts:176`).

La restricción que ordenó todo lo demás: **nada de tiempo real ni de azar del
runtime dentro de la máquina**. El ISN y el puerto efímero salen de
`sim.random`; TIME_WAIT, la sonda de zero window y el RTO son eventos de
`sim.schedule()` (`packages/core/src/tcp.ts:119-123`). Si el reloj es un dato,
la misma semilla produce la misma secuencia de trazas y una corrida se puede
grabar y reconstruir después sin volver a simular.

## Las decisiones de diseño

1. **Todo el estado de conexión vive en un objeto, no en el host.** El host solo
   es dueño del espacio de puertos (`Host.bindTcp` / `Host.onTcpSegment`); los
   once estados de RFC 793, el open simultáneo, el cierre en cuatro pasos, el
   timeout de TIME_WAIT y el manejo de RST están en el socket
   (`packages/core/src/tcp.ts:4-8`).
2. **Secuenciación por bytes, no por segmentos.** `send()` corta por MSS y lleva
   SND.UNA/SND.NXT; el receptor entrega en orden —un segmento fuera de orden se
   bufferiza hasta que se llena el hueco— y cada segmento válido gana un ACK
   acumulativo con RCV.NXT; los duplicados se re-ACKean sin entregarse
   (`packages/core/src/tcp.ts:10-14`). La consecuencia grande: un ACK que tapa
   un hueco también reconoce todo lo anterior, y eso es lo que permite que un
   solo temporizador alcance para todo lo que está en vuelo.
3. **La ventana efectiva es un mínimo de tres números, con tres dueños
   distintos**: `cwnd` (lo que aguanta el camino), `SND.WND` (lo que aguanta el
   buffer del par) y `sendWindow` (el tope fijo del operador)
   (`packages/core/src/tcp.ts:18-26`, `packages/core/src/tcp.ts:60-69`).
4. **Los temporizadores son eventos de la simulación.** TIME_WAIT, la sonda y el
   RTO no son `setTimeout`: son eventos agendados (`packages/core/src/tcp.ts:119-123`).
   Es lo que después hace posible que `netlab replay` scrubee un cierre hacia
   atrás sin simular nada (`odd/tasks/fase-7-pcap-dist.md:7`,
   `odd/tasks/fase-7-pcap-dist.md:14`).
5. **La observabilidad es parte del contrato.** `cwnd` y `ssthresh` son getters
   públicos y cada cambio se publica en el `TraceBus` como un registro `state`
   en el molde `key=value` que ya usaba el router
   (`packages/core/src/tcp.ts:86-90`). El test verifica que el detalle sea
   graficable: `cwnd=` y `ssthresh=` con los mismos números que exponen los
   getters (`packages/core/test/tcp.test.ts:1420-1423`), y `ss` imprime esas dos
   columnas por socket (`packages/shell/src/shell.ts:170`).
6. **HTTP no vive en la máquina.** El shell arma el HTTP/1.0 mínimo sobre
   `send()`/`onData`: GET, `Content-Length`, sin keep-alive, sin chunked
   (`packages/core/src/tcp.ts:115-117`, `packages/shell/src/shell.ts:14-20`).
   Meter el servidor adentro de TCP hubiera hecho imposible decir dónde termina
   la máquina y dónde empieza la aplicación.
7. **El backlog es una cola de aceptación de verdad.** Con `backlog: 1` el
   listener completa el handshake él mismo; con un valor mayor se queda en
   LISTEN y bifurca un TCB por conexión. Un SYN que encuentra la cola llena se
   descarta —nunca se contesta con RST— para que el par reintente con su propio
   RTO (`packages/core/src/tcp.ts:99-108`).

## Los tres aprendizajes

### 1. Una ventana que se cierra no es un error: es una respuesta

El receptor anuncia `capacity - buffered`, y el buffer cuenta tanto lo que
`read()` todavía no drenó como lo que está fuera de orden esperando
reensamblado. La ventana no puede encogerse: el borde derecho `RCV.NXT + window`
solo avanza, y lo único que un par puede ver es el piso de cero cuando el buffer
está lleno. `read()` que reabre una ventana en cero manda el _window update_ en
el acto; el payload que no entra en la ventana actual se descarta y se
re-ACKea, jamás se entrega (`packages/core/src/tcp.ts:33-42`).

El ejemplo concreto que me hizo entenderlo: con `receiveCapacity` de 2 MSS,
el sender llena exactamente 2 MSS y `SND.NXT` se congela ahí mientras `cwnd`
sigue subiendo — el camino está perfecto, el que no puede recibir es el otro
(`packages/core/test/tcp.test.ts:749-790`). La sonda que rompe el empate es un
temporizador de intervalo fijo que manda el primer byte pendiente en `SND.NXT`
sin gastar espacio de secuencia; el receptor lo descarta por estar fuera de la
ventana y re-ACKea su ventana cerrada
(`packages/core/src/tcp.ts:27-32`, `packages/core/test/tcp.test.ts:856-899`).
Cuando la aplicación drena, sale un único ACK vacío con la ventana nueva y la
transferencia sigue (`packages/core/test/tcp.test.ts:791-824`).

Moraleja: "zero window" tiene que ser un estado del buffer, no una rama de
error. Si la sonda fuera el RTO, arrastraría backoff y una cola de
retransmisión a un problema que no es de pérdida.

### 2. Un ACK duplicado no es ruido

Un ACK duplicado es un portador legal de actualización de ventana: SND.WND se
toma de todo ACK válido en `[SND.UNA, SND.NXT]`, duplicados incluidos
(`packages/core/src/tcp.ts:20-22`). Y el tercero en SND.UNA es una señal de
pérdida: el segmento de cabeza se reenvía en el acto, dentro del mismo evento
que trajo el ACK (`packages/core/test/tcp.test.ts:1096-1145`, con la aserción
`resent[0]?.t === thirdAckArrivesAt` en
`packages/core/test/tcp.test.ts:1139`). Reno, además, infla: `ssthresh =
max(2*MSS, cwnd/2)` y `cwnd = ssthresh + 3*MSS`, un MSS más por cada duplicado
extra, y desinfla al primer ACK que cubre datos nuevos
(`packages/core/src/tcp.ts:78-85`). En el test eso se ve como 8 MSS → ssthresh
de 4 MSS → `cwnd` de 7 MSS (`packages/core/test/tcp.test.ts:1574`).

Moraleja: la deduplicación que "ignora duplicados" es exactamente lo contrario
de lo que hay que hacer. Hay que contarlos y dejar que el contador maneje el
estado.

### 3. La retransmisión son dos relojes y una decisión de estado

El RTO guarda una copia de todo segmento que gasta espacio de secuencia (datos,
SYN, FIN) hasta que un ACK acumulativo lo cubra; el primero de la cola arma el
temporizador, y al vencer se reenvía el más viejo byte por byte (mismo número
de secuencia, mismo payload) mientras el timeout se duplica hasta `maxRtoUs`.
Cualquier ACK que avance SND.UNA tira las copias que cubre, devuelve el timeout
a la base y rearma para lo que siga pendiente. Los timeouts **no** producen
muestra de RTT (regla de Karn: un segmento reenviado es ambiguo)
(`packages/core/src/tcp.ts:46-55`).

Con un cable muerto las cuentas cierran solas: intentos en t0, t0+1 s, t0+3 s y
t0+7 s, con `rtoUs` en 4 s; el cuarto pasa y el ACK que avanza SND.UNA lo
devuelve a 1 s (`packages/core/test/tcp.test.ts:1159-1189`). El otro reloj no
tiene nada que ver: el _persist timer_ de la zero window es de intervalo fijo,
sin backoff, sin cola de retransmisión y sin gastar secuencia
(`packages/core/src/tcp.ts:27-32`, `packages/core/src/tcp.ts:176`).

Y acá llegó la factura que no había previsto: con un temporizador que se rearma,
`runAll()` no termina nunca. El primer párrafo del archivo de tests lo dice sin
vueltas —`runAll()` giraría sobre un persist timer que se rearma mientras la
ventana del par siga cerrada, y sobre un RTO que reenvía a un cable muerto— y
por eso la suite usa `runUntil()` (`packages/core/test/tcp.test.ts:9-13`).

Lo que sí quedó probado en propiedad: con 5 % de pérdida sembrada, cuatro
semillas y un payload de 8 MSS, todos los bytes llegan idénticos y en orden, y
`rtoUs` vuelve a la base al terminar (`packages/core/test/tcp.test.ts:1217-1239`);
con 10 % de pérdida y 40 MSS, la ventana sube, colapsa y vuelve a subir al menos
dos veces, y los 40 MSS llegan intactos
(`packages/core/test/tcp.test.ts:1606-1668`).

## Qué quedó afuera

- **SACK, NewReno, estimador de RTT y cualquier congestión que no sea Reno
  clásico** (`packages/core/src/tcp.ts:92-95`). Hoy un solo ACK que avanza se
  toma como fin de la recuperación: un ACK parcial (el caso que NewReno existe
  para resolver) desinflaría de más.
- **El test de 1 MB no existe.** La suite prueba la propiedad con 8 MSS
  (11 680 B) por semilla (`packages/core/test/tcp.test.ts:1219-1221`) y el
  diente de sierra con 40 MSS (`packages/core/test/tcp.test.ts:1614`). El 1 MB
  es el entregable de la fase (`odd/tasks/fase-5-tcp.md:7`), no una aserción.
- **Mathis quedó como criterio, no como test.** El _sanity check_ de throughput
  está en el criterio de aceptación (`odd/tasks/fase-5-tcp.md:8`) pero no hay
  comparación automática; el benchmark publicado mide frames L2 de 1 400 B
  sobre tiempo virtual, no flujos TCP (`docs/bench.md:44-46`). Los números de la
  tabla (`docs/bench.md:26-29`) son humo de motor, no una afirmación sobre TCP.
- **El gráfico de `cwnd` es datos, no curva.** Cada cambio va al bus
  (`packages/core/src/tcp.ts:86-90`) y `ss` imprime `Cwnd`/`Ssthresh`
  (`packages/shell/src/shell.ts:170`), pero el workbench web no decodifica TCP:
  su contrato de protocolos es `ARP | ICMP | UDP | DNS | DHCP | OTRO`
  (`packages/web/src/lib/decode.ts:115`) y el filtro rechaza `tcp.port` como
  campo desconocido (`packages/web/test/filter.test.ts:402`). Hoy el diente de
  sierra se lee como tabla, no como gráfico.
- **El estado "de la máquina" y el "del cable" son dos cosas distintas.**
  `--break-on-tcp` deduce el estado de los frames, no del TCB
  (`packages/cli/src/replay.ts:20-28`): LISTEN no emite paquetes, así que nunca
  puede matchear.
- **TIME_WAIT de 60 s** (`packages/core/src/tcp.ts:151`) obliga a `runUntil` en
  todos los tests de cierre (`packages/core/test/tcp.test.ts:356`). No hay
  atajo, y está bien: es el precio de que el reloj sea determinista.

## Cierre

La parte que más me sirvió no fue la que sale en el diagrama de estados, sino la
que se puede verificar con herramientas de terceros: cada corrida se exporta a
PCAP/PCAPNG y la CI la abre con `tshark`, que falla si aparece un frame
malformado o un checksum mal (`odd/tasks/fase-7-pcap-dist.md:12-13`,
`.github/workflows/ci.yml:77-100`). Escribir TCP es, sobre todo, escribir un
protocolo que otro pueda leer.

## Fuentes

Cada afirmación técnica del post, con el archivo y la línea que la respalda.

1. Criterio de aceptación de la fase: bytes idénticos bajo pérdida, handshake y
   cierre RFC 793/9293, `cwnd` en diente de sierra, Mathis como sanity check —
   `odd/tasks/fase-5-tcp.md:8`.
2. Entregable de 1 MB con 5 % de pérdida y reordenamiento —
   `odd/tasks/fase-5-tcp.md:7`.
3. Once estados de RFC 793, open simultáneo, cierre en cuatro pasos, TIME_WAIT y
   RST; el host solo es dueño del espacio de puertos —
   `packages/core/src/tcp.ts:4-8`.
4. Secuenciación por bytes, buffer de envío SND.UNA/SND.NXT, entrega en orden,
   ACK acumulativo y duplicados que se re-ACKean sin entregarse —
   `packages/core/src/tcp.ts:10-14`.
5. Ventana efectiva `min(cwnd, sendWindow, SND.WND)`; SND.WND desde el SYN y
   desde todo ACK válido, duplicados incluidos; `sendWindow` fue el standby de
   `cwnd` en el hito 5.3 — `packages/core/src/tcp.ts:18-26`.
6. Sonda de zero window: intervalo fijo, primer byte pendiente sin gastar
   secuencia, sin RTT ni backoff ni cola de retransmisión —
   `packages/core/src/tcp.ts:27-32`.
7. Ventana anunciada `capacity - buffered`, prohibición de encoger, window
   update al reabrir, payload que no entra se descarta y se re-ACKea —
   `packages/core/src/tcp.ts:33-42`.
8. RTO: copia hasta el ACK acumulativo, reenvío byte por byte, backoff hasta
   `maxRtoUs`, reset con ACK que avanza SND.UNA, regla de Karn —
   `packages/core/src/tcp.ts:46-55`.
9. Fast retransmit ante el tercer ACK duplicado en SND.UNA —
   `packages/core/src/tcp.ts:56-58`.
10. Reno: `cwnd` arranca en 1 MSS, `ssthresh` en `sendWindow`, slow start
    duplica por RTT, congestión aditiva ~1 MSS por RTT, timeout tipo Tahoe
    (`ssthresh = max(2*MSS, cwnd/2)`, `cwnd = 1 MSS`) e inflado de fast
    recovery (`ssthresh + 3*MSS`) — `packages/core/src/tcp.ts:60-85`.
11. Observabilidad: getters públicos y registro `state` en el `TraceBus` con
    forma `key=value` — `packages/core/src/tcp.ts:86-90`.
12. Fuera de alcance: SACK, NewReno, estimador de RTT y otras congestiones;
    FIN encolado detrás de los datos — `packages/core/src/tcp.ts:92-95`.
13. Cola de aceptación, `backlog` por defecto 1, SYN descartado sin RST cuando
    está llena — `packages/core/src/tcp.ts:99-108`.
14. HTTP fuera de la máquina: mínimo HTTP/1.0 sobre `send()`/`onData` —
    `packages/core/src/tcp.ts:115-117`.
15. Determinismo: ISN y puerto efímero desde `sim.random`; TIME_WAIT, sonda y
    RTO agendados con `sim.schedule()`, y `runUntil` en lugar de `runAll` —
    `packages/core/src/tcp.ts:119-123`.
16. Valores por defecto: TIME_WAIT 60 s —
    `packages/core/src/tcp.ts:151`; MSS 1 460 B —
    `packages/core/src/tcp.ts:154`; tope de envío 4 MSS —
    `packages/core/src/tcp.ts:164`; buffer de recepción 65 535 B —
    `packages/core/src/tcp.ts:170`; sonda de 1 s —
    `packages/core/src/tcp.ts:176`; RTO base 1 s —
    `packages/core/src/tcp.ts:196`; techo de backoff 60 s —
    `packages/core/src/tcp.ts:199`.
17. Tests deterministas con `runAll()`/`runUntil()` y el motivo (persist timer
    y RTO rearmándose) — `packages/core/test/tcp.test.ts:9-13`.
18. Prueba de control de flujo: con capacidad de 2 MSS, `SND.NXT` se congela en
    `start + capacity` mientras `cwnd` sigue creciendo —
    `packages/core/test/tcp.test.ts:749-790`.
19. Ventana cero anunciada y reabierta por `read()`, con un único window update
    — `packages/core/test/tcp.test.ts:791-824`.
20. Sonda de zero window: al menos dos probes en el mismo `SND.NXT`, sin gastar
    secuencia, descartados por el receptor, y transferencia completa al reabrir
    — `packages/core/test/tcp.test.ts:856-899`.
21. Fast retransmit en el mismo evento del tercer ACK duplicado —
    `packages/core/test/tcp.test.ts:1096-1145`; aserción de tiempo —
    `packages/core/test/tcp.test.ts:1139`; `ssthresh` de 2 MSS con `cwnd` de
    `ssthresh + 3*MSS` — `packages/core/test/tcp.test.ts:1146`.
22. Backoff: intentos en t0, +1 s, +3 s y +7 s, `rtoUs = 4*rto` y reset a 1 s —
    `packages/core/test/tcp.test.ts:1159-1189`.
23. Propiedad de integridad con 5 % de pérdida en las semillas 3, 17, 29 y 43,
    payload de 8 MSS, `rtoUs` de vuelta en la base —
    `packages/core/test/tcp.test.ts:1217-1239`.
24. Diente de sierra con 10 % de pérdida y 40 MSS: al menos dos colapsos, todos
    los bytes entregados — `packages/core/test/tcp.test.ts:1606-1668`.
25. Traza `state` graficable (`cwnd=`, `ssthresh=`) —
    `packages/core/test/tcp.test.ts:1420-1423`.
26. Inflado de Reno medido (8 MSS → ssthresh 4 MSS → cwnd 7 MSS) —
    `packages/core/test/tcp.test.ts:1574`.
27. `ss` imprime `Cwnd` y `Ssthresh` por socket —
    `packages/shell/src/shell.ts:170`.
28. HTTP/1.0 mínimo: GET, `Content-Length`, `Connection: close`, sin keep-alive
    ni chunked — `packages/shell/src/shell.ts:14-20`.
29. Scrub hacia atrás con snapshots y breakpoints como alcance de la fase 7 —
    `odd/tasks/fase-7-pcap-dist.md:7` y `odd/tasks/fase-7-pcap-dist.md:14`.
30. Validación con `tshark` de toda captura, sin errores ni warnings de
    checksum — `odd/tasks/fase-7-pcap-dist.md:12-13` y
    `.github/workflows/ci.yml:77-100`.
31. Benchmark `bulk` mide frames L2 de 1 400 B sobre tiempo virtual, no flujos
    TCP — `docs/bench.md:44-46`; tabla publicada —
    `docs/bench.md:26-29`.
32. El workbench web no decodifica TCP y su filtro rechaza `tcp.port` —
    `packages/web/src/lib/decode.ts:115` y
    `packages/web/test/filter.test.ts:402`.
33. `--break-on-tcp` deduce el estado del cable, no del TCB; LISTEN nunca
    matchea — `packages/cli/src/replay.ts:20-28`.
34. El stack vive en un módulo por protocolo, no en un archivo monolítico —
    `packages/protocols/src/` (`ethernet.ts`, `arp.ts`, `ipv4.ts`, `icmp.ts`,
    `udp.ts`, `dns.ts`, `dhcp.ts`, `tcp.ts`).
35. El cierre espera TIME_WAIT con `runUntil`, nunca con `runAll` —
    `packages/core/test/tcp.test.ts:356`.
