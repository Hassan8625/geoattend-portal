const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

let db = null;
let isPostgres = false;
let pool = null;

// Normalize parameter placeholders: '?' -> '$1', '$2', ... for PostgreSQL
function toPostgresSql(sql) {
  let idx = 1;
  return sql.replace(/\?/g, () => `$${idx++}`);
}

const DATABASE_URL = process.env.DATABASE_URL;

if (DATABASE_URL && DATABASE_URL.trim()) {
  // -------------------------------------------------------------
  // SUPABASE / POSTGRESQL MODE
  // -------------------------------------------------------------
  isPostgres = true;
  const { Pool } = require('pg');

  // Sanitize connection string in case password contains unencoded special characters like '%'
  let sanitizedUrl = DATABASE_URL.trim();
  try {
    const match = sanitizedUrl.match(/^(postgres(?:ql)?:\/\/)([^@]+)@(.+)$/i);
    if (match) {
      const prefix = match[1];
      const auth = match[2];
      const rest = match[3];
      const colonIdx = auth.indexOf(':');
      if (colonIdx !== -1) {
        const user = auth.substring(0, colonIdx);
        let pass = auth.substring(colonIdx + 1);
        pass = pass.replace(/%(?![0-9a-fA-F]{2})/g, '%25');
        sanitizedUrl = `${prefix}${user}:${pass}@${rest}`;
      }
    }
  } catch (_) {}
  
  const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'false' 
    ? false 
    : (process.env.NODE_ENV === 'production');

  pool = new Pool({
    connectionString: sanitizedUrl,
    ssl: { rejectUnauthorized }
  });

  pool.on('error', (err) => {
    console.error('[DB] Unexpected error on idle Postgres client:', err);
  });

  // Verify connection on startup
  pool.query('SELECT NOW()').then(() => {
    console.log('====================================================');
    console.log(' [DB] Connected to Supabase Cloud PostgreSQL successfully!');
    console.log('====================================================');
  }).catch((err) => {
    console.error('====================================================');
    console.error(' [DB ERROR] Supabase connection failed:', err.message);
    if (sanitizedUrl.includes('db.') && (err.message.includes('ENOTFOUND') || err.message.includes('ETIMEDOUT'))) {
      console.error(' [DB HINT] Direct host db.xxxx.supabase.co is IPv6-only.');
      console.error(' On Replit, use the Supabase Pooler URI: aws-0-[region].pooler.supabase.com:6543');
    }
    console.error('====================================================');
  });

  db = {
    isPostgres: true,

    async query(sql, params = []) {
      const pgSql = toPostgresSql(sql);
      const res = await pool.query(pgSql, params);
      return res.rows;
    },

    async queryOne(sql, params = []) {
      const pgSql = toPostgresSql(sql);
      const res = await pool.query(pgSql, params);
      return res.rows && res.rows.length > 0 ? res.rows[0] : null;
    },

    async execute(sql, params = []) {
      let pgSql = toPostgresSql(sql);
      if (/^\s*insert\s+into\s+(?!system_settings\b)/i.test(sql) && !/returning/i.test(sql)) {
        pgSql += ' RETURNING id';
      }
      const res = await pool.query(pgSql, params);
      const lastId = res.rows && res.rows[0] && res.rows[0].id ? res.rows[0].id : null;
      return { lastInsertRowid: lastId, changes: res.rowCount };
    },

    async close() {
      await pool.end();
    }
  };

} else {
  // -------------------------------------------------------------
  // LOCAL SQLITE MODE (Fallback for offline desktop testing)
  // -------------------------------------------------------------
  const Database = require('better-sqlite3');
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'attendance.db');
  const sqliteDb = new Database(dbPath);

  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');

  // Initialize SQLite tables & seed
  initSqliteDB(sqliteDb);

  db = {
    isPostgres: false,
    sqliteRaw: sqliteDb,

    async query(sql, params = []) {
      return sqliteDb.prepare(sql).all(...params);
    },

    async queryOne(sql, params = []) {
      const row = sqliteDb.prepare(sql).get(...params);
      return row || null;
    },

    async execute(sql, params = []) {
      const info = sqliteDb.prepare(sql).run(...params);
      return {
        lastInsertRowid: info.lastInsertRowid,
        changes: info.changes
      };
    },

    // Synchronous helpers for backward compatibility
    prepare(sql) {
      return sqliteDb.prepare(sql);
    },

    exec(sql) {
      return sqliteDb.exec(sql);
    },

    pragma(cmd) {
      return sqliteDb.pragma(cmd);
    },

    async close() {
      sqliteDb.close();
    }
  };
}

function initSqliteDB(sqliteDb) {
  sqliteDb.exec(`
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
      role TEXT NOT NULL DEFAULT 'EMPLOYEE',
      assigned_location_id INTEGER,
      phone TEXT,
      department TEXT DEFAULT 'General',
      face_descriptor TEXT,
      face_enrolled INTEGER NOT NULL DEFAULT 0,
      profile_photo TEXT,
      token_version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (assigned_location_id) REFERENCES locations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS attendance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      location_id INTEGER,
      check_type TEXT NOT NULL DEFAULT 'CHECK_IN',
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      gps_accuracy REAL NOT NULL,
      distance_meters REAL NOT NULL,
      status TEXT NOT NULL,
      biometric_verified INTEGER NOT NULL DEFAULT 0,
      biometric_confidence REAL,
      face_snapshot TEXT,
      server_timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      work_date TEXT NOT NULL,
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

  // Auto-migration checks for existing SQLite databases
  try { sqliteDb.exec("ALTER TABLE users ADD COLUMN face_descriptor TEXT;"); } catch (_) {}
  try { sqliteDb.exec("ALTER TABLE users ADD COLUMN face_enrolled INTEGER NOT NULL DEFAULT 0;"); } catch (_) {}
  try { sqliteDb.exec("ALTER TABLE users ADD COLUMN profile_photo TEXT;"); } catch (_) {}
  try { sqliteDb.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;"); } catch (_) {}
  try { sqliteDb.exec("ALTER TABLE attendance_records ADD COLUMN biometric_verified INTEGER NOT NULL DEFAULT 0;"); } catch (_) {}
  try { sqliteDb.exec("ALTER TABLE attendance_records ADD COLUMN biometric_confidence REAL;"); } catch (_) {}
  try { sqliteDb.exec("ALTER TABLE attendance_records ADD COLUMN face_snapshot TEXT;"); } catch (_) {}
  try { sqliteDb.exec("DROP INDEX IF EXISTS idx_attendance_user_workdate_type;"); } catch (_) {}
  try { sqliteDb.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_unique_success ON attendance_records(user_id, work_date, check_type) WHERE status IN ('PRESENT', 'LATE');"); } catch (_) {}

  const setSettingStmt = sqliteDb.prepare(`INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)`);
  setSettingStmt.run('work_start_time', '09:00');
  setSettingStmt.run('late_grace_minutes', '15');
  setSettingStmt.run('auto_check_out_time', '18:00');
  setSettingStmt.run('company_name', 'Enterprise Workplace Solutions');
  setSettingStmt.run('company_timezone', 'Asia/Karachi');

  // Ensure real company workplace sites are permanently seeded
  const existingLocations = sqliteDb.prepare(`SELECT name FROM locations`).all().map(l => l.name);
  const insertLoc = sqliteDb.prepare(`
    INSERT INTO locations (name, address, latitude, longitude, radius_meters)
    VALUES (?, ?, ?, ?, ?)
  `);

  if (!existingLocations.includes('CCL')) {
    insertLoc.run(
      'CCL',
      '65-Industrial Estate, Kot Lakhpat, Quaid e Azam Industrial Estate, Lahore',
      31.448848,
      74.332609,
      60
    );
  }

  if (!existingLocations.includes('Masjid')) {
    insertLoc.run(
      'Masjid',
      'C7HH+XQ2, Block C PGECHS 2, Lahore, Pakistan',
      31.429888,
      74.279391,
      50
    );
  }

  if (!existingLocations.includes('Main Workplace - Jinnah Town')) {
    insertLoc.run(
      'Main Workplace - Jinnah Town',
      'H83C+2VM, Block B Jinnah Town, Lahore, 54000, Pakistan',
      31.552588,
      74.322172,
      100
    );
  }

  sqliteDb.prepare(`DELETE FROM locations WHERE name = 'Headquarters - Main Campus'`).run();

  const primaryLoc = sqliteDb.prepare(`SELECT id FROM locations WHERE is_active = 1 ORDER BY id ASC LIMIT 1`).get();
  const defaultLocationId = primaryLoc ? primaryLoc.id : 1;

  const adminCount = sqliteDb.prepare(`SELECT COUNT(*) as count FROM users WHERE role = 'ADMIN'`).get().count;
  if (adminCount === 0) {
    const crypto = require('crypto');
    const tempAdminPassword = crypto.randomBytes(12).toString('base64url');
    const salt = bcrypt.genSaltSync(10);
    const adminHash = bcrypt.hashSync(tempAdminPassword, salt);

    const insertUser = sqliteDb.prepare(`
      INSERT INTO users (name, email, password_hash, employee_code, role, assigned_location_id, department, phone, token_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    insertUser.run(
      'System Administrator',
      'admin@company.com',
      adminHash,
      'ADMIN-001',
      'ADMIN',
      defaultLocationId,
      'Executive',
      '+00-000-0000000'
    );

    console.log('====================================================');
    console.log(' [SECURITY] Zero existing admin accounts detected.');
    console.log(' Initial administrator account generated:');
    console.log(' Email:    admin@company.com');
    console.log(` Temp Pwd: ${tempAdminPassword}`);
    console.log(' IMPORTANT: Log in and reset this password immediately.');
    console.log('====================================================');
  }
}

module.exports = db;
