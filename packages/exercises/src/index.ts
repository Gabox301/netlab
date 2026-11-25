/**
 * `@netlab/exercises`: declarative exercises plus the validators that judge a
 * solution against the simulation evidence (F-110 to F-112).
 *
 * The package sits below `@netlab/cli` (ADR-001): it defines the JSON format
 * with hand-written validation, plans probes, and evaluates checks over
 * injected run evidence. It never imports the CLI — the CLI passes its
 * `runScenario` in.
 */

export const PACKAGE = "@netlab/exercises";

export {
  type ArpCheckDef,
  type CheckDef,
  DEFAULT_UNTIL_US,
  type DropReason,
  type DurationInput,
  EXERCISE_KINDS,
  EXERCISE_VERSION,
  type ExecCheckDef,
  type ExecExpectation,
  type ExerciseHint,
  type ExerciseJSON,
  type ExerciseKind,
  isCidr,
  isIpv4,
  isMac,
  type MacTableCheckDef,
  type PingCheckDef,
  parseDurationToUs,
  parseExerciseJson,
  parseExerciseText,
  type RouteCheckDef,
  type ScenarioInterfaceLike,
  type ScenarioLike,
  type ScenarioNodeLike,
  type ScenarioShellActionLike,
  type TraceCheckDef,
  type TraceKind,
} from "./schema";
export {
  type CheckResult,
  type ExerciseExample,
  type ExerciseValidationResult,
  exerciseExamples,
  type MacRowLike,
  macLearningExample,
  type ProbePlan,
  type ProbePlanEntry,
  pingGatewayExample,
  planProbes,
  prepareScenario,
  type RouteRowLike,
  type RunEvidence,
  type RunSummary,
  routingExample,
  type ScenarioRunner,
  type ShellTranscriptLike,
  validateExercise,
} from "./validate";
