-- Agentic AI Commerce — core schema (PostgreSQL 15+). See docs/07-data-model.md
-- Embedding columns (pgvector) are added by 002_pgvector.sql only when the extension is available.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable login identity: "entra:<oid>", "demo:<id>" (public demo) or "dev:<id>" (local dev).
  external_id TEXT NOT NULL UNIQUE,
  auth_provider TEXT NOT NULL CHECK (auth_provider IN ('entra', 'demo', 'dev')),
  entra_oid UUID UNIQUE,
  entra_tid UUID,
  display_name TEXT NOT NULL,
  family_name TEXT,
  given_name TEXT,
  email CITEXT,
  locale TEXT NOT NULL DEFAULT 'ja-JP' CHECK (locale IN ('ja-JP', 'en')),
  personalization_consent BOOLEAN NOT NULL DEFAULT FALSE,
  sensitive_data_consent_at TIMESTAMPTZ,
  company_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
  address_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users,
  label TEXT NOT NULL CHECK (label IN ('home', 'office', 'other')),
  postal_code CHAR(8) NOT NULL CHECK (postal_code ~ '^\d{3}-\d{4}$'),
  prefecture TEXT NOT NULL,
  city TEXT NOT NULL,
  street TEXT NOT NULL,
  building TEXT,
  recipient_name TEXT,
  phone TEXT,
  zone_code TEXT,
  geo POINT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE payment_methods (
  payment_method_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users,
  type TEXT NOT NULL CHECK (type IN ('card', 'paypay', 'rakuten_pay', 'd_barai', 'au_pay', 'corporate_invoice')),
  psp_token TEXT NOT NULL,              -- PSP token only; card numbers are never stored (PCI DSS)
  brand TEXT, last4 CHAR(4), exp_month SMALLINT, exp_year SMALLINT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  company_id UUID
);

CREATE TABLE restaurants (
  restaurant_id TEXT PRIMARY KEY,
  name_ja TEXT NOT NULL,
  name_en TEXT,
  qualified_invoice_reg_no CHAR(14) NOT NULL CHECK (qualified_invoice_reg_no ~ '^T\d{13}$'),
  min_prep_minutes INT NOT NULL DEFAULT 45,
  opening_hours JSONB NOT NULL,
  zone_codes TEXT[] NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE menu_items (
  item_id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants,
  name_ja TEXT NOT NULL, name_en TEXT,
  description_ja TEXT, description_en TEXT,
  price_incl_tax INT NOT NULL CHECK (price_incl_tax >= 0),
  tax_category TEXT NOT NULL CHECK (tax_category IN ('reduced_8', 'standard_10')),
  allergens TEXT[] NOT NULL DEFAULT '{}',
  allergen_data_complete BOOLEAN NOT NULL DEFAULT FALSE,
  may_contain TEXT[] NOT NULL DEFAULT '{}',
  dietary_tags TEXT[] NOT NULL DEFAULT '{}',
  taste_tags TEXT[] NOT NULL DEFAULT '{}',
  taste_vector JSONB NOT NULL DEFAULT '{}',
  category TEXT, cuisine TEXT, serving_temp TEXT,
  calories INT,
  daily_stock INT,
  is_sold_out BOOLEAN NOT NULL DEFAULT FALSE,
  available_from TIME, available_to TIME,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON menu_items USING GIN (allergens);

CREATE TABLE menu_item_options (
  option_group_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES menu_items ON DELETE CASCADE,
  name_ja TEXT NOT NULL, name_en TEXT,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  options JSONB NOT NULL,  -- [{option_id, name_ja, name_en, price_delta, allergens_added[]}]
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, option_group_id)
);

CREATE TABLE delivery_slots (
  zone_code TEXT NOT NULL,
  slot_start TIMESTAMPTZ NOT NULL,
  capacity INT NOT NULL,
  reserved INT NOT NULL DEFAULT 0 CHECK (reserved <= capacity),
  order_cutoff TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (zone_code, slot_start)
);

CREATE TABLE preference_profiles (
  user_id UUID PRIMARY KEY REFERENCES users,
  allergens TEXT[] NOT NULL DEFAULT '{}',
  dietary TEXT[] NOT NULL DEFAULT '{}',
  soft JSONB NOT NULL DEFAULT '{}',
  version INT NOT NULL DEFAULT 1,
  recomputed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE preference_events (
  event_id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users,
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('item', 'restaurant', 'taste', 'cuisine', 'allergen', 'dietary', 'note')),
  subject_id TEXT,
  value NUMERIC,
  source TEXT NOT NULL CHECK (source IN ('order', 'chat', 'settings', 'feedback', 'system', 'user_edit')),
  user_quote TEXT,
  half_life_days INT,                -- NULL = no decay (allergens, dietary)
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'pending_user_confirmation', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON preference_events (user_id, created_at DESC);

CREATE TABLE carts (
  cart_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users,
  restaurant_id TEXT REFERENCES restaurants,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'checked_out', 'abandoned', 'expired')),
  version INT NOT NULL DEFAULT 1,
  delivery_date DATE, slot_start TIMESTAMPTZ, address_id TEXT REFERENCES addresses,
  payment_method_id TEXT REFERENCES payment_methods,
  coupon_code TEXT, points_used INT NOT NULL DEFAULT 0,
  invoice_recipient TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('agent', 'ui')),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_cart_per_user ON carts (user_id) WHERE status = 'active';

CREATE TABLE cart_lines (
  cart_line_id TEXT PRIMARY KEY,
  cart_id UUID NOT NULL REFERENCES carts ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES menu_items,
  quantity INT NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  options JSONB NOT NULL DEFAULT '{}',
  unit_price_incl_tax INT NOT NULL,
  tax_category TEXT NOT NULL,
  note TEXT,
  added_by TEXT NOT NULL CHECK (added_by IN ('agent', 'user'))
);

CREATE TABLE confirmation_requests (
  confirmation_request_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users,
  cart_id UUID NOT NULL REFERENCES carts,
  cart_version INT NOT NULL,
  checkout_hash TEXT NOT NULL,
  total INT NOT NULL,
  summary JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('AWAITING_USER', 'TOKEN_ISSUED', 'CONSUMED', 'STALE', 'EXPIRED')),
  token_jti UUID UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  order_id TEXT PRIMARY KEY,                       -- A-YYYYMMDD-NNNN
  user_id UUID NOT NULL REFERENCES users,
  cart_id UUID NOT NULL REFERENCES carts,
  restaurant_id TEXT NOT NULL REFERENCES restaurants,
  idempotency_key TEXT NOT NULL UNIQUE,
  confirmation_request_id TEXT NOT NULL,  -- proof of human confirmation (the request itself lives in Redis, 5-minute TTL)
  payment_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  delivery_slot_start TIMESTAMPTZ NOT NULL,
  address_snapshot JSONB NOT NULL,
  subtotal_8 INT NOT NULL DEFAULT 0, subtotal_10 INT NOT NULL DEFAULT 0,
  tax_8 INT NOT NULL DEFAULT 0, tax_10 INT NOT NULL DEFAULT 0,
  discount_total INT NOT NULL DEFAULT 0, delivery_fee INT NOT NULL DEFAULT 0, points_used INT NOT NULL DEFAULT 0,
  total INT NOT NULL,
  placed_via TEXT NOT NULL CHECK (placed_via IN ('agent_chat', 'ui')),
  summary_snapshot JSONB NOT NULL,   -- exactly what the customer confirmed (lines, discounts, tax per rate, recipient)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ
);

CREATE TABLE order_lines (
  order_id TEXT NOT NULL REFERENCES orders,
  line_no INT NOT NULL,
  item_id TEXT NOT NULL,
  name_snapshot TEXT NOT NULL,
  options_snapshot JSONB NOT NULL,
  unit_price_incl_tax INT NOT NULL,
  quantity INT NOT NULL,
  tax_rate SMALLINT NOT NULL CHECK (tax_rate IN (8, 10)),
  allergens_snapshot TEXT[] NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE payments (
  payment_id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders,
  user_id UUID NOT NULL REFERENCES users,
  cart_id UUID NOT NULL REFERENCES carts,
  method_type TEXT NOT NULL,
  psp TEXT NOT NULL,
  psp_payment_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('initiated', 'requires_action', 'authorized', 'captured', 'failed', 'voided', 'refunded', 'unknown')),
  failure_code TEXT,
  raw_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  invoice_id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders,
  issuer_name TEXT NOT NULL,
  issuer_reg_no CHAR(14) NOT NULL CHECK (issuer_reg_no ~ '^T\d{13}$'),
  recipient_name TEXT NOT NULL,
  transaction_date DATE NOT NULL,
  lines JSONB NOT NULL,
  amount_8_incl INT NOT NULL, amount_10_incl INT NOT NULL,
  tax_8 INT NOT NULL, tax_10 INT NOT NULL,
  total INT NOT NULL,
  document_html TEXT NOT NULL,      -- rendered 適格請求書 (HTML, printable); PDF rendering can be added later
  document_sha256 TEXT NOT NULL,
  pdf_blob_path TEXT,
  corrects_invoice_id TEXT REFERENCES invoices,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE email_outbox (
  email_id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders,
  template TEXT NOT NULL,
  locale TEXT NOT NULL,
  to_address CITEXT NOT NULL,
  attachment_invoice_id TEXT REFERENCES invoices,
  status TEXT NOT NULL DEFAULT 'queued',
  provider_message_id TEXT,
  attempts INT NOT NULL DEFAULT 0,
  dedupe_key TEXT NOT NULL UNIQUE
);

CREATE TABLE idempotency_keys (
  user_id UUID NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  response JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE chat_sessions (
  session_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users,
  locale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'abandoned', 'completed', 'expired')),
  epoch INT NOT NULL DEFAULT 0,                 -- increments each time the history is summarized
  summary JSONB,                                 -- latest conversation summary (claude-haiku-5-5)
  cart_id UUID REFERENCES carts,
  order_id TEXT REFERENCES orders,
  main_model TEXT, light_model TEXT,
  total_input_tokens BIGINT NOT NULL DEFAULT 0,
  total_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_logs (
  log_id BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  user_id TEXT NOT NULL,
  turn_index INT,
  actor TEXT NOT NULL CHECK (actor IN ('llm', 'user_chat', 'user_ui', 'system')),
  event_type TEXT NOT NULL,    -- user_message, assistant_message (+thinking summary), tool_call, platform_event, intent, ...
  tool_name TEXT,
  tool_input JSONB, tool_output JSONB,
  cart_version_before INT, cart_version_after INT,
  decision_rationale TEXT,
  model TEXT, request_id TEXT, latency_ms INT, input_tokens INT, output_tokens INT,
  cache_read_tokens INT, cache_write_tokens INT, cost_usd NUMERIC(12, 6),
  prev_hash TEXT NOT NULL, row_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON agent_logs (user_id, log_id DESC);
CREATE INDEX ON agent_logs (session_id, log_id);

-- Append-only: the application role can insert and read, never change history.
-- CREATE ROLE agent_app; GRANT INSERT, SELECT ON agent_logs TO agent_app; GRANT USAGE ON SEQUENCE agent_logs_log_id_seq TO agent_app;

-- Human-readable order numbers: A-YYYYMMDD-NNNN
CREATE SEQUENCE order_number_seq START 41;
CREATE INDEX ON orders (user_id, created_at DESC);
CREATE INDEX ON payments (user_id, created_at DESC);
