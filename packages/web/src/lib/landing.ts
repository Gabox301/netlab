/**
 * Datos puros de la entrada (`/`): qué es NetLab, los tres modos y el camino
 * de arranque.
 *
 * La página solo renderiza: acá no hay Svelte ni `resolve()`, así que el
 * orden de las cards, los copys y los destinos se pueden pinear sin build.
 * El destino de cada card es una ruta interna literal; la página la pasa por
 * `resolve()` para que el prefijo (`base`) se anteponga en runtime.
 */

/** Ruta interna a la que apunta una card de la landing. */
export type LandingHref = "/workbench" | "/editor" | "/practica";

/** Ruta de la teoría en el sitio; las cards no la usan, la lista sí. */
export type LandingTheoryHref = "/teoria";

export interface LandingHero {
  eyebrow: string;
  title: string;
  lede: string;
  note: string;
  metaDescription: string;
}

export interface LandingCard {
  /** Slug estable: sirve de `key` en el render y de clase. */
  id: string;
  kicker: string;
  title: string;
  line: string;
  href: LandingHref;
  cta: string;
}

export interface LandingStep {
  /** Número humano del paso: 1, 2, 3. */
  n: string;
  title: string;
  line: string;
}

export interface LandingTheory {
  id: string;
  protocol: string;
  line: string;
  /** Ancla de la sección en `/teoria` (`#capa-2-arp`, …). */
  anchor: string;
  /** Destino del link: la página de teoría, nunca el `.md` del repo. */
  href: LandingTheoryHref;
  /**
   * Doc del repo que origina la sección. Es procedencia, no destino: la
   * landing no lo renderiza ni lo enlaza, el contenido se lee en `/teoria`.
   */
  doc: string;
}

/** Prefijo de los docs de teoría en el repo (solo procedencia). */
export const LANDING_THEORY_ROOT = "docs/teoria/";

/** La teoría se lee en el sitio: la landing enlaza la página, no los `.md`. */
export const LANDING_THEORY_NOTE =
  "La teoría está en el sitio, en /teoria: cuatro secciones con el párrafo de cada protocolo, sus conceptos observables y los ejercicios para practicarla.";

export const LANDING_HERO: LandingHero = {
  eyebrow: "Laboratorio de redes · corre entero en el navegador",
  title: "El tema antes de los clicks",
  lede: "NetLab es un laboratorio de redes con stack TCP/IP propio (Ethernet, ARP, IPv4, ICMP, UDP, DNS, DHCP y TCP) y un motor de simulación determinista: mismo escenario y misma semilla, mismos paquetes, siempre.",
  note: "No hay servidor ni atajos pintados a mano: la simulación corre en un Web Worker, el reloj es virtual y cada trama que ves salió de un codec real.",
  metaDescription:
    "NetLab: laboratorio de redes con stack TCP/IP propio y motor determinista con semilla. Workbench, editor de topologías y ejercicios.",
};

/**
 * Los tres modos, en el orden en que se presentan: mirar (workbench), armar
 * (editor) y practicar (práctica).
 */
export const LANDING_CARDS: readonly LandingCard[] = [
  {
    id: "workbench",
    kicker: "Mirar",
    title: "Workbench",
    line: "Una topología de dos subredes con tramas reales en el cable: lista de paquetes con timeline, inspector capa por capa y consola por host.",
    href: "/workbench",
    cta: "Abrir el workbench",
  },
  {
    id: "editor",
    kicker: "Armar",
    title: "Editor",
    line: "Hosts, switches y routers en un lienzo: interfaces, IPs, máscaras y gateway sobre el nodo, con autosave local y export del escenario JSON.",
    href: "/editor",
    cta: "Abrir el editor",
  },
  {
    id: "practica",
    kicker: "Practicar",
    title: "Práctica",
    line: "Cuatro rutas y 25 ejercicios que se validan en el navegador con el mismo motor que la CLI, más el entrenador de subnetting.",
    href: "/practica",
    cta: "Ir a práctica",
  },
];

/** Camino de entrada: qué hacer en la primera sesión, en tres pasos. */
export const LANDING_STEPS: readonly LandingStep[] = [
  {
    n: "1",
    title: "Corré el escenario de ejemplo",
    line: "El workbench abre con el escenario de dos subredes ya simulado: ▶ Run lo repite desde t = 0 y ⏮ / ⏭ recorren las tramas una por una.",
  },
  {
    n: "2",
    title: "Leé una trama capa por capa",
    line: "Elegí un paquete de la lista: el inspector muestra los mismos bytes que ves en el hexdump y la consola del host de origen.",
  },
  {
    n: "3",
    title: "Armá y resolvé lo tuyo",
    line: "Pasá al editor para dibujar una topología propia y después a práctica para validar soluciones contra el motor.",
  },
];

/**
 * Teoría por protocolo, en el orden de las capas. Cada entrada enlaza su
 * ancla en `/teoria`; el `doc` queda como procedencia del contenido.
 */
export const LANDING_THEORY: readonly LandingTheory[] = [
  {
    id: "capa-2-arp",
    protocol: "Capa 2 y ARP",
    line: "Tramas, MAC y cómo se resuelve un destino dentro del mismo segmento.",
    anchor: "capa-2-arp",
    href: "/teoria",
    doc: "docs/teoria/capa-2-arp.md",
  },
  {
    id: "ipv4-icmp",
    protocol: "IPv4 e ICMP",
    line: "Direccionamiento, máscara, routing entre subredes y el eco que viaja y vuelve.",
    anchor: "ipv4-icmp",
    href: "/teoria",
    doc: "docs/teoria/ipv4-icmp.md",
  },
  {
    id: "tcp",
    protocol: "TCP",
    line: "Handshake, ventana y retransmisión sobre el mismo cable que el resto.",
    anchor: "tcp",
    href: "/teoria",
    doc: "docs/teoria/tcp.md",
  },
  {
    id: "dns-dhcp",
    protocol: "DNS y DHCP",
    line: "Cómo un host consigue su IP y cómo se traduce un nombre antes del primer byte útil.",
    anchor: "dns-dhcp",
    href: "/teoria",
    doc: "docs/teoria/dns-dhcp.md",
  },
];
