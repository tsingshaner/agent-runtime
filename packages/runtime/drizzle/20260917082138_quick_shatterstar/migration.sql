CREATE TABLE "projects" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"working_directories" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "model" text;
--> statement-breakpoint
INSERT INTO projects (id, name, working_directories, created_at, updated_at)
SELECT project_id, project_id, jsonb_agg(DISTINCT cwd), min(created_at), max(updated_at)
FROM sessions GROUP BY project_id;
--> statement-breakpoint
UPDATE sessions SET model = options->>'model'
WHERE jsonb_typeof(options->'model') = 'string' AND length(trim(options->>'model')) > 0;
