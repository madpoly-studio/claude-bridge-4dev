import { describe, expect, it } from "vitest";
import { fnv1a32, SKIN_COUNT, skinOf } from "./skin";

describe("fnv1a32", () => {
  it("khớp các vector chuẩn của FNV-1a 32 bit", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("luôn trả số nguyên không dấu 32 bit", () => {
    for (const id of ["w-sh-01", "worker/ö/長い", "x".repeat(500)]) {
      const h = fnv1a32(id);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("skinOf", () => {
  it("là fnv1a32(worker_id) % 5", () => {
    for (const id of ["w-sh-01", "w-sh-02", "runner-a/wt-3", ""]) {
      expect(skinOf(id)).toBe(fnv1a32(id) % SKIN_COUNT);
    }
  });

  it("ổn định: giá trị cố định cho các id của demo (đổi hàm băm sẽ làm test này hỏng)", () => {
    expect(["w-sh-01", "w-sh-02", "w-sh-03", "w-sh-04", "w-sh-05"].map(skinOf)).toEqual([3, 4, 0, 1, 2]);
  });

  it("không phụ thuộc thứ tự gọi hay các worker khác", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `w-${i}`);
    const forward = ids.map(skinOf);
    const backward = [...ids].reverse().map(skinOf).reverse();
    expect(backward).toEqual(forward);
    expect(skinOf("w-7")).toBe(forward[7]);
  });

  it("phân bố khá đều trên 1000 id", () => {
    const counts = new Array<number>(SKIN_COUNT).fill(0);
    for (let i = 0; i < 1000; i++) counts[skinOf(`w-sh-${String(i).padStart(3, "0")}`)]! += 1;
    for (const c of counts) {
      expect(c).toBeGreaterThan(140);
      expect(c).toBeLessThan(260);
    }
  });
});
