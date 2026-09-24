CREATE TABLE "tasks" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL UNIQUE,
	"texts" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id");