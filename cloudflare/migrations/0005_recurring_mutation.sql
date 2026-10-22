-- Tie revision writes to the request that actually won the plan version update.
ALTER TABLE recurring_plans ADD COLUMN mutation_id TEXT NOT NULL DEFAULT '';
