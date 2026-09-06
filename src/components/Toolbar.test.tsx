import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toolbar } from "./Toolbar";

describe("Toolbar", () => {
  it("disables document actions before a PDF is opened", () => {
    const noop = vi.fn();
    render(<Toolbar hasDocument={false} canUndo={false} canRedo={false} zoom={100} busy={false} onOpen={noop} onSave={noop} onSaveAs={noop} onUndo={noop} onRedo={noop} onZoom={noop} onFit={noop} />);
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "開く" })).toBeEnabled();
  });
});
