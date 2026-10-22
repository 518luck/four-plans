ALTER TABLE tasks ADD COLUMN reminder_date TEXT NOT NULL DEFAULT '';
UPDATE tasks SET reminder_date=scheduled_date WHERE reminder_time!='';
CREATE INDEX tasks_reminder_date ON tasks(reminder_date, reminder_time);
