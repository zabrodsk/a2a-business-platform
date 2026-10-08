PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS seed_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, origin TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vehicles (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), make TEXT NOT NULL, model TEXT NOT NULL, plate TEXT NOT NULL, vehicle_type TEXT NOT NULL, wheel_size_inches INTEGER NOT NULL, rim_type TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staff (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, name TEXT NOT NULL, location_id TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity=1));
CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, name TEXT NOT NULL, duration_minutes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS price_versions (id TEXT PRIMARY KEY, configuration_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calendar_slots (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id), start_at TEXT NOT NULL, end_at TEXT NOT NULL, origin TEXT NOT NULL, CHECK(start_at < end_at));
CREATE INDEX IF NOT EXISTS slots_window ON calendar_slots(resource_id,start_at,end_at);
CREATE TABLE IF NOT EXISTS inquiries (id TEXT PRIMARY KEY, customer_id TEXT REFERENCES customers(id), name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, location_id TEXT NOT NULL, price_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), slot_id TEXT NOT NULL REFERENCES calendar_slots(id), version INTEGER NOT NULL, price_json TEXT NOT NULL, requires_owner_approval INTEGER NOT NULL, approved_by TEXT REFERENCES staff(id), rulebook_version INTEGER, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, origin TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id), customer_id TEXT NOT NULL REFERENCES customers(id), status TEXT NOT NULL, payment_mode TEXT, amount_minor INTEGER, balance_minor INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, origin TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS booking_holds (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), slot_id TEXT NOT NULL REFERENCES calendar_slots(id), status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payment_intents (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), hold_id TEXT NOT NULL REFERENCES booking_holds(id), request_json TEXT NOT NULL, state TEXT NOT NULL, observation_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, origin TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stripe_checkouts (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), hold_id TEXT NOT NULL UNIQUE REFERENCES booking_holds(id),
  quote_id TEXT NOT NULL REFERENCES quotes(id), quote_version INTEGER NOT NULL, quote_fingerprint TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id), actor_id TEXT NOT NULL, approved_at TEXT NOT NULL,
  payment_mode TEXT NOT NULL CHECK(payment_mode IN ('deposit','full')), amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
  currency TEXT NOT NULL CHECK(currency='czk'), stripe_account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  integration_identifier TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, dispatched_at TEXT,
  state TEXT NOT NULL CHECK(state IN ('prepared','creating','open','processing','paid','expired','failed','reconciliation_required')),
  session_id TEXT UNIQUE, checkout_url TEXT, payment_intent_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), slot_id TEXT NOT NULL REFERENCES calendar_slots(id), customer_id TEXT NOT NULL REFERENCES customers(id), status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), intent_id TEXT UNIQUE REFERENCES payment_intents(id), provider TEXT NOT NULL, origin TEXT NOT NULL, amount_minor INTEGER NOT NULL, payment_mode TEXT NOT NULL, state TEXT NOT NULL, recorded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger_entries (id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id), kind TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(payment_id,kind));
CREATE TABLE IF NOT EXISTS partners (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, contact TEXT NOT NULL, document_eta_days INTEGER NOT NULL, origin TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES partners(id), sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, stock_quantity INTEGER NOT NULL, unit_price_minor INTEGER NOT NULL, eta_days INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS supplier_quotes (id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES partners(id), sku TEXT NOT NULL REFERENCES inventory(sku), quantity INTEGER NOT NULL, unit_price_minor INTEGER NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS purchase_orders (id TEXT PRIMARY KEY, supplier_quote_id TEXT NOT NULL REFERENCES supplier_quotes(id), approved_by TEXT NOT NULL REFERENCES staff(id), status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, event_type TEXT NOT NULL, actor_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
