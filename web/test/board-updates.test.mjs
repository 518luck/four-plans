import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardUpdates } from "../src/boardUpdates.ts";

const date = "2026-10-18";
const task = (id, extra = {}) => ({
  id,
  title: id,
  notes: "",
  bucket: "today",
  date,
  done: false,
  priority: false,
  version: 1,
  createdAt: `${date}T01:00:00Z`,
  updatedAt: `${date}T01:00:00Z`,
  ...extra,
});
function board(tasks = [], extra = {}) {
  return {
    date,
    periods: {
      today: { start: date, end: date },
      three: { start: date, end: "2026-10-20" },
      week: { start: "2026-10-12", end: date },
      month: { start: "2026-10-01", end: "2026-10-31" },
    },
    buckets: { today: tasks, three: [], week: [], month: [] },
    carryovers: [],
    cancelled: [],
    trash: [],
    recurringPlans: [],
    syncedAt: `${date}T01:00:00Z`,
    statistics: {
      totalPlans: tasks.length,
      completedPlans: tasks.filter((t) => t.done).length,
      completionRate: 0,
      longestStreak: 0,
      currentStreak: 0,
      estimatedCompletions: 0,
      start: date,
      end: date,
      days: [],
      years: [2026],
    },
    ...extra,
  };
}
function fixture(tasks, extra) {
  const updates = new BoardUpdates();
  updates.replace(board(tasks, extra));
  return updates;
}
const find = (updates, id) =>
  updates.snapshot().buckets.today.find((t) => t.id === id);

test("one failed request cannot roll back another task's successful completion", () => {
  const a = task("a"),
    b = task("b");
  const updates = fixture([a, b]);
  updates.begin(a, { done: true });
  updates.begin(b, { done: true });
  updates.finish("b", { ...b, done: true, version: 2 });
  updates.finish("a");
  assert.equal(find(updates, "a").done, false);
  assert.equal(find(updates, "b").done, true);
  assert.equal(find(updates, "b").version, 2);
  assert.equal(updates.snapshot().statistics.completedPlans, 1);
});

test("rollback preserves another in-flight optimistic update in either response order", () => {
  const a = task("a"),
    b = task("b");
  const updates = fixture([a, b]);
  updates.begin(a, { done: true });
  updates.begin(b, { done: true });
  updates.finish("a");
  assert.equal(find(updates, "a").done, false);
  assert.equal(find(updates, "b").done, true);
  updates.finish("b", { ...b, done: true, version: 2 });
  assert.equal(updates.snapshot().statistics.completedPlans, 1);
});

test("refresh rebases pending changes without counting a server-confirmed completion twice", () => {
  const a = task("a"),
    b = task("b");
  const updates = fixture([a, b]);
  updates.begin(a, { done: true });
  updates.begin(b, { done: true });
  updates.replace(board([{ ...a, done: true, version: 2 }, b]));
  assert.equal(updates.snapshot().statistics.completedPlans, 2);
  assert.equal(find(updates, "b").done, true);
  updates.finish("a", { ...a, done: true, version: 2 });
  updates.finish("b");
  assert.equal(updates.snapshot().statistics.completedPlans, 1);
});

test("rescheduling a carryover uses authoritative placement without duplicating it", () => {
  const overdue = task("overdue", { bucket: "three", date: "2026-10-10" });
  const updates = fixture([], { carryovers: [overdue] });
  updates.begin(overdue, {
    bucket: "three",
    date: "2026-10-19",
    cancelledAt: "",
  });
  assert.equal(updates.snapshot().buckets.three.length, 0);
  const moved = { ...overdue, date: "2026-10-19", version: 2 };
  updates.finish(overdue.id, moved);
  const authoritative = board();
  authoritative.buckets.three = [moved];
  updates.replace(authoritative);
  assert.equal(updates.snapshot().carryovers.length, 0);
  assert.deepEqual(updates.snapshot().buckets.three, [moved]);
});

test("moving a today task to tomorrow removes it as soon as the saved board arrives", () => {
  const a = task("a");
  const updates = fixture([a]);
  updates.begin(a, { date: "2026-10-19" });
  updates.finish("a", { ...a, date: "2026-10-19", version: 2 });
  updates.replace(board([]));
  assert.equal(updates.snapshot().buckets.today.length, 0);
});

test("canonical PATCH buckets cannot corrupt a displayed automatic promotion", () => {
  const promoted = task("a");
  const updates = fixture([promoted]);
  updates.begin(promoted, { done: true });
  updates.finish("a", {
    ...promoted,
    bucket: "three",
    date: "2026-10-16",
    done: true,
    version: 2,
  });
  assert.equal(find(updates, "a").bucket, "today");
  const canonical = board([]);
  canonical.buckets.three = [
    {
      ...promoted,
      bucket: "three",
      date: "2026-10-16",
      done: true,
      version: 2,
    },
  ];
  updates.replace(canonical);
  assert.equal(updates.snapshot().buckets.today.length, 0);
  assert.equal(updates.snapshot().buckets.three[0].done, true);
});

test("cancelling a plan avoids optimistic updates until confirmed by the server", () => {
  const a = task("a");
  const updates = fixture([a]);
  updates.begin(a, { cancelledAt: `${date}T02:00:00Z` });
  assert.equal(updates.snapshot().buckets.today.length, 1);
  assert.equal(updates.snapshot().cancelled.length, 0);
  assert.equal(updates.snapshot().statistics.totalPlans, 1);
  const cancelled = { ...a, cancelledAt: `${date}T02:00:00Z`, version: 2 };
  updates.finish("a", cancelled);
  assert.equal(updates.snapshot().buckets.today.length, 1);
  const authoritative = board([]);
  authoritative.cancelled = [cancelled];
  updates.replace(authoritative);
  assert.equal(updates.snapshot().buckets.today.length, 0);
  assert.equal(updates.snapshot().cancelled.length, 1);
});

test("a failed priority change preserves the prior focus without mutating confirmed data", () => {
  const a = task("a", { priority: true }),
    b = task("b");
  const updates = fixture([a, b]);
  updates.begin(b, { priority: true, bucket: b.bucket, date: b.date });
  assert.equal(find(updates, "a").priority, false);
  updates.finish("b");
  assert.equal(find(updates, "a").priority, true);
  assert.equal(find(updates, "b").priority, false);
  assert.equal(a.priority, true);
});

test("pending changes from another date do not leak into the current view", () => {
  const a = task("a");
  const updates = fixture([a]);
  updates.begin(a, { done: true });
  updates.replace(board([a], { date: "2026-10-19" }));
  assert.equal(find(updates, "a").done, false);
});

test("logging out discards pending state and ignores late responses", () => {
  const a = task("a");
  const updates = fixture([a]);
  updates.begin(a, { done: true });
  updates.clear();
  updates.finish("a", { ...a, done: true, version: 2 });
  assert.equal(updates.snapshot(), null);
});

test("reminder preferences survive subsequent task snapshots", () => {
  const a = task("a");
  const updates = fixture([a]);
  const settings = { enabled: false, webhookUrl: "", defaultAdvance: 5 };
  updates.setReminderSettings(settings);
  updates.begin(a, { done: true });
  updates.finish("a");
  assert.deepEqual(updates.snapshot().reminderSettings, settings);
});

test("a late PATCH cannot overwrite a newer confirmed version", () => {
  const a = task("a");
  const updates = fixture([a]);
  updates.begin(a, { done: true });
  updates.replace(
    board([{ ...a, title: "newer title", version: 3, priority: true }]),
  );
  updates.finish("a", { ...a, title: "old title", done: true, version: 2 });
  assert.equal(find(updates, "a").version, 3);
  assert.equal(find(updates, "a").title, "newer title");
  assert.equal(find(updates, "a").done, false);
  assert.equal(find(updates, "a").priority, true);
});

test("a late PATCH cannot change a newly opened session after clear", () => {
  const a = task("a");
  const updates = fixture([a]);
  updates.begin(a, { done: true });
  updates.clear();
  updates.replace(board([{ ...a, title: "new session" }]));
  updates.finish("a", { ...a, done: true, version: 2 });
  assert.equal(find(updates, "a").title, "new session");
  assert.equal(find(updates, "a").done, false);
});
