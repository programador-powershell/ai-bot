-- The whole schema, in one migration.
--
-- WHY THERE IS ONLY ONE. A migration chain records how a schema was arrived at, which matters to a
-- deployment that has to walk it and not at all to one starting from nothing. Every deployment of
-- this starts from nothing, so the chain was collapsed into the schema it produces.
--
-- [Cirurgia §4.4] Dialeto sqlite (bun:sqlite) no lugar do Postgres do openbot.
-- TRES COISAS AQUI NAO SAO GERADAS pelo drizzle-kit e precisam sobreviver a
-- uma regeneracao: (1) o indice de expressao channels_recent_activity_idx,
-- que o drizzle-kit serializa quebrado no sqlite e foi consertado a mao;
-- (2) os dois triggers no fim, que tornam a trilha de auditoria append-only;
-- (3) NAO ha extensao vector — knowledge entra SEM busca vetorial (I7).

CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_account_idx` ON `accounts` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`configuration` text NOT NULL,
	`package_id` text,
	`override` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `deployment_packages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`event_type` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_created_at_idx` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `channel_agents` (
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`channel_id`, `agent_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channel_memberships` (
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`channel_id`, `user_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`suggested_prompts` text DEFAULT '[]' NOT NULL,
	`allowed_groups` text DEFAULT '[]' NOT NULL,
	`package_id` text,
	`override` text,
	`last_message` text,
	`last_message_at` integer,
	`last_message_agent_id` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `deployment_packages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`last_message_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `channels_recent_activity_idx` ON `channels` (COALESCE(`last_message_at`, `created_at`) DESC);--> statement-breakpoint
CREATE TABLE `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	`embedding` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chunks_document_position_idx` ON `chunks` (`document_id`,`position`);--> statement-breakpoint
CREATE INDEX `chunks_document_idx` ON `chunks` (`document_id`);--> statement-breakpoint
CREATE TABLE `connector_cursors` (
	`connector_instance_id` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `connector_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`credential_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`source_metadata` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`key_id` text NOT NULL,
	`metadata` text NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deployment_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`source_path` text NOT NULL,
	`checksum` text NOT NULL,
	`loaded_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_packages_tenant_id_unique` ON `deployment_packages` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `document_acls` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`principal` text NOT NULL,
	`effect` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_acls_document_principal_effect_idx` ON `document_acls` (`document_id`,`principal`,`effect`);--> statement-breakpoint
CREATE INDEX `document_acls_principal_idx` ON `document_acls` (`principal`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text NOT NULL,
	`source_id` text NOT NULL,
	`title` text NOT NULL,
	`canonical_url` text NOT NULL,
	`metadata` text NOT NULL,
	`content_hash` text NOT NULL,
	`deleted_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_connector_source_idx` ON `documents` (`connector_instance_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `documents_connector_deleted_idx` ON `documents` (`connector_instance_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `intelligence_channel_mappings` (
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`user_id`, `channel_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intelligence_channel_mappings_thread_idx` ON `intelligence_channel_mappings` (`thread_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`completed_at` integer,
	`error` text,
	`stats` text NOT NULL,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_runs_connector_started_at_idx` ON `sync_runs` (`connector_instance_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`user_id`, `role`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`image` text,
	`email_verified` integer DEFAULT false NOT NULL,
	`groups` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text NOT NULL,
	`provider_subscription_id` text NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `action_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`deny` text NOT NULL,
	`allow` text NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_preferences` (
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`hidden_at` integer,
	PRIMARY KEY(`user_id`, `agent_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_profiles` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`title` text NOT NULL,
	`role_description` text NOT NULL,
	`avatar_seed` text NOT NULL,
	`visibility` text NOT NULL,
	`deleted_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_profiles_visibility_deleted_idx` ON `agent_profiles` (`visibility`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `component_exclusions` (
	`component_name` text NOT NULL,
	`agent_id` text NOT NULL,
	`withheld_by` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`component_name`, `agent_id`),
	FOREIGN KEY (`component_name`) REFERENCES `components`(`name`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `component_functions` (
	`component_name` text NOT NULL,
	`function_name` text NOT NULL,
	`granted_by` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`component_name`, `function_name`),
	FOREIGN KEY (`component_name`) REFERENCES `components`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `components` (
	`name` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`draft_description` text NOT NULL,
	`published_description` text,
	`published` integer DEFAULT false NOT NULL,
	`published_at` integer,
	`updated_by` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`vendor` text NOT NULL,
	`url` text NOT NULL,
	`provenance` text DEFAULT 'first-party' NOT NULL,
	`credential_id` text,
	`tools_refreshed_at` integer,
	`last_error` text,
	`added_by` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_tools` (
	`server_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`input_schema` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`server_id`, `name`),
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plugin_grants` (
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`agent_id` text NOT NULL,
	`granted_by` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`kind`, `ref`, `agent_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plugin_grants_agent_idx` ON `plugin_grants` (`agent_id`);--> statement-breakpoint
CREATE TABLE `sandboxed_components` (
	`name` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`draft_description` text DEFAULT '' NOT NULL,
	`draft_html` text DEFAULT '' NOT NULL,
	`draft_css` text DEFAULT '' NOT NULL,
	`draft_js_functions` text DEFAULT '' NOT NULL,
	`draft_argument_schema` text DEFAULT '{}' NOT NULL,
	`published_description` text,
	`published_html` text,
	`published_css` text,
	`published_js_functions` text,
	`published_argument_schema` text,
	`sample_arguments` text DEFAULT '{}' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`published_at` integer,
	`authored_by` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`instructions` text NOT NULL,
	`origin` text DEFAULT 'yours' NOT NULL,
	`installed_by` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_slug_key` ON `skills` (`slug`);--> statement-breakpoint
CREATE INDEX `skills_owner_idx` ON `skills` (`owner_user_id`);
--> statement-breakpoint
-- THE AUDIT TRAIL IS APPEND-ONLY, AND THIS IS WHAT MAKES THAT TRUE. A trail anybody can edit after
-- the fact answers no question worth asking. Enforced in the database rather than in the
-- application, because the application is not the only thing that can reach this table.
-- [Cirurgia §4.4] O par de triggers substitui a function+trigger do Postgres.
CREATE TRIGGER `audit_events_append_only_update`
BEFORE UPDATE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'Audit events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_events_append_only_delete`
BEFORE DELETE ON `audit_events`
BEGIN
  SELECT RAISE(ABORT, 'Audit events are append-only');
END;
