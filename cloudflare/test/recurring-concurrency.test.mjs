import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../.wrangler/test-worker/index.js";
import { fixture } from "./fixture.mjs";

test(
  "a losing concurrent resume cannot write today's or tomorrow's revisions",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    let readers = 0;
    let release;
    let synchronize = false;
    const bothRead = new Promise((resolve) => {
      release = resolve;
    });
    // Only synchronize the preflight reads. Updates, triggers and transactions
    // execute unchanged against real D1, including the losing version update.
    const db = {
      prepare(sql) {
        const statement = f.db.prepare(sql);
        if (
          !synchronize ||
          !sql.startsWith("SELECT p.*") ||
          !sql.endsWith(" AND p.id=?")
        )
          return statement;
        return {
          bind(...args) {
            const bound = statement.bind(...args);
            return {
              async first() {
                const row = await bound.first();
                readers++;
                if (readers === 2) release();
                await bothRead;
                return row;
              },
            };
          },
        };
      },
      batch(statements) {
        return f.db.batch(statements);
      },
    };
    const env = {
      DB: { withSession: () => db },
      TEST_NOW: "2026-10-13T01:00:00Z",
      BOOTSTRAP_TOKEN: "fixture-init-key",
    };
    let cookie = "";
    async function send(method, path, body) {
      const response = await worker.fetch(
        new Request(`https://local.test${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            Origin: "https://local.test",
            Cookie: cookie,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
      );
      if (response.headers.has("Set-Cookie"))
        cookie = response.headers.get("Set-Cookie").split(";")[0];
      return response;
    }
    assert.equal(
      (
        await send("POST", "/api/setup", {
          username: "test",
          password: "test-password-42",
          accessKey: "fixture-init-key",
        })
      ).status,
      201,
    );
    const created = await send("POST", "/api/recurring", {
      title: "Original",
      notes: "Today's notes",
      start: "2026-10-13",
      end: "2026-10-20",
    });
    assert.equal(created.status, 201);
    let plan = await created.json();
    const paused = await send("PATCH", `/api/recurring/${plan.id}`, {
      version: plan.version,
      status: "paused",
    });
    assert.equal(paused.status, 200);
    plan = await paused.json();
    env.TEST_NOW = "2026-10-15T01:00:00Z";
    synchronize = true;
    const contents = [
      { title: "Resume A", notes: "Notes A", end: "2026-10-21" },
      { title: "Resume B", notes: "Notes B", end: "2026-10-22" },
    ];
    const responses = await Promise.all(
      contents.map((content) =>
        send("PATCH", `/api/recurring/${plan.id}`, {
          version: plan.version,
          status: "active",
          ...content,
        }),
      ),
    );
    assert.equal(readers, 2);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const winner = contents[responses.findIndex((r) => r.status === 200)];
    const stored = await f.db
      .prepare("SELECT * FROM recurring_plans WHERE id=?")
      .bind(plan.id)
      .first();
    assert.equal(stored.version, plan.version + 1);
    assert.equal(stored.title, winner.title);
    assert.equal(stored.notes, winner.notes);
    assert.equal(stored.end_date, winner.end);
    const today = await f.db
      .prepare(
        "SELECT * FROM recurring_revisions WHERE plan_id=? AND effective_date='2026-10-15'",
      )
      .bind(plan.id)
      .first();
    assert.equal(today.title, "Original");
    assert.equal(today.notes, "Today's notes");
    assert.equal(today.end_date, "2026-10-20");
    assert.equal(today.status, "active");
    const tomorrow = await f.db
      .prepare(
        "SELECT * FROM recurring_revisions WHERE plan_id=? AND effective_date='2026-10-16'",
      )
      .bind(plan.id)
      .first();
    assert.equal(tomorrow.title, winner.title);
    assert.equal(tomorrow.notes, winner.notes);
    assert.equal(tomorrow.end_date, winner.end);
    env.TEST_NOW = "2026-10-16T01:00:00Z";
    const board = await send("GET", "/api/board?date=2026-10-16");
    assert.equal(board.status, 200);
    const tasks = (await board.json()).buckets.today.filter(
      (task) => task.recurringId === plan.id,
    );
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, winner.title);
    assert.equal(tasks[0].notes, winner.notes);
  },
);
