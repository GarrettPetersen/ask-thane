ALTER TABLE thane_cli_workspace_invites
  ADD COLUMN invitee_email TEXT;

CREATE INDEX IF NOT EXISTS idx_thane_cli_workspace_invites_invitee_email
  ON thane_cli_workspace_invites(invitee_email);
