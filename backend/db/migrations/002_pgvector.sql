-- Optional: pgvector embeddings for menu items and taste profiles (Preference Memory, phase 2).
-- Hosted Postgres without the extension (e.g. Railway's default image) skips this migration without failing.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector not available (%), skipping embedding columns', SQLERRM;
    RETURN;
  END;
  ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS embedding vector(1024);
  ALTER TABLE preference_profiles ADD COLUMN IF NOT EXISTS taste_embedding vector(1024);
END $$;
