ALTER TABLE thane_cli_workspaces ADD COLUMN workspace_name TEXT;
ALTER TABLE thane_cli_workspaces ADD COLUMN ascii_art TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_thane_cli_workspaces_slug
  ON thane_cli_workspaces(workspace_slug);

CREATE TABLE IF NOT EXISTS thane_cli_workspace_members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  handle TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES thane_cli_workspaces(id),
  UNIQUE(workspace_id, email)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_workspace_members_email
  ON thane_cli_workspace_members(email, workspace_id);

CREATE TABLE IF NOT EXISTS thane_cli_channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'channel' CHECK(kind IN ('channel', 'dm')),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'private')),
  topic TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES thane_cli_workspaces(id),
  UNIQUE(workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_channels_workspace
  ON thane_cli_channels(workspace_id, name);

CREATE TABLE IF NOT EXISTS thane_cli_channel_members (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  FOREIGN KEY(channel_id) REFERENCES thane_cli_channels(id),
  FOREIGN KEY(member_id) REFERENCES thane_cli_workspace_members(id),
  UNIQUE(channel_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_channel_members_member
  ON thane_cli_channel_members(member_id, channel_id);

CREATE TABLE IF NOT EXISTS thane_cli_chat_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_member_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'chat' CHECK(source IN ('chat', 'terminal')),
  thread_root_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES thane_cli_workspaces(id),
  FOREIGN KEY(channel_id) REFERENCES thane_cli_channels(id),
  FOREIGN KEY(author_member_id) REFERENCES thane_cli_workspace_members(id)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_chat_messages_channel_created
  ON thane_cli_chat_messages(channel_id, created_at);

CREATE INDEX IF NOT EXISTS idx_thane_cli_chat_messages_workspace_created
  ON thane_cli_chat_messages(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS thane_cli_message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES thane_cli_chat_messages(id),
  FOREIGN KEY(member_id) REFERENCES thane_cli_workspace_members(id),
  UNIQUE(message_id, member_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_thane_cli_message_reactions_message
  ON thane_cli_message_reactions(message_id);
