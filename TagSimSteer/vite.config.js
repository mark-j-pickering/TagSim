import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 is Vite's own default and collides with other projects on this
    // machine (Windows dual-stack binding can then route "localhost" to the
    // wrong app instead of erroring). Use a less common port, and fail
    // loudly on conflict rather than silently retrying elsewhere.
    port: process.env.PORT ? Number(process.env.PORT) : 5183,
    strictPort: true,
  },
});
