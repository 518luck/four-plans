export type Bucket = "today" | "three" | "week" | "month";
export interface Task {
  id: string;
  recurringId?: string;
  title: string;
  notes: string;
  bucket: Bucket;
  date: string;
  done: boolean;
  priority: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  completedAt?: string;
  completionDateEstimated?: boolean;
}
export interface ActivityDay {
  date: string;
  count: number;
  cumulative: number;
}
export interface PlanStatistics {
  totalPlans: number;
  completedPlans: number;
  completionRate: number;
  longestStreak: number;
  currentStreak: number;
  estimatedCompletions: number;
  start: string;
  end: string;
  days: ActivityDay[];
  years: number[];
}
export interface Board {
  date: string;
  periods: Record<Bucket, { start: string; end: string }>;
  buckets: Record<Bucket, Task[]>;
  carryovers: Task[];
  trash: Task[];
  syncedAt: string;
  statistics: PlanStatistics;
  recurringPlans: RecurringPlan[];
}
export interface Session {
  configured: boolean;
  user: { username: string } | null;
}
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export async function request<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(12000),
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
  } catch {
    throw new ApiError("暂时连接不上，请检查服务是否启动后重试", 0);
  }
  if (response.status === 204) return undefined as T;
  let body: { error?: string };
  try {
    body = await response.json();
  } catch {
    throw new ApiError("服务返回异常，请稍后重试", response.status);
  }
  if (!response.ok)
    throw new ApiError(body.error || "操作未完成，请稍后重试", response.status);
  return body as T;
}
export const jsonBody = (value: unknown) => JSON.stringify(value);
export function today(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join("-");
}
export function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
export function dateLabel(date: string, weekday = false): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    ...(weekday ? { weekday: "long" as const } : {}),
  }).format(new Date(`${date}T12:00:00Z`));
}

export interface RecurringPlan {
  id: string;
  title: string;
  notes: string;
  start: string;
  end: string;
  status: "active" | "paused" | "stopped";
  effectiveDate: string;
  version: number;
  generated: number;
  completed: number;
  createdAt: string;
  updatedAt: string;
}
export interface DailyQuote {
  date: string;
  text: string;
  author: string;
  source: string;
  fallback: boolean;
}
