import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const origin = "https://local.test";
const sql1 = await readFile(
  new URL("../migrations/0001_initial.sql", import.meta.url),
  "utf8",
);
const sql2 = await readFile(
  new URL("../migrations/0002_add_reminders.sql", import.meta.url),
  "utf8",
);
const sql3 = await readFile(
  new URL("../migrations/0003_add_cancelled_at.sql", import.meta.url),
  "utf8",
);
const sql = sql1 + "\n" + sql2 + "\n" + sql3;
async function fixture(t) {
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
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(async () => {
    await mf.dispose();
    await rm(persist, { recursive: true, force: true });
  });
  let db = await mf.getD1Database("DB");
  const statements = sql
    .replace(/--[^\n]*/g, "")
    .match(/CREATE\s+TRIGGER[\s\S]*?END;|(?:CREATE|ALTER)[\s\S]*?;/g);
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
test("private setup, secure sessions, CSRF and persistent login limits", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send("GET", "/api/board")).status, 401);
  assert.equal((await f.send("GET", "/api/quote")).status, 401);
  assert.equal(
    (
      await f.send("POST", "/api/setup", {
        username: "x",
        password: "test-password-42",
        accessKey: "wrong",
      })
    ).status,
    403,
  );
  const session = await (await f.send("GET", "/api/session")).json();
  assert.equal(session.bootstrapRequired, true);
  await f.setup();
  assert.equal(
    (
      await f.send("POST", "/api/setup", {
        username: "x",
        password: "test-password-42",
        accessKey: "fixture-init-key",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.send(
        "POST",
        "/api/tasks",
        { title: "x", bucket: "today", date: "2026-10-13" },
        { Origin: "https://other.test" },
      )
    ).status,
    403,
  );
  const stored = await f.db.prepare("SELECT password_hash FROM users").first();
  assert.match(stored.password_hash, /^pbkdf2-sha256:100000:/);
  assert.ok(!stored.password_hash.includes("test-password"));
  assert.equal((await f.send("POST", "/api/logout")).status, 204);
  assert.equal((await f.send("GET", "/api/board")).status, 401);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await f.send("POST", "/api/login", {
          username: "测试空间",
          password: "incorrect",
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await f.send("POST", "/api/login", {
        username: "测试空间",
        password: "test-password-42",
      })
    ).status,
    429,
  );
  await f.now("2026-10-13T01:16:00Z");
  assert.equal(
    (
      await f.send("POST", "/api/login", {
        username: "测试空间",
        password: "test-password-42",
      })
    ).status,
    200,
  );
});
test("focus, task versions, actual completion time, moving and trash lifecycle", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const a = await f.create("today", "2026-10-13", "first", true),
    b = await f.create("today", "2026-10-13", "second", true);
  let board = await f.board();
  assert.equal(board.buckets.today.filter((v) => v.priority).length, 1);
  assert.equal(
    (
      await f.send("PATCH", "/api/tasks/" + a.id, {
        version: a.version,
        done: true,
      })
    ).status,
    409,
  );
  let r = await f.send("PATCH", "/api/tasks/" + b.id, {
    version: b.version,
    done: true,
  });
  assert.equal(r.status, 200);
  let task = await r.json();
  const completed = task.completedAt;
  await f.now("2026-10-14T01:00:00Z");
  r = await f.send("PATCH", "/api/tasks/" + b.id, {
    version: task.version,
    bucket: "week",
    date: "2026-10-14",
  });
  assert.equal(r.status, 200);
  task = await r.json();
  assert.equal(task.date, "2026-10-12");
  assert.equal(task.completedAt, completed);
  assert.equal(
    (await f.send("DELETE", "/api/tasks/" + b.id, { version: task.version }))
      .status,
    204,
  );
  board = await f.board("2026-10-14");
  assert.equal(board.statistics.completedPlans, 0);
  assert.equal(board.trash.length, 1);
  assert.equal(
    (
      await f.send("POST", "/api/trash/" + b.id + "/restore", {
        version: board.trash[0].version,
      })
    ).status,
    204,
  );
  board = await f.board("2026-10-14");
  task = board.buckets.week[0];
  assert.equal(task.completedAt, completed);
  assert.equal(board.statistics.completedPlans, 1);
  r = await f.send("PATCH", "/api/tasks/" + b.id, {
    version: task.version,
    done: false,
  });
  task = await r.json();
  assert.ok(!task.completedAt);
  assert.equal(
    (await f.send("DELETE", "/api/tasks/" + b.id, { version: task.version }))
      .status,
    204,
  );
  board = await f.board();
  assert.equal(
    (
      await f.send("DELETE", "/api/trash/" + b.id, {
        version: board.trash[0].version,
      })
    ).status,
    204,
  );
  assert.equal((await f.board()).statistics.totalPlans, 1);
});
test("daily goal catch-up, next-day revisions, pause/resume, tombstones and concurrency", async (t) => {
  const f = await fixture(t);
  await f.setup();
  let r = await f.send("POST", "/api/recurring", {
    title: "每天读书",
    start: "2026-10-13",
    end: "2026-10-20",
  });
  assert.equal(r.status, 201, await r.clone().text());
  let goal = await r.json();
  let b = await f.board("2026-10-19");
  assert.equal(b.statistics.totalPlans, 1);
  assert.equal(b.buckets.today.length, 0);
  b = await f.board();
  const first = b.buckets.today[0];
  assert.equal(first.recurringId, goal.id);
  r = await f.send("PATCH", "/api/tasks/" + first.id, {
    version: first.version,
    done: true,
  });
  assert.equal(r.status, 200);
  r = await f.send("PATCH", "/api/recurring/" + goal.id, {
    version: goal.version,
    title: "每天写作",
  });
  assert.equal(r.status, 200);
  goal = await r.json();
  assert.equal((await f.board()).buckets.today[0].title, "每天读书");
  await f.now("2026-10-16T01:00:00Z");
  const boards = await Promise.all(
    Array.from({ length: 5 }, () => f.board("2026-10-16")),
  );
  for (const b of boards) {
    assert.equal(b.statistics.totalPlans, 4);
    assert.equal(b.carryovers.length, 0);
    assert.equal(b.statistics.completionRate, 25);
    assert.equal(b.buckets.today[0].title, "每天写作");
  }
  const task = boards[0].buckets.today[0];
  assert.equal(
    (await f.send("DELETE", "/api/tasks/" + task.id, { version: task.version }))
      .status,
    204,
  );
  b = await f.board("2026-10-16");
  assert.equal(
    (
      await f.send("DELETE", "/api/trash/" + task.id, {
        version: b.trash[0].version,
      })
    ).status,
    204,
  );
  await f.db.prepare("UPDATE recurring_plans SET generated_until=''").run();
  assert.equal((await f.board("2026-10-16")).buckets.today.length, 0);
  r = await f.send("PATCH", "/api/recurring/" + goal.id, {
    version: goal.version,
    status: "paused",
  });
  assert.equal(r.status, 200);
  goal = await r.json();
  await f.now("2026-10-19T01:00:00Z");
  assert.equal((await f.board("2026-10-19")).statistics.totalPlans, 3);
  r = await f.send("PATCH", "/api/recurring/" + goal.id, {
    version: goal.version,
    status: "active",
  });
  assert.equal(r.status, 200);
  goal = await r.json();
  await f.now("2026-10-20T01:00:00Z");
  assert.equal((await f.board("2026-10-20")).statistics.totalPlans, 4);
  await f.now("2026-10-22T01:00:00Z");
  assert.equal((await f.board("2026-10-22")).statistics.totalPlans, 4);
  assert.equal(
    (
      await f.send("PATCH", "/api/recurring/" + goal.id, {
        version: 1,
        status: "stopped",
      })
    ).status,
    409,
  );
});
test("historic leap-year statistics, resource truth and cached quote fallback", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const task = await f.create("today", "2024-02-29", "历史任务");
  await f.db
    .prepare("UPDATE tasks SET done=1,completed_at=? WHERE id=?")
    .bind("2024-02-28T16:30:00Z", task.id)
    .run();
  const now = await f.create("today", "2026-10-13", "今天");
  assert.equal(
    (
      await f.send("PATCH", "/api/tasks/" + now.id, {
        version: now.version,
        done: true,
      })
    ).status,
    200,
  );
  const stats = await (await f.send("GET", "/api/statistics?year=2024")).json();
  assert.equal(stats.days.length, 366);
  assert.equal(stats.days[59].count, 1);
  assert.equal(stats.completedPlans, 2);
  assert.equal(stats.currentStreak, 1);
  assert.equal(stats.years.length, 3);
  const resources = await (await f.send("GET", "/api/resources")).json();
  assert.equal(resources.cloudflareConnected, true);
  assert.equal(resources.memory.usedBytes, null);
  assert.ok(resources.storage.usedBytes > 0);
  const q = await (await f.send("GET", "/api/quote")).json();
  assert.equal(q.fallback, true);
  assert.ok(q.text);
  assert.deepEqual(await (await f.send("GET", "/api/quote")).json(), q);
  const exported = await (await f.send("GET", "/api/export")).json();
  assert.equal(exported.formatVersion, 2);
  assert.equal(exported.tasks.length, 2);
  assert.equal((await f.send("GET", "/api/statistics?year=2027")).status, 400);
  assert.equal(
    (
      await f.send("POST", "/api/tasks", {
        title: "bad",
        bucket: "today",
        date: "2026-02-30",
      })
    ).status,
    400,
  );
});

test("reminder settings and task reminder flow", async (t) => {
  const f = await fixture(t);
  await f.setup();

  // Initial reminder settings
  const initRes = await f.send("GET", "/api/settings/reminder");
  assert.equal(initRes.status, 200);
  const initSettings = await initRes.json();
  assert.equal(initSettings.enabled, false);

  // Update reminder settings
  const updateRes = await f.send("PUT", "/api/settings/reminder", {
    enabled: true,
    webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
    webhookSecret: "test-secret",
    defaultAdvance: 15,
  });
  assert.equal(updateRes.status, 200);

  // Verify updated settings
  const verifyRes = await f.send("GET", "/api/settings/reminder");
  assert.equal(verifyRes.status, 200);
  const settings = await verifyRes.json();
  assert.equal(settings.enabled, true);
  assert.equal(settings.defaultAdvance, 15);

  // Board contains reminderSettings
  const boardRes = await f.send("GET", "/api/board");
  assert.equal(boardRes.status, 200);
  const board = await boardRes.json();
  assert.equal(board.reminderSettings?.enabled, true);
  assert.equal(board.reminderSettings?.defaultAdvance, 15);

  // Create task with reminder
  const taskRes = await f.send("POST", "/api/tasks", {
    title: "飞书提醒计划",
    bucket: "today",
    date: "2026-10-13",
    priority: true,
    reminderTime: "14:30",
    reminderAdvance: 15,
  });
  assert.equal(taskRes.status, 201);
  const task = await taskRes.json();
  assert.equal(task.reminderTime, "14:30");
  assert.equal(task.reminderAdvance, 15);

  // Update task reminder
  const patchRes = await f.send("PATCH", "/api/tasks/" + task.id, {
    version: task.version,
    reminderTime: "15:00",
    reminderAdvance: 5,
  });
  assert.equal(patchRes.status, 200);
  const updated = await patchRes.json();
  assert.equal(updated.reminderTime, "15:00");
  assert.equal(updated.reminderAdvance, 5);
});

test("day statistics detail endpoint", async (t) => {
  const f = await fixture(t);
  await f.setup();

  const taskRes = await f.send("POST", "/api/tasks", {
    title: "今日已完成任务",
    bucket: "today",
    date: "2026-10-13",
  });
  assert.equal(taskRes.status, 201);
  const task = await taskRes.json();

  await f.send("PATCH", "/api/tasks/" + task.id, {
    version: task.version,
    done: true,
  });

  await f.send("POST", "/api/tasks", {
    title: "今日未完成任务",
    bucket: "today",
    date: "2026-10-13",
  });

  // Create a 3-day task starting 2026-10-12 (cycle: 10-12, 10-13, 10-14)
  await f.send("POST", "/api/tasks", {
    title: "三天任务",
    bucket: "three",
    date: "2026-10-12",
  });

  // Query 2026-10-13 (Day 2 of three-day task): must NOT enter uncompleted yet
  const res = await f.send("GET", "/api/statistics/day?date=2026-10-13");
  assert.equal(res.status, 200);
  const detail = await res.json();
  assert.equal(detail.date, "2026-10-13");
  assert.equal(detail.completed.length, 1);
  assert.equal(detail.completed[0].id, task.id);
  assert.equal(detail.uncompleted.length, 1);
  assert.equal(detail.total, 2);
  assert.equal(detail.rate, 50);

  // Query 2026-10-14 (Day 3 of three-day task): enters 1天/today and uncompleted
  const res14 = await f.send("GET", "/api/statistics/day?date=2026-10-14");
  assert.equal(res14.status, 200);
  const detail14 = await res14.json();
  assert.equal(detail14.uncompleted.length, 1);
  assert.equal(detail14.uncompleted[0].bucket, "today");

  const badRes = await f.send("GET", "/api/statistics/day?date=bad-date");
  assert.equal(badRes.status, 400);
});

test("recurring records and checkin punch-in wall flow", async (t) => {
  const f = await fixture(t);
  await f.setup();

  const planRes = await f.send("POST", "/api/recurring", {
    title: "英语打卡计划",
    start: "2026-10-13",
    end: "2026-10-16",
  });
  assert.equal(planRes.status, 201);
  const plan = await planRes.json();

  // Move forward in time so 10-13, 10-14, 10-15 are past, 10-15 is today
  await f.now("2026-10-15T02:00:00Z");

  // Get initial records: 10-13 and 10-14 missed, 10-15 pending, 10-16 upcoming
  const recordsRes = await f.send("GET", `/api/recurring/${plan.id}/records`);
  assert.equal(recordsRes.status, 200);
  const history = await recordsRes.json();
  assert.equal(history.planId, plan.id);
  assert.equal(history.totalDays, 4);
  assert.equal(history.passedDays, 3);
  assert.equal(history.completedDays, 0);
  assert.equal(history.missedDays, 2);
  assert.equal(history.currentStreak, 0);

  // Retroactive checkin (补卡 2026-10-13)
  const checkinRes1 = await f.send("POST", `/api/recurring/${plan.id}/checkin`, {
    date: "2026-10-13",
    done: true,
  });
  assert.equal(checkinRes1.status, 200);
  const h1 = await checkinRes1.json();
  assert.equal(h1.completedDays, 1);
  assert.equal(h1.missedDays, 1);

  // Checkin today (2026-10-15)
  const checkinRes2 = await f.send("POST", `/api/recurring/${plan.id}/checkin`, {
    date: "2026-10-15",
    done: true,
  });
  assert.equal(checkinRes2.status, 200);
  const h2 = await checkinRes2.json();
  assert.equal(h2.completedDays, 2);
  assert.equal(h2.currentStreak, 1);

  // Board recurringPlans reflects missed and completed
  const b = await f.board("2026-10-15");
  const p = b.recurringPlans.find((item) => item.id === plan.id);
  assert.equal(p.completed, 2);
  assert.equal(p.missed, 1);
});
