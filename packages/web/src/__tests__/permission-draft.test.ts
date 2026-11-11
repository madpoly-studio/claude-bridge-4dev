import { describe, expect, it } from "vitest";
import { applyDraftEdits, draftFromInput, editsFromInput, splitAcceptance } from "../state/permission-draft";

describe("draftFromInput", () => {
  it("đọc input dạng mcp-atlassian (additional_fields là chuỗi JSON)", () => {
    const d = draftFromInput({
      project_key: "SH",
      issue_type: "Bug",
      summary: "Reload bị bỏ qua",
      description: "Đặt lại cờ.\n\n## Tiêu chí nghiệm thu\n- Điều kiện 1\n- Điều kiện 2",
      additional_fields: JSON.stringify({ labels: ["agent"] }),
    });
    expect(d).toEqual({
      type: "Bug",
      project: "SH",
      labels: ["agent"],
      title: "Reload bị bỏ qua",
      description: "Đặt lại cờ.",
      solution: null,
      acceptance: ["Điều kiện 1", "Điều kiện 2"],
    });
  });

  it("đọc input dạng Jira REST (fields, object có name/key)", () => {
    const d = draftFromInput({
      fields: {
        project: { key: "MPS" },
        issuetype: { name: "Task" },
        title: "T",
        labels: "agent, ui",
        acceptance_criteria: ["A", "B"],
        description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Mô tả ADF" }] }] },
      },
    });
    expect(d.project).toBe("MPS");
    expect(d.type).toBe("Task");
    expect(d.title).toBe("T");
    expect(d.labels).toEqual(["agent", "ui"]);
    expect(d.acceptance).toEqual(["A", "B"]);
    expect(d.description).toBe("Mô tả ADF");
  });

  it("input rỗng hoặc lạ không ném lỗi", () => {
    expect(draftFromInput(undefined).title).toBeNull();
    expect(draftFromInput({ weird: [1, 2] }).labels).toEqual([]);
  });

  it("splitAcceptance chỉ tách khi có heading", () => {
    expect(splitAcceptance("Không có heading").acceptance).toEqual([]);
    expect(splitAcceptance("A\nAcceptance criteria:\n1. X\n2) Y\n## Khác\nZ")).toEqual({ body: "A\n## Khác\nZ", acceptance: ["X", "Y"] });
  });
});

describe("applyDraftEdits", () => {
  it("ghi vào đúng khóa gốc và giữ định dạng additional_fields", () => {
    const input = { project_key: "SH", title: "Cũ", description: "D", additional_fields: JSON.stringify({ labels: ["agent"], priority: "High" }) };
    const out = applyDraftEdits(input, { summary: "Mới", description: "D2", labels: ["agent", "ui"] });
    expect(out.title).toBe("Mới");
    expect(out.summary).toBeUndefined();
    expect(out.description).toBe("D2");
    expect(JSON.parse(out.additional_fields as string)).toEqual({ labels: ["agent", "ui"], priority: "High" });
    // Không đổi input gốc.
    expect(input.title).toBe("Cũ");
  });

  it("ghi vào fields khi input dạng Jira REST; labels dạng chuỗi giữ dạng chuỗi", () => {
    const out = applyDraftEdits({ fields: { summary: "A", labels: "x,y" } }, { summary: "B", description: "Mô tả", labels: ["z"] });
    expect(out.fields).toEqual({ summary: "B", labels: "z", description: "Mô tả" });
  });

  it("thêm khóa mặc định khi input không có trường", () => {
    const out = applyDraftEdits({}, { summary: "S", description: "", labels: [] });
    expect(out).toEqual({ summary: "S", description: "", labels: [] });
  });

  it("editsFromInput lấy giá trị ban đầu cho form", () => {
    expect(editsFromInput({ summary: "S", description: "D", labels: ["a"] })).toEqual({ summary: "S", description: "D", labels: ["a"] });
  });
});
