# Guion — demo de NetLab (82 s)

Video corto de lanzamiento: workbench (Run → lista → inspector → scrub) y la
parte de TCP por CLI (`replay --break-on-tcp` + `pcap` + `tshark`). Todo lo que
se muestra corre hoy en el repo; no hay tomas de maqueta.

- **Duración total: 82 s** (rango objetivo 60-90 s).
- Formato: 16:9, 1440×900, fuente de terminal 15 px, navegador sin marcadores.
- Tono: directo, sin epílogos. Una idea por toma.
- Se graba en dos pasadas: workbench (T1-T4) y terminal (T6-T9). La placa final
  se arma en edición.

## Preflight (antes de grabar)

```sh
bun install                                        # workspaces @netlab/*
bun run --cwd packages/web build                   # UI estática; `netlab serve` la necesita
bun packages/cli/src/main.ts serve --port 0        # imprime "netlab listo en http://127.0.0.1:<puerto>/"
which tshark                                       # obligatorio para T9 (en Windows: where tshark)
```

- Dejar `packages/web/build` construido: el manifest embebido se genera desde
  ahí y el directorio está en `.gitignore`.
- Abrir el workbench **una vez** antes de grabar y cerrar el tutorial de
  bienvenida (`Omitir`): la marca queda en `localStorage`
  (`netlab.tutorial.v1`) y el overlay no vuelve a aparecer en la toma.
- Dejar una terminal limpia en la raíz del repo y el navegador ya abierto en la
  URL que imprime `serve`. Cerrar pestañas y notificaciones.
- Verificar una vez, fuera de cámara, que `tcp.json` y `tcp.pcap` se generan sin
  error. No dejarlos abiertos en el editor durante la toma.

## Tomas

| Toma | In–out    | Dur  | En pantalla                                                                                                                                                | Acción / comando                                                                                                                                                                                                                                  | Texto en pantalla                                   |
| ---- | --------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| T1   | 0:00–0:06 | 6 s  | Terminal: se tipea el comando y aparece una sola línea                                                                                                     | `bun packages/cli/src/main.ts serve --port 0`                                                                                                                                                                                                     | NetLab — laboratorio de redes con stack propio      |
| T2   | 0:06–0:17 | 11 s | Navegador en la URL impresa. Workbench completo: `NetLab`, `dos-subredes.json · seed 11`, topología h1–r1–h2, panel `Paquetes`, línea de tiempo en `0 µs`  | Clic en **▶ Run**. La topología anima los vuelos y la lista se llena de filas ARP e ICMP                                                                                                                                                          | 4 pings, reloj virtual, todo determinista           |
| T3   | 0:17–0:29 | 12 s | Clic en una fila ICMP de la lista: el panel derecho abre la pestaña **Inspector** con las capas Ethernet / IPv4 / ICMP y el volcado hexadecimal            | Clic en un campo (por ejemplo `TTL`): los bytes de ese campo quedan resaltados en el hexdump; pasar el mouse por una capa marca sus bytes                                                                                                         | el campo y sus bytes, en los dos sentidos           |
| T4   | 0:29–0:38 | 9 s  | Se arrastra la línea de tiempo hacia atrás: cambia `t = … µs` en el encabezado y la lista se recorta al instante elegido                                   | Arrastrar el slider (`Retroceder al instante`), después **⏮ Prev** / **⏭ Next** (o ← →) para ir frame por frame                                                                                                                                   | scrub hacia atrás, sin re-simular                   |
| T5   | 0:38–0:42 | 4 s  | Plano del presentador o cartón sobre el workbench                                                                                                          | —                                                                                                                                                                                                                                                 | TCP se ve por CLI: la UI todavía no lo decodifica   |
| T6   | 0:42–0:49 | 7 s  | Terminal: se tipea el `run` con grabación; scrollean las trazas del handshake                                                                              | `bun packages/cli/src/main.ts run packages/exercises/solutions/tcp-zero-window.json --until 2s --snapshot-out tcp.json`                                                                                                                           | una corrida, grabada                                |
| T7   | 0:49–0:58 | 9 s  | Se tipea el `replay`; la salida corta en una línea: `break on tcp at t=80us: ESTABLISHED (10.0.0.1:60841 -> 10.0.0.2:80)` y debajo la traza del tercer ACK | `bun packages/cli/src/main.ts replay tcp.json --break-on-tcp ESTABLISHED`                                                                                                                                                                         | el breakpoint cae en el ACK que cierra el handshake |
| T8   | 0:58–1:04 | 6 s  | Misma terminal; el corte ahora cae en `t=1000000us` con `FIN_WAIT_1` y la traza `[ACK,FIN]`                                                                | `bun packages/cli/src/main.ts replay tcp.json --break-on-tcp FIN_WAIT_1`                                                                                                                                                                          | y en el cierre, 1 s después                         |
| T9   | 1:04–1:14 | 10 s | Se exporta la captura y `tshark` la abre: primero el `expert` sin errores, después el puerto destino del SYN                                               | `bun packages/cli/src/main.ts pcap packages/exercises/solutions/tcp-zero-window.json -o tcp.pcap --until 100ms` · `tshark -r tcp.pcap -q -z expert` · `tshark -r tcp.pcap -Y "tcp.flags.syn == 1 && tcp.flags.ack == 0" -T fields -e tcp.dstport` | Wireshark lee lo que escribió el simulador          |
| T10  | 1:14–1:22 | 8 s  | Placa final sobre fondo del workbench                                                                                                                      | —                                                                                                                                                                                                                                                 | demo + repo + `netlab serve --port 0`               |

Suma: 6 + 11 + 12 + 9 + 4 + 7 + 9 + 6 + 10 + 8 = **82 s**.

## Guion palabra por palabra

**T1 (0:00).** Voz: «NetLab simula una red desde los bytes: Ethernet, IP, UDP,
DNS, DHCP y TCP escritos en TypeScript. Un comando y está corriendo.»

**T2 (0:06).** «El workbench corre la simulación en un worker, con semilla fija:
la misma semilla da la misma secuencia de frames. Le doy Run y tengo la lista
completa: ARP para resolver el gateway y cuatro pings con su respuesta.»

**T3 (0:17).** «Cada fila se abre por capas. Elijo un campo y el inspector me
marca exactamente qué bytes son, en el volcado hexadecimal. Y al revés: toco un
byte y me dice de qué campo es.»

**T4 (0:29).** «La línea de tiempo se arrastra para atrás. No se re-simula nada:
la corrida ya está grabada, así que retroceder es instantáneo. Con ← y → voy
frame por frame.»

**T5 (0:38).** «Hasta acá la UI. TCP todavía no se decodifica en el workbench, así
que lo miro donde sí está: la CLI.»

**T6 (0:42).** «Grabo una corrida de un escenario TCP: un servidor HTTP y un
cliente que se conecta.»

**T7 (0:49).** «Y ahora la reproduzco con un breakpoint de estado. Corta en el
tercer ACK: el handshake quedó establecido en 80 microsegundos de tiempo
virtual.»

**T8 (0:58).** «Otro breakpoint, esta vez en el cierre: el FIN sale exactamente un
segundo después, cuando se vence la ventana de espera del cliente.»

**T9 (1:04).** «Exporto la misma corrida a PCAP y la abro con tshark. Cero
errores de disección, y el SYN va al puerto 80. La captura del simulador la lee
Wireshark.»

**T10 (1:14).** «Demo, código y el guion de este video, en el repo. Se levanta con
`netlab serve --port 0`.»

## Detalle de cada toma (qué tiene que verse sí o sí)

**T1.** El comando se tipea sin prisa y la única salida es
`netlab listo en http://127.0.0.1:<puerto>/`. No mostrar `bun install` ni el
build: van en el preflight.

**T2.** Encuadre que entre completo el encabezado (`NetLab`,
`dos-subredes.json · seed 11`, `t = 0 µs`, `▶ Run`) y el panel
`Paquetes`. Después del clic, esperar a que la lista se llene y el reloj avance.
Los chips de filtro (`ARP`, `ICMP`, `UDP`, `DNS`, `DHCP`, `OTRO`) quedan
visibles: son parte del argumento de accesibilidad.

**T3.** El inspector arranca con el primer ICMP preseleccionado; el clic en la
fila es para mostrar la interacción lista → inspector. Elegir un campo corto
(`TTL`) para que el resaltado en el hexdump se lea aun en video vertical.

**T4.** Arrastrar el slider de derecha a izquierda en un solo movimiento, sin
soltar; el contador `t = … µs` del encabezado es el que cuenta la historia. Un
solo ← y un solo → al final, para mostrar el paso a paso por teclado.

**T5.** Cuatro segundos, sin captura de pantalla. Es el plano que evita que la
audiencia crea que el workbench hace TCP.

**T6.** Tipear el comando completo y dejar que scrollee: el corte a T7 va antes
de que termine. No hace falta leer la salida: la prueba es el archivo `tcp.json`.

**T7.** La salida esperada es una línea de corte y una traza:

```text
break on tcp at t=80us: ESTABLISHED (10.0.0.1:60841 -> 10.0.0.2:80)
[t=80us] TX l1 from=a len=60
```

El puerto efímero depende de la semilla del escenario (1020); si cambia, se
ajusta el cartón, no el comando. Lo que no puede cambiar es que el corte caiga
en el tercer ACK (`t=80us`), no en el SYN ni en el SYN+ACK.

**T8.** El corte cae en `t=1000000us` con `FIN_WAIT_1` y la traza del
`[ACK,FIN]` del cliente. Ese segundo exacto es la ventana de espera del `nc`, no
un RTO: si en la toma aparece otro valor, se cortó otra cosa.

**T9.** Tres comandos, en este orden:

```sh
bun packages/cli/src/main.ts pcap packages/exercises/solutions/tcp-zero-window.json -o tcp.pcap --until 100ms
tshark -r tcp.pcap -q -z expert
tshark -r tcp.pcap -Y "tcp.flags.syn == 1 && tcp.flags.ack == 0" -T fields -e tcp.dstport
```

El segundo comando imprime el reporte de expertos sin líneas de error; el
tercero imprime `80`. Es la misma verificación que corre la CI.

**T10.** Placa final, tres líneas:

```text
Demo:      https://<owner>.github.io/Net-Lab/   (o: netlab serve --port 0)
Código:    https://github.com/<owner>/Net-Lab
Video:     este guion
```

La URL de Pages es la que publica `.github/workflows/pages.yml`: el prefijo se
deriva del nombre del repo (`docs/demo.md`, sección «GitHub Pages»). Si el
deploy todavía no está arriba, la placa cierra solo con `netlab serve --port 0`
y el repo: no se promete una URL que no responde.

## Postproducción

- Cortes secos, sin transiciones. El único texto animado es el contador de `t`
  que ya trae la UI.
- Subtítulos quemados en español para T1, T2, T4, T7, T8 y T9: son las tomas
  donde el texto en pantalla explica el argumento.
- Si hay que recortar a 60 s: se cae T5 (queda el cartón de una línea sobre T6) y
  T8 (el cierre se cuenta en la voz sobre T7). Se pierde el cierre de la
  conexión, no el handshake.

## Chequeo de exactitud de lo afirmado

Los archivos que otras tareas tocaron en paralelo (`+page.svelte`,
`vite.config.ts`) pueden moverse de línea: ahí se cita el símbolo, que es lo
estable. El resto va con línea exacta.

- Encabezado del workbench (`NetLab`, `dos-subredes.json · seed 11`,
  `t = … µs`, `▶ Run`, `⏸ Pause`, `⏮ Prev`, `⏭ Next`, `⟲ Start`): bloque
  `<header class="top">` de `packages/web/src/routes/workbench/+page.svelte`.
- Escenario fijo del workbench: `h1 10.0.0.2 — r1 — h2 10.0.1.2`, semilla 11,
  horizonte 10 000 µs, 4 pings de 32 B cada 2 500 µs —
  `packages/web/src/lib/scenario.ts:25-32`.
- Pestañas `Inspector / Terminal h1 / Tablas`: constantes `TAB_ORDER` y
  `TAB_LABEL` de `packages/web/src/routes/workbench/+page.svelte`.
- Volcado hexadecimal, resaltado bidireccional y su hint: bloque
  `<pre class="hex" aria-label="Volcado hexadecimal del frame">` de
  `packages/web/src/routes/workbench/+page.svelte`.
- Slider con `aria-label="Retroceder al instante"` y lectura en µs:
  `packages/web/src/routes/workbench/+page.svelte` (elemento `id="scrub"`).
- Teclas globales (espacio pausa, ← y → paso a paso): `onReplayKey` de
  `packages/web/src/routes/workbench/+page.svelte`; las filas aceptan ↑/↓, Enter y espacio:
  `onRowKey` del mismo archivo.
- Preselección del primer ICMP y del primer instante al terminar un run:
  `handleMessage` de `packages/web/src/routes/workbench/+page.svelte`.
- `serve` imprime `netlab listo en <url>` y escucha en loopback por defecto:
  `packages/cli/src/serve.ts:32-36`.
- `run --snapshot-out` y `replay --break-on-tcp`: `packages/cli/src/replay.ts:20-28`;
  la línea de corte y la traza que la acompañan, `formatBreakHuman` en
  `packages/cli/src/replay.ts:897-904`.
- Salida de `netlab pcap`, `-o` y `--until`: texto de ayuda observado con
  `bun packages/cli/src/main.ts --help` (`packages/cli/src/pcap.ts`).
- El FIN de T8 sale al vencer la ventana de `nc`: 1 000 000 µs de espera
  (`packages/shell/src/shell.ts:122`) y `socket.close()` recién al terminar
  `runUntil(deadline)` (`packages/shell/src/shell.ts:973-999`).
- `tshark -r … -q -z expert` y el chequeo del puerto 80 sobre `tcp.pcap`
  generado desde `tcp-zero-window.json`: `.github/workflows/ci.yml:73` y
  `.github/workflows/ci.yml:77-113`.
- La UI no decodifica TCP (protocolos `ARP | ICMP | UDP | DNS | DHCP | OTRO`):
  `packages/web/src/lib/decode.ts:115`.
- URL de la demo en Pages (`https://<owner>.github.io/<repo>/`, prefijo derivado
  del nombre del repo) y build con `BASE_PATH`: `docs/demo.md` («GitHub Pages»
  y «Build»).
