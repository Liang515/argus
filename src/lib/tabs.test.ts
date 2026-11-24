import { describe, expect, it } from "vitest";
import {
  activeAfterClose,
  dropIndex,
  hiddenTabIds,
  moveTab,
  overflowAlerts,
  resolveSelect,
  shortcutAction,
  type Tab,
  tabLabels,
  tabName,
} from "./tabs";

const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  key: k,
  code: "",
  ...extra,
});

const tabs: Tab[] = [
  { id: "a", path: "/p/a" },
  { id: "b", path: "/p/b" },
  { id: "c", path: "/p/c" },
];

describe("tabName", () => {
  it("取最後一段資料夾名稱", () => {
    expect(tabName("/Users/x/專案/argus")).toBe("argus");
    expect(tabName("/Users/x/repo/")).toBe("repo");
    expect(tabName("/")).toBe("/");
  });
});

describe("tabLabels", () => {
  it("同資料夾的分頁依序編號，其他維持資料夾名稱", () => {
    const labels = tabLabels([
      { id: "a", path: "/p/map-viewer" },
      { id: "b", path: "/p/weather" },
      { id: "c", path: "/p/map-viewer" },
      { id: "d", path: "/p/map-viewer" },
    ]);
    expect(labels).toEqual({ a: "map-viewer", b: "weather", c: "map-viewer ②", d: "map-viewer ③" });
  });
});

describe("shortcutAction", () => {
  it("Cmd+T / Cmd+W / Cmd+數字", () => {
    expect(shortcutAction(key("t"))).toEqual({ type: "new" });
    expect(shortcutAction(key("W"))).toEqual({ type: "close" });
    expect(shortcutAction(key("2"))).toEqual({ type: "select", index: 1 });
    expect(shortcutAction(key("9"))).toEqual({ type: "select", index: -1 });
    expect(shortcutAction(key("k"))).toEqual({ type: "palette" });
    expect(shortcutAction(key("p"))).toEqual({ type: "palette" });
    expect(shortcutAction(key("j"))).toEqual({ type: "recap" });
    expect(shortcutAction(key("j", { ctrlKey: true }))).toBeNull();
    expect(shortcutAction(key("b"))).toEqual({ type: "sidebar" });
    expect(shortcutAction(key("/", { code: "Slash" }))).toEqual({ type: "help" });
    expect(shortcutAction(key("T", { shiftKey: true, code: "KeyT" }))).toEqual({
      type: "duplicate",
    });
  });

  it("Cmd+Shift+← → 移動分頁", () => {
    expect(shortcutAction(key("ArrowLeft", { shiftKey: true, code: "ArrowLeft" }))).toEqual({
      type: "move",
      delta: -1,
    });
    expect(shortcutAction(key("ArrowRight", { shiftKey: true, code: "ArrowRight" }))).toEqual({
      type: "move",
      delta: 1,
    });
  });

  it("Cmd+Shift+[ ] 切換前後分頁", () => {
    expect(shortcutAction(key("}", { shiftKey: true, code: "BracketRight" }))).toEqual({
      type: "next",
    });
    expect(shortcutAction(key("{", { shiftKey: true, code: "BracketLeft" }))).toEqual({
      type: "prev",
    });
  });

  it("其他按鍵交給終端機", () => {
    expect(shortcutAction(key("t", { metaKey: false }))).toBeNull();
    expect(shortcutAction(key("c"))).toBeNull();
    expect(shortcutAction(key("t", { ctrlKey: true }))).toBeNull();
    expect(shortcutAction(key("0"))).toBeNull();
  });
});

describe("resolveSelect", () => {
  it("依序號或前後切換，並循環", () => {
    expect(resolveSelect(tabs, "a", { type: "select", index: 1 })).toBe("b");
    expect(resolveSelect(tabs, "a", { type: "select", index: 5 })).toBeNull();
    expect(resolveSelect(tabs, "a", { type: "select", index: -1 })).toBe("c");
    expect(resolveSelect(tabs, "c", { type: "next" })).toBe("a");
    expect(resolveSelect(tabs, "a", { type: "prev" })).toBe("c");
    expect(resolveSelect([], null, { type: "next" })).toBeNull();
  });
});

describe("moveTab", () => {
  const ids = (t: Tab[]) => t.map((x) => x.id).join("");
  it("移到指定位置", () => {
    expect(ids(moveTab(tabs, "a", 2))).toBe("bca");
    expect(ids(moveTab(tabs, "c", 0))).toBe("cab");
    expect(ids(moveTab(tabs, "b", 0))).toBe("bac");
  });
  it("超出範圍停在頭尾，位置不變回傳原陣列", () => {
    expect(ids(moveTab(tabs, "a", -1))).toBe("abc");
    expect(ids(moveTab(tabs, "b", 9))).toBe("acb");
    expect(moveTab(tabs, "b", 1)).toBe(tabs);
    expect(moveTab(tabs, "zz", 0)).toBe(tabs);
  });
});

describe("dropIndex", () => {
  // 三個分頁，中線在 x = 50 / 150 / 250
  const mids = [50, 150, 250];
  const ids = (from: number, x: number) => {
    const order = moveTab(tabs, tabs[from].id, dropIndex(mids, from, x));
    return order.map((t) => t.id).join("");
  };
  it("往右拖過別人的中線才換位置", () => {
    expect(ids(0, 140)).toBe("abc");
    expect(ids(0, 160)).toBe("bac");
    expect(ids(0, 300)).toBe("bca");
  });
  it("往左拖", () => {
    expect(ids(2, 160)).toBe("abc");
    expect(ids(2, 140)).toBe("acb");
    expect(ids(2, 10)).toBe("cab");
  });
});

describe("activeAfterClose", () => {
  it("關背景分頁不影響目前分頁", () => {
    expect(activeAfterClose(tabs, "c", "a")).toBe("a");
  });
  it("關目前分頁時選右邊，最後一個則選左邊", () => {
    expect(activeAfterClose(tabs, "b", "b")).toBe("c");
    expect(activeAfterClose(tabs, "c", "c")).toBe("b");
  });
  it("全部關完回傳 null", () => {
    expect(activeAfterClose([tabs[0]], "a", "a")).toBeNull();
  });
});

describe("hiddenTabIds", () => {
  const view = { left: 100, right: 500 };
  it("完全或部分在可見範圍外的分頁都算看不到", () => {
    const tabs = [
      { id: "a", left: 100, right: 220 },
      { id: "b", left: 224, right: 344 },
      { id: "c", left: 440, right: 560 }, // 右邊被切掉
      { id: "d", left: 564, right: 684 }, // 完全在右邊外
      { id: "e", left: -30, right: 90 }, // 捲到左邊外
    ];
    expect(hiddenTabIds(view, tabs)).toEqual(["c", "d", "e"]);
  });
  it("差幾個像素（邊框、小數）不算被切掉", () => {
    expect(hiddenTabIds(view, [{ id: "a", left: 98, right: 502 }])).toEqual([]);
  });
});

describe("overflowAlerts", () => {
  it("列出所有出現的狀態，依等你確認、已完成、執行中排序", () => {
    expect(overflowAlerts(["running", "done", "needs-input"])).toEqual([
      "needs-input",
      "done",
      "running",
    ]);
    expect(overflowAlerts(["done", "done", "running", "done"])).toEqual(["done", "running"]);
    expect(overflowAlerts(["idle", "running", "off"])).toEqual(["running"]);
  });
  it("只有待命或沒有 agent 時不提醒", () => {
    expect(overflowAlerts(["idle", "off"])).toEqual([]);
    expect(overflowAlerts([])).toEqual([]);
  });
});

describe("字體縮放快捷鍵", () => {
  it("⌘＝、⌘⇧＝（⌘＋）放大，⌘－ 縮小，⌘0 恢復", () => {
    expect(shortcutAction(key("=", { code: "Equal" }))).toEqual({ type: "zoom", delta: 1 });
    expect(shortcutAction(key("+", { code: "Equal", shiftKey: true }))).toEqual({
      type: "zoom",
      delta: 1,
    });
    expect(shortcutAction(key("-", { code: "Minus" }))).toEqual({ type: "zoom", delta: -1 });
    expect(shortcutAction(key("0", { code: "Digit0" }))).toEqual({ type: "zoom", delta: 0 });
  });
});
