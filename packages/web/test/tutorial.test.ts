import { describe, expect, test } from "bun:test";
import {
  nextTutorialStep,
  parseTutorialState,
  previousTutorialStep,
  readTutorialValue,
  saveTutorialStatus,
  serializeTutorialState,
  shouldShowTutorial,
  TUTORIAL_MESSAGES,
  TUTORIAL_STEPS,
  TUTORIAL_STORAGE_KEY,
  type TutorialStorage,
  tutorialNextLabel,
  tutorialProgressLabel,
  tutorialState,
  tutorialStepAt,
} from "../src/lib/tutorial";

function memoryStorage(initial: Record<string, string> = {}): {
  storage: TutorialStorage;
  writes: Array<{ key: string; value: string }>;
} {
  const data = new Map(Object.entries(initial));
  const writes: Array<{ key: string; value: string }> = [];
  return {
    storage: {
      getItem(key: string): string | null {
        return data.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        writes.push({ key, value });
        data.set(key, value);
      },
    },
    writes,
  };
}

describe("pasos del tutorial de bienvenida (Fase 8 T3)", () => {
  test("los tres pasos siguen el golden path Run → frame → scrub", () => {
    expect(TUTORIAL_STEPS).toHaveLength(3);
    expect(TUTORIAL_STEPS.map((step) => step.id)).toEqual([
      "run",
      "frame",
      "scrub",
    ]);
    expect(TUTORIAL_STEPS.map((step) => step.anchor)).toEqual([
      "run",
      "packets",
      "timeline",
    ]);
  });

  test("cada paso trae título, línea y acción no vacíos", () => {
    for (const step of TUTORIAL_STEPS) {
      expect(step.title.trim(), step.id).not.toBe("");
      expect(step.line.trim(), step.id).not.toBe("");
      expect(step.action.trim(), step.id).not.toBe("");
    }
  });

  test("los ids no se repiten", () => {
    const ids = new Set(TUTORIAL_STEPS.map((step) => step.id));
    expect(ids.size).toBe(TUTORIAL_STEPS.length);
  });

  test("la clave de storage es la versionada", () => {
    expect(TUTORIAL_STORAGE_KEY).toBe("netlab.tutorial.v1");
  });
});

describe("primera visita persistida", () => {
  test("sin valor guardado el tutorial se muestra", () => {
    expect(shouldShowTutorial(null)).toBe(true);
  });

  test("visto o completado ya no se muestran solos", () => {
    expect(shouldShowTutorial(JSON.stringify(tutorialState("seen")))).toBe(
      false,
    );
    expect(shouldShowTutorial(JSON.stringify(tutorialState("completed")))).toBe(
      false,
    );
  });

  test("vacío, basura u otra versión cuentan como primera visita", () => {
    for (const value of [
      "",
      "   ",
      "{nope",
      "null",
      "[]",
      JSON.stringify({ version: 2, status: "seen" }),
      JSON.stringify({ version: 1, status: "skipped" }),
      JSON.stringify({ version: 1 }),
    ]) {
      expect(shouldShowTutorial(value), value).toBe(true);
    }
  });

  test("parseTutorialState solo acepta seen y completed", () => {
    expect(parseTutorialState(JSON.stringify(tutorialState("seen")))).toEqual({
      version: 1,
      status: "seen",
    });
    expect(
      parseTutorialState(JSON.stringify(tutorialState("completed"))),
    ).toEqual({ version: 1, status: "completed" });
    expect(parseTutorialState(null)).toBeNull();
    expect(parseTutorialState("no-json")).toBeNull();
  });

  test("round-trip de storage y escritura bajo la clave versionada", () => {
    const { storage, writes } = memoryStorage();
    expect(readTutorialValue(storage)).toBeNull();

    saveTutorialStatus("seen", storage);
    expect(readTutorialValue(storage)).toBe(
      serializeTutorialState(tutorialState("seen")),
    );

    saveTutorialStatus("completed", storage);
    expect(parseTutorialState(readTutorialValue(storage))?.status).toBe(
      "completed",
    );
    expect(writes.length).toBe(2);
    for (const write of writes) {
      expect(write.key).toBe(TUTORIAL_STORAGE_KEY);
    }
  });

  test("storage ausente o que falla no rompe la página", () => {
    expect(readTutorialValue(null)).toBeNull();
    expect(() => saveTutorialStatus("seen", null)).not.toThrow();

    const broken: TutorialStorage = {
      getItem(): string | null {
        throw new Error("modo privado");
      },
      setItem(): void {
        throw new Error("cuota llena");
      },
    };
    expect(readTutorialValue(broken)).toBeNull();
    expect(() => saveTutorialStatus("seen", broken)).not.toThrow();
  });
});

describe("copia y navegación del overlay", () => {
  test("todos los mensajes tienen texto", () => {
    for (const [name, message] of Object.entries(TUTORIAL_MESSAGES)) {
      expect(message.trim(), name).not.toBe("");
    }
  });

  test("el progreso se etiqueta Paso N de M", () => {
    expect(tutorialProgressLabel(0)).toBe("Paso 1 de 3");
    expect(tutorialProgressLabel(2)).toBe("Paso 3 de 3");
    expect(tutorialProgressLabel(99)).toBe("Paso 3 de 3");
    expect(tutorialProgressLabel(-1)).toBe("Paso 1 de 3");
  });

  test("el botón primario avanza y cierra en el último paso", () => {
    expect(tutorialNextLabel(0)).toBe(TUTORIAL_MESSAGES.next);
    expect(tutorialNextLabel(1)).toBe(TUTORIAL_MESSAGES.next);
    expect(tutorialNextLabel(2)).toBe(TUTORIAL_MESSAGES.finish);
  });

  test("next y previous quedan clampeados al rango real", () => {
    expect(previousTutorialStep(0)).toBe(0);
    expect(nextTutorialStep(0)).toBe(1);
    expect(nextTutorialStep(2)).toBe(2);
    expect(tutorialStepAt(-5).id).toBe("run");
    expect(tutorialStepAt(99).id).toBe("scrub");
    expect(tutorialStepAt(Number.NaN).id).toBe("run");
  });
});
