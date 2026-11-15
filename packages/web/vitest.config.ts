import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    // Chỉ CSS của khung chat Văn phòng được xử lý thật (test selector cấu trúc cần nội dung file); còn lại vẫn là proxy tên class.
    css: { include: /floating-chat\.module\.css/, modules: { classNameStrategy: "non-scoped" } },
  },
});
