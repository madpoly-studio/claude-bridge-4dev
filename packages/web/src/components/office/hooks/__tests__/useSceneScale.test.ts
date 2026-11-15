import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { CHAT_GAP_PX, CHAT_MAX_WIDTH_PX, CHAT_MIN_WIDTH_PX, CHAT_SHEET_BELOW_PX, MIN_SCENE_SCALE, SCENE_FIT_TRANSITION_MS } from "../../constants";
import { SCENE_H, SCENE_W } from "../../model/geometry";
import { OFFICE_LAYOUT } from "../../model/layout";
import { ORCHESTRATOR_SHEET, PLANNER_SHEET } from "../../model/sprites";
import { computeSceneFit, useSceneScale } from "../useSceneScale";
import type { SceneFit } from "../useSceneScale";

/** Kích thước vùng cảnh (cửa sổ trừ top bar và banner demo) đo trên ảnh chụp ở từng cỡ cửa sổ. */
const AREA = {
  "1920x1000": { width: 1920, height: 899 },
  "1600x1000": { width: 1600, height: 899 },
  "1280x900": { width: 1280, height: 743 },
  "1100x700": { width: 1100, height: 543 },
} as const;
const AREAS = Object.entries(AREA).map(([name, area]) => ({ name, ...area }));

const HOME_ROBOTS = [
  { home: OFFICE_LAYOUT.planner.home, sheet: PLANNER_SHEET },
  { home: OFFICE_LAYOUT.orchestrator.home, sheet: ORCHESTRATOR_SHEET },
];

const mapRight = (fit: SceneFit) => fit.left + SCENE_W * fit.scale;
const chatLeft = (fit: SceneFit, width: number) => width - CHAT_GAP_PX - fit.chatWidth;

describe("computeSceneFit với khung chat mở", () => {
  it.each(AREAS)("$name: hai agent ở góc home nằm hẳn bên trái khung chat", ({ width, height }) => {
    const fit = computeSceneFit(width, height, true);
    for (const { home, sheet } of HOME_ROBOTS) {
      const anchorX = fit.left + home.anchor.x * fit.scale;
      // Mép phải của ảnh robot (nửa thân bên phải điểm neo).
      const bodyRight = fit.left + (home.anchor.x - sheet.anchor.x + sheet.display.w) * fit.scale;
      expect(anchorX).toBeLessThan(chatLeft(fit, width));
      expect(bodyRight).toBeLessThan(chatLeft(fit, width));
    }
  });

  it.each(AREAS.filter((a) => a.name !== "1100x700"))("$name: bản đồ sát khung chat, chỉ cách một khe; không tràn dưới khung", ({ width, height }) => {
    const fit = computeSceneFit(width, height, true);
    const band = chatLeft(fit, width) - mapRight(fit);
    expect(band).toBeGreaterThan(CHAT_GAP_PX - 1e-6);
    // floor của bề rộng khung chat để lại chưa tới 1 px lẻ.
    expect(band).toBeLessThan(CHAT_GAP_PX + 1);
    expect(fit.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH_PX);
    expect(fit.chatWidth).toBeLessThanOrEqual(CHAT_MAX_WIDTH_PX);
    expect(fit.scale).toBeGreaterThan(MIN_SCENE_SCALE);
  });

  it("từng cỡ cửa sổ: bề rộng khung chat, scale và lề trái của bản đồ", () => {
    const at = (name: keyof typeof AREA) => computeSceneFit(AREA[name].width, AREA[name].height, true);
    // Rất rộng, bản đồ bị chiều cao giới hạn: khung chat ở tối đa, phần dư nằm bên trái bản đồ.
    expect(at("1920x1000")).toMatchObject({ chatWidth: CHAT_MAX_WIDTH_PX, left: 145, chatLayout: "side" });
    expect(at("1920x1000").scale).toBeCloseTo(899 / SCENE_H, 5);
    // Chiều cao vẫn là cạnh chật nhưng chỗ trống ít: khung chat nở ra lấp hết, không còn phần dư.
    expect(at("1600x1000")).toMatchObject({ chatWidth: 385, left: 0 });
    expect(at("1600x1000").scale).toBeCloseTo(899 / SCENE_H, 5);
    // Bề rộng là cạnh chật: khung chat ở tối thiểu, bản đồ co cho vừa phần còn lại.
    expect(at("1280x900")).toMatchObject({ chatWidth: CHAT_MIN_WIDTH_PX, left: 0 });
    expect(at("1280x900").scale).toBeCloseTo((1280 - 2 * CHAT_GAP_PX - CHAT_MIN_WIDTH_PX) / SCENE_W, 5);
    // Quá hẹp: sàn scale tối thiểu thắng, mép phải bản đồ nằm dưới khung chat (góc home thì không).
    const small = at("1100x700");
    expect(small).toMatchObject({ scale: MIN_SCENE_SCALE, chatWidth: CHAT_MIN_WIDTH_PX, left: 0 });
    expect(mapRight(small)).toBeGreaterThan(chatLeft(small, AREA["1100x700"].width));
  });

  it("khung chat thu gọn: bản đồ lấy cả vùng cảnh, canh giữa như trước", () => {
    for (const { width, height } of AREAS) {
      const fit = computeSceneFit(width, height, false);
      const scale = Math.max(MIN_SCENE_SCALE, Math.min(width / SCENE_W, height / SCENE_H));
      expect(fit).toMatchObject({ scale, chatWidth: 0, left: Math.max(0, Math.round((width - SCENE_W * scale) / 2)) });
    }
  });

  it("vùng cảnh hẹp hơn CHAT_SHEET_BELOW_PX: khung chat là bottom sheet, bản đồ không nhường chỗ", () => {
    const width = CHAT_SHEET_BELOW_PX - 1;
    const open = computeSceneFit(width, 800, true);
    expect(open).toMatchObject({ chatLayout: "sheet", chatWidth: 0 });
    expect(open).toEqual(computeSceneFit(width, 800, false));
    expect(computeSceneFit(CHAT_SHEET_BELOW_PX, 800, true)).toMatchObject({ chatLayout: "side", chatWidth: CHAT_MIN_WIDTH_PX });
  });
});

describe("useSceneScale", () => {
  const VIEW = AREA["1280x900"];

  function host() {
    const el = document.createElement("main");
    Object.defineProperty(el, "clientWidth", { value: VIEW.width });
    Object.defineProperty(el, "clientHeight", { value: VIEW.height });
    return el;
  }

  const scaleOf = (el: HTMLElement) => Number(el.style.getPropertyValue("--scene-scale"));
  const mount = (el: HTMLElement, open: boolean) => renderHook((chatOpen: boolean) => useSceneScale({ current: el }, chatOpen), { initialProps: open });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("lần đầu áp ngay, không bật transition; khung chat và bản đồ nhận hình học từ cùng một phép tính", () => {
    const el = host();
    mount(el, true);
    const fit = computeSceneFit(VIEW.width, VIEW.height, true);
    expect(scaleOf(el)).toBeCloseTo(fit.scale);
    expect(el.style.getPropertyValue("--scene-left")).toBe(`${fit.left}px`);
    expect(el.style.getPropertyValue("--chat-width")).toBe(`${fit.chatWidth}px`);
    expect(el.style.getPropertyValue("--chat-gap")).toBe(`${CHAT_GAP_PX}px`);
    expect(el.dataset.chatLayout).toBe("side");
    expect(el.style.getPropertyValue("--scene-fit-ms")).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("mở / thu gọn khung chat: bật transition trong SCENE_FIT_TRANSITION_MS rồi tắt", () => {
    const el = host();
    const { rerender } = mount(el, false);
    const closedScale = scaleOf(el);
    expect(el.style.getPropertyValue("--chat-width")).toBe("");

    rerender(true);
    expect(el.style.getPropertyValue("--scene-fit-ms")).toBe(`${SCENE_FIT_TRANSITION_MS}ms`);
    expect(scaleOf(el)).toBeLessThan(closedScale);
    expect(el.style.getPropertyValue("--chat-width")).toBe(`${CHAT_MIN_WIDTH_PX}px`);
    act(() => void vi.advanceTimersByTime(SCENE_FIT_TRANSITION_MS));
    expect(el.style.getPropertyValue("--scene-fit-ms")).toBe("");

    rerender(false);
    expect(el.style.getPropertyValue("--scene-fit-ms")).toBe(`${SCENE_FIT_TRANSITION_MS}ms`);
    expect(scaleOf(el)).toBe(closedScale);
    expect(el.style.getPropertyValue("--chat-width")).toBe("");
  });

  it("gỡ component giữa lúc trượt: dọn timer và biến transition", () => {
    const el = host();
    const { rerender, unmount } = mount(el, false);
    rerender(true);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(el.style.getPropertyValue("--scene-fit-ms")).toBe("");
  });
});
