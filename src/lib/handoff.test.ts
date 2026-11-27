import { describe, expect, it } from "vitest";
import { handoffNext, isHandoffPrompt } from "./handoff";

describe("isHandoffPrompt", () => {
  it("認得 /handoff、交接與 handoff 開頭的訊息", () => {
    expect(isHandoffPrompt("/handoff")).toBe(true);
    expect(isHandoffPrompt("/handoff 暫停")).toBe(true);
    expect(isHandoffPrompt("交接")).toBe(true);
    expect(isHandoffPrompt("  交接：更新 HANDOFF.md")).toBe(true);
    expect(isHandoffPrompt("Handoff: update HANDOFF.md")).toBe(true);
    expect(isHandoffPrompt("hand off please")).toBe(true);
  });
  it("其他訊息不算", () => {
    expect(isHandoffPrompt("幫我寫交接")).toBe(false);
    expect(isHandoffPrompt("/handoffs")).toBe(false);
    expect(isHandoffPrompt("handoffs are great")).toBe(false);
    expect(isHandoffPrompt("修 bug")).toBe(false);
  });
});

describe("handoffNext", () => {
  it("寫完（回到完成或待命）才進入等確認，等權限確認時繼續等", () => {
    expect(handoffNext("writing", "running")).toBe("writing");
    expect(handoffNext("writing", "needs-input")).toBe("writing");
    expect(handoffNext("writing", "done")).toBe("confirm");
    expect(handoffNext("writing", "idle")).toBe("confirm");
  });

  it("等確認時使用者又繼續對話，或 agent 關掉，就結束流程", () => {
    expect(handoffNext("confirm", "done")).toBe("confirm");
    expect(handoffNext("confirm", "running")).toBeNull();
    expect(handoffNext("confirm", "needs-input")).toBeNull();
    expect(handoffNext("confirm", "off")).toBeNull();
    expect(handoffNext("writing", "off")).toBeNull();
  });
});
