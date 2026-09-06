import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEditHistory } from "./useEditHistory";

describe("useEditHistory", () => {
  it("supports commit, undo, redo and branching", () => {
    const { result } = renderHook(() => useEditHistory());
    act(() => result.current.commit("span-1", "before", "after"));
    expect(result.current.current.get("span-1")).toBe("after");
    expect(result.current.dirty).toBe(true);
    act(() => result.current.undo());
    expect(result.current.current.has("span-1")).toBe(false);
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    act(() => result.current.markSaved());
    expect(result.current.dirty).toBe(false);
    act(() => result.current.undo());
    act(() => result.current.commit("span-2", "a", "b"));
    expect(result.current.canRedo).toBe(false);
    expect(result.current.current.get("span-2")).toBe("b");
  });
});
