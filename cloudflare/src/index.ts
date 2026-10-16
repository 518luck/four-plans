import type {
  Task,
  RecurringPlan,
  DailyQuote,
  ReminderSettings,
  RecurringRecord,
  RecurringHistory,
  RecurringDayStatus,
} from "../../shared/contracts";
import {
  HttpError,
  bad,
  text,
  integer,
  boolean,
  beijingDate,
  addDays,
  lastDayOfMonth,
  periods,
  taskFromRow,
  goalFromRow,
  validateTask,
  validateGoal,
  statistics,
  dayDetail,
  type Row,
} from "./domain";
import {
  randomToken,
  hash,
  equal,
  passwordHash,
  verifyPassword,
  credentials,
  input,
  cookieToken,
  sessionCookie,
} from "./auth";
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BOOTSTRAP_TOKEN?: string;
  TEST_NOW?: string;
  QUOTE_URL?: string;
}
type DB = Pick<D1Database, "prepare" | "batch">;
const goalSelect = `SELECT p.*,(SELECT COUNT(*) FROM tasks WHERE recurring_id=p.id AND deleted_at IS NULL) AS generated,(SELECT COUNT(*) FROM tasks WHERE recurring_id=p.id AND deleted_at IS NULL AND done=1) AS completed,(SELECT COUNT(*) FROM tasks WHERE recurring_id=p.id AND deleted_at IS NULL AND done=0 AND scheduled_date < ?) AS missed FROM recurring_plans p WHERE p.user_id=1`;
const defaultQuotes = [
  "每天向前一点，也是一种坚持。",
  "把今天能做的一步，认真做好。",
  "不必一次走很远，今天开始就很好。",
  "允许自己慢一点，也记得继续前行。",
  "每一次小小的完成，都在积累力量。",
];
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}
function conflict(): never {
  throw new HttpError(409, "计划已在其他窗口更新，请刷新后重试", "conflict");
}

async function generateFeishuSign(
  timestamp: number,
  secret: string,
): Promise<string> {
  const enc = new TextEncoder();
  const stringToSign = `${timestamp}\n${secret}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(stringToSign),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(""));
  const binary = String.fromCharCode(...new Uint8Array(signature));
  return btoa(binary);
}

async function sendFeishuNotification(
  webhookUrl: string,
  secret: string,
  title: string,
  text: string,
): Promise<void> {
  const payload: Record<string, unknown> = {
    msg_type: "post",
    content: {
      post: {
        zh_cn: {
          title,
          content: [[{ tag: "text", text }]],
        },
      },
    },
  };
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = await generateFeishuSign(timestamp, secret);
    payload.timestamp = String(timestamp);
    payload.sign = sign;
  }
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new HttpError(
      400,
      `飞书服务响应错误 (HTTP ${res.status}): ${errText}`,
      "webhook_failed",
    );
  }
  const resData = (await res.json().catch(() => ({}))) as {
    code?: number;
    StatusCode?: number;
    msg?: string;
  };
  if (resData.code !== undefined && resData.code !== 0) {
    throw new HttpError(
      400,
      `飞书推送失败 (${resData.code}): ${resData.msg || ""}`,
      "webhook_failed",
    );
  }
  if (resData.StatusCode !== undefined && resData.StatusCode !== 0) {
    throw new HttpError(
      400,
      `飞书推送失败 (${resData.StatusCode}): ${resData.msg || ""}`,
      "webhook_failed",
    );
  }
}

async function loadReminderSettings(db: DB): Promise<ReminderSettings> {
  const rows = (
    await db
      .prepare(
        "SELECT key, value FROM settings WHERE key IN ('reminder_enabled', 'feishu_webhook_url', 'feishu_webhook_secret', 'default_reminder_advance')",
      )
      .all<Row>()
  ).results;
  const settings: ReminderSettings = {
    enabled: false,
    webhookUrl: "",
    webhookSecret: "",
    defaultAdvance: 0,
  };
  for (const row of rows) {
    const k = String(row.key),
      v = String(row.value);
    if (k === "reminder_enabled") settings.enabled = v === "true";
    if (k === "feishu_webhook_url") settings.webhookUrl = v;
    if (k === "feishu_webhook_secret") settings.webhookSecret = v;
    if (k === "default_reminder_advance")
      settings.defaultAdvance = Number(v) || 0;
  }
  return settings;
}

async function saveReminderSettings(
  db: DB,
  settings: ReminderSettings,
  now: string,
): Promise<void> {
  const statements = [
    db
      .prepare(
        "INSERT INTO settings(key, value, updated_at) VALUES('reminder_enabled', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      )
      .bind(settings.enabled ? "true" : "false", now),
    db
      .prepare(
        "INSERT INTO settings(key, value, updated_at) VALUES('feishu_webhook_url', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      )
      .bind(settings.webhookUrl, now),
    db
      .prepare(
        "INSERT INTO settings(key, value, updated_at) VALUES('feishu_webhook_secret', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      )
      .bind(settings.webhookSecret || "", now),
    db
      .prepare(
        "INSERT INTO settings(key, value, updated_at) VALUES('default_reminder_advance', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      )
      .bind(String(settings.defaultAdvance), now),
  ];
  await db.batch(statements);
}

async function checkAndSendReminders(db: DB, now: Date): Promise<void> {
  const settings = await loadReminderSettings(db);
  if (!settings.enabled || !settings.webhookUrl) return;
  const currentDate = beijingDate(now);
  const rows = (
    await db
      .prepare(
        "SELECT * FROM tasks WHERE user_id=1 AND scheduled_date=? AND reminder_time!='' AND (reminded_at='' OR reminded_at IS NULL) AND done=0 AND deleted_at IS NULL",
      )
      .bind(currentDate)
      .all<Row>()
  ).results;
  const tasks = rows.map(taskFromRow);
  for (const task of tasks) {
    if (!task.reminderTime) continue;
    const taskDate = new Date(`${task.date}T${task.reminderTime}:00+08:00`);
    if (isNaN(taskDate.getTime())) continue;
    const triggerTime = new Date(
      taskDate.getTime() - (task.reminderAdvance || 0) * 60000,
    );
    if (now.getTime() < triggerTime.getTime()) continue;

    const priorityTag = task.priority ? " · 今日重点" : "";
    const advanceText =
      (task.reminderAdvance || 0) > 0
        ? `提前 ${task.reminderAdvance} 分钟提醒`
        : "准时提醒";
    const bucketNames: Record<string, string> = {
      today: "今天",
      three: "三天",
      week: "本周",
      month: "本月",
    };
    const bucketName = bucketNames[task.bucket] || task.bucket;

    const lines = [
      `🎯 计划：${task.title}`,
      `⏰ 时间：${task.reminderTime} (${advanceText})`,
      `📌 类别：${bucketName}计划${priorityTag}`,
    ];
    if (task.notes) lines.push(`📝 备注：${task.notes}`);

    try {
      await sendFeishuNotification(
        settings.webhookUrl,
        settings.webhookSecret || "",
        "四格计划 · 提醒",
        lines.join("\n"),
      );
      await db
        .prepare(
          "UPDATE tasks SET reminded_at=? WHERE id=? AND (reminded_at='' OR reminded_at IS NULL)",
        )
        .bind(now.toISOString(), task.id)
        .run();
    } catch (e) {
      console.error("send feishu reminder failed", e);
    }
  }
}

async function currentUser(
  db: DB,
  request: Request,
  now: string,
): Promise<string | null> {
  const token = cookieToken(request);
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await db
    .prepare(
      "SELECT u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
    )
    .bind(await hash(token), now)
    .first<Row>();
  return row ? String(row.username) : null;
}
async function newSession(
  db: DB,
  request: Request,
  now: Date,
): Promise<string> {
  const token = randomToken();
  await db.batch([
    db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,1,?)",
      )
      .bind(
        await hash(token),
        new Date(now.getTime() + 2592000000).toISOString(),
      ),
    db
      .prepare("DELETE FROM sessions WHERE expires_at<=?")
      .bind(now.toISOString()),
    db
      .prepare("DELETE FROM login_attempts WHERE expires_at<=?")
      .bind(now.toISOString()),
  ]);
  return sessionCookie(token, request);
}
async function readTasks(db: DB): Promise<Task[]> {
  return (
    await db
      .prepare(
        "SELECT * FROM tasks WHERE user_id=1 ORDER BY deleted_at DESC,done,priority DESC,created_at,id",
      )
      .all<Row>()
  ).results.map(taskFromRow);
}
async function goals(db: DB, now?: Date): Promise<RecurringPlan[]> {
  const today = now ? beijingDate(now) : beijingDate(new Date());
  return (
    await db
      .prepare(goalSelect + " ORDER BY p.created_at DESC,p.id")
      .bind(today)
      .all<Row>()
  ).results.map(goalFromRow);
}
async function generate(db: DB, now: Date): Promise<void> {
  const today = beijingDate(now),
    stamp = now.toISOString();
  // A single D1 transaction covers all missing occurrences and cursors. The trigger creates
  // its task only on the first occurrence insert; deleted tasks can never be recreated.
  await db.batch([
    db
      .prepare(
        `WITH RECURSIVE days(plan_id,day) AS (
  SELECT id,CASE WHEN generated_until='' THEN start_date ELSE date(generated_until,'+1 day') END FROM recurring_plans WHERE user_id=1 AND start_date<=? AND generated_until<?
  UNION ALL SELECT plan_id,date(day,'+1 day') FROM days WHERE day<?
 ) INSERT OR IGNORE INTO recurring_occurrences(plan_id,scheduled_date,task_id,created_at)
 SELECT d.plan_id,d.day,lower(hex(randomblob(12))),? FROM days d
 JOIN recurring_revisions r ON r.plan_id=d.plan_id AND r.effective_date=(SELECT MAX(effective_date) FROM recurring_revisions WHERE plan_id=d.plan_id AND effective_date<=d.day)
 WHERE d.day<=? AND r.status='active' AND d.day<=r.end_date`,
      )
      .bind(today, today, today, stamp, today),
    db
      .prepare(
        "UPDATE recurring_plans SET generated_until=? WHERE user_id=1 AND start_date<=? AND generated_until<?",
      )
      .bind(today, today, today),
  ]);
}
async function findTask(db: DB, id: string): Promise<Task> {
  const row = await db
    .prepare(
      "SELECT * FROM tasks WHERE id=? AND user_id=1 AND deleted_at IS NULL",
    )
    .bind(id)
    .first<Row>();
  if (!row) throw new HttpError(404, "这项计划已被移除", "not_found");
  return taskFromRow(row);
}
async function taskRoute(
  request: Request,
  db: DB,
  now: Date,
  id?: string,
): Promise<Response> {
  const stamp = now.toISOString();
  if (request.method === "POST" && !id) {
    const body = await input(request, [
      "title",
      "notes",
      "bucket",
      "date",
      "priority",
      "reminderTime",
      "reminderAdvance",
    ]);
    const task: Task = {
      id: randomToken(12),
      title: text(body.title),
      notes: text(body.notes, ""),
      bucket: text(body.bucket) as Task["bucket"],
      date: text(body.date),
      done: false,
      priority: body.priority === undefined ? false : boolean(body.priority),
      reminderTime: body.reminderTime ? String(body.reminderTime) : undefined,
      reminderAdvance:
        body.reminderAdvance !== undefined && body.reminderAdvance !== null
          ? Number(body.reminderAdvance)
          : 0,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    validateTask(task);
    await db
      .prepare(
        "INSERT INTO tasks(id,user_id,title,notes,bucket,scheduled_date,priority,created_at,updated_at,reminder_time,reminder_advance) VALUES(?,1,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        task.id,
        task.title,
        task.notes,
        task.bucket,
        task.date,
        task.priority ? 1 : 0,
        stamp,
        stamp,
        task.reminderTime || "",
        task.reminderAdvance || 0,
      )
      .run();
    return json(task, 201);
  }
  if (request.method === "PATCH" && id) {
    const body = await input(request, [
        "version",
        "title",
        "notes",
        "bucket",
        "date",
        "done",
        "priority",
        "reminderTime",
        "reminderAdvance",
      ]),
      version = integer(body.version);
    const task = await findTask(db, id);
    if (task.version !== version) conflict();
    const wasDone = task.done;
    if (body.title !== undefined) task.title = text(body.title);
    if (body.notes !== undefined) task.notes = text(body.notes);
    if (body.bucket !== undefined)
      task.bucket = text(body.bucket) as Task["bucket"];
    if (body.date !== undefined) task.date = text(body.date);
    if (body.done !== undefined) task.done = boolean(body.done);
    if (body.priority !== undefined) task.priority = boolean(body.priority);
    if (body.reminderTime !== undefined) {
      const newTime = body.reminderTime ? String(body.reminderTime) : undefined;
      if (task.reminderTime !== newTime) task.remindedAt = undefined;
      task.reminderTime = newTime;
    }
    if (body.reminderAdvance !== undefined) {
      const newAdv =
        body.reminderAdvance !== null ? Number(body.reminderAdvance) : 0;
      if (task.reminderAdvance !== newAdv) task.remindedAt = undefined;
      task.reminderAdvance = newAdv;
    }
    validateTask(task);
    if (task.done && !wasDone) {
      task.completedAt = stamp;
      task.completionDateEstimated = false;
    } else if (!task.done) {
      task.completedAt = undefined;
      task.completionDateEstimated = false;
    }
    task.version++;
    task.updatedAt = stamp;
    const result = await db
      .prepare(
        "UPDATE tasks SET title=?,notes=?,bucket=?,scheduled_date=?,done=?,priority=?,version=version+1,updated_at=?,completed_at=?,completion_date_estimated=?,reminder_time=?,reminder_advance=?,reminded_at=? WHERE id=? AND user_id=1 AND version=? AND deleted_at IS NULL",
      )
      .bind(
        task.title,
        task.notes,
        task.bucket,
        task.date,
        task.done ? 1 : 0,
        task.priority ? 1 : 0,
        stamp,
        task.completedAt || null,
        task.completionDateEstimated ? 1 : 0,
        task.reminderTime || "",
        task.reminderAdvance || 0,
        task.remindedAt || "",
        id,
        version,
      )
      .run();
    if (!result.meta.changes) conflict();
    return json(task);
  }
  if (request.method === "DELETE" && id) {
    const body = await input(request, ["version"]);
    const result = await db
      .prepare(
        "UPDATE tasks SET deleted_at=?,updated_at=?,priority=0,version=version+1 WHERE id=? AND user_id=1 AND version=? AND deleted_at IS NULL",
      )
      .bind(stamp, stamp, id, integer(body.version))
      .run();
    if (!result.meta.changes) conflict();
    return new Response(null, { status: 204 });
  }
  throw new HttpError(404, "接口不存在", "not_found");
}
async function goalRoute(
  request: Request,
  db: DB,
  now: Date,
  id?: string,
): Promise<Response> {
  const today = beijingDate(now),
    stamp = now.toISOString();
  await generate(db, now);
  if (request.method === "GET" && !id) return json(await goals(db, now));
  if (request.method === "POST" && !id) {
    const body = await input(request, ["title", "notes", "start", "end"]);
    const goal: RecurringPlan = {
      id: randomToken(12),
      title: text(body.title),
      notes: text(body.notes, ""),
      start: text(body.start),
      end: text(body.end),
      status: "active",
      effectiveDate: today,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
      generated: 0,
      completed: 0,
      missed: 0,
    };
    validateGoal(goal);
    if (goal.start < today) bad("开始日期不能早于今天");
    await db
      .prepare(
        "INSERT INTO recurring_plans(id,user_id,title,notes,start_date,end_date,status,effective_date,created_at,updated_at) VALUES(?,1,?,?,?,?,'active',?,?,?)",
      )
      .bind(
        goal.id,
        goal.title,
        goal.notes,
        goal.start,
        goal.end,
        goal.effectiveDate,
        stamp,
        stamp,
      )
      .run();
    await generate(db, now);
    return json(goal, 201);
  }
  if (request.method === "PATCH" && id) {
    const body = await input(request, [
        "version",
        "title",
        "notes",
        "end",
        "status",
      ]),
      version = integer(body.version);
    const row = await db
      .prepare(goalSelect + " AND p.id=?")
      .bind(today, id)
      .first<Row>();
    if (!row) throw new HttpError(404, "目标不存在", "not_found");
    const goal = goalFromRow(row);
    if (goal.version !== version) conflict();
    if (goal.status === "stopped")
      throw new HttpError(409, "已停止的目标保留为历史，请新建目标", "stopped");
    if (body.title !== undefined) goal.title = text(body.title);
    if (body.notes !== undefined) goal.notes = text(body.notes);
    if (body.end !== undefined) goal.end = text(body.end);
    if (body.status !== undefined)
      goal.status = text(body.status) as RecurringPlan["status"];
    validateGoal(goal);
    goal.effectiveDate = addDays(today, 1);
    if (body.end !== undefined && goal.end < goal.effectiveDate)
      bad("新的截止日期不能早于明天");
    goal.version++;
    goal.updatedAt = stamp;
    const result = await db
      .prepare(
        "UPDATE recurring_plans SET title=?,notes=?,end_date=?,status=?,effective_date=?,version=version+1,updated_at=? WHERE id=? AND user_id=1 AND version=? AND status<>'stopped'",
      )
      .bind(
        goal.title,
        goal.notes,
        goal.end,
        goal.status,
        goal.effectiveDate,
        stamp,
        id,
        version,
      )
      .run();
    if (!result.meta.changes) conflict();
    return json(goal);
  }
  throw new HttpError(404, "接口不存在", "not_found");
}

async function getRecurringHistory(
  db: DB,
  planId: string,
  now: Date,
): Promise<RecurringHistory> {
  const today = beijingDate(now);
  await generate(db, now);

  const planRow = await db
    .prepare("SELECT * FROM recurring_plans WHERE id=? AND user_id=1")
    .bind(planId)
    .first<Row>();
  if (!planRow) throw new HttpError(404, "目标不存在", "not_found");

  const revRows = (
    await db
      .prepare(
        "SELECT effective_date, status, end_date FROM recurring_revisions WHERE plan_id=? ORDER BY effective_date ASC",
      )
      .bind(planId)
      .all<Row>()
  ).results;

  const taskRows = (
    await db
      .prepare(
        "SELECT id, scheduled_date, done, version, completed_at FROM tasks WHERE recurring_id=? AND user_id=1 AND deleted_at IS NULL ORDER BY scheduled_date ASC",
      )
      .bind(planId)
      .all<Row>()
  ).results;

  const tasksByDate = new Map<
    string,
    { id: string; done: boolean; version: number; completedAt?: string }
  >();
  for (const t of taskRows) {
    tasksByDate.set(String(t.scheduled_date), {
      id: String(t.id),
      done: Boolean(t.done),
      version: Number(t.version),
      completedAt: t.completed_at ? String(t.completed_at) : undefined,
    });
  }

  const start = String(planRow.start_date);
  const end = String(planRow.end_date);
  const records: RecurringRecord[] = [];

  let cur = start;
  while (cur <= end) {
    let revStatus = String(planRow.status);
    for (const rev of revRows) {
      if (String(rev.effective_date) <= cur) {
        revStatus = String(rev.status);
      }
    }

    const t = tasksByDate.get(cur);
    let status: RecurringDayStatus;
    if (revStatus === "paused" && cur <= today) {
      status = "paused";
    } else if (cur > today) {
      status = "upcoming";
    } else if (t) {
      if (t.done) {
        status = "completed";
      } else if (cur === today) {
        status = "pending";
      } else {
        status = "missed";
      }
    } else {
      if (cur === today) {
        status = "pending";
      } else if (cur < today) {
        status = "missed";
      } else {
        status = "upcoming";
      }
    }

    records.push({
      date: cur,
      status,
      done: t ? t.done : false,
      taskId: t?.id,
      version: t?.version,
      completedAt: t?.completedAt,
    });

    cur = addDays(cur, 1);
  }

  let completedDays = 0;
  let missedDays = 0;
  let passedDays = 0;
  let longestStreak = 0;
  let run = 0;

  for (const r of records) {
    if (r.date <= today) {
      passedDays++;
      if (r.status === "completed") {
        completedDays++;
        run++;
        if (run > longestStreak) longestStreak = run;
      } else if (r.status === "missed") {
        missedDays++;
        run = 0;
      } else if (r.status === "pending") {
        run = 0;
      }
    }
  }

  let currentStreak = 0;
  const todayIdx = records.findIndex((r) => r.date === today);
  if (todayIdx >= 0) {
    if (records[todayIdx].status === "completed") {
      for (let i = todayIdx; i >= 0; i--) {
        if (records[i].status === "completed") currentStreak++;
        else break;
      }
    } else {
      for (let i = todayIdx - 1; i >= 0; i--) {
        if (records[i].status === "completed") currentStreak++;
        else break;
      }
    }
  }

  return {
    planId,
    totalDays: records.length,
    passedDays,
    completedDays,
    missedDays,
    currentStreak,
    longestStreak,
    records,
  };
}

async function recurringCheckinRoute(
  request: Request,
  db: DB,
  now: Date,
  planId: string,
): Promise<Response> {
  const today = beijingDate(now);
  const stamp = now.toISOString();
  const body = await input(request, ["date", "done"]);
  const targetDate = text(body.date);
  if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    bad("请指定有效的打卡日期");
  }

  const planRow = await db
    .prepare("SELECT * FROM recurring_plans WHERE id=? AND user_id=1")
    .bind(planId)
    .first<Row>();
  if (!planRow) throw new HttpError(404, "目标不存在", "not_found");

  const start = String(planRow.start_date);
  const end = String(planRow.end_date);
  if (targetDate < start || targetDate > end) {
    bad("打卡日期超出目标计划周期");
  }
  if (targetDate > today) {
    bad("不能为未来日期打卡");
  }

  const existing = await db
    .prepare(
      "SELECT * FROM tasks WHERE recurring_id=? AND scheduled_date=? AND user_id=1 AND deleted_at IS NULL",
    )
    .bind(planId, targetDate)
    .first<Row>();

  let nextDone: boolean;
  if (body.done !== undefined) {
    nextDone = boolean(body.done);
  } else {
    nextDone = existing ? !existing.done : true;
  }

  if (existing) {
    const compAt = nextDone ? stamp : null;
    await db
      .prepare(
        "UPDATE tasks SET done=?, completed_at=?, updated_at=?, version=version+1 WHERE id=? AND user_id=1",
      )
      .bind(nextDone ? 1 : 0, compAt, stamp, existing.id)
      .run();
  } else {
    const taskId = randomToken(12);
    await db
      .prepare(
        "INSERT INTO tasks(id,user_id,title,notes,bucket,scheduled_date,done,completed_at,created_at,updated_at,recurring_id,version) VALUES(?,1,?,?, 'today', ?, ?, ?, ?, ?, ?, 1)",
      )
      .bind(
        taskId,
        String(planRow.title),
        String(planRow.notes || ""),
        targetDate,
        nextDone ? 1 : 0,
        nextDone ? stamp : null,
        stamp,
        stamp,
        planId,
      )
      .run();
  }

  const history = await getRecurringHistory(db, planId, now);
  return json(history);
}
async function quote(db: DB, env: Env, now: Date): Promise<Response> {
  const date = beijingDate(now);
  const saved = await db
    .prepare("SELECT * FROM daily_quotes WHERE date=?")
    .bind(date)
    .first<Row>();
  if (saved) return json({ ...saved, fallback: !!saved.fallback });
  const q: DailyQuote = {
    date,
    text: defaultQuotes[
      (Math.floor(
        (Date.parse(date) - Date.parse(date.slice(0, 4) + "-01-01")) / 86400000,
      ) +
        1) %
        defaultQuotes.length
    ],
    author: "",
    source: "内置文案",
    fallback: true,
  };
  try {
    const response = await fetch(
      env.QUOTE_URL ||
        "https://api.vsaa.cn/api/quote/index.php?type=%E9%BC%93%E5%8A%B1",
      { signal: AbortSignal.timeout(3000) },
    );
    if (!response.ok) throw new Error("unavailable");
    const reader = response.body!.getReader();
    let size = 0;
    const parts: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new Error("too large");
      }
      parts.push(next.value);
    }
    const content = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      content.set(part, offset);
      offset += part.length;
    }
    const body = JSON.parse(new TextDecoder().decode(content));
    const value =
      typeof body.text?.[0] === "string"
        ? body.text[0].trim().replace(/\s+/g, " ")
        : "";
    if (value && [...value].length <= 160) {
      q.text = value;
      q.author =
        typeof body.author?.[0] === "string" && [...body.author[0]].length <= 80
          ? body.author[0].trim()
          : "";
      q.source = "万象语录";
      q.fallback = false;
    }
  } catch {
    /* A failed upstream never blocks using plans. */
  }
  await db
    .prepare(
      "INSERT OR IGNORE INTO daily_quotes(date,text,author,source,fallback) VALUES(?,?,?,?,?)",
    )
    .bind(date, q.text, q.author, q.source, q.fallback ? 1 : 0)
    .run();
  const winner = await db
    .prepare("SELECT * FROM daily_quotes WHERE date=?")
    .bind(date)
    .first<Row>();
  return json(winner ? { ...winner, fallback: !!winner.fallback } : q);
}
async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    now = new Date(env.TEST_NOW || Date.now()),
    stamp = now.toISOString();
  const db: DB = env.DB.withSession("first-primary");
  if (!["GET", "HEAD"].includes(request.method)) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin)
      throw new HttpError(403, "请求来源无效，请刷新页面", "origin");
    if (request.headers.get("Sec-Fetch-Site") === "cross-site")
      throw new HttpError(403, "请求来源无效", "origin");
  }
  if (path === "/api/health" && request.method === "GET") {
    await db.prepare("SELECT 1").first();
    return json({ status: "ok" });
  }
  if (path === "/api/session" && request.method === "GET") {
    const owner = await db.prepare("SELECT id FROM users WHERE id=1").first(),
      username = await currentUser(db, request, stamp);
    return json({
      configured: !!owner,
      bootstrapRequired: !owner,
      user: username ? { username } : null,
    });
  }
  if (path === "/api/setup" && request.method === "POST") {
    if (await db.prepare("SELECT id FROM users WHERE id=1").first())
      throw new HttpError(409, "账号已经设置，请直接登录", "configured");
    const body = await input(request, ["username", "password", "accessKey"]);
    if (!env.BOOTSTRAP_TOKEN)
      throw new HttpError(
        503,
        "首次账号初始化暂未开放，请联系部署者",
        "unavailable",
      );
    if (
      typeof body.accessKey !== "string" ||
      !equal(body.accessKey, env.BOOTSTRAP_TOKEN)
    )
      throw new HttpError(403, "初始化密钥不正确", "bootstrap");
    const { username, password } = credentials(body),
      encoded = await passwordHash(password);
    const result = await db
      .prepare(
        "INSERT OR IGNORE INTO users(id,username,password_hash,created_at) VALUES(1,?,?,?)",
      )
      .bind(username, encoded, stamp)
      .run();
    if (!result.meta.changes)
      throw new HttpError(409, "账号已经设置，请直接登录", "configured");
    const response = json({ username }, 201);
    response.headers.set("Set-Cookie", await newSession(db, request, now));
    return response;
  }
  if (path === "/api/login" && request.method === "POST") {
    const ip = await hash(request.headers.get("CF-Connecting-IP") || "local"),
      attempt = await db
        .prepare(
          "SELECT failures FROM login_attempts WHERE ip_hash=? AND expires_at>?",
        )
        .bind(ip, stamp)
        .first<Row>();
    if (Number(attempt?.failures || 0) >= 10)
      throw new HttpError(429, "尝试次数过多，请 15 分钟后再试", "rate_limit");
    const body = await input(request, ["username", "password"]);
    const username = text(body.username).trim(),
      password = text(body.password);
    if (new TextEncoder().encode(password).length > 72)
      bad("密码最多 72 个字节");
    const owner = await db
      .prepare("SELECT username,password_hash FROM users WHERE id=1")
      .first<Row>();
    if (
      !owner ||
      !(await verifyPassword(password, String(owner.password_hash))) ||
      username !== owner.username
    ) {
      await db
        .prepare(
          "INSERT INTO login_attempts(ip_hash,failures,expires_at) VALUES(?,1,?) ON CONFLICT(ip_hash) DO UPDATE SET failures=CASE WHEN expires_at>? THEN failures+1 ELSE 1 END,expires_at=CASE WHEN expires_at>? THEN expires_at ELSE excluded.expires_at END",
        )
        .bind(ip, new Date(now.getTime() + 900000).toISOString(), stamp, stamp)
        .run();
      throw new HttpError(401, "昵称或密码不正确", "credentials");
    }
    await db
      .prepare("DELETE FROM login_attempts WHERE ip_hash=?")
      .bind(ip)
      .run();
    const response = json({ username });
    response.headers.set("Set-Cookie", await newSession(db, request, now));
    return response;
  }
  if (!(await currentUser(db, request, stamp)))
    throw new HttpError(401, "请先登录", "unauthorized");
  if (path === "/api/logout" && request.method === "POST") {
    await db
      .prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(await hash(cookieToken(request)))
      .run();
    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": sessionCookie("", request, true) },
    });
  }
  if (path === "/api/tasks" && request.method === "POST")
    return taskRoute(request, db, now);
  const taskMatch = path.match(/^\/api\/tasks\/([a-f0-9]{24})$/);
  if (taskMatch) return taskRoute(request, db, now, taskMatch[1]);
  const trashMatch = path.match(/^\/api\/trash\/([a-f0-9]{24})(\/restore)?$/);
  if (trashMatch) {
    const body = await input(request, ["version"]),
      version = integer(body.version);
    let statement: D1PreparedStatement;
    if (trashMatch[2] && request.method === "POST")
      statement = db
        .prepare(
          "UPDATE tasks SET deleted_at=NULL,updated_at=?,priority=0,version=version+1 WHERE id=? AND user_id=1 AND version=? AND deleted_at IS NOT NULL",
        )
        .bind(stamp, trashMatch[1], version);
    else if (!trashMatch[2] && request.method === "DELETE")
      statement = db
        .prepare(
          "DELETE FROM tasks WHERE id=? AND user_id=1 AND version=? AND deleted_at IS NOT NULL",
        )
        .bind(trashMatch[1], version);
    else throw new HttpError(404, "接口不存在", "not_found");
    const result = await statement.run();
    if (!result.meta.changes) conflict();
    return new Response(null, { status: 204 });
  }
  if (path === "/api/recurring") return goalRoute(request, db, now);
  const goalMatch = path.match(/^\/api\/recurring\/([a-f0-9]{24})$/);
  if (goalMatch) return goalRoute(request, db, now, goalMatch[1]);
  const recordsMatch = path.match(
    /^\/api\/recurring\/([a-f0-9]{24})\/records$/,
  );
  if (recordsMatch && request.method === "GET") {
    return json(await getRecurringHistory(db, recordsMatch[1], now));
  }
  const checkinMatch = path.match(
    /^\/api\/recurring\/([a-f0-9]{24})\/checkin$/,
  );
  if (checkinMatch && request.method === "POST") {
    return recurringCheckinRoute(request, db, now, checkinMatch[1]);
  }
  if (path === "/api/quote" && request.method === "GET")
    return quote(db, env, now);
  if (path === "/api/resources" && request.method === "GET") {
    const result = await db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_schema")
      .run();
    return json({
      memory: {
        usedBytes: null,
        source: "worker_unavailable",
        limitBytes: 134217728,
      },
      storage: {
        usedBytes: Number.isFinite(result.meta.size_after)
          ? result.meta.size_after
          : null,
        source: "d1",
      },
      cloudflareConnected: true,
      updatedAt: stamp,
    });
  }
  if (path === "/api/board" && request.method === "GET") {
    const date = url.searchParams.get("date") || beijingDate(now),
      bounds = periods(date);
    await generate(db, now);
    const tasks = await readTasks(db);
    const buckets: Record<Task["bucket"], Task[]> = {
        today: [],
        three: [],
        week: [],
        month: [],
      },
      carryovers: Task[] = [],
      trash: Task[] = [];
    for (const task of tasks) {
      if (task.deletedAt) {
        trash.push(task);
        continue;
      }
      switch (task.bucket) {
        case "today":
          if (task.date === date) {
            buckets.today.push(task);
          } else if (task.date < date && !task.done && !task.recurringId) {
            carryovers.push(task);
          }
          break;
        case "three": {
          const cycleEnd = addDays(task.date, 2);
          if (date === cycleEnd) {
            if (!task.done) {
              buckets.today.push({
                ...task,
                bucket: "today",
                date,
              });
            } else {
              buckets.three.push(task);
            }
          } else if (task.date <= date && date < cycleEnd) {
            buckets.three.push(task);
          } else if (task.date >= bounds.three.start && task.date <= bounds.three.end) {
            buckets.three.push(task);
          } else if (date > cycleEnd && !task.done && !task.recurringId) {
            carryovers.push(task);
          }
          break;
        }
        case "week": {
          const createdDate = task.createdAt.slice(0, 10);
          const friday = addDays(task.date, 4);
          const sunday = addDays(task.date, 6);
          if (date === sunday && (createdDate < sunday || date > createdDate)) {
            if (!task.done) {
              buckets.today.push({
                ...task,
                bucket: "today",
                date,
              });
            } else {
              buckets.week.push(task);
            }
          } else if (date >= friday && date < sunday && (createdDate < friday || date > createdDate)) {
            if (!task.done) {
              buckets.three.push({
                ...task,
                bucket: "three",
                date: friday,
              });
            } else {
              buckets.week.push(task);
            }
          } else if (
            (task.date <= date && date <= sunday) ||
            (task.date >= bounds.week.start && task.date <= bounds.week.end)
          ) {
            buckets.week.push(task);
          } else if (date > sunday && !task.done && !task.recurringId) {
            carryovers.push(task);
          }
          break;
        }
        case "month": {
          const monthEnd = lastDayOfMonth(task.date);
          const sprintStart = addDays(monthEnd, -6);
          if (date >= sprintStart && date <= monthEnd) {
            if (!task.done) {
              buckets.week.push({
                ...task,
                bucket: "week",
                date: bounds.week.start,
              });
            } else {
              buckets.month.push(task);
            }
          } else if (
            (date >= task.date && date <= monthEnd) ||
            (task.date >= bounds.month.start && task.date <= bounds.month.end)
          ) {
            buckets.month.push(task);
          } else if (date > monthEnd && !task.done && !task.recurringId) {
            carryovers.push(task);
          }
          break;
        }
      }
    }
    return json({
      date,
      periods: bounds,
      buckets,
      carryovers,
      trash,
      recurringPlans: await goals(db, now),
      statistics: statistics(tasks, now),
      reminderSettings: await loadReminderSettings(db),
      syncedAt: stamp,
    });
  }
  if (path === "/api/settings/reminder") {
    if (request.method === "GET") {
      return json(await loadReminderSettings(db));
    }
    if (request.method === "PUT") {
      const body = await input(request, [
        "enabled",
        "webhookUrl",
        "webhookSecret",
        "defaultAdvance",
      ]);
      const webhookUrl = text(body.webhookUrl, "").trim();
      const webhookSecret = text(body.webhookSecret, "").trim();
      const enabled = boolean(body.enabled);
      const defaultAdvance =
        body.defaultAdvance !== undefined ? Number(body.defaultAdvance) : 0;
      if (enabled && !webhookUrl) bad("开启提醒需填写飞书机器人 Webhook 地址");
      if (defaultAdvance < 0 || defaultAdvance > 120) bad("提前时间无效");
      const settings: ReminderSettings = {
        enabled,
        webhookUrl,
        webhookSecret,
        defaultAdvance,
      };
      await saveReminderSettings(db, settings, stamp);
      return json(settings);
    }
  }
  if (path === "/api/settings/reminder/test" && request.method === "POST") {
    const body = await input(request, ["webhookUrl", "webhookSecret"]);
    let webhookUrl = text(body.webhookUrl, "").trim();
    let webhookSecret = text(body.webhookSecret, "").trim();
    if (!webhookUrl) {
      const current = await loadReminderSettings(db);
      if (current.webhookUrl) {
        webhookUrl = current.webhookUrl;
        if (!webhookSecret) webhookSecret = current.webhookSecret || "";
      }
    }
    if (!webhookUrl) bad("请先填写飞书机器人 Webhook 地址");
    const testMsg = `🎉 这是一条来自四格计划的测试通知！\n⏰ 发送时间：${now.toISOString()}\n✅ 飞书自定义机器人连接成功，到点将为你推送计划提醒。`;
    await sendFeishuNotification(
      webhookUrl,
      webhookSecret,
      "四格计划 · 测试提醒",
      testMsg,
    );
    return json({
      status: "ok",
      message: "测试提醒已发送，请检查飞书群聊或单聊消息",
    });
  }
  if (path === "/api/statistics" && request.method === "GET") {
    const value = url.searchParams.get("year");
    let year = 0;
    if (value !== null) {
      year = Number(value);
      if (
        !/^\d{1,4}$/.test(value) ||
        year < 1 ||
        year > Number(beijingDate(now).slice(0, 4))
      )
        bad("请选择有效年份");
    }
    await generate(db, now);
    return json(statistics(await readTasks(db), now, year));
  }
  if (path === "/api/statistics/day" && request.method === "GET") {
    const date = url.searchParams.get("date") || beijingDate(now);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      bad("日期格式无效，请输入 YYYY-MM-DD");
    }
    await generate(db, now);
    const tasks = await readTasks(db);
    return json(dayDetail(tasks, date));
  }
  if (path === "/api/export" && request.method === "GET") {
    await generate(db, now);
    const response = json({
      formatVersion: 2,
      exportedAt: stamp,
      tasks: (await readTasks(db)).filter((t) => !t.deletedAt),
      recurringPlans: await goals(db, now),
    });
    response.headers.set(
      "Content-Disposition",
      'attachment; filename="four-plans.json"',
    );
    return response;
  }
  throw new HttpError(404, "接口不存在", "not_found");
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/api"))
      return env.ASSETS.fetch(request);
    let response: Response;
    try {
      response = await api(request, env);
    } catch (error) {
      if (error instanceof HttpError)
        response = json(
          { error: error.message, code: error.code },
          error.status,
        );
      else {
        console.error(
          "API failed",
          error instanceof Error ? error.message : "unknown",
        );
        response = json(
          { error: "暂时无法保存，请稍后重试", code: "internal" },
          500,
        );
      }
    }
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("Referrer-Policy", "same-origin");
    return response;
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await checkAndSendReminders(env.DB, new Date());
  },
} satisfies ExportedHandler<Env>;
