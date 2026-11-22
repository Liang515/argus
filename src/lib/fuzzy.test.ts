import { describe, expect, it } from "vitest";
import { fuzzyScore, pushRecent, rank } from "./fuzzy";

describe("fuzzyScore", () => {
  it("字元依序出現才算符合", () => {
    expect(fuzzyScore("tc", "tidy-cart")).not.toBeNull();
    expect(fuzzyScore("ct", "tidy-cart")).not.toBeNull();
    expect(fuzzyScore("xyz", "tidy-cart")).toBeNull();
  });
  it("連續命中與字首命中分數較高", () => {
    const contiguous = fuzzyScore("map", "mapview") as number;
    const scattered = fuzzyScore("map", "m-a-p") as number;
    expect(contiguous).toBeGreaterThan(scattered);
    const wordStart = fuzzyScore("c", "tidy-cart") as number;
    const middle = fuzzyScore("a", "tidy-cart") as number;
    expect(wordStart).toBeGreaterThan(middle);
  });
  it("空字串全部符合，忽略大小寫與空白", () => {
    expect(fuzzyScore("", "abc")).toBe(0);
    expect(fuzzyScore("Ty C", "tidy-cart")).not.toBeNull();
  });
});

describe("rank", () => {
  const items = [
    { name: "invoice-tool", path: "/home/me/code/invoice-tool" },
    { name: "map-viewer", path: "/home/me/code/map-viewer" },
    { name: "chat-terminal", path: "/home/me/code/chat-terminal" },
  ];
  const fields = (i: (typeof items)[number]) => [i.name, i.path];

  it("最相關的排最前面，完全不符合的濾掉", () => {
    expect(rank(items, "map", fields)[0].name).toBe("map-viewer");
    expect(rank(items, "ct", fields)[0].name).toBe("chat-terminal");
    expect(rank(items, "zzz", fields)).toEqual([]);
  });
  it("空查詢維持原順序", () => {
    expect(rank(items, " ", fields)).toEqual(items);
  });
});

describe("pushRecent", () => {
  it("移到最前面、去重、限制數量", () => {
    expect(pushRecent(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
    expect(pushRecent(["/a", "/b"], "/c", 2)).toEqual(["/c", "/a"]);
  });
});
