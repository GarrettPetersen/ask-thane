PRAGMA foreign_keys = ON;

ALTER TABLE ingest_events ADD COLUMN event_type TEXT;
ALTER TABLE ingest_events ADD COLUMN event_subtype TEXT;
ALTER TABLE ingest_events ADD COLUMN channel_id TEXT;
ALTER TABLE ingest_events ADD COLUMN actor_external_user_id TEXT;
ALTER TABLE ingest_events ADD COLUMN event_ts TEXT;

CREATE INDEX IF NOT EXISTS idx_ingest_events_org_event_type_received
  ON ingest_events(organization_id, provider, event_type, received_at DESC);
