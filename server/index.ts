import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAuth } from "./auth";
import { registerApiRoutes } from "./routes";
import { registerPfdGateway } from "./pfd-gateway";
import { store } from "./store";
import { startTaiWritebackPollerIfEnabled } from "./tai-writeback-poller";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "2mb" }));

  // Allow Chrome Gmail side-panel extension to talk to /api and /gmail-panel with credentials
  app.use((req, res, next) => {
    const origin = req.headers.origin || "";
    if (origin.startsWith("chrome-extension://") || origin.startsWith("https://mail.google.com")) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, x-csrf-token, x-gmail-panel-expected-email",
      );
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  registerAuth(app);
  registerApiRoutes(app);
  // /api/pfd/* → Primary Freight Dashboard staff APIs (see server/pfd-gateway.ts)
  registerPfdGateway(app);

  // Hydrate Supabase & Realtime in background on startup, and start poller if enabled
  store.initSupabaseSyncAndRealtime().catch(() => {});
  startTaiWritebackPollerIfEnabled();

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
  const host = isProd ? "0.0.0.0" : "127.0.0.1";
  app.listen(port, host, () => {
    console.log(`[FiveNines Ops v2] Listening on http://${host}:${port}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start FiveNines Ops server:", err);
  process.exit(1);
});
