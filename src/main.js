import os from "node:os";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT || 7777);
const dataDir = process.env.DATA_DIR || fileURLToPath(new URL("../data", import.meta.url));
const { app } = createApp({ dataDir });

// 0.0.0.0 so the iPad on the LAN can reach it.
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`ipad-send listening on http://${os.hostname()}:${port} (data: ${dataDir})`);
});
