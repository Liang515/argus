import { describe, expect, it } from "vitest";
import { changeBadge, needsHandoffProtocol, pickEditor, splitPath } from "./project";

describe("changeBadge", () => {
  it("對應常見的 git 狀態", () => {
    expect(changeBadge("??")).toEqual({ label: "U", tone: "added" });
    expect(changeBadge(" M")).toEqual({ label: "M", tone: "modified" });
    expect(changeBadge("MM")).toEqual({ label: "M", tone: "modified" });
    expect(changeBadge("A ")).toEqual({ label: "A", tone: "added" });
    expect(changeBadge(" D")).toEqual({ label: "D", tone: "deleted" });
    expect(changeBadge("R ")).toEqual({ label: "R", tone: "renamed" });
    expect(changeBadge("UU")).toEqual({ label: "!", tone: "conflict" });
  });
});

describe("splitPath", () => {
  it("拆出資料夾與檔名", () => {
    expect(splitPath("src/lib/a.ts")).toEqual({ dir: "src/lib/", name: "a.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
    expect(splitPath("newdir/")).toEqual({ dir: "", name: "newdir" });
  });
});

describe("pickEditor", () => {
  const vscode = { id: "vscode", label: "VS Code" };
  const cursor = { id: "cursor", label: "Cursor" };
  it("選過且有裝就用它，否則用第一個有裝的", () => {
    expect(pickEditor("cursor", [vscode, cursor])).toBe(cursor);
    expect(pickEditor("zed", [vscode, cursor])).toBe(vscode);
    expect(pickEditor(null, [cursor])).toBe(cursor);
  });
  it("一個編輯器都沒裝", () => {
    expect(pickEditor("vscode", [])).toBeNull();
  });
});

describe("needsHandoffProtocol", () => {
  it("沒有文件，或 CLAUDE.md 還沒加交接規則時提示", () => {
    expect(needsHandoffProtocol(null)).toBe(true);
    expect(needsHandoffProtocol({ name: "CLAUDE.md", content: "# 規則" })).toBe(true);
  });
  it("已經有 HANDOFF.md 或加過規則就不提示", () => {
    expect(needsHandoffProtocol({ name: "HANDOFF.md", content: "# 進度" })).toBe(false);
    expect(
      needsHandoffProtocol({
        name: "CLAUDE.md",
        content: "# 規則\n\n## Session Handoff Protocol\n- …",
      }),
    ).toBe(false);
  });
});
