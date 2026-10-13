import { spawn } from "node:child_process";
import path from "node:path";
import { root, binary, runGo } from "./go.mjs";

await runGo(["build", "-tags=nomsgpack", "-p=4", "-o", binary, "./cmd/server"]);
const env = {
  ...process.env,
  HOST: process.env.HOST || "127.0.0.1",
  PORT: "8788",
  DATA_PATH: process.env.DATA_PATH || path.join(root, ".data/plans.db"),
  STATIC_DIR: path.join(root, "web/dist"),
};
const children = [
  spawn(binary, [], {
    cwd: root,
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  }),
  spawn("pnpm", ["--dir", "web", "dev"], {
    cwd: root,
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  }),
];
function signalChildren(signal) {
  for (const child of children) {
    if (!child.pid) continue;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") console.error(error.message);
    }
  }
}
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  signalChildren("SIGTERM");
  setTimeout(() => {
    signalChildren("SIGKILL");
    process.exit(code);
  }, 2000).unref();
}
for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code || 0);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
