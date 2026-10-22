import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixture, origin } from "./fixture.mjs";

async function reminders(t, outbound) {
  const notifications = [];
  const f = await fixture(t, {
    unsafeTriggerHandlers: true,
    outboundService: async (request) => {
      notifications.push(await request.json());
      if (outbound) await outbound(notifications.length);
      return Response.json({ code: 0 });
    },
  });
  await f.setup();
  assert.equal(
    (
      await f.send("PUT", "/api/settings/reminder", {
        enabled: true,
        webhookUrl: "https://webhook.test/reminder",
        defaultAdvance: 0,
      })
    ).status,
    200,
  );
  return {
    ...f,
    get db() {
      return f.db;
    },
    notifications,
    async trigger() {
      const r = await f.mf.dispatchFetch(origin + "/cdn-cgi/local/scheduled");
      assert.equal(r.status, 200, await r.text());
    },
    async create(input = {}) {
      const r = await f.send("POST", "/api/tasks", {
        title: "提醒日期",
        bucket: "today",
        date: "2026-10-13",
        reminderTime: "09:00",
        ...input,
      });
      assert.equal(r.status, 201, await r.clone().text());
      return r.json();
    },
    async patch(task, input) {
      const r = await f.send("PATCH", `/api/tasks/${task.id}`, {
        version: task.version,
        ...input,
      });
      assert.equal(r.status, 200, await r.clone().text());
      return r.json();
    },
  };
}

test("week and month reminders retain the chosen day instead of the period start", async (t) => {
  const f = await reminders(t);
  for (const [bucket, normalized] of [
    ["week", "2026-10-12"],
    ["month", "2026-10-01"],
  ]) {
    const task = await f.create({ bucket });
    assert.equal(task.date, normalized);
    assert.equal(task.reminderDate, "2026-10-13");
  }
  await f.trigger();
  await f.trigger();
  assert.equal(f.notifications.length, 2);
});

test("reminder date can change independently, survive edits and follow rescheduling", async (t) => {
  const f = await reminders(t);
  let task = await f.create({ bucket: "week", reminderDate: "2026-10-15" });
  task = await f.patch(task, { date: task.date, notes: "保留独立提醒日" });
  assert.equal(task.reminderDate, "2026-10-15");
  task = await f.patch(task, { reminderDate: "2026-10-13" });
  await f.trigger();
  assert.equal(f.notifications.length, 1);
  task = await f.patch(task, {
    bucket: "today",
    date: "2026-10-13",
    reminderDate: "2026-10-13",
    priority: true,
  });
  assert.ok(
    task.remindedAt,
    "changing display placement must not re-arm an unchanged reminder",
  );
  await f.trigger();
  assert.equal(f.notifications.length, 1);
  task = await f.patch(task, {
    bucket: "week",
    date: "2026-10-12",
    reminderDate: "2026-10-13",
  });
  // A plan-date change with no explicit reminder date follows the requested day,
  // even if it normalizes back to the same week.
  task = await f.patch(task, { date: "2026-10-16" });
  assert.equal(task.date, "2026-10-12");
  assert.equal(task.reminderDate, "2026-10-16");
  assert.ok(!task.remindedAt);
  task = await f.patch(task, { reminderTime: "" });
  assert.ok(!task.reminderDate);
  const invalid = await f.send("POST", "/api/tasks", {
    title: "无效日期",
    bucket: "today",
    date: "2026-10-13",
    reminderTime: "09:00",
    reminderDate: "2026-02-30",
  });
  assert.equal(invalid.status, 400);
});

test("advance reminders cross midnight and do not fire again after midnight", async (t) => {
  const f = await reminders(t);
  await f.create({
    date: "2026-10-14",
    reminderTime: "00:10",
    reminderAdvance: 30,
  });
  await f.now("2026-10-13T15:39:00Z");
  await f.trigger();
  assert.equal(f.notifications.length, 0);
  await f.now("2026-10-13T15:40:00Z");
  await f.trigger();
  assert.equal(f.notifications.length, 1);
  await f.now("2026-10-13T16:00:00Z");
  await f.trigger();
  assert.equal(f.notifications.length, 1);
});

test("an old delivery cannot acknowledge a reminder rescheduled during its request", async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await reminders(t, async (count) => {
    if (count === 1) {
      entered.resolve();
      await release.promise;
    }
  });
  let task = await f.create();
  const sending = f.trigger();
  try {
    await entered.promise;
    task = await f.patch(task, { date: "2026-10-14" });
  } finally {
    release.resolve();
    await sending;
  }
  const saved = await f.db
    .prepare("SELECT reminded_at FROM tasks WHERE id=?")
    .bind(task.id)
    .first();
  assert.equal(saved.reminded_at, "");
  await f.now("2026-10-14T01:00:00Z");
  await f.trigger();
  await f.trigger();
  assert.equal(f.notifications.length, 2);
});

test("reminder-date migration preserves existing dates and delivered state", async (t) => {
  const f = await reminders(t);
  const task = await f.create();
  await f.trigger();
  const before = await f.db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .bind(task.id)
    .first();
  await f.db.prepare("DROP INDEX tasks_reminder_date").run();
  await f.db.prepare("ALTER TABLE tasks DROP COLUMN reminder_date").run();
  const migration = await readFile(
    new URL("../migrations/0004_add_reminder_date.sql", import.meta.url),
    "utf8",
  );
  for (const sql of migration
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await f.db.prepare(sql).run();
  const after = await f.db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .bind(task.id)
    .first();
  assert.equal(after.reminder_date, before.scheduled_date);
  assert.equal(after.reminded_at, before.reminded_at);
  assert.equal(after.version, before.version);
});
