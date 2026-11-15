import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OFFICE_FAILED_NOTICE, OFFICE_STORAGE_KEYS } from "../constants";
import { installMemoryStorage } from "./memory-storage";

// S1: Văn phòng hỏng (code ném lỗi lúc render, hoặc chunk nạp lười không tải được) thì không được trắng trang.
function visit(search: string) {
  window.history.replaceState({}, "", `/${search}`);
}

/** Nạp lại App với OfficeView giả; AppShell giữ `lazy(...)` ở mức module nên phải reset module. */
async function loadApp(officeModule: () => Record<string, unknown>) {
  vi.resetModules();
  vi.doMock("../OfficeView", officeModule);
  return (await import("../../../App")).App;
}

const brokenRender = () => ({
  default: () => {
    throw new Error("office render lỗi");
  },
});
const brokenChunk = () => {
  throw new Error("không tải được chunk");
};

beforeAll(installMemoryStorage);

beforeEach(() => {
  localStorage.clear();
  // React in lỗi đã bị boundary chặn ra console.error.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.doUnmock("../OfficeView");
  vi.restoreAllMocks();
  localStorage.clear();
  visit("");
});

async function expectFellBackToDashboard() {
  expect(await screen.findByRole("region", { name: "Log" })).toBeTruthy();
  expect(screen.queryByRole("main", { name: "Văn phòng" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain(OFFICE_FAILED_NOTICE);
  expect(screen.getByRole("button", { name: "Chuyển sang chế độ Văn phòng" })).toBeTruthy();
  expect(localStorage.getItem(OFFICE_STORAGE_KEYS.viewMode)).toBe("dashboard");
}

describe("Văn phòng hỏng → quay về dashboard", () => {
  it("OfficeView ném lỗi lúc render với ?view=office: hiện dashboard kèm thông báo, gỡ ?view và ghi nhớ dashboard", async () => {
    visit("?view=office&scenario=still");
    const App = await loadApp(brokenRender);
    render(<App demo />);
    await expectFellBackToDashboard();
    // Không còn ?view=office: tải lại trang không rơi vào lỗi lần nữa.
    expect(new URLSearchParams(window.location.search).has("view")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("scenario")).toBe("still");
  });

  it("lựa chọn Văn phòng đã nhớ: sau khi hỏng, lần tải sau vào thẳng dashboard, không báo lỗi lại", async () => {
    localStorage.setItem(OFFICE_STORAGE_KEYS.viewMode, "office");
    const App = await loadApp(brokenRender);
    render(<App demo />);
    await expectFellBackToDashboard();

    cleanup();
    render(<App demo />);
    expect(screen.getByRole("region", { name: "Log" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("chunk của Văn phòng không tải được: cũng quay về dashboard", async () => {
    visit("?view=office");
    const App = await loadApp(brokenChunk);
    render(<App demo />);
    await expectFellBackToDashboard();
    expect(new URLSearchParams(window.location.search).has("view")).toBe(false);
  });
});
