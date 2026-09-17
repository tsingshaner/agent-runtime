ALTER TABLE "runs" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "request_text" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_id_request_id_unique" UNIQUE("session_id","request_id");