import { useCallback, useMemo, useReducer } from "react";
import type { EditPatch } from "../types/pdf";

interface Step { spanId: string; before: string; after: string }
interface State { steps: Step[]; cursor: number; savedSnapshot: string }
type Action = { type: "commit"; step: Step } | { type: "undo" } | { type: "redo" } | { type: "reset" } | { type: "saved"; snapshot: string };

const EMPTY_SNAPSHOT = "[]";

function reduce(state: State, action: Action): State {
  if (action.type === "reset") return { steps: [], cursor: 0, savedSnapshot: EMPTY_SNAPSHOT };
  if (action.type === "undo") return { ...state, cursor: Math.max(0, state.cursor - 1) };
  if (action.type === "redo") return { ...state, cursor: Math.min(state.steps.length, state.cursor + 1) };
  if (action.type === "saved") return { ...state, savedSnapshot: action.snapshot };
  if (action.step.before === action.step.after) return state;
  const steps = [...state.steps.slice(0, state.cursor), action.step];
  return { ...state, steps, cursor: steps.length };
}

function replay(steps: Step[], cursor: number): Map<string, string> {
  const edits = new Map<string, string>();
  for (let index = 0; index < cursor; index += 1) edits.set(steps[index].spanId, steps[index].after);
  return edits;
}

function snapshot(edits: Map<string, string>): string {
  return JSON.stringify([...edits.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function useEditHistory() {
  const [state, dispatch] = useReducer(reduce, { steps: [], cursor: 0, savedSnapshot: EMPTY_SNAPSHOT });
  const current = useMemo(() => replay(state.steps, state.cursor), [state.steps, state.cursor]);
  const currentSnapshot = useMemo(() => snapshot(current), [current]);
  const patches = useMemo<EditPatch[]>(() => [...current].map(([spanId, newText]) => ({ spanId, newText })), [current]);
  const commit = useCallback((spanId: string, before: string, after: string) => dispatch({ type: "commit", step: { spanId, before, after } }), []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);
  const markSaved = useCallback(() => dispatch({ type: "saved", snapshot: currentSnapshot }), [currentSnapshot]);
  return { current, patches, commit, undo, redo, reset, markSaved, canUndo: state.cursor > 0, canRedo: state.cursor < state.steps.length, dirty: currentSnapshot !== state.savedSnapshot };
}
