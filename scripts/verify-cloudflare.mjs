// Read-only post-deployment checks; never creates an account or modifies plans.
const base =
  process.env.CLOUDFLARE_URL || "https://four-plans.zhangluck598.workers.dev";
for (const [path, expected] of [
  ["/api/health", 200],
  ["/api/session", 200],
  ["/api/board", 401],
  ["/api/quote", 401],
  ["/api/resources", 401],
]) {
  const response = await fetch(base + path, {
    signal: AbortSignal.timeout(12000),
  });
  if (response.status !== expected)
    throw new Error(`${path}: ${response.status}, expected ${expected}`);
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(`${path}: expected JSON`);
  const body = await response.json();
  if (path === "/api/health" && body.status !== "ok")
    throw new Error("Health check failed");
  if (path === "/api/session" && body.user !== null)
    throw new Error("Anonymous session must not expose a user");
  console.log(`${path}: ${expected}`);
}
const page = await fetch(base, { signal: AbortSignal.timeout(12000) });
if (!page.ok || !(await page.text()).includes('id="root"'))
  throw new Error("Frontend unavailable");
console.log("Frontend and protected API verified");
