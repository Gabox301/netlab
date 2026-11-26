/**
 * Contenido de `/teoria`: las cuatro páginas de `docs/teoria/*.md` portadas a
 * datos puros para que se lean dentro del sitio.
 *
 * Los `.md` siguen siendo la fuente (viven en el repo y se leen desde el
 * checkout); acá quedan el párrafo de teoría, la lista corta de conceptos
 * observables y los ejercicios de cada protocolo. Nada de Svelte ni de
 * `resolve()`: el orden, las anclas y los ids se pueden pinear sin build.
 *
 * Dos adaptaciones respecto del `.md`, para no prometer nada que la UI web no
 * tenga: las rutas de archivo y lo que solo existe en la CLI (`netlab run`,
 * `netlab pcap`, `tshark`) se reemplazan por lo que se ve en el workbench o se
 * prueba en práctica. Los comandos que sí existen en la consola del host se
 * citan tal cual.
 */

/** Un concepto observable: qué mirar y dónde se ve en NetLab. */
export interface TeoriaConcept {
  /** Nombre del concepto, como en la tabla del `.md`. */
  label: string;
  /** Dónde verlo: consola del host, inspector, workbench o práctica. */
  detail: string;
}

/** Un ejercicio de `packages/exercises`, por id y título reales. */
export interface TeoriaExercise {
  /** Id del catálogo (`packages/exercises/exercises/<id>.json`). */
  id: string;
  /** Título del catálogo; es también el texto del link a `/practica`. */
  title: string;
}

/** Una de las cuatro secciones de teoría. */
export interface TeoriaSection {
  /** Slug estable: sirve de ancla en la página y de `key` en el render. */
  anchor: string;
  title: string;
  /** Un párrafo: la teoría mínima de la sección, portada del `.md`. */
  summary: string;
  concepts: readonly TeoriaConcept[];
  exercises: readonly TeoriaExercise[];
}

export interface TeoriaHero {
  eyebrow: string;
  title: string;
  lede: string;
  note: string;
  metaDescription: string;
}

/** Ruta de la teoría; la página la pasa por `resolve()`. */
export const TEORIA_ROUTE = "/teoria";

/** Ruta de práctica: todo ejercicio linkea acá, sin deep-link por ejercicio. */
export const TEORIA_PRACTICE_ROUTE = "/practica";

/**
 * Por qué los ejercicios van a la ruta y no a una URL propia: la práctica no
 * direcciona ejercicios por URL, se eligen por título en la lista.
 */
export const TEORIA_PRACTICE_NOTE =
  "Cada ejercicio abre la práctica en la ruta, no una URL propia: la lista se recorre por título. Mismos ids que valida la CLI.";

export const TEORIA_HERO: TeoriaHero = {
  eyebrow: "Teoría por protocolo · cuatro capas, un mismo motor",
  title: "La teoría antes del paquete",
  lede: "Las cuatro páginas de teoría del repo, acá mismo: capa 2 y ARP, IPv4 e ICMP, TCP, y DNS con DHCP. Cada sección trae el párrafo que explica el protocolo, la lista de conceptos que se pueden ver en NetLab y los ejercicios con los que se practica.",
  note: TEORIA_PRACTICE_NOTE,
  metaDescription:
    "Teoría de redes por protocolo en NetLab: capa 2 y ARP, IPv4 e ICMP, TCP, DNS y DHCP, con conceptos observables y ejercicios para practicar.",
};

/**
 * Las cuatro secciones, en el orden de las capas: cable y MAC, direccionamiento
 * y ruteo, transporte, servicios.
 */
export const TEORIA_SECTIONS: readonly TeoriaSection[] = [
  {
    anchor: "capa-2-arp",
    title: "Capa 2 y ARP",
    summary:
      "La capa 2 es la que decide quién escucha el frame: Ethernet entrega tramas por dirección MAC dentro de un mismo dominio de broadcast, el switch aprende qué MAC vive en qué puerto mirando el origen de cada trama e inunda el destino mientras no lo conoce, y VLAN/trunk (802.1Q) parten ese dominio en segmentos lógicos que solo se cruzan por un puerto trunk con la VLAN transportada. ARP resuelve el paso de IP a MAC dentro del segmento: un ARP request en broadcast, un ARP reply en unicast y una entrada en la caché del host; si esa entrada se envenena, el tráfico sale hacia la MAC equivocada aunque la IP sea correcta.",
    concepts: [
      {
        label: "Aprendizaje de MAC",
        detail:
          "El switch aprende qué MAC vive en qué puerto mirando el origen: la primera trama a un destino desconocido se inunda y la siguiente sale por un solo puerto. Se sigue trama por trama en el workbench.",
      },
      {
        label: "Hub vs switch",
        detail:
          "El hub repite a todos los puertos siempre; el switch aprende y filtra. Se prueba reemplazando uno por otro en práctica.",
      },
      {
        label: "VLAN de acceso y aislamiento",
        detail:
          "Puertos en VLANs distintas del mismo switch no se alcanzan aunque compartan prefijo IP.",
      },
      {
        label: "Trunk 802.1Q y VLAN nativa",
        detail:
          "La VLAN que el trunk no transporta queda aislada; la nativa mal puesta asigna el tráfico sin etiquetar a la VLAN equivocada.",
      },
      {
        label: "Caché ARP",
        detail:
          "arp e ip neigh show en la consola del host muestran la entrada IP → MAC del vecino.",
      },
      {
        label: "ARP spoofing",
        detail:
          "Entrada del gateway apuntando a una MAC ajena: el ping sale y no vuelve.",
      },
    ],
    exercises: [
      {
        id: "l2-flood-vs-learn",
        title: "Hub que inunda vs switch que aprende",
      },
      { id: "l2-vlan-isolated", title: "VLAN aislada" },
      { id: "l2-trunk-misconfigured", title: "Trunk mal configurado" },
      { id: "l2-arp-spoofing", title: "ARP spoofing en el laboratorio" },
    ],
  },
  {
    anchor: "ipv4-icmp",
    title: "IPv4 e ICMP",
    summary:
      "IPv4 entrega datagramas extremo a extremo: cada host decide si el destino es vecino directo comparando la dirección con su máscara, y si no lo es manda el paquete a su gateway; cada router elige por dónde sale con la ruta más específica (longest prefix match), decrementa el TTL y descarta el paquete con un ICMP Time Exceeded cuando llega a cero, que es exactamente lo que arma traceroute. ICMP también reporta lo que el camino no puede entregar —Fragmentation Needed cuando hay que fragmentar y el bit DF lo impide, con el MTU del salto que se quedó corto— y por eso un ping que falla cuenta una historia distinta según el tipo y el código que vuelven.",
    concepts: [
      {
        label: "Dirección, máscara y gateway",
        detail:
          "ip addr show en la consola del host, e ip addr set IP dev IFACE con gateway GW para fijarlos.",
      },
      {
        label: "Tabla de ruteo y LPM",
        detail:
          "ip route show; las rutas salen del escenario y la /24 le gana a la /16: gana el prefijo más específico.",
      },
      {
        label: "Vecino directo vs gateway",
        detail:
          "Dentro del prefijo el ping resuelve por ARP; fuera del prefijo necesita gateway.",
      },
      {
        label: "Decremento de TTL",
        detail:
          "Un TTL por salto en el inspector; TTL 0 genera ICMP Time Exceeded y corta el bucle.",
      },
      {
        label: "traceroute como TTLs crecientes",
        detail:
          "traceroute DST imprime un salto por línea con el RTT en microsegundos.",
      },
      {
        label: "MTU, fragmentación y reensamble",
        detail:
          "Un ping -s SIZE mayor que el MTU del enlace se fragmenta y se reensambla en destino.",
      },
      {
        label: "DF y Fragmentation Needed",
        detail:
          "Un ping grande con DF recibe ICMP tipo 3 código 4 con el MTU del camino.",
      },
      {
        label: "RTT observable",
        detail:
          "Cada respuesta del ping reporta el tiempo virtual con reloj determinista.",
      },
    ],
    exercises: [
      { id: "ip-subnetting-basic", title: "Subnetting básico en una /26" },
      { id: "ip-vlsm", title: "VLSM: tres bloques en una /24" },
      { id: "ip-wrong-mask", title: "Máscara incorrecta en el mismo cable" },
      { id: "ip-duplicate", title: "IP duplicada" },
      { id: "ip-missing-gateway", title: "Gateway faltante" },
      { id: "rt-two-networks", title: "Dos redes con un router" },
      { id: "rt-default-route", title: "Ruta por defecto" },
      { id: "rt-specific-route", title: "La ruta más específica gana" },
      { id: "rt-ttl-loop", title: "Bucle de ruteo con TTL" },
      { id: "rt-convergence", title: "Convergencia con rutas estáticas" },
      { id: "icmp-traceroute", title: "Traceroute a mano" },
      { id: "icmp-mtu-fragmentation", title: "MTU y fragmentación" },
      { id: "icmp-frag-needed-df", title: "Fragmentation needed con DF" },
    ],
  },
  {
    anchor: "tcp",
    title: "TCP",
    summary:
      "TCP convierte un flujo de bytes en segmentos confiables y ordenados sobre un camino que puede perder, duplicar y reordenar: abre con un three-way handshake (SYN, SYN-ACK, ACK) que sincroniza números de secuencia y ventanas, numera cada byte, acumula ACKs y retransmite cuando vence el RTO o cuando los ACKs duplicados delatan un hueco. Encima de eso conviven dos controles distintos que NetLab mantiene separados: el flow control (la ventana anunciada por el receptor, que puede llegar a cero y dispara window probes) y el control de congestión estilo Reno (cwnd y ssthresh: slow start que duplica por RTT, evitación aditiva y fast recovery al detectar pérdida), que es lo que fija el throughput que se observa en una descarga.",
    concepts: [
      {
        label: "Handshake y estados",
        detail:
          "ss muestra el socket en ESTABLISHED; nc HOST PORT completa el saludo.",
      },
      {
        label: "Flags por segmento",
        detail:
          "SYN, ACK, FIN y RST viajan en cada segmento y se leen en la captura y en las trazas.",
      },
      {
        label: "Números de secuencia y ACKs",
        detail:
          "Cada byte enviado aparece una vez; los ACKs son acumulativos, no por segmento.",
      },
      {
        label: "Retransmisión por pérdida",
        detail:
          "En un enlace con pérdida la conexión se establece igual y las trazas muestran la retransmisión.",
      },
      {
        label: "Ventana anunciada y Cwnd/Ssthresh",
        detail:
          "Window de cada segmento en la captura: puede llegar a cero. ss imprime Cwnd y Ssthresh del socket en ESTABLISHED.",
      },
      {
        label: "Throughput y cuello de botella",
        detail:
          "curl http://HOST:PORT/ sobre un enlace limitado: el ancho de banda manda.",
      },
      {
        label: "Puerto cerrado",
        detail:
          "nc HOST 81 devuelve un RST inmediato, sin handshake ni timeout.",
      },
    ],
    exercises: [
      { id: "tcp-handshake", title: "Handshake TCP paso a paso" },
      { id: "tcp-retransmission", title: "Retransmisión con pérdida" },
      { id: "tcp-zero-window", title: "Ventana TCP observable" },
      { id: "tcp-congestion", title: "Cuello de botella y throughput" },
      { id: "tcp-closed-port", title: "Puerto cerrado" },
    ],
  },
  {
    anchor: "dns-dhcp",
    title: "DNS y DHCP",
    summary:
      "Los servicios de red son los que hacen que la red sirva para algo, y fallan de formas que no se parecen a un cable cortado: DNS es un protocolo de pregunta/respuesta sobre UDP/53 (con nombres comprimidos por punteros y reintentos que se agotan en silencio), DHCP reparte direcciones en cuatro mensajes —Discover, Offer, Request, ACK— con un pool finito y leases que expiran y se renuevan a T1 y T2, y HTTP viaja sobre TCP a un puerto concreto que no tiene por qué ser el 80. Diagnosticar es separar las capas: ¿hay dirección? ¿hay ruta? ¿resuelve el nombre? ¿escucha el servicio en ese puerto?",
    concepts: [
      {
        label: "Consulta y respuesta DNS",
        detail:
          "dig [@SERVER] NAME [A] en la consola del host; sin resolver configurado los intentos se agotan.",
      },
      {
        label: "Nombres comprimidos",
        detail:
          "El codec DNS acepta y emite punteros 0xc0 a nombres ya escritos (RFC 1035 §4.1.4).",
      },
      {
        label: "DHCP DORA y lease",
        detail:
          "dhclient [IFACE]: Discover, Offer, Request y ACK; el servidor recuerda un lease por MAC.",
      },
      {
        label: "Pool agotado",
        detail:
          "Sin direcciones libres el cliente reintenta en vez de recibir un ACK.",
      },
      {
        label: "Renovación y expiración",
        detail:
          "Al 50% y 87,5% del lease el cliente renueva o hace rebind; al vencer vuelve a descubrir.",
      },
      {
        label: "Servicio en puerto no estándar",
        detail:
          "http-server [PORT] y curl http://HOST:PORT/: el 80 puede estar cerrado mientras el 8080 responde.",
      },
      {
        label: "Servicio vivo, nombre muerto",
        detail:
          "curl con IP literal funciona mientras dig falla: el problema es el resolver.",
      },
    ],
    exercises: [
      { id: "svc-dns-broken", title: "DNS roto, servicio vivo" },
      { id: "svc-dhcp-exhausted", title: "DHCP agotado: dirección estática" },
      { id: "svc-http-port", title: "HTTP en un puerto no estándar" },
    ],
  },
];

/** Todos los ejercicios de la página, en el orden en que se listan. */
export const TEORIA_EXERCISES: readonly TeoriaExercise[] =
  TEORIA_SECTIONS.flatMap((section) => section.exercises);

/** Anclar una sección de la teoría (para el índice y para la landing). */
export function teoriaAnchor(anchor: string): string {
  return `#${anchor}`;
}
