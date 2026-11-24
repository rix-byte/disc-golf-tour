import { mkdirSync, writeFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

// Dev only: POST a PNG to /__shot?name=x and it lands in shots/x.png,
// so screenshots can be taken even while the browser tab is in the background.
const shots: Plugin = {
  name: "shots",
  configureServer(server) {
    server.middlewares.use("/__shot", (req, res) => {
      const name = (new URL(req.url ?? "/", "http://x").searchParams.get("name") ?? "shot").replace(/[^\w.-]/g, "");
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        mkdirSync("shots", { recursive: true });
        writeFileSync(`shots/${name}.png`, Buffer.concat(chunks));
        res.end("ok");
      });
    });
  },
};

export default defineConfig({
  // Relative paths: the build works from any folder (GitHub Pages serves it under /<repo>/).
  base: "./",
  plugins: [shots],
  server: { port: 5190, strictPort: true },
  build: { outDir: "dist", chunkSizeWarningLimit: 2000, rollupOptions: { input: { main: "index.html" } } },
});
