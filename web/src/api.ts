export type {
  Bucket,
  Task,
  ActivityDay,
  PlanStatistics,
  Board,
  Session,
  RecurringPlan,
  DailyQuote,
} from "../../shared/contracts";
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
