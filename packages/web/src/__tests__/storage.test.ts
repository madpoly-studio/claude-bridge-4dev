import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../config";
import { readStorage, writeStorage } from "../lib/storage";
import { forgetRememberedToken, loadToken, saveToken } from "../lib/token-storage";
import { LiveBridgeService } from "../services/live-bridge-service";
import { createStore } from "../state/store";
import { createFakeTransport } from "./fake-transport";

const KEY = STORAGE_KEYS.token;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("readStorage / writeStorage", () => {
  it("đọc/ghi đúng vùng local hoặc session", () => {
    writeStorage("k", "L");
    writeStorage("k", "S", "session");
    expect(localStorage.getItem("k")).toBe("L");
    expect(sessionStorage.getItem("k")).toBe("S");
    writeStorage("k", null, "session");
    expect(readStorage("k", "session")).toBeNull();
    expect(readStorage("k")).toBe("L");
  });

  it("không ném khi storage không tồn tại (Node) hoặc bị chặn", () => {
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("sessionStorage", undefined);
    expect(readStorage("k")).toBeNull();
    expect(() => writeStorage("k", "v", "session")).not.toThrow();
    expect(loadToken()).toEqual({ token: null, remember: false });
    expect(() => saveToken("t", true)).not.toThrow();
    vi.unstubAllGlobals();

    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    vi.stubGlobal("localStorage", throwing);
    expect(readStorage("k")).toBeNull();
    expect(() => writeStorage("k", "v")).not.toThrow();
    expect(() => forgetRememberedToken()).not.toThrow();
  });
});

describe("token storage", () => {
  it("mặc định chỉ lưu trong sessionStorage", () => {
    saveToken("t1", false);
    expect(sessionStorage.getItem(KEY)).toBe("t1");
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(loadToken()).toEqual({ token: "t1", remember: false });
  });

  it("ghi nhớ: lưu trong localStorage và xóa bản session", () => {
    sessionStorage.setItem(KEY, "old");
    saveToken("t2", true);
    expect(localStorage.getItem(KEY)).toBe("t2");
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(loadToken()).toEqual({ token: "t2", remember: true });
  });

  it("bỏ ghi nhớ xóa token khỏi localStorage", () => {
    saveToken("t3", true);
    saveToken("t3", false);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(loadToken()).toEqual({ token: "t3", remember: false });
  });

  it("token cũ trong localStorage vẫn dùng được và coi như đã chọn ghi nhớ", () => {
    localStorage.setItem(KEY, "legacy");
    expect(loadToken()).toEqual({ token: "legacy", remember: true });
  });

  it("forgetRememberedToken chuyển token sang session của tab hiện tại", () => {
    localStorage.setItem(KEY, "legacy");
    forgetRememberedToken();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(loadToken()).toEqual({ token: "legacy", remember: false });
  });

  it("LiveBridgeService.connect: mặc định sessionStorage, remember=true thì localStorage, không nói thì giữ nguyên", () => {
    const service = new LiveBridgeService(createStore(), { transport: createFakeTransport().factory });
    service.connect("ws://x/ws", "a");
    expect(sessionStorage.getItem(KEY)).toBe("a");
    expect(localStorage.getItem(KEY)).toBeNull();

    service.connect("ws://x/ws", "b", { remember: true });
    expect(localStorage.getItem(KEY)).toBe("b");
    expect(sessionStorage.getItem(KEY)).toBeNull();

    // Tự kết nối lại (không truyền remember) giữ lựa chọn ghi nhớ.
    service.connect("ws://x/ws", "b");
    expect(localStorage.getItem(KEY)).toBe("b");
    service.disconnect();
  });
});
