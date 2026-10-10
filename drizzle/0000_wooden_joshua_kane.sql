CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`capability` text NOT NULL,
	`description` text NOT NULL,
	`persona` text NOT NULL,
	`avatar` text DEFAULT '🤖' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`topic` text NOT NULL,
	`workspace_path` text NOT NULL,
	`status` text DEFAULT 'paused' NOT NULL,
	`max_rounds` integer DEFAULT 6 NOT NULL,
	`current_round` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meeting_id` text NOT NULL,
	`channel` text NOT NULL,
	`agent_id` text,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`round` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`meeting_role` text NOT NULL,
	`sdk_session_id` text,
	`speak_order` integer NOT NULL,
	`last_injected_msg_id` integer DEFAULT 0 NOT NULL
);
