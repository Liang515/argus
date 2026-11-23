import { describe, expect, it } from "vitest";
import {
  type ActivityEvent,
  applyActivity,
  EMPTY_ACTIVITY,
  formatTook,
  MAX_ITEMS,
  parseActivity,
  todoProgress,
} from "./activity";

const run = (events: [number, ActivityEvent][]) =>
  events.reduce((s, [at, e]) => applyActivity(s, e, at), EMPTY_ACTIVITY);

describe("parseActivity", () => {
  it("接受後端的摘要格式", () => {
    expect(parseActivity('{"k":"start","id":"t1","verb":"run","target":"npm test"}')).toEqual({
      k: "start",
      id: "t1",
      verb: "run",
      target: "npm test",
    });
    expect(parseActivity('{"k":"stop"}')).toEqual({ k: "stop" });
    expect(
      parseActivity('{"k":"done","id":"c1","verb":"run","target":"Run tests","ok":true}'),
    ).toEqual({
      k: "done",
      id: "c1",
      verb: "run",
      target: "Run tests",
      ok: true,
    });
  });
  it("格式不對就忽略", () => {
    expect(parseActivity("not json")).toBeNull();
    expect(parseActivity('{"k":"start","verb":"hack","target":"x"}')).toBeNull();
    expect(parseActivity('{"k":"done","verb":"run","target":"x"}')).toBeNull();
    expect(parseActivity('{"k":"end"}')).toBeNull();
    expect(
      parseActivity('{"k":"todos","items":[null,1,{"text":"ok","status":"pending"}]}'),
    ).toEqual({ k: "todos", items: [{ text: "ok", status: "pending" }] });
  });
});

describe("applyActivity", () => {
  it("開始到結束：記下結果與花費時間", () => {
    const s = run([
      [1000, { k: "prompt", text: "做活動面板" }],
      [2000, { k: "start", id: "a", verb: "run", target: "npm test" }],
      [6000, { k: "end", id: "a", ok: true }],
    ]);
    expect(s.items.map((i) => [i.kind, i.status, i.took])).toEqual([
      ["prompt", undefined, undefined],
      ["run", "ok", 4000],
    ]);
  });
  it("沒有 id 時結束最後一筆還在執行的", () => {
    const s = run([
      [0, { k: "start", verb: "read", target: "a.ts" }],
      [1, { k: "end", ok: true }],
      [2, { k: "start", verb: "run", target: "cargo test" }],
      [3, { k: "end", ok: false }],
    ]);
    expect(s.items.map((i) => i.status)).toEqual(["ok", "fail"]);
  });
  it("回覆結束時還在執行的改成不確定，不會一直轉圈", () => {
    const s = run([
      [0, { k: "start", id: "x", verb: "run", target: "sleep 99" }],
      [1, { k: "stop" }],
    ]);
    expect(s.items[0].status).toBe("unknown");
  });
  it("計畫清單：新的一輪會先清掉舊計畫", () => {
    let s = run([
      [
        0,
        {
          k: "todos",
          items: [
            { text: "讀程式", status: "completed" },
            { text: "補測試", status: "in_progress" },
            { text: "發佈", status: "weird" },
          ],
        },
      ],
    ]);
    expect(s.todos.map((t) => t.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(todoProgress(s.todos)).toEqual({ done: 1, total: 3 });
    s = applyActivity(s, { k: "prompt", text: "下一個任務" }, 9);
    expect(s.todos).toEqual([]);
  });
  it("agy：同一輪重複的 PreInvocation 訊息去重，Stop 後下一輪可再顯示，PostToolUse 一步到位", () => {
    const s = run([
      [1000, { k: "prompt", text: "幫我看這段", dedup: true }],
      [2000, { k: "done", id: "c1", verb: "read", target: "src/App.tsx", ok: true }],
      [3000, { k: "prompt", text: "幫我看這段", dedup: true }],
      [
        4000,
        { k: "done", id: "c2", verb: "run", target: "Run tests", detail: "npm test", ok: false },
      ],
      [5000, { k: "stop" }],
      [6000, { k: "prompt", text: "幫我看這段", dedup: true }],
    ]);
    expect(s.items.map((i) => [i.kind, i.target, i.status])).toEqual([
      ["prompt", "幫我看這段", undefined],
      ["read", "src/App.tsx", "ok"],
      ["run", "Run tests", "fail"],
      ["prompt", "幫我看這段", undefined],
    ]);
    expect(s.items[2]?.detail).toBe("npm test");
  });
  it("最多保留固定筆數", () => {
    let s = EMPTY_ACTIVITY;
    for (let i = 0; i < MAX_ITEMS + 20; i++) {
      s = applyActivity(s, { k: "start", verb: "read", target: `f${i}` }, i);
    }
    expect(s.items).toHaveLength(MAX_ITEMS);
    expect(s.items[s.items.length - 1]?.target).toBe(`f${MAX_ITEMS + 19}`);
  });
});

describe("formatTook", () => {
  it("秒數與分鐘", () => {
    expect(formatTook(300)).toBe("<1s");
    expect(formatTook(4200)).toBe("4s");
    expect(formatTook(80_000)).toBe("1m 20s");
  });
});
