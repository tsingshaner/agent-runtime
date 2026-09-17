CREATE TABLE "memory_writes" (
	"run_id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"session_id" text NOT NULL,
	"user" text NOT NULL,
	"assistant" text NOT NULL,
	"status" text NOT NULL,
	"error" jsonb
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "memory_error" jsonb;--> statement-breakpoint
ALTER TABLE "memory_writes" ADD CONSTRAINT "memory_writes_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id");