<script lang="ts">
import { resolve } from "$app/paths";
import { TEORIA_HERO, TEORIA_SECTIONS, teoriaAnchor } from "../../lib/teoria";
</script>

<svelte:head>
  <title>Teoría por protocolo — NetLab</title>
  <meta name="description" content={TEORIA_HERO.metaDescription} />
</svelte:head>

<div class="shell">
  <a class="skip" href="#indice">Saltar al índice</a>
  <header class="top">
    <div class="logo">Net<b>Lab</b></div>
    <div class="scen mono">teoría · cuatro protocolos, el mismo motor</div>
    <div class="sp"></div>
    <a class="navlink" href={resolve("/")}>← Inicio</a>
    <a class="navlink" href={resolve("/workbench")}>Workbench →</a>
    <a class="navlink" href={resolve("/practica")}>Práctica →</a>
  </header>

  <main class="teoria">
    <section class="hero" aria-labelledby="hero-title">
      <p class="eyebrow mono">{TEORIA_HERO.eyebrow}</p>
      <h1 id="hero-title">{TEORIA_HERO.title}</h1>
      <p class="lede">{TEORIA_HERO.lede}</p>
      <p class="note">{TEORIA_HERO.note}</p>
    </section>

    <nav id="indice" class="index" aria-labelledby="indice-title">
      <h2 id="indice-title">Índice</h2>
      <ol class="index-list">
        {#each TEORIA_SECTIONS as section, i (section.anchor)}
          <li>
            <a href={teoriaAnchor(section.anchor)}>
              <span class="num mono" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span class="index-title">{section.title}</span>
            </a>
            <span class="index-meta mono">
              {section.concepts.length} conceptos · {section.exercises.length}
              ejercicios
            </span>
          </li>
        {/each}
      </ol>
    </nav>

    {#each TEORIA_SECTIONS as section, i (section.anchor)}
      <section
        id={section.anchor}
        class="sec"
        aria-labelledby={`${section.anchor}-title`}
      >
        <h2 id={`${section.anchor}-title`}>
          <span class="num mono" aria-hidden="true">
            {String(i + 1).padStart(2, "0")}
          </span>
          {section.title}
        </h2>
        <p class="prose">{section.summary}</p>

        <h3>Conceptos observables</h3>
        <dl class="concepts">
          {#each section.concepts as concept (concept.label)}
            <div class="concept">
              <dt>{concept.label}</dt>
              <dd>{concept.detail}</dd>
            </div>
          {/each}
        </dl>

        <h3>Ejercicios</h3>
        <ul class="exercises">
          {#each section.exercises as exercise (exercise.id)}
            <li>
              <a href={resolve("/practica")}>{exercise.title}</a>
              <code>{exercise.id}</code>
            </li>
          {/each}
        </ul>
      </section>
    {/each}

    <p class="back">
      <a href={resolve("/")}>← Volver a la entrada</a>
      <a href={resolve("/practica")}>Ir a práctica →</a>
    </p>
  </main>

  <footer class="foot mono">
    NetLab · misma semilla, mismos paquetes · teoría, workbench y práctica
  </footer>
</div>

<style>
  :global(:root) {
    --bg: #0b0b0d;
    --panel: #131316;
    --panel2: #1b1b20;
    --line: #34343c;
    --ink: #ffffff;
    --mut: #b4b4be;
    --dim: #80808c;
    --acc: #ff4d3d;
    --ok: #4dff9a;
    --warn: #ffd23d;
    --bad: #ff4d3d;
    --code: #050506;
    --disp: Impact, "Arial Narrow", "Arial Narrow Bold", sans-serif;
    --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  }

  :global(*) {
    box-sizing: border-box;
  }

  :global(html),
  :global(body) {
    margin: 0;
  }

  :global(body) {
    background: var(--bg);
    color: var(--ink);
    font:
      14px -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      Roboto,
      Helvetica,
      Arial,
      sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  :global(:focus-visible) {
    outline: 2px solid var(--acc);
    outline-offset: 2px;
  }

  :global(a) {
    color: var(--acc);
  }

  code,
  .mono {
    font-family: var(--mono);
  }

  code {
    color: var(--warn);
    font-size: 0.92em;
  }

  .shell {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }

  /* Mismo skip-link que la landing y el workbench, sin animación. */
  .skip {
    position: absolute;
    left: 0.5rem;
    top: -3rem;
    z-index: 50;
    background: #16161a;
    color: #f2f2f5;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--acc);
    border-radius: 0.375rem;
  }

  .skip:focus-visible {
    top: 0.5rem;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    min-height: 52px;
    padding: 6px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }

  .logo {
    font: 700 19px var(--disp);
    letter-spacing: 0.4px;
  }

  .logo b {
    color: var(--acc);
  }

  .scen {
    color: var(--mut);
    font-size: 12.5px;
  }

  .sp {
    flex: 1;
  }

  .navlink {
    color: var(--ink);
    text-decoration: none;
    border: 1px solid var(--line);
    background: var(--panel2);
    padding: 7px 13px;
    font-size: 13px;
    white-space: nowrap;
  }

  .navlink:hover {
    border-color: var(--acc);
  }

  .teoria {
    width: 100%;
    max-width: 1080px;
    margin: 0 auto;
    padding: 40px 18px 64px;
    display: flex;
    flex-direction: column;
    gap: 40px;
  }

  .hero {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 76ch;
  }

  .eyebrow {
    margin: 0;
    color: var(--acc);
    font-size: 11.5px;
    letter-spacing: 0.6px;
    text-transform: uppercase;
  }

  .hero h1 {
    font: 700 46px var(--disp);
    letter-spacing: 0.5px;
    line-height: 1.05;
    margin: 0;
    text-transform: uppercase;
  }

  .lede {
    margin: 0;
    color: var(--ink);
    font-size: 16px;
    line-height: 1.55;
    max-width: 72ch;
  }

  .note {
    margin: 0;
    color: var(--mut);
    line-height: 1.55;
    max-width: 72ch;
  }

  .index h2,
  .sec h2,
  .sec h3 {
    font: 700 22px var(--disp);
    letter-spacing: 0.4px;
    text-transform: uppercase;
    margin: 0 0 14px;
  }

  .sec h3 {
    font-size: 14px;
    color: var(--mut);
    margin: 22px 0 10px;
  }

  .index-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    border: 1px solid var(--line);
    background: var(--line);
  }

  .index-list li {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px 14px;
    background: var(--panel);
  }

  .index-list li:hover {
    background: var(--panel2);
  }

  .index-list a {
    display: flex;
    align-items: baseline;
    gap: 12px;
    color: var(--ink);
    text-decoration: none;
  }

  .index-list a:hover .index-title {
    color: var(--acc);
  }

  .index-meta {
    margin-left: auto;
    color: var(--mut);
    font-size: 11.5px;
  }

  .num {
    color: var(--acc);
    font-size: 15px;
    font-weight: 700;
  }

  .sec {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--line);
    padding-top: 26px;
    scroll-margin-top: 12px;
  }

  .sec h2 {
    display: flex;
    gap: 12px;
    align-items: baseline;
    font-size: 26px;
    margin-bottom: 12px;
  }

  .sec h2 .num {
    font-size: 18px;
  }

  .prose {
    margin: 0;
    color: var(--ink);
    line-height: 1.6;
    max-width: 76ch;
  }

  .concepts {
    margin: 0;
    border: 1px solid var(--line);
    background: var(--line);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .concept {
    display: grid;
    grid-template-columns: minmax(160px, 240px) 1fr;
    gap: 12px;
    align-items: baseline;
    padding: 10px 14px;
    background: var(--panel);
  }

  .concept dt {
    font-size: 13px;
    font-weight: 600;
  }

  .concept dd {
    margin: 0;
    color: var(--mut);
    line-height: 1.5;
  }

  .exercises {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    border: 1px solid var(--line);
    background: var(--line);
  }

  .exercises li {
    display: flex;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
    padding: 9px 14px;
    background: var(--panel);
  }

  .exercises a {
    color: var(--ink);
    text-decoration: none;
    border-bottom: 1px solid var(--line);
  }

  .exercises a:hover {
    color: var(--acc);
    border-color: var(--acc);
  }

  .exercises code {
    color: var(--dim);
    font-size: 11.5px;
  }

  .back {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    margin: 0;
    padding-top: 18px;
    border-top: 1px solid var(--line);
    font-size: 13px;
  }

  .back a {
    color: var(--ink);
    text-decoration: none;
  }

  .back a:hover {
    color: var(--acc);
  }

  .foot {
    margin-top: auto;
    padding: 14px 18px;
    border-top: 1px solid var(--line);
    background: var(--panel);
    color: var(--dim);
    font-size: 11.5px;
    text-align: center;
  }

  @media (max-width: 720px) {
    .hero h1 {
      font-size: 34px;
    }

    .index-meta {
      margin-left: 0;
    }

    .concept {
      grid-template-columns: 1fr;
    }
  }
</style>
