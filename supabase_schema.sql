-- ==========================================================
-- GeoAttend PRO — Supabase Cloud PostgreSQL Schema & Seed
-- Run this in your Supabase Project: SQL Editor -> New query
-- ==========================================================

-- 1. Locations Table
CREATE TABLE IF NOT EXISTS locations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  radius_meters INTEGER NOT NULL DEFAULT 100,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Users Table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  employee_code TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'EMPLOYEE', -- 'ADMIN' or 'EMPLOYEE'
  assigned_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  phone TEXT,
  department TEXT DEFAULT 'General',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Attendance Records Table
CREATE TABLE IF NOT EXISTS attendance_records (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  check_type TEXT NOT NULL DEFAULT 'CHECK_IN', -- 'CHECK_IN' or 'CHECK_OUT'
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  gps_accuracy DOUBLE PRECISION NOT NULL,
  distance_meters INTEGER NOT NULL,
  status TEXT NOT NULL, -- 'PRESENT', 'LATE', 'OUT_OF_BOUNDS_REJECTED'
  server_timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  work_date TEXT NOT NULL, -- 'YYYY-MM-DD'
  device_info TEXT,
  notes TEXT
);

-- 4. System Settings Table
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Create Indexes for High Performance
CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance_records(user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_status ON attendance_records(status);
CREATE INDEX IF NOT EXISTS idx_attendance_work_date ON attendance_records(work_date);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_code ON users(employee_code);

-- ==========================================================
-- DEFAULT SEED DATA
-- ==========================================================

-- System Settings
INSERT INTO system_settings (key, value) VALUES
  ('work_start_time', '09:00'),
  ('late_grace_minutes', '15'),
  ('auto_check_out_time', '18:00'),
  ('company_name', 'Enterprise Workplace Solutions'),
  ('company_timezone', 'Asia/Karachi')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Real Workplaces in Lahore
INSERT INTO locations (name, address, latitude, longitude, radius_meters, is_active) VALUES
  ('CCL', '65-Industrial Estate, Kot Lakhpat, Quaid e Azam Industrial Estate, Lahore', 31.448848, 74.332609, 60, 1),
  ('Masjid', 'C7HH+XQ2, Block C PGECHS 2, Lahore, Pakistan', 31.429888, 74.279391, 50, 1),
  ('Main Workplace - Jinnah Town', 'H83C+2VM, Block B Jinnah Town, Lahore, 54000, Pakistan', 31.552588, 74.322172, 100, 1)
ON CONFLICT DO NOTHING;

-- Initial Seed Accounts (Passwords: admin123 and employee123)
-- Hash generated via bcryptjs (10 rounds)
INSERT INTO users (name, email, password_hash, employee_code, role, assigned_location_id, department, phone) VALUES
  (
    'Arthur Vance (CEO / Admin)',
    'admin@company.com',
    '$2b$10$ii1ndTmcXK9ZkXdXa0EQXu6K7uCfd/z6Hkb.6hzBTAM0iyQlHkA7.',
    'CEO-001',
    'ADMIN',
    1,
    'Executive',
    '+92-300-1234567'
  ),
  (
    'Sarah Jenkins',
    'sarah@company.com',
    '$2b$10$NkimVrYNBQ8jn5gNskk92u/d9XfXzwMd.NL.f.Fo2SnpuRAS8MTqW',
    'EMP-101',
    'EMPLOYEE',
    1,
    'Operations',
    '+92-301-2345678'
  ),
  (
    'Michael Chen',
    'michael@company.com',
    '$2b$10$NkimVrYNBQ8jn5gNskk92u/d9XfXzwMd.NL.f.Fo2SnpuRAS8MTqW',
    'EMP-102',
    'EMPLOYEE',
    2,
    'Engineering',
    '+92-302-3456789'
  )
ON CONFLICT (email) DO NOTHING;
