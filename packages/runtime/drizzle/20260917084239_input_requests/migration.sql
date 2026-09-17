CREATE TABLE "input_requests" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"native_request_id" jsonb NOT NULL,
	"questions" jsonb NOT NULL,
	"answers" jsonb,
	"status" text NOT NULL,
	CONSTRAINT "input_requests_run_id_native_request_id_unique" UNIQUE("run_id","native_request_id"),
	CONSTRAINT "input_status_check" CHECK ("status" in ('pending', 'responding', 'resolved', 'expired'))
);
--> statement-breakpoint
DROP INDEX "one_active_run";--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_run" ON "runs" ("session_id") WHERE "status" in ('starting', 'running', 'waiting_approval', 'waiting_input', 'cancelling');--> statement-breakpoint
ALTER TABLE "input_requests" ADD CONSTRAINT "input_requests_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_status_check", ADD CONSTRAINT "runs_status_check" CHECK ("status" in ('starting', 'running', 'waiting_approval', 'waiting_input', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted'));