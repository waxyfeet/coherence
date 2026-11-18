import { defineConfig, type ProxyOptions, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import path from "node:path";

export default defineConfig(async ({ command }): Promise<UserConfig> => {
  const shared: UserConfig = {
    plugins: [react()],
    build: { sourcemap: false },
  };
  // A production build needs no server settings; loading them would resolve the user's folders.
  if (command === "build") return shared;
  const { config } = await import("./server/config");

  const localProxy: ProxyOptions = {
    target: `http://127.0.0.1:${config.port}`,
    configure(proxy) {
      proxy.on("proxyReq", (upstream, req) => {
        // This credential stays on the owner-controlled server side of Vite, never in browser code.
        upstream.removeHeader("X-ScreenScribe-Dev-Proxy");
        try {
          const { capability } = JSON.parse(
            readFileSync(
              path.join(config.dataDir, ".local-auth/launch.json"),
              "utf8",
            ),
          ) as { capability: string };
          if (/^[a-f0-9]{64}$/.test(capability))
            upstream.setHeader(
              "X-ScreenScribe-Dev-Proxy",
              createHmac("sha256", capability)
                .update(`dev-proxy\n${req.headers.host}`)
                .digest("hex"),
            );
        } catch {
          /* A missing/stale launcher record must fail closed at the backend. */
        }
      });
    },
  };

  return {
    ...shared,
    server: {
      host: "127.0.0.1",
      port: config.devPort,
      strictPort: true,
      proxy: { "/api": localProxy },
      watch: {
        ignored: [
          "**/.cache/**",
          "**/.screenscribe-v2/**",
          "**/artifacts/**",
          "**/.local-auth/**",
          "**/build/**",
          config.dataDir.replace(/\\/g, "/") + "/**",
        ],
      },
      fs: {
        deny: [
          "**/.env*",
          "**/.screenscribe-v2/**",
          "**/.cache/**",
          "**/.local-auth/**",
          config.dataDir.replace(/\\/g, "/") + "/**",
          "**/*.pem",
          "**/*.key",
        ],
      },
    },
    preview: {
      host: "127.0.0.1",
      port: config.devPort,
      strictPort: true,
      proxy: { "/api": localProxy },
    },
  };
});
