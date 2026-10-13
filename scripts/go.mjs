import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const goEnv = {
  ...process.env,
  GOTOOLCHAIN: "local",
  GOMODCACHE: path.join(root, ".cache/go-mod"),
  GOCACHE: path.join(root, ".cache/go-build"),
};
export const binary = path.join(root, ".cache/four-plans-server");

export async function runGo(args) {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn("go", args, {
      cwd: path.join(root, "api"),
      env: goEnv,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Go command exited ${code}`)),
    );
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const args =
    command === "build"
      ? ["build", "-tags=nomsgpack", "-p=4", "-o", binary, "./cmd/server"]
      : command === "test"
        ? ["test", "-race", "-tags=nomsgpack", "-p=4", "./..."]
        : ["vet", "-tags=nomsgpack", "-p=4", "./..."];
  await runGo(args);
}
