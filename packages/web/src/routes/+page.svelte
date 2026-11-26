<script lang="ts">
import { asset, resolve } from "$app/paths";
import {
  LANDING_CARDS,
  LANDING_HERO,
  LANDING_STEPS,
  LANDING_THEORY,
  LANDING_THEORY_NOTE,
} from "../lib/landing";
</script>

<svelte:head>
  <title>NetLab — laboratorio de redes con stack propio</title>
  <meta name="description" content={LANDING_HERO.metaDescription} />
</svelte:head>

<div class="shell">
  <a class="skip" href="#modos">Saltar a los modos</a>
  <header class="top">
    <div class="logo">Net<b>Lab</b></div>
    <div class="scen mono">stack TCP/IP propio · motor determinista</div>
    <div class="sp"></div>
    <a class="navlink" href={resolve("/workbench")}>Workbench →</a>
    <a class="navlink" href={resolve("/editor")}>Editor →</a>
    <a class="navlink" href={resolve("/teoria")}>Teoría →</a>
    <a class="navlink" href={resolve("/practica")}>Práctica →</a>
  </header>

  <main class="landing">
    <section class="hero" aria-labelledby="hero-title">
      <img
        class="hero-logo"
        src={asset("logo.webp")}
        alt="Logo de NetLab"
        width="84"
        height="84"
      />
      <p class="eyebrow mono">{LANDING_HERO.eyebrow}</p>
      <h1 id="hero-title">{LANDING_HERO.title}</h1>
      <p class="lede">{LANDING_HERO.lede}</p>
      <p class="note">{LANDING_HERO.note}</p>
      <p class="actions">
        <a class="cta" href={resolve("/workbench")}>Empezar por el workbench</a>
        <a class="ghost" href={resolve("/practica")}>Ver ejercicios</a>
      </p>
    </section>

    <section id="modos" class="modes" aria-labelledby="modos-title">
      <h2 id="modos-title">Tres modos, un mismo motor</h2>
      <ul class="cards">
        {#each LANDING_CARDS as card (card.id)}
          <li class="card">
            <p class="kicker mono">{card.kicker}</p>
            <h3>{card.title}</h3>
            <p class="card-line">{card.line}</p>
            <a class="card-cta" href={resolve(card.href)}>{card.cta} →</a>
          </li>
        {/each}
      </ul>
    </section>

    <section class="start" aria-labelledby="start-title">
      <h2 id="start-title">Cómo empezar</h2>
      <ol class="steps">
        {#each LANDING_STEPS as step (step.n)}
          <li class="step">
            <span class="num mono" aria-hidden="true">{step.n}</span>
            <h3>{step.title}</h3>
            <p>{step.line}</p>
          </li>
        {/each}
      </ol>
    </section>

    <section class="theory" aria-labelledby="theory-title">
      <h2 id="theory-title">Teoría por protocolo</h2>
      <p class="theory-note">{LANDING_THEORY_NOTE}</p>
      <ul class="theory-list">
        {#each LANDING_THEORY as item (item.id)}
          <li>
            <b>{item.protocol}</b>
            <p>{item.line}</p>
            <a class="theory-link" href={resolve(item.href) + "#" + item.anchor}>
              Leer →
            </a>
          </li>
        {/each}
      </ul>
    </section>
  </main>

  <footer class="foot mono">
    NetLab · misma semilla, mismos paquetes · simulación en el navegador
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

  .mono {
    font-family: var(--mono);
  }

  .shell {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }

  /* Mismo skip-link que el workbench, sin animación: aparece al enfocar. */
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

  .landing {
    width: 100%;
    max-width: 1080px;
    margin: 0 auto;
    padding: 40px 18px 64px;
    display: flex;
    flex-direction: column;
    gap: 48px;
  }

  .hero {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 76ch;
  }

  .hero-logo {
    width: 84px;
    height: auto;
    border-radius: 18px;
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

  .actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin: 6px 0 0;
  }

  .cta,
  .ghost {
    text-decoration: none;
    padding: 9px 16px;
    border: 1px solid var(--line);
    font-size: 13.5px;
    white-space: nowrap;
  }

  .cta {
    background: var(--acc);
    border-color: var(--acc);
    color: #0b0b0d;
    font-weight: 700;
  }

  .ghost {
    background: var(--panel2);
    color: var(--ink);
  }

  .ghost:hover,
  .cta:hover {
    border-color: var(--ink);
  }

  .modes h2,
  .start h2,
  .theory h2 {
    font: 700 22px var(--disp);
    letter-spacing: 0.4px;
    text-transform: uppercase;
    margin: 0 0 14px;
  }

  .cards {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 14px;
    margin: 0;
    padding: 0;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
    border: 1px solid var(--line);
    background: var(--panel);
  }

  .card:hover {
    border-color: var(--acc);
  }

  .kicker {
    margin: 0;
    color: var(--mut);
    font-size: 10.5px;
    letter-spacing: 0.6px;
    text-transform: uppercase;
  }

  .card h3 {
    margin: 0;
    font: 700 20px var(--disp);
    letter-spacing: 0.4px;
  }

  .card-line {
    margin: 0;
    color: var(--mut);
    line-height: 1.5;
    flex: 1;
  }

  .card-cta {
    align-self: flex-start;
    color: var(--ink);
    text-decoration: none;
    border: 1px solid var(--line);
    background: var(--panel2);
    padding: 6px 12px;
    font-size: 12.5px;
    white-space: nowrap;
  }

  .card-cta:hover {
    border-color: var(--acc);
    color: var(--acc);
  }

  .steps {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 14px;
    margin: 0;
    padding: 0;
  }

  .step {
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-areas:
      "num title"
      "num line";
    column-gap: 12px;
    row-gap: 6px;
    align-content: start;
  }

  .num {
    grid-area: num;
    color: var(--acc);
    font-size: 26px;
    line-height: 1;
    font-weight: 700;
  }

  .step h3 {
    grid-area: title;
    margin: 0;
    font-size: 15px;
  }

  .step p {
    grid-area: line;
    margin: 0;
    color: var(--mut);
    line-height: 1.5;
  }

  .theory-note {
    margin: 0 0 12px;
    color: var(--mut);
    max-width: 72ch;
    line-height: 1.5;
  }

  .theory-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    border: 1px solid var(--line);
    background: var(--line);
  }

  .theory-list li {
    display: grid;
    grid-template-columns: minmax(140px, 200px) 1fr auto;
    gap: 12px;
    align-items: baseline;
    padding: 10px 14px;
    background: var(--panel);
  }

  .theory-list b {
    font-size: 13px;
  }

  .theory-list p {
    margin: 0;
    color: var(--mut);
    line-height: 1.5;
  }

  .theory-link {
    color: var(--ink);
    text-decoration: none;
    border-bottom: 1px solid var(--line);
    font-size: 12.5px;
    white-space: nowrap;
  }

  .theory-link:hover {
    color: var(--acc);
    border-color: var(--acc);
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

    .theory-list li {
      grid-template-columns: 1fr;
    }
  }
</style>
