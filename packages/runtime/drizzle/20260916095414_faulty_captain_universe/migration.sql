CREATE TABLE "approvals" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"native_request_id" jsonb NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb NOT NULL,
	"allowed_decisions" jsonb NOT NULL,
	"status" text NOT NULL,
	"decision" text,
	CONSTRAINT "approvals_run_id_native_request_id_unique" UNIQUE("run_id","native_request_id"),
	CONSTRAINT "approvals_kind_check" CHECK ("kind" in ('command', 'file-change')),
	CONSTRAINT "approvals_status_check" CHECK ("status" in ('pending', 'responding', 'resolved', 'expired')),
	CONSTRAINT "approvals_decision_check" CHECK ("decision" in ('approve', 'deny'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"run_id" text,
	"sequence" integer,
	"event" jsonb NOT NULL,
	CONSTRAINT "events_pkey" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "events_sequence_check" CHECK ("sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"native_turn_id" text,
	"status" text NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"events_cleared" boolean DEFAULT false NOT NULL,
	CONSTRAINT "runs_status_check" CHECK ("status" in ('starting', 'running', 'waiting_approval', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted')),
	CONSTRAINT "runs_last_sequence_check" CHECK ("last_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY,
	"runtime" text NOT NULL,
	"native_session_id" text NOT NULL,
	"project_id" text NOT NULL,
	"cwd" text NOT NULL,
	"title" text NOT NULL,
	"options" jsonb DEFAULT '{}' NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_runtime_native_session_id_unique" UNIQUE("runtime","native_session_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_run" ON "runs" ("session_id") WHERE "status" in ('starting', 'running', 'waiting_approval', 'cancelling');--> statement-breakpoint
CREATE INDEX "session_runs" ON "runs" ("session_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id");