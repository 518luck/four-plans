import { spawn } from "node:child_process";
import path from "node:path";
import { root, binary } from "./go.mjs";

const child = spawn(binary, [], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    HOST: process.env.HOST || "127.0.0.1",
    PORT: process.env.PORT || "8788",
    DATA_PATH: process.env.DATA_PATH || path.join(root, ".data/plans.db"),
    STATIC_DIR: path.join(root, "web/dist"),
  },
});
child.on("error", () => {
  console.error("请先运行 pnpm build，再启动。");
  process.exit(1);
});
child.on("exit", (code) => process.exit(code || 0));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
