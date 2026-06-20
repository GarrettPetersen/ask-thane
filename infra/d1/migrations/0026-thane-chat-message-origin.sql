ALTER TABLE thane_cli_chat_messages
  ADD COLUMN origin TEXT CHECK(origin IN ('chat', 'terminal', 'webhook'));
