import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PermissionEditForm } from "../components/planner/PermissionEditForm";

afterEach(cleanup);

const ADF = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Mô tả ADF" }] }] };
const INPUT = { project_key: "SH", summary: "Cũ", description: ADF };

function setup(input: Record<string, unknown> = INPUT) {
  const onSubmit = vi.fn();
  render(<PermissionEditForm input={input} submitting={false} onSubmit={onSubmit} onCancel={() => undefined} />);
  return onSubmit;
}

const rawValue = () => (screen.getByLabelText("Input của tool (JSON)") as HTMLTextAreaElement).value;

describe("PermissionEditForm", () => {
  it("chỉ đổi tiêu đề: gửi input gốc với tiêu đề mới, mô tả ADF không bị làm phẳng, không thêm labels", () => {
    const onSubmit = setup();
    fireEvent.change(screen.getByLabelText("Tiêu đề"), { target: { value: "  Mới  " } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu và tạo ticket" }));
    expect(onSubmit).toHaveBeenCalledWith({ project_key: "SH", summary: "Mới", description: ADF });
  });

  it("JSON thô khởi tạo từ input gốc chưa bị ghi lại", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Sửa JSON thô" }));
    expect(JSON.parse(rawValue())).toEqual(INPUT);
  });

  it("đã sửa form rồi mới chuyển JSON thô: chỉ mang theo trường đã sửa", () => {
    const onSubmit = setup();
    fireEvent.change(screen.getByLabelText("Tiêu đề"), { target: { value: "Mới" } });
    fireEvent.click(screen.getByRole("button", { name: "Sửa JSON thô" }));
    expect(JSON.parse(rawValue())).toEqual({ ...INPUT, summary: "Mới" });
    fireEvent.click(screen.getByRole("button", { name: "Lưu và tạo ticket" }));
    expect(onSubmit).toHaveBeenCalledWith({ ...INPUT, summary: "Mới" });
  });
});
