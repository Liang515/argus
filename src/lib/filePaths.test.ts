import { describe, expect, it, vi } from "vitest";
import { findPathCandidates, hyperlinkTarget, lineText } from "./filePaths";

// 沒指定平台的測試用 macOS 規則；CI 也在 Windows 上跑，不能依跑測試的機器而定
vi.mock("./platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platform")>()),
  platform: "mac",
  isMac: true,
}));

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
  it("記下行號與欄號", () => {
    const [a, b, c] = findPathCandidates("src/a.ts:12:3 lib/b.rs:7 c.md");
    expect([a.line, a.column]).toEqual([12, 3]);
    expect([b.line, b.column]).toEqual([7, undefined]);
    expect([c.line, c.column]).toEqual([undefined, undefined]);
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

describe("Windows 路徑", () => {
  it("認得磁碟代號與反斜線路徑，並拆出行號", () => {
    const found = findPathCandidates("error at C:\\proj\\src\\a.ts:12:3 and src\\b.ts", "windows");
    expect(found.map((c) => [c.path, c.line, c.column])).toEqual([
      ["C:\\proj\\src\\a.ts", 12, 3],
      ["src\\b.ts", undefined, undefined],
    ]);
  });
});

describe("不當成路徑的", () => {
  it("網路路徑（滑過就會連線）兩個平台都略過", () => {
    for (const target of ["mac", "windows"] as const) {
      expect(findPathCandidates("see \\\\attacker\\share\\a.txt", target)).toEqual([]);
      expect(findPathCandidates("see //attacker/share/a.txt", target)).toEqual([]);
    }
  });
  it("macOS 不把反斜線字串（\\n、正規表示式）當路徑", () => {
    expect(findPathCandidates("printf a\\nb and C:\\x\\y", "mac")).toEqual([]);
  });
});

describe("hyperlinkTarget（OSC 8 超連結）", () => {
  it("http(s) 網址照原樣打開", () => {
    expect(hyperlinkTarget("https://2048-drab.vercel.app")).toEqual({
      kind: "url",
      url: "https://2048-drab.vercel.app",
    });
  });
  it("file:// 轉成本機路徑（解開 %20 等編碼）", () => {
    expect(hyperlinkTarget("file:///Users/a/my%20app/x.ts")).toEqual({
      kind: "path",
      path: "/Users/a/my app/x.ts",
    });
    expect(hyperlinkTarget("file://localhost/tmp/x")).toEqual({ kind: "path", path: "/tmp/x" });
    expect(hyperlinkTarget("file:///C:/Users/a/x.ts", "windows")).toEqual({
      kind: "path",
      path: "C:\\Users\\a\\x.ts",
    });
  });
  it("其他協定、別台主機與壞掉的網址都不開", () => {
    expect(hyperlinkTarget("javascript:alert(1)")).toBeNull();
    expect(hyperlinkTarget("vscode://file/x")).toBeNull();
    expect(hyperlinkTarget("file://server/share/x")).toBeNull();
    expect(hyperlinkTarget("file:///%E0%A4%A")).toBeNull();
    expect(hyperlinkTarget("not a url")).toBeNull();
    expect(hyperlinkTarget("file:///tmp/x", "windows")).toBeNull();
  });
});
