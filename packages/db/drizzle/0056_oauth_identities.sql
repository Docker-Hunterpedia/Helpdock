CREATE TYPE "public"."oauth_provider" AS ENUM('google', 'github');--> statement-breakpoint
CREATE TABLE "user_oauth_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "oauth_provider" NOT NULL,
	"provider_subject" varchar(255) NOT NULL,
	"email_at_link" varchar(320) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_identity_subject_key" UNIQUE("provider","provider_subject"),
	CONSTRAINT "oauth_identity_user_provider_key" UNIQUE("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "user_oauth_identities" ADD CONSTRAINT "user_oauth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;