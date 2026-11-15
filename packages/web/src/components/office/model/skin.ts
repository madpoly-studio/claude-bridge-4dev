// Skin worker = hàm băm thuần của worker_id: cùng id luôn ra cùng skin, trên mọi máy,
// không phụ thuộc thứ tự hay số lượng worker.

export const SKIN_COUNT = 5;
export type SkinIndex = 0 | 1 | 2 | 3 | 4;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32 bit trên các code unit UTF-16 của chuỗi. Trả số nguyên không dấu. */
export function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

export function skinOf(workerId: string): SkinIndex {
  return (fnv1a32(workerId) % SKIN_COUNT) as SkinIndex;
}
