import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "./activity";
import {
  MAX_PROJECTS,
  mergeRecaps,
  noteActivity,
  noteStatus,
  type ProjectRecap,
  parseRecaps,
  projectStatus,
  relativeTime,
} from "./recap";

const run = (events: [string, number, ActivityEvent][], start: ProjectRecap[] = []) =>
  events.reduce((r, [path, at, e]) => noteActivity(r, path, e, at), start);

describe("noteActivity", () => {
  it("記下最後一句指令與之後改過的檔案，最近的專案排最前面", () => {
    const r = run([
      ["/a", 1, { k: "prompt", text: "修 bug" }],
      ["/a", 2, { k: "start", verb: "edit", target: "x.ts", path: "/a/x.ts" }],
      ["/b", 3, { k: "prompt", text: "寫文件" }],
      ["/a", 4, { k: "done", verb: "write", target: "y.ts", ok: true, path: "/a/y.ts" }],
      ["/a", 5, { k: "start", verb: "edit", target: "x.ts", path: "/a/x.ts" }],
    ]);
    expect(r.map((p) => p.path)).toEqual(["/a", "/b"]);
    expect(r[0]).toEqual({ path: "/a", at: 5, prompt: "修 bug", files: ["/a/x.ts", "/a/y.ts"] });
  });

  it("新的指令先留著上一輪的檔案（標成上一輪），這輪改了檔才換掉；agy 同一輪重送同一句不動", () => {
    const base = run([
      ["/a", 1, { k: "prompt", text: "一" }],
      ["/a", 2, { k: "start", verb: "edit", target: "x", path: "/a/x" }],
    ]);
    expect(run([["/a", 3, { k: "prompt", text: "一", dedup: true }]], base)[0].files).toEqual([
      "/a/x",
    ]);
    const asked = run([["/a", 3, { k: "prompt", text: "二" }]], base);
    expect(asked[0]).toMatchObject({ prompt: "二", files: ["/a/x"], filesEarlier: true });
    // 這輪第一次改檔：清單換成這輪的，之後照常累積
    const edited = run(
      [
        ["/a", 4, { k: "start", verb: "edit", target: "y", path: "/a/y" }],
        ["/a", 5, { k: "done", verb: "write", target: "z", ok: true, path: "/a/z" }],
      ],
      asked,
    );
    expect(edited[0]).toEqual({ path: "/a", at: 5, prompt: "二", files: ["/a/z", "/a/y"] });
    // 再問一句、讀檔：仍是上一輪的
    const again = run(
      [
        ["/a", 6, { k: "prompt", text: "三" }],
        ["/a", 7, { k: "start", verb: "read", target: "y", path: "/a/y" }],
      ],
      edited,
    );
    expect(again[0]).toMatchObject({ files: ["/a/z", "/a/y"], filesEarlier: true });
  });

  it("上一輪沒改檔時，新指令不標上一輪", () => {
    const r = run([
      ["/a", 1, { k: "prompt", text: "一" }],
      ["/a", 2, { k: "prompt", text: "二" }],
    ]);
    expect(r[0]).toEqual({ path: "/a", at: 2, prompt: "二", files: [] });
  });

  it("讀檔、執行指令只更新時間；end、todos、空白指令不算", () => {
    const base = run([["/a", 1, { k: "prompt", text: "一" }]]);
    const read = run([["/a", 9, { k: "start", verb: "read", target: "x", path: "/a/x" }]], base);
    expect(read[0]).toMatchObject({ at: 9, files: [] });
    for (const e of [
      { k: "end", ok: true },
      { k: "todos", items: [] },
      { k: "stop" },
      { k: "prompt", text: "  " },
    ] as ActivityEvent[]) {
      expect(noteActivity(base, "/a", e, 9)).toBe(base);
    }
  });

  it("專案數有上限，最舊的被擠掉", () => {
    let r: ProjectRecap[] = [];
    for (let i = 0; i <= MAX_PROJECTS; i++) {
      r = noteActivity(r, `/p${i}`, { k: "prompt", text: "x" }, i);
    }
    expect(r).toHaveLength(MAX_PROJECTS);
    expect(r.some((p) => p.path === "/p0")).toBe(false);
  });
});

describe("noteActivity 記下是哪個 agent", () => {
  it("指令記下收到它的 agent；之後別的 agent 有動作只改最近的 agent", () => {
    let r = noteActivity([], "/a", { k: "prompt", text: "刪掉它" }, 1, "agy");
    expect(r[0]).toMatchObject({ prompt: "刪掉它", promptAgent: "agy", agent: "agy" });
    r = noteStatus(r, "/a", "running", "claude", 2);
    r = noteActivity(r, "/a", { k: "start", verb: "read", target: "x" }, 3, "claude");
    expect(r[0]).toMatchObject({ prompt: "刪掉它", promptAgent: "agy", agent: "claude" });
    r = noteActivity(r, "/a", { k: "prompt", text: "新的" }, 4, "claude");
    expect(r[0]).toMatchObject({ prompt: "新的", promptAgent: "claude" });
  });
  it("不同 agent 說了同一句不算同一輪重送：換成新的 agent，檔案標成上一輪的", () => {
    let r = noteActivity([], "/a", { k: "prompt", text: "好" }, 1, "claude");
    r = noteActivity(
      r,
      "/a",
      { k: "start", verb: "edit", target: "a", path: "/a/a.ts" },
      2,
      "claude",
    );
    r = noteActivity(r, "/a", { k: "prompt", text: "好", dedup: true }, 3, "agy");
    expect(r[0]).toMatchObject({
      prompt: "好",
      promptAgent: "agy",
      files: ["/a/a.ts"],
      filesEarlier: true,
    });
  });
  it("新指令不知道是哪個 agent 時，不沿用上一句的 promptAgent", () => {
    let r = noteActivity([], "/a", { k: "prompt", text: "一" }, 1, "agy");
    r = noteActivity(r, "/a", { k: "prompt", text: "二" }, 2);
    expect(r[0].promptAgent).toBeUndefined();
  });
  it("存檔讀回來也保留 promptAgent，不認得的值略過", () => {
    const json = JSON.stringify([
      { path: "/a", at: 1, files: ["/a/x"], prompt: "x", promptAgent: "agy", filesEarlier: true },
      { path: "/b", at: 0, files: [], prompt: "y", promptAgent: "nope" },
    ]);
    const [a, b] = parseRecaps(json);
    expect(a.promptAgent).toBe("agy");
    expect(a.filesEarlier).toBe(true);
    expect(b.promptAgent).toBeUndefined();
    expect(b.filesEarlier).toBeUndefined();
  });
});

describe("noteStatus", () => {
  it("執行、等確認、完成都更新時間並記 agent；off、idle 不動", () => {
    const r = noteStatus([], "/a", "running", "codex", 7);
    expect(r).toEqual([{ path: "/a", at: 7, files: [], agent: "codex" }]);
    expect(noteStatus(r, "/a", "off", "claude", 9)).toBe(r);
    expect(noteStatus(r, "/a", "idle", "claude", 9)).toBe(r);
  });
});

describe("parseRecaps", () => {
  it("略過壞掉的項目並依時間排序", () => {
    const json = JSON.stringify([
      { path: "/old", at: 1, files: ["/old/a", 3], agent: "nope" },
      { path: 5, at: 2 },
      "junk",
      { path: "/new", at: 9, prompt: "嗨", files: [], agent: "agy" },
    ]);
    expect(parseRecaps(json)).toEqual([
      { path: "/new", at: 9, prompt: "嗨", files: [], agent: "agy" },
      { path: "/old", at: 1, files: ["/old/a"] },
    ]);
  });

  it("沒有檔案或內容壞掉時回傳空清單", () => {
    expect(parseRecaps(null)).toEqual([]);
    expect(parseRecaps("{")).toEqual([]);
    expect(parseRecaps('{"a":1}')).toEqual([]);
  });
});

describe("mergeRecaps", () => {
  it("同專案以剛發生的為準，其他專案從存檔補上並依時間排序", () => {
    const saved = [
      { path: "/a", at: 5, prompt: "舊", files: [] },
      { path: "/b", at: 3, files: [] },
    ];
    const live = [{ path: "/a", at: 9, prompt: "新", files: [] }];
    expect(mergeRecaps(saved, live).map((r) => [r.path, r.prompt])).toEqual([
      ["/a", "新"],
      ["/b", undefined],
    ]);
  });

  it("讀檔前說了新指令、還沒改檔：存檔的檔案當成上一輪的", () => {
    const saved = [{ path: "/a", at: 5, prompt: "舊", files: ["/a/x"] }];
    expect(mergeRecaps(saved, [{ path: "/a", at: 9, prompt: "新", files: [] }])).toEqual([
      { path: "/a", at: 9, prompt: "新", files: ["/a/x"], filesEarlier: true },
    ]);
    // 這輪已經改了檔：只留這輪的
    expect(mergeRecaps(saved, [{ path: "/a", at: 9, prompt: "新", files: ["/a/y"] }])).toEqual([
      { path: "/a", at: 9, prompt: "新", files: ["/a/y"] },
    ]);
  });

  it("只有燈號時沿用存檔的上一輪標記", () => {
    const saved = [
      { path: "/a", at: 5, prompt: "問", files: ["/a/x"], filesEarlier: true as const },
    ];
    expect(mergeRecaps(saved, [{ path: "/a", at: 9, files: [] }])[0]).toMatchObject({
      files: ["/a/x"],
      filesEarlier: true,
    });
    // 讀檔前這輪已經改了檔：上一輪的不混進來
    expect(mergeRecaps(saved, [{ path: "/a", at: 9, files: ["/a/y"] }])[0]).toEqual({
      path: "/a",
      at: 9,
      prompt: "問",
      files: ["/a/y"],
    });
  });
});

describe("mergeRecaps 讀檔前只有燈號", () => {
  it("沿用存檔的指令與檔案，剛改的檔案排前面", () => {
    const saved = [{ path: "/a", at: 5, prompt: "舊", files: ["/a/x"], agent: "agy" as const }];
    const live = [{ path: "/a", at: 9, files: ["/a/y", "/a/x"] }];
    expect(mergeRecaps(saved, live)).toEqual([
      { path: "/a", at: 9, prompt: "舊", files: ["/a/y", "/a/x"], agent: "agy" },
    ]);
  });
});

describe("noteActivity 失敗的動作", () => {
  it("done 失敗不算改了檔案，但仍更新時間", () => {
    const r = noteActivity(
      [],
      "/a",
      { k: "done", verb: "edit", target: "x", ok: false, path: "/a/x" },
      3,
    );
    expect(r).toEqual([{ path: "/a", at: 3, files: [] }]);
  });
});

describe("projectStatus", () => {
  const tabs = [
    { id: "1", path: "/a" },
    { id: "2", path: "/a" },
    { id: "3", path: "/b" },
  ];
  it("同專案多個分頁時挑最需要注意的", () => {
    expect(projectStatus("/a", tabs, { "1": "done", "2": "needs-input" })).toEqual({
      status: "needs-input",
      tabId: "2",
    });
    expect(projectStatus("/b", tabs, {})).toEqual({ status: "off", tabId: "3" });
  });
  it("沒開分頁就沒有 tabId", () => {
    expect(projectStatus("/c", tabs, {})).toEqual({ status: "off", tabId: null });
  });
});

describe("relativeTime", () => {
  const now = new Date(2026, 10, 24, 12, 0).getTime();
  const ago = (ms: number) => relativeTime(now - ms, now, "zh-TW");
  it("依時間長短顯示", () => {
    expect(ago(30_000)).toBe("剛剛");
    expect(ago(5 * 60_000)).toBe("5 分鐘前");
    expect(ago(3 * 3_600_000)).toBe("3 小時前");
    expect(ago(30 * 3_600_000)).toBe("昨天");
    expect(ago(4 * 86_400_000)).toBe("4 天前");
    expect(ago(10 * 86_400_000)).toBe("11/14");
    expect(relativeTime(now - 5 * 60_000, now, "en")).toBe("5m ago");
  });
});
