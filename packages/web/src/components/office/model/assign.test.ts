import { describe, expect, it } from "vitest";
import { assignDesks, assignSlots, deskIndexOf } from "./assign";

const POOL = ["s0", "s1", "s2", "s3"];
const cand = (...pairs: Array<[string, number]>) => pairs.map(([workerId, index]) => ({ workerId, index }));

describe("deskIndexOf", () => {
  it("chỉ số = vị trí trong danh sách đã sắp", () => {
    const map = deskIndexOf(["a", "b", "c"]);
    expect([map.get("a"), map.get("b"), map.get("c")]).toEqual([0, 1, 2]);
    expect(map.get("x")).toBeUndefined();
  });
});

describe("assignSlots", () => {
  it("stable: worker chỉ số i nhận pool[i % n], không trùng slot", () => {
    const r = assignSlots(cand(["a", 0], ["b", 2], ["c", 5]), POOL, "stable");
    expect(Object.fromEntries(r.placed)).toEqual({ a: "s0", b: "s2", c: "s1" });
    expect(r.overflow).toEqual([]);
    expect(new Set(r.placed.values()).size).toBe(3);
  });

  it("stable: slot ưu tiên bị chiếm thì lấy slot trống kế tiếp theo vòng", () => {
    const r = assignSlots(cand(["a", 3], ["b", 7], ["c", 11]), POOL, "stable");
    expect(Object.fromEntries(r.placed)).toEqual({ a: "s3", b: "s0", c: "s1" });
  });

  it("stable: worker giữ nguyên chỗ khi worker khác rời đi", () => {
    const before = assignSlots(cand(["a", 0], ["b", 1], ["c", 2]), POOL, "stable");
    const after = assignSlots(cand(["a", 0], ["c", 2]), POOL, "stable");
    expect(after.placed.get("a")).toBe(before.placed.get("a"));
    expect(after.placed.get("c")).toBe(before.placed.get("c"));
  });

  it("compact: lấp từ đầu pool theo thứ tự đầu vào", () => {
    const r = assignSlots(cand(["a", 4], ["b", 9]), POOL, "compact");
    expect(Object.fromEntries(r.placed)).toEqual({ a: "s0", b: "s1" });
  });

  it("tràn: phần dư vào overflow theo thứ tự đầu vào, không ai bị mất", () => {
    const many = cand(["a", 0], ["b", 1], ["c", 2], ["d", 3], ["e", 4], ["f", 5]);
    for (const mode of ["stable", "compact"] as const) {
      const r = assignSlots(many, POOL, mode);
      expect(r.placed.size).toBe(4);
      expect(new Set(r.placed.values()).size).toBe(4);
      expect(r.overflow).toEqual(["e", "f"]);
    }
  });

  it("pool rỗng: tất cả vào overflow", () => {
    expect(assignSlots(cand(["a", 0]), [], "stable")).toEqual({ placed: new Map(), overflow: ["a"] });
  });
});

describe("assignDesks", () => {
  const DESKS = ["d0", "d1", "d2"];

  it("worker có chỉ số trong số bàn nhận bàn nhà của nó", () => {
    const r = assignDesks(cand(["a", 0], ["c", 2]), DESKS);
    expect(Object.fromEntries(r.placed)).toEqual({ a: "d0", c: "d2" });
    expect(r.overflow).toEqual([]);
  });

  it("worker ngoài số bàn nhận bàn trống đầu tiên, không tràn khi còn bàn", () => {
    const r = assignDesks(cand(["b", 1], ["x", 7], ["y", 9]), DESKS);
    expect(Object.fromEntries(r.placed)).toEqual({ b: "d1", x: "d0", y: "d2" });
    expect(r.overflow).toEqual([]);
  });

  it("chỉ tràn khi mọi bàn đều có người, theo thứ tự đầu vào", () => {
    const r = assignDesks(cand(["a", 0], ["b", 1], ["c", 2], ["x", 7], ["y", 9]), DESKS);
    expect(r.placed.size).toBe(3);
    expect(r.overflow).toEqual(["x", "y"]);
  });

  it("giữ bàn của lượt trước: worker có bàn nhà đang bị ngồi nhờ lấy bàn trống khác, không ai bị đổi chỗ", () => {
    const first = assignDesks(cand(["x", 7]), DESKS);
    expect(first.placed.get("x")).toBe("d0");
    // "a" (bàn nhà d0) bận sau: x vẫn ở d0, a sang bàn trống đầu tiên.
    const second = assignDesks(cand(["a", 0], ["x", 7]), DESKS, first.placed);
    expect(Object.fromEntries(second.placed)).toEqual({ a: "d1", x: "d0" });
    // Lượt sau nữa không ai nhảy bàn, kể cả khi bàn nhà của a trống trở lại.
    const third = assignDesks(cand(["a", 0]), DESKS, second.placed);
    expect(third.placed.get("a")).toBe("d1");
  });

  it("bàn nhớ không còn hợp lệ hoặc bị trùng thì gán lại", () => {
    const prev = new Map([
      ["a", "gone"],
      ["b", "d2"],
      ["c", "d2"],
    ]);
    const r = assignDesks(cand(["a", 0], ["b", 1], ["c", 2]), DESKS, prev);
    expect(Object.fromEntries(r.placed)).toEqual({ a: "d0", b: "d2", c: "d1" });
    expect(new Set(r.placed.values()).size).toBe(3);
  });

  it("không có bàn nào: tất cả tràn", () => {
    expect(assignDesks(cand(["a", 0]), [])).toEqual({ placed: new Map(), overflow: ["a"] });
  });
});
