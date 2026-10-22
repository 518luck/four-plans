import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";

for (const [bucket, date] of [
  ["week", "2026-10-18"],
  ["month", "2026-10-31"],
]) {
  test(`${bucket} creation and explicit moves survive Beijing midnight refresh`, async (t) => {
    const f = await fixture(t);
    await f.setup();
    const day = Date.parse(`${date}T00:00:00+08:00`);
    for (const hour of [0, 1, 7, 8, 23]) {
      await f.now(new Date(day + hour * 3600000).toISOString());
      const created = await f.create(bucket, date, `凌晨新建 ${hour}`);
      const moving = await f.create("today", date, `凌晨移动 ${hour}`);
      const response = await f.send("PATCH", `/api/tasks/${moving.id}`, {
        version: moving.version,
        bucket,
        date,
      });
      assert.equal(response.status, 200, await response.clone().text());
      const board = await f.board(date);
      for (const task of [created, moving])
        assert.ok(
          board.buckets[bucket].some((item) => item.id === task.id),
          `${bucket} ${hour}:00 Beijing operation must stay in selected bucket`,
        );
    }
  });
}

for (const date of ["2026-10-16", "2026-10-18", "2026-10-25", "2026-10-31"]) {
  test(`daily unfinished details match board promotion on ${date}`, async (t) => {
    const f = await fixture(t);
    await f.setup();
    const threeStart = new Date(Date.parse(`${date}T00:00:00Z`) - 2 * 86400000)
      .toISOString()
      .slice(0, 10);
    await f.create("today", date, "今天行动");
    await f.create("three", threeStart, "三天收尾");
    await f.create("week", date, "本周目标");
    await f.create("month", date, "本月目标");
    await f.now(`${date}T01:00:00Z`);
    const board = await f.board(date);
    const response = await f.send("GET", `/api/statistics/day?date=${date}`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    const expected = board.buckets.today
      .filter((task) => !task.done)
      .map((task) => task.id)
      .sort();
    assert.deepEqual(
      detail.uncompleted.map((task) => task.id).sort(),
      expected,
    );
    assert.equal(detail.total, expected.length);
    assert.ok(
      detail.uncompleted.every(
        (task) => task.bucket === "today" && task.date === date,
      ),
    );
  });
}

test("completed goals keep their bucket while later completion preserves historical unfinished details", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const week = await f.create("week", "2026-10-12", "周目标");
  const three = await f.create("three", "2026-10-16", "三天目标");
  await f.now("2026-10-18T01:00:00Z");
  assert.equal(
    (
      await f.send("PATCH", `/api/tasks/${week.id}`, {
        version: week.version,
        done: true,
      })
    ).status,
    200,
  );
  await f.now("2026-10-19T01:00:00Z");
  assert.equal(
    (
      await f.send("PATCH", `/api/tasks/${three.id}`, {
        version: three.version,
        done: true,
      })
    ).status,
    200,
  );
  const response = await f.send("GET", "/api/statistics/day?date=2026-10-18");
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(
    detail.completed.find((task) => task.id === week.id).bucket,
    "week",
  );
  assert.equal(
    detail.uncompleted.find((task) => task.id === three.id).bucket,
    "today",
  );
});
