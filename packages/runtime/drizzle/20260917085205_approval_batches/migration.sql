CREATE TABLE "approval_batches" (
	"id" text PRIMARY KEY,
	"native_request_id" jsonb NOT NULL,
	"run_id" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "approval_batches_run_id_native_request_id_unique" UNIQUE("run_id","native_request_id"),
	CONSTRAINT "batch_status_check" CHECK ("status" in ('pending', 'responding', 'resolved', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_run_id_native_request_id_unique";--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "batch_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "batch_index" integer;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_batch_id_native_request_id_unique" UNIQUE("batch_id","native_request_id");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_batch_id_batch_index_unique" UNIQUE("batch_id","batch_index");--> statement-breakpoint
CREATE UNIQUE INDEX "single_approval_request" ON "approvals" ("run_id","native_request_id") WHERE "batch_id" is null;--> statement-breakpoint
ALTER TABLE "approval_batches" ADD CONSTRAINT "approval_batches_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_batch_id_approval_batches_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "approval_batches"("id");--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_kind_check", ADD CONSTRAINT "approvals_kind_check" CHECK ("kind" in ('command', 'file-change', 'tool'));--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_status_check", ADD CONSTRAINT "approvals_status_check" CHECK ("status" in ('pending', 'decided', 'responding', 'resolved', 'expired'));