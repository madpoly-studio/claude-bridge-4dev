import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../App";

afterEach(cleanup);

describe("App (demo mode)", () => {
  it("render đủ 3 cột, top bar và card duyệt", () => {
    render(<App demo />);
    expect(screen.getByRole("heading", { name: "claude-bridge" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Planner" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Orchestrator" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Log" })).toBeTruthy();
    expect(screen.getByText("Dừng giao việc")).toBeTruthy();
    expect(screen.getByText("Đang chạy")).toBeTruthy();

    const planner = screen.getByRole("region", { name: "Planner" });
    expect(within(planner).getByText("Bản nháp ticket")).toBeTruthy();
    expect(within(planner).getByText("Đã đọc 6 file")).toBeTruthy();
    expect(within(planner).getByRole("button", { name: "Duyệt và tạo ticket" })).toBeTruthy();

    const orch = screen.getByRole("region", { name: "Orchestrator" });
    expect(within(orch).getByText("3 turn hệ thống")).toBeTruthy();
    expect(within(orch).getByText("assign_task(w-sh-01, SH-129)")).toBeTruthy();
    expect(within(orch).getByText("SH-127, build_failed")).toBeTruthy();

    const log = screen.getByRole("region", { name: "Log" });
    expect(within(log).getByText("w-sh-01")).toBeTruthy();
    expect(within(log).getAllByText("BUSY").length).toBeGreaterThan(0);
    expect(within(log).getByText("IDLE")).toBeTruthy();
    expect(within(log).getByText("OFFLINE")).toBeTruthy();
  });

  it("chuyển tab Tickets / Events và mở chi tiết task", () => {
    render(<App demo />);
    fireEvent.click(screen.getByRole("tab", { name: /Tickets/ }));
    expect(screen.getByText(/CHỜ GIAO/)).toBeTruthy();
    expect(screen.getByText("bị chặn bởi SH-128")).toBeTruthy();
    expect(screen.getByText("MR !412")).toBeTruthy();
    expect(screen.getByText("build_failed · lần 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Events/ }));
    fireEvent.click(screen.getByRole("button", { name: "chỉ lỗi" }));
    expect(screen.getByText("SH-127 · build_failed · lần 1 · CS0246")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Workers/ }));
    fireEvent.click(screen.getByRole("button", { name: /w-sh-01, BUSY, SH-129/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("RUNNING")).toBeTruthy();
    expect(within(dialog).getByText("Chỉ xem. Lệnh cho worker đi qua orchestrator.")).toBeTruthy();
    expect(within(dialog).getByText("agent/SH-129")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Đóng" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("duyệt bản nháp trong demo xóa card và thêm ticket", async () => {
    render(<App demo />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Duyệt và tạo ticket" }));
    });
    expect(screen.queryByText("Bản nháp ticket")).toBeNull();
    expect(screen.getByText(/Đã tạo SH-134/)).toBeTruthy();
  });

  it("Dừng giao việc chuyển thành Tiếp tục giao việc", async () => {
    render(<App demo />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dừng giao việc" }));
    });
    expect(screen.getByRole("button", { name: "Tiếp tục giao việc" })).toBeTruthy();
    expect(screen.getByText("assign_task sẽ bị từ chối. Task đang chạy không bị ảnh hưởng.")).toBeTruthy();
  });

  it("không có demo và chưa có token: hiện màn hình kết nối", () => {
    render(<App demo={false} />);
    expect(screen.getByRole("button", { name: "Kết nối" })).toBeTruthy();
    expect(screen.getByLabelText("Pairing token")).toBeTruthy();
  });
});
