ALTER TABLE "routers" ADD COLUMN "api_username" varchar(60);--> statement-breakpoint
ALTER TABLE "routers" ADD COLUMN "api_password_encrypted" text;