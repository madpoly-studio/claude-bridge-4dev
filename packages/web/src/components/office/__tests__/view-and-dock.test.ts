import { describe, expect, it } from "vitest";
import { CHAT_DEFAULT_OPEN_MIN_WIDTH, CHAT_GAP_PX, CHAT_MAX_WIDTH_PX, CHAT_MIN_WIDTH_PX, LABEL_SCALE_MAX, MIN_SCENE_SCALE } from "../constants";
import { resolveChatDock } from "../hooks/useChatDock";
import { computeSceneFit } from "../hooks/useSceneScale";
import { SCENE_H, SCENE_W } from "../model/geometry";
import { resolveViewMode } from "../view-mode";

describe("resolveViewMode", () => {
  it("mặc định dashboard", () => {
    expect(resolveViewMode("", null)).toBe("dashboard");
    expect(resolveViewMode("?demo=1", "rác")).toBe("dashboard");
  });

  it("dùng lựa chọn đã nhớ", () => {
    expect(resolveViewMode("", "office")).toBe("office");
  });

  it("?view= thắng storage; giá trị lạ thì bỏ qua", () => {
    expect(resolveViewMode("?view=office", "dashboard")).toBe("office");
    expect(resolveViewMode("?demo=1&view=dashboard", "office")).toBe("dashboard");
    expect(resolveViewMode("?view=xyz", "office")).toBe("office");
  });
});

describe("resolveChatDock", () => {
  const WIDE = CHAT_DEFAULT_OPEN_MIN_WIDTH + 100;

  it("lần đầu: tab Planner, mở nếu cửa sổ đủ rộng", () => {
    expect(resolveChatDock("", null, WIDE)).toEqual({ tab: "planner", open: true });
    expect(resolveChatDock("", null, 1100)).toEqual({ tab: "planner", open: false });
  });

  it("nhớ tab và trạng thái thu gọn", () => {
    expect(resolveChatDock("", "orchestrator:open", 1100)).toEqual({ tab: "orchestrator", open: true });
    expect(resolveChatDock("", "orchestrator:closed", WIDE)).toEqual({ tab: "orchestrator", open: false });
    expect(resolveChatDock("", "rác:open", 1100)).toEqual({ tab: "planner", open: false });
  });

  it("?chat= ép trạng thái cho lần tải đó", () => {
    expect(resolveChatDock("?chat=closed", "planner:open", WIDE)).toEqual({ tab: "planner", open: false });
    expect(resolveChatDock("?chat=orchestrator", "planner:closed", 800)).toEqual({ tab: "orchestrator", open: true });
  });
});

describe("computeSceneFit", () => {
  it("giữ tỉ lệ 4:3: lấy cạnh chật hơn, canh giữa phần dư", () => {
    const fit = computeSceneFit(SCENE_W * 2, SCENE_H, false);
    expect(fit.scale).toBe(1);
    expect(fit.left).toBe(SCENE_W / 2);
    expect(fit.chatWidth).toBe(0);
    expect(computeSceneFit(SCENE_W, SCENE_H * 3, false)).toMatchObject({ scale: 1, left: 0 });
  });

  it("có sàn scale tối thiểu; nhãn co ngược nhưng có trần", () => {
    const fit = computeSceneFit(300, 300, false);
    expect(fit.scale).toBe(MIN_SCENE_SCALE);
    expect(fit.left).toBe(0);
    expect(fit.labelScale).toBeGreaterThan(1);
    expect(fit.labelScale).toBeLessThanOrEqual(LABEL_SCALE_MAX);
    expect(computeSceneFit(SCENE_W, SCENE_H, false).labelScale).toBe(1);
  });

  it("khung chat mở: bản đồ nhường chỗ bên phải cho khung chat, lề trái không bao giờ âm", () => {
    const closed = computeSceneFit(SCENE_W + 600, SCENE_H, false);
    const open = computeSceneFit(SCENE_W + 600, SCENE_H, true);
    expect(closed.left).toBe(300);
    // Chiều cao là cạnh chật: scale giữ nguyên, khung chat nở tới tối đa, phần dư còn lại dồn sang trái bản đồ.
    expect(open.scale).toBe(closed.scale);
    expect(open.chatWidth).toBe(CHAT_MAX_WIDTH_PX);
    expect(open.left).toBe(600 - 2 * CHAT_GAP_PX - CHAT_MAX_WIDTH_PX);
    // Bề rộng là cạnh chật: bản đồ co lại, khung chat ở bề rộng tối thiểu, không còn phần dư.
    const tight = computeSceneFit(SCENE_W + 100, SCENE_H, true);
    expect(tight.scale).toBeLessThan(1);
    expect(tight).toMatchObject({ left: 0, chatWidth: CHAT_MIN_WIDTH_PX });
  });
});
