const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'attendance.db');
const db = new Database(dbPath);

// Enable foreign keys and WAL mode for better concurrency and reliability
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize tables
function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius_meters INTEGER NOT NULL DEFAULT 100,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      employee_code TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'EMPLOYEE', -- 'ADMIN' or 'EMPLOYEE'
      assigned_location_id INTEGER,
      phone TEXT,
      department TEXT DEFAULT 'General',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (assigned_location_id) REFERENCES locations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS attendance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      location_id INTEGER,
      check_type TEXT NOT NULL DEFAULT 'CHECK_IN', -- 'CHECK_IN' or 'CHECK_OUT'
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      gps_accuracy REAL NOT NULL,
      distance_meters REAL NOT NULL,
      status TEXT NOT NULL, -- 'PRESENT', 'LATE', 'OUT_OF_BOUNDS_REJECTED'
      server_timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      work_date TEXT NOT NULL, -- 'YYYY-MM-DD'
      device_info TEXT,
      notes TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Initialize Default Settings if not present
  const setSettingStmt = db.prepare(`INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)`);
  setSettingStmt.run('work_start_time', '09:00');
  setSettingStmt.run('late_grace_minutes', '15');
  setSettingStmt.run('auto_check_out_time', '18:00');
  setSettingStmt.run('company_name', 'Enterprise Workplace Solutions');

  // Ensure all actual company workplace sites are permanently seeded
  const existingLocations = db.prepare(`SELECT name FROM locations`).all().map(l => l.name);
  const insertLoc = db.prepare(`
    INSERT INTO locations (name, address, latitude, longitude, radius_meters)
    VALUES (?, ?, ?, ?, ?)
  `);

  // 1. CCL - Kot Lakhpat
  if (!existingLocations.includes('CCL')) {
    insertLoc.run(
      'CCL',
      '65-Industrial Estate, Kot Lakhpat, Quaid e Azam Industrial Estate, Lahore',
      31.448848,
      74.332609,
      60
    );
  }

  // 2. Masjid
  if (!existingLocations.includes('Masjid')) {
    insertLoc.run(
      'Masjid',
      'C7HH+XQ2, Block C PGECHS 2, Lahore, Pakistan',
      31.429888,
      74.279391,
      50
    );
  }

  // 3. Main Workplace - Jinnah Town
  if (!existingLocations.includes('Main Workplace - Jinnah Town')) {
    insertLoc.run(
      'Main Workplace - Jinnah Town',
      'H83C+2VM, Block B Jinnah Town, Lahore, 54000, Pakistan',
      31.552588,
      74.322172,
      100
    );
  }

  // Remove the old dummy Karachi placeholder if present
  db.prepare(`DELETE FROM locations WHERE name = 'Headquarters - Main Campus'`).run();

  const primaryLoc = db.prepare(`SELECT id FROM locations WHERE is_active = 1 ORDER BY id ASC LIMIT 1`).get();
  const defaultLocationId = primaryLoc ? primaryLoc.id : 1;

  // Check if admin exists, seed default admin & sample employees
  const adminCount = db.prepare(`SELECT COUNT(*) as count FROM users WHERE role = 'ADMIN'`).get().count;
  if (adminCount === 0) {
    const salt = bcrypt.genSaltSync(10);
    const adminHash = bcrypt.hashSync('admin123', salt);
    const empHash = bcrypt.hashSync('employee123', salt);

    const insertUser = db.prepare(`
      INSERT INTO users (name, email, password_hash, employee_code, role, assigned_location_id, department, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // CEO / Admin Account
    insertUser.run(
      'Arthur Vance (CEO / Admin)',
      'admin@company.com',
      adminHash,
      'CEO-001',
      'ADMIN',
      defaultLocationId,
      'Executive',
      '+1-555-0100'
    );

    // Seed 3 sample employees
    insertUser.run(
      'Sarah Jenkins',
      'sarah@company.com',
      empHash,
      'EMP-101',
      'EMPLOYEE',
      defaultLocationId,
      'Operations',
      '+1-555-0101'
    );

    insertUser.run(
      'Michael Chen',
      'michael@company.com',
      empHash,
      'EMP-102',
      'EMPLOYEE',
      defaultLocationId,
      'Engineering',
      '+1-555-0102'
    );

    insertUser.run(
      'Elena Rostova',
      'elena@company.com',
      empHash,
      'EMP-103',
      'EMPLOYEE',
      defaultLocationId,
      'Marketing',
      '+1-555-0103'
    );

    console.log('Database initialized with default CEO/Admin and sample employees.');
  }
}

initDB();

module.exports = db;
