import { describe, expect, test } from "bun:test";
import {
  EDITOR_HELP_SHORTCUTS,
  EDITOR_HELP_STEPS,
  HELP_MESSAGES,
  hasHelpTour,
  hasInlineGuide,
  helpNextLabel,
  helpProgressLabel,
  helpStepAt,
  nextHelpStep,
  previousHelpStep,
  SCREEN_HELP,
  VALIDATION_FLOW,
  WORKBENCH_HELP_SHORTCUTS,
  WORKBENCH_LEGEND,
} from "../src/lib/help";
import {
  clampStepIndex,
  nextStepIndex,
  previousStepIndex,
  stepAt,
  stepPrimaryLabel,
  stepProgressLabel,
} from "../src/lib/tutorial";

/** S2: ni ids de ejercicios, ni redes de referencia, ni respuestas. */
const SPOILER_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "tag de feature/ejercicio", pattern: /\bF-\d+\b/ },
  { name: "nivel de ruta", pattern: /\bN[1-9]\b/ },
  { name: "IPv4 literal", pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  { name: "prefijo CIDR", pattern: /\/\d{1,2}\b/ },
  { name: "MAC literal", pattern: /\b[0-9a-f]{2}(:[0-9a-f]{2}){5}\b/i },
  { name: "solución o respuesta", pattern: /soluci[oó]n|respuesta|correcta/i },
];

function helpTexts(): string[] {
  const texts: string[] = Object.values(HELP_MESSAGES);
  for (const step of EDITOR_HELP_STEPS) {
    texts.push(step.id, step.title, step.line, step.action);
  }
  for (const step of VALIDATION_FLOW) {
    texts.push(step.id, step.title, step.line);
  }
  for (const item of WORKBENCH_LEGEND) {
    texts.push(item.id, item.label, item.what);
  }
  for (const group of [...EDITOR_HELP_SHORTCUTS, ...WORKBENCH_HELP_SHORTCUTS]) {
    texts.push(group.title);
    for (const shortcut of group.shortcuts) {
      texts.push(shortcut.keys, shortcut.what);
    }
  }
  return texts;
}

describe("tour de ayuda del editor (A1)", () => {
  test("los cuatro pasos siguen el orden de uso: paleta → lienzo → propiedades → export", () => {
    expect(EDITOR_HELP_STEPS).toHaveLength(4);
    expect(EDITOR_HELP_STEPS.map((step) => step.id)).toEqual([
      "palette",
      "canvas",
      "properties",
      "export",
    ]);
    expect(EDITOR_HELP_STEPS.map((step) => step.anchor)).toEqual([
      "palette",
      "canvas",
      "properties",
      "export",
    ]);
  });

  test("cada paso trae título, línea y acción no vacíos", () => {
    for (const step of EDITOR_HELP_STEPS) {
      expect(step.title.trim(), step.id).not.toBe("");
      expect(step.line.trim(), step.id).not.toBe("");
      expect(step.action.trim(), step.id).not.toBe("");
    }
  });

  test("los ids no se repiten", () => {
    const ids = new Set(EDITOR_HELP_STEPS.map((step) => step.id));
    expect(ids.size).toBe(EDITOR_HELP_STEPS.length);
  });

  test("el paso va clampeado al rango real del tour", () => {
    expect(helpStepAt(0).id).toBe("palette");
    expect(helpStepAt(3).id).toBe("export");
    expect(helpStepAt(99).id).toBe("export");
    expect(helpStepAt(-7).id).toBe("palette");
    expect(helpStepAt(Number.NaN).id).toBe("palette");
  });

  test("el progreso y el botón primario se etiquetan en español", () => {
    expect(helpProgressLabel(0)).toBe("Paso 1 de 4");
    expect(helpProgressLabel(3)).toBe("Paso 4 de 4");
    expect(helpProgressLabel(99)).toBe("Paso 4 de 4");
    expect(helpNextLabel(0)).toBe(HELP_MESSAGES.next);
    expect(helpNextLabel(2)).toBe(HELP_MESSAGES.next);
    expect(helpNextLabel(3)).toBe(HELP_MESSAGES.finish);
  });

  test("next y previous no se salen del tour", () => {
    expect(previousHelpStep(0)).toBe(0);
    expect(nextHelpStep(0)).toBe(1);
    expect(nextHelpStep(3)).toBe(3);
  });

  test("los botones y títulos del diálogo tienen texto", () => {
    for (const [name, message] of Object.entries(HELP_MESSAGES)) {
      expect(message.trim(), name).not.toBe("");
    }
    expect(HELP_MESSAGES.dialogLabel).toBe("Ayuda del editor");
    expect(HELP_MESSAGES.openTitle).not.toBe(HELP_MESSAGES.open);
  });
});

describe("atajos de teclado documentados", () => {
  test("los atajos del editor cubren lo que el canvas implementa", () => {
    const keys = EDITOR_HELP_SHORTCUTS.flatMap((group) =>
      group.shortcuts.map((shortcut) => shortcut.keys),
    );
    for (const expected of [
      "Ctrl+Z",
      "Ctrl+Shift+Z · Ctrl+Y",
      "Ctrl+C",
      "Ctrl+V",
      "Flechas",
      "Shift+Flechas",
      "Esc",
      "+ · =",
      "−",
      "0",
      "Rueda",
    ]) {
      expect(keys, expected).toContain(expected);
    }
  });

  test("los atajos de replay son Espacio, ← y →", () => {
    const shortcuts = WORKBENCH_HELP_SHORTCUTS.flatMap(
      (group) => group.shortcuts,
    );
    expect(shortcuts.map((shortcut) => shortcut.keys)).toEqual([
      "Espacio",
      "←",
      "→",
    ]);
  });

  test("ningún grupo está vacío y cada atajo tiene tecla y explicación", () => {
    for (const group of [
      ...EDITOR_HELP_SHORTCUTS,
      ...WORKBENCH_HELP_SHORTCUTS,
    ]) {
      expect(group.title.trim()).not.toBe("");
      expect(group.shortcuts.length).toBeGreaterThan(0);
      for (const shortcut of group.shortcuts) {
        expect(shortcut.keys.trim(), group.title).not.toBe("");
        expect(shortcut.what.trim(), shortcut.keys).not.toBe("");
      }
    }
  });

  test("una misma combinación no se documenta dos veces", () => {
    const keys = EDITOR_HELP_SHORTCUTS.flatMap((group) =>
      group.shortcuts.map((shortcut) => shortcut.keys),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("guía del workbench (A2)", () => {
  test("la leyenda explica tx, rx, drop y el vuelo descartado", () => {
    expect(WORKBENCH_LEGEND.map((item) => item.id)).toEqual([
      "tx",
      "rx",
      "drop",
      "dropped",
    ]);
    for (const item of WORKBENCH_LEGEND) {
      expect(item.label.trim(), item.id).not.toBe("");
      expect(item.what.trim(), item.id).not.toBe("");
    }
  });

  test("el flujo de validación va armar → exportar → subir", () => {
    expect(VALIDATION_FLOW).toHaveLength(3);
    expect(VALIDATION_FLOW.map((step) => step.id)).toEqual([
      "build",
      "export",
      "validate",
    ]);
    for (const step of VALIDATION_FLOW) {
      expect(step.title.trim(), step.id).not.toBe("");
      expect(step.line.trim(), step.id).not.toBe("");
    }
  });
});

describe("visibilidad de la ayuda por pantalla", () => {
  test("el editor tiene tour y no necesita guía inline", () => {
    expect(hasHelpTour("editor")).toBe(true);
    expect(hasInlineGuide("editor")).toBe(false);
  });

  test("práctica no tiene tour, así que su guía va inline", () => {
    expect(hasHelpTour("practica")).toBe(false);
    expect(hasInlineGuide("practica")).toBe(true);
  });

  test("el workbench tiene tour de bienvenida y guía inline", () => {
    expect(hasHelpTour("workbench")).toBe(true);
    expect(hasInlineGuide("workbench")).toBe(true);
  });

  test("toda pantalla ofrece al menos una superficie de ayuda", () => {
    for (const [screen, help] of Object.entries(SCREEN_HELP)) {
      expect(help.tour || help.inlineGuide, screen).toBe(true);
    }
    expect(Object.keys(SCREEN_HELP)).toEqual([
      "workbench",
      "editor",
      "practica",
    ]);
  });
});

describe("S2: la ayuda enseña la herramienta, no la respuesta", () => {
  test("ningún texto nuevo menciona ids, redes, soluciones ni valores esperados", () => {
    const texts = helpTexts();
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      for (const { name, pattern } of SPOILER_PATTERNS) {
        expect(pattern.test(text), `${name} en: ${text}`).toBe(false);
      }
    }
  });
});

describe("navegación de pasos compartida con el tutorial", () => {
  test("el clamp es el mismo para cualquier cantidad de pasos", () => {
    expect(clampStepIndex(-3, 4)).toBe(0);
    expect(clampStepIndex(1.7, 4)).toBe(1);
    expect(clampStepIndex(9, 4)).toBe(3);
    expect(clampStepIndex(Number.POSITIVE_INFINITY, 4)).toBe(0);
    expect(nextStepIndex(3, 4)).toBe(3);
    expect(previousStepIndex(0, 4)).toBe(0);
    expect(stepProgressLabel(2, 4)).toBe("Paso 3 de 4");
    expect(stepPrimaryLabel(3, 4, { next: "Seguir", finish: "Final" })).toBe(
      "Final",
    );
    expect(stepPrimaryLabel(0, 4, { next: "Seguir", finish: "Final" })).toBe(
      "Seguir",
    );
    expect(stepAt(["a", "b"], 5)).toBe("b");
  });
});
