CREATE TYPE "public"."brand_role_source" AS ENUM('manual', 'sso');--> statement-breakpoint
CREATE TYPE "public"."sso_protocol" AS ENUM('oidc', 'saml');--> statement-breakpoint
CREATE TABLE "sso_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"protocol" "sso_protocol" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"email_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"jit_enabled" boolean DEFAULT true NOT NULL,
	"idp_enforces_mfa" boolean DEFAULT false NOT NULL,
	"default_access" jsonb,
	"group_attribute" varchar(200),
	"config" jsonb NOT NULL,
	"secret_encrypted" text,
	"last_sign_in_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_role_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"idp_group" varchar(300) NOT NULL,
	"brand_id" uuid NOT NULL,
	"role" "brand_role" NOT NULL,
	"department_ids" uuid[],
	"position" integer NOT NULL,
	CONSTRAINT "sso_mapping_group_brand_key" UNIQUE("connection_id","idp_group","brand_id")
);
--> statement-breakpoint
CREATE TABLE "user_sso_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"subject" varchar(300) NOT NULL,
	"email_at_link" varchar(320) NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sign_in_at" timestamp with time zone,
	CONSTRAINT "sso_identity_subject_key" UNIQUE("connection_id","subject")
);
--> statement-breakpoint
ALTER TABLE "user_brand_roles" ADD COLUMN "source" "brand_role_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_brand_roles" ADD COLUMN "sso_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_role_mappings" ADD CONSTRAINT "sso_role_mappings_connection_id_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sso_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_role_mappings" ADD CONSTRAINT "sso_role_mappings_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sso_identities" ADD CONSTRAINT "user_sso_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sso_identities" ADD CONSTRAINT "user_sso_identities_connection_id_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sso_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connections_name_lower_key" ON "sso_connections" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "user_brand_roles" ADD CONSTRAINT "user_brand_roles_sso_connection_id_sso_connections_id_fk" FOREIGN KEY ("sso_connection_id") REFERENCES "public"."sso_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_brand_roles" ADD CONSTRAINT "user_brand_roles_source_connection_check" CHECK (("user_brand_roles"."source" = 'sso') = ("user_brand_roles"."sso_connection_id" IS NOT NULL));