import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
export const origin = "https://local.test";
const migrationDir = new URL("../migrations/", import.meta.url);
const sql = (
  await Promise.all(
    (await readdir(migrationDir))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => readFile(new URL(name, migrationDir), "utf8")),
  )
).join("\n");
export async function fixture(t, overrides = {}) {
  const persist = await mkdtemp(path.join(tmpdir(), "four-plans-d1-"));
  const options = {
    modules: true,
    scriptPath: path.resolve(
      import.meta.dirname,
      "../.wrangler/test-worker/index.js",
    ),
    compatibilityDate: "2026-10-01",
    d1Databases: { DB: "fixture" },
    d1Persist: persist,
    bindings: {
      BOOTSTRAP_TOKEN: "fixture-init-key",
      TEST_NOW: "2026-10-13T01:00:00Z",
      QUOTE_URL: "invalid-url",
    },
    serviceBindings: { ASSETS: () => new Response("frontend") },
    ...overrides,
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(async () => {
    await mf.dispose();
    await rm(persist, { recursive: true, force: true });
  });
  let db = await mf.getD1Database("DB");
  const statements = sql
    .replace(/--[^\n]*/g, "")
    .match(/CREATE\s+TRIGGER[\s\S]*?END;|(?:CREATE|ALTER|UPDATE)[\s\S]*?;/g);
  for (const statement of statements) await db.prepare(statement).run();
  let cookie = "";
  const send = async (method, url, body, extraHeaders = {}) => {
    const response = await mf.dispatchFetch(origin + url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...extraHeaders,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.headers.get("Set-Cookie"))
      cookie = response.headers.get("Set-Cookie").split(";")[0];
    return response;
  };
  const setup = async () => {
    const r = await send("POST", "/api/setup", {
      username: "测试空间",
      password: "test-password-42",
      accessKey: "fixture-init-key",
    });
    assert.equal(r.status, 201, await r.clone().text());
    assert.match(r.headers.get("Set-Cookie"), /Secure/);
    assert.match(r.headers.get("Set-Cookie"), /HttpOnly/);
  };
  const now = async (value) => {
    options.bindings.TEST_NOW = value;
    await mf.setOptions(convertV4MiniflareOptions(options));
    db = await mf.getD1Database("DB");
  };
  const board = async (date = "2026-10-13") => {
    const r = await send("GET", "/api/board?date=" + date);
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const create = async (bucket, date, title, priority = false) => {
    const r = await send("POST", "/api/tasks", {
      bucket,
      date,
      title,
      priority,
    });
    assert.equal(r.status, 201, await r.clone().text());
    return r.json();
  };
  return {
    mf,
    get db() {
      return db;
    },
    send,
    setup,
    now,
    board,
    create,
  };
}
