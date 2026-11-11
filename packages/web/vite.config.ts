import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const DEV_PORT = 5173;

export default defineConfig({
  plugins: [react()],
  // Đường dẫn tương đối để thư mục dist/ chạy được ở bất kỳ sub-path nào trên host SSO.
  base: "./",
  server: { port: DEV_PORT, strictPort: true },
  preview: { port: DEV_PORT, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
});
