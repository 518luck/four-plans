import type { Task, RecurringPlan, PlanStatistics } from "../../web/src/api";
export type Row = Record<string, unknown>;
export class HttpError extends Error {
 constructor(public status: number, message: string, public code = "invalid") { super(message); }
}
export const bad = (message: string): never => { throw new HttpError(400, message); };
export function text(value: unknown, fallback?: string): string {
 if(value===undefined && fallback!==undefined)return fallback;
 if(typeof value!=="string")bad("提交的数据格式不正确");return value as string;
}
export function integer(value: unknown): number {
 if(typeof value!=="number" || !Number.isSafeInteger(value) || value<1)bad("缺少有效版本，请刷新页面");return value as number;
}
export function boolean(value:unknown):boolean {if(typeof value!=="boolean")bad("提交的数据格式不正确");return value as boolean;}
export function parseDate(date: string): Date {
 const result = new Date(`${date}T00:00:00Z`);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date.startsWith("0000")||!Number.isFinite(result.getTime())||result.toISOString().slice(0,10)!==date)bad("请选择有效的日期");return result;
}
export function addDays(date: string, amount: number): string {
 const result=parseDate(date);result.setUTCDate(result.getUTCDate()+amount);return result.toISOString().slice(0,10);
}
export function beijingDate(now: Date): string {
 const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
 return ["year","month","day"].map(type=>parts.find(part=>part.type===type)!.value.padStart(type==="year"?4:2,"0")).join("-");
}
export function periods(date: string) {
 const day=parseDate(date),monday=addDays(date,-((day.getUTCDay()+6)%7));
 const month=date.slice(0,7)+"-01",next=parseDate(month);next.setUTCMonth(next.getUTCMonth()+1);next.setUTCDate(0);
 return {today:{start:date,end:date},three:{start:date,end:addDays(date,2)},week:{start:monday,end:addDays(monday,6)},month:{start:month,end:next.toISOString().slice(0,10)}};
}
export function taskFromRow(row: Row): Task {
 return {id:String(row.id),title:String(row.title),notes:String(row.notes),bucket:row.bucket as Task["bucket"],date:String(row.scheduled_date),done:!!row.done,priority:!!row.priority,version:Number(row.version),createdAt:String(row.created_at),updatedAt:String(row.updated_at),deletedAt:row.deleted_at ? String(row.deleted_at):undefined,completedAt:row.completed_at ? String(row.completed_at):undefined,recurringId:row.recurring_id ? String(row.recurring_id):undefined,completionDateEstimated:!!row.completion_date_estimated};
}
export function goalFromRow(row:Row):RecurringPlan {
 return {id:String(row.id),title:String(row.title),notes:String(row.notes),start:String(row.start_date),end:String(row.end_date),status:row.status as RecurringPlan["status"],effectiveDate:String(row.effective_date),version:Number(row.version),createdAt:String(row.created_at),updatedAt:String(row.updated_at),generated:Number(row.generated||0),completed:Number(row.completed||0)};
}
export function validateTask(task:Task):void {
 task.title=task.title.trim();task.notes=task.notes.trim();
 if(!task.title||[...task.title].length>160)bad("计划标题需要 1–160 个字");if([...task.notes].length>1000)bad("备注最多 1000 个字");
 const bounds=periods(task.date);if(!(task.bucket in bounds))bad("计划类型无效");
 if(task.bucket==="week"||task.bucket==="month")task.date=bounds[task.bucket].start;
 if(task.bucket!=="today"||task.done)task.priority=false;
}
export function validateGoal(plan:RecurringPlan):void {
 plan.title=plan.title.trim();plan.notes=plan.notes.trim();
 if(!plan.title||[...plan.title].length>160)bad("目标需要 1–160 个字");if([...plan.notes].length>1000)bad("备注最多 1000 个字");
 const span=(parseDate(plan.end).getTime()-parseDate(plan.start).getTime())/86400000;
 if(span<0||span>3650)bad("持续时间需要在 1–3651 天之间");
 if(!["active","paused","stopped"].includes(plan.status))bad("目标状态无效");
}
export function statistics(tasks:Task[],now:Date,year=0):PlanStatistics {
 const actualToday=beijingDate(now);let end=actualToday,start=addDays(end,-364);
 if(year){start=`${String(year).padStart(4,"0")}-01-01`;end=`${String(year).padStart(4,"0")}-12-31`;if(end>actualToday)end=actualToday;}
 const result:PlanStatistics={totalPlans:0,completedPlans:0,completionRate:0,longestStreak:0,currentStreak:0,estimatedCompletions:0,start,end,days:[],years:[]};
 const counts=new Map<string,number>();let earliestYear=Number(actualToday.slice(0,4));
 for(const task of tasks){
  if(task.deletedAt)continue;result.totalPlans++;earliestYear=Math.min(earliestYear,Number(task.date.slice(0,4)));
  if(!task.done)continue;result.completedPlans++;if(task.completionDateEstimated)result.estimatedCompletions++;
  if(!task.completedAt||!Number.isFinite(Date.parse(task.completedAt)))continue;
  const date=beijingDate(new Date(task.completedAt));if(date<=actualToday){counts.set(date,(counts.get(date)||0)+1);earliestYear=Math.min(earliestYear,Number(date.slice(0,4)));}
 }
 result.completionRate=result.totalPlans?Math.round(result.completedPlans*100/result.totalPlans):0;
 let previous="",run=0,cumulative=0;
 for(const date of [...counts.keys()].sort()){run=previous===addDays(date,-1)?run+1:1;result.longestStreak=Math.max(result.longestStreak,run);previous=date;if(date<start)cumulative+=counts.get(date)!;}
 let cursor=counts.has(actualToday)?actualToday:addDays(actualToday,-1);
 while(counts.has(cursor)){result.currentStreak++;cursor=addDays(cursor,-1);}
 for(let date=start;date<=end;date=addDays(date,1)){const count=counts.get(date)||0;cumulative+=count;result.days.push({date,count,cumulative});}
 for(let y=Number(actualToday.slice(0,4));y>=earliestYear;y--)result.years.push(y);
 return result;
}
