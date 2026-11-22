import { describe, expect, it } from "vitest";
import { findPathCandidates, lineText } from "./filePaths";

const paths = (text: string) => findPathCandidates(text).map((c) => c.path);

describe("findPathCandidates", () => {
  it("找出相對、家目錄、絕對路徑與帶行號的路徑", () => {
    expect(paths("改在 src/App.tsx:313 和 `~/Desktop/argus-signing`")).toEqual([
      "src/App.tsx",
      "~/Desktop/argus-signing",
    ]);
    expect(paths("看 /Users/me/專案/argus/README.md。")).toEqual([
      "/Users/me/專案/argus/README.md",
    ]);
    expect(paths("./run.sh 與 ../lib/a.rs:10:2")).toEqual(["./run.sh", "../lib/a.rs"]);
  });
  it("沒有斜線時要有副檔名才算", () => {
    expect(paths("更新 HANDOFF.md，再跑 npm test")).toEqual(["HANDOFF.md"]);
  });
  it("網址、純數字與一般文字不算", () => {
    expect(paths("見 https://example.com/a.html 共 3.5 秒 and/or")).toEqual(["and/or"]);
  });
  it("起訖位置包含行號、不含結尾標點", () => {
    const [c] = findPathCandidates("x src/a.ts:12.");
    expect([c.start, c.end]).toEqual([2, 13]);
  });
});

describe("lineText", () => {
  const cell = (chars: string, width: number) => ({ getChars: () => chars, getWidth: () => width });
  it("寬字元佔兩格，後面字元的格子位置要往後推", () => {
    const { text, col, width } = lineText([cell("中", 2), cell("", 0), cell("a", 1), cell("", 1)]);
    expect(text).toBe("中a ");
    expect(col).toEqual([0, 2, 3]);
    expect(width).toEqual([2, 1, 1]);
  });
});
