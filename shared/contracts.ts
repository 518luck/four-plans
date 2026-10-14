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
  reminderTime?: string;
  reminderAdvance?: number;
  remindedAt?: string;
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
export interface ReminderSettings {
  enabled: boolean;
  webhookUrl: string;
  webhookSecret?: string;
  defaultAdvance: number;
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
  reminderSettings?: ReminderSettings;
}
export interface Session {
  configured: boolean;
  bootstrapRequired?: boolean;
  user: { username: string } | null;
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
