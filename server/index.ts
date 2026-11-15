import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerApiRoutes } from "./routes";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // Allow Chrome Gmail side-panel extension to talk to /api and /gmail-panel
  app.use((req, res, next) => {
    const origin = req.headers.origin || "";
    if (origin.startsWith("chrome-extension://") || origin.startsWith("https://mail.google.com")) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  registerApiRoutes(app);

  const isProd = process.env.NODE_ENV === "production";
  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      configFile: path.resolve(__dirname, "../vite.config.ts"),
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const publicDir = path.resolve(__dirname, "public");
    app.use(express.static(publicDir));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(publicDir, "index.html"));
    });
  }

  const port = Number(process.env.PORT) || 5090;
  app.listen(port, "127.0.0.1", () => {
    console.log(`[FiveNines Ops v2] Running on http://127.0.0.1:${port}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start FiveNines Ops server:", err);
  process.exit(1);
});
