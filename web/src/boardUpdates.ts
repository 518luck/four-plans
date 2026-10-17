import type { Board, ReminderSettings, Task } from "../../shared/contracts";

const buckets = ["today", "three", "week", "month"] as const;
type PendingUpdate = { task: Task; change: Partial<Task>; date: string };

function findTask(board: Board, id: string): Task | undefined {
  return [
    ...buckets.flatMap((bucket) => board.buckets[bucket]),
    ...board.carryovers,
    ...board.cancelled,
  ].find((task) => task.id === id);
}

function applyUpdate(board: Board, id: string, change: Partial<Task>): Board {
  const task = findTask(board, id);
  if (!task) return board;
  const next = { ...task, ...change };
  if (change.done === true && !task.done && !change.completedAt) {
    next.completedAt = new Date().toISOString();
  } else if (change.done === false) {
    next.completedAt = undefined;
  }
  if (next.done || next.cancelledAt || next.bucket !== "today") {
    next.priority = false;
  }
  const replace = (list: Task[]) =>
    list.flatMap((item) => {
      if (item.id === id) return next.cancelledAt ? [] : [next];
      return [
        change.priority === true &&
        next.bucket === "today" &&
        item.date === next.date
          ? { ...item, priority: false }
          : item,
      ];
    });
  const nextBuckets = { ...board.buckets };
  for (const bucket of buckets)
    nextBuckets[bucket] = replace(board.buckets[bucket]);
  const cancelled = board.cancelled.filter((item) => item.id !== id);
  if (next.cancelledAt) cancelled.unshift(next);

  const counted = (item: Task) => !item.cancelledAt && !item.deletedAt;
  const completed = (item: Task) => counted(item) && item.done;
  const statistics = {
    ...board.statistics,
    totalPlans:
      board.statistics.totalPlans +
      Number(counted(next)) -
      Number(counted(task)),
    completedPlans:
      board.statistics.completedPlans +
      Number(completed(next)) -
      Number(completed(task)),
  };
  statistics.completionRate = statistics.totalPlans
    ? Math.round((statistics.completedPlans * 100) / statistics.totalPlans)
    : 0;
  return {
    ...board,
    buckets: nextBuckets,
    carryovers: replace(board.carryovers),
    cancelled,
    statistics,
  };
}

/** Keep confirmed data separate so failing one request cannot undo another. */
export class BoardUpdates {
  private board: Board | null = null;
  private pending = new Map<string, PendingUpdate>();

  replace(board: Board): void {
    this.board = board;
  }

  clear(): void {
    this.board = null;
    this.pending.clear();
  }

  begin(task: Task, change: Partial<Task>): void {
    if (!this.board) return;
    this.pending.set(task.id, { task, change, date: this.board.date });
  }

  finish(id: string, serverTask?: Task): void {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (!pending || !this.board || !serverTask) return;
    const current = findTask(this.board, id);
    if (current && current.version > serverTask.version) return;
    if (
      pending &&
      ((pending.change.bucket !== undefined &&
        pending.change.bucket !== pending.task.bucket) ||
        (pending.change.date !== undefined &&
          pending.change.date !== pending.task.date))
    )
      return;
    // Preserve the displayed projection until the authoritative board is read.
    // Raw PATCH responses can still contain the task's original bucket/date.
    const { bucket: _bucket, date: _date, ...fields } = serverTask;
    this.board = applyUpdate(this.board, id, {
      ...fields,
      cancelledAt: serverTask.cancelledAt || "",
      completedAt: serverTask.completedAt,
    });
  }

  setReminderSettings(settings: ReminderSettings): void {
    if (this.board) this.board = { ...this.board, reminderSettings: settings };
  }

  snapshot(): Board | null {
    let result = this.board;
    if (!result) return null;
    for (const { task, change, date } of this.pending.values()) {
      if (date !== result.date) continue;
      // Date/bucket changes may move tasks outside the visible ranges or invoke
      // automatic promotion. Keep their placement authoritative, without guessing.
      if (
        (change.bucket !== undefined && change.bucket !== task.bucket) ||
        (change.date !== undefined && change.date !== task.date)
      )
        continue;
      result = applyUpdate(result, task.id, change);
    }
    return result;
  }
}
