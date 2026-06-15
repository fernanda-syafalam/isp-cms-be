CREATE TABLE "app_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"company_name" varchar(120) NOT NULL,
	"company_address" varchar(255) NOT NULL,
	"company_phone" varchar(40) NOT NULL,
	"company_email" varchar(120) NOT NULL,
	"billing_late_fee_idr" integer NOT NULL,
	"billing_due_days" integer NOT NULL,
	"billing_isolir_grace_days" integer NOT NULL,
	"tax_pkp" boolean NOT NULL,
	"tax_npwp" varchar(40) NOT NULL,
	"tax_ppn_rate" real NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_singleton_unique" UNIQUE("singleton")
);
