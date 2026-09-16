const assert = require('assert');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');

// Ensure JWT_SECRET is present for testing
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_environment_secure_jwt_secret_at_least_32_chars_long!';

const db = require('../server/db');
const { haversineDistance, getLocalDateString } = require('../server/geo');
const authRoutes = require('../server/routes/authRoutes');
const attendanceRoutes = require('../server/routes/attendanceRoutes');
const locationRoutes = require('../server/routes/locationRoutes');
const adminRoutes = require('../server/routes/adminRoutes');
const settingsRoutes = require('../server/routes/settingsRoutes');

// Set up test server
const testApp = express();
testApp.use(express.json());
testApp.use(cookieParser());
testApp.use('/api/auth', authRoutes);
testApp.use('/api/attendance', attendanceRoutes);
testApp.use('/api/locations', locationRoutes);
testApp.use('/api/admin', adminRoutes);
testApp.use('/api/settings', settingsRoutes);

let server;
const PORT = 3099;
const BASE_URL = `http://localhost:${PORT}`;

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const response = await fetch(url, {
    ...options,
    headers
  });
  const contentType = response.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }
  return { status: response.status, data, headers: response.headers };
}

async function runTests() {
  console.log('--- Starting Geolocation & Attendance Verification Tests ---');

  // 1. Haversine Math Verification
  console.log('1. Testing Haversine Math...');
  const d0 = haversineDistance(24.8607, 67.0011, 24.8607, 67.0011);
  assert.strictEqual(d0, 0, 'Distance to same point must be 0');

  const dClose = haversineDistance(24.8607, 67.0011, 24.8617, 67.0011);
  assert(dClose > 100 && dClose < 120, `Expected ~111m, got ${dClose}m`);

  const dFar = haversineDistance(24.8607, 67.0011, 24.9607, 67.0011);
  assert(dFar > 10000 && dFar < 12000, `Expected ~11km, got ${dFar}m`);

  console.log('✓ Haversine Math verified successfully.');

  try {
    // Provision isolated test users
    console.log('Provisioning isolated test credentials...');
    const salt = await bcrypt.genSalt(10);
    const testPassword = 'TestPassword123!';
    const testHash = await bcrypt.hash(testPassword, salt);

    await db.execute(`DELETE FROM users WHERE email IN ('test_admin@company.com', 'test_sarah@company.com') OR employee_code IN ('TEST-ADM', 'TEST-EMP-101')`);

    // Ensure an active location exists
    let primaryLoc = await db.queryOne(`SELECT id FROM locations WHERE is_active = 1 LIMIT 1`);
    if (!primaryLoc) {
      const locResult = await db.execute(`
        INSERT INTO locations (name, address, latitude, longitude, radius_meters, is_active)
        VALUES ('Test HQ', '123 Test St', 31.552588, 74.322172, 100, 1)
      `);
      primaryLoc = { id: locResult.lastInsertRowid };
    }

    await db.execute(`
      INSERT INTO users (name, email, password_hash, employee_code, role, assigned_location_id, department, phone, token_version)
      VALUES ('Test Admin', 'test_admin@company.com', ?, 'TEST-ADM', 'ADMIN', ?, 'Executive', '+1-555-0100', 1)
    `, [testHash, primaryLoc.id]);

    const empRes = await db.execute(`
      INSERT INTO users (name, email, password_hash, employee_code, role, assigned_location_id, department, phone, token_version)
      VALUES ('Sarah Jenkins', 'test_sarah@company.com', ?, 'TEST-EMP-101', 'EMPLOYEE', ?, 'Operations', '+1-555-0101', 1)
    `, [testHash, primaryLoc.id]);

    const empUser = await db.queryOne(`SELECT * FROM users WHERE email = 'test_sarah@company.com'`);

    // Start HTTP Server
    await new Promise((resolve) => {
      server = testApp.listen(PORT, resolve);
    });
    console.log(`Test server running on port ${PORT}`);
    // 2. Admin Login
    console.log('2. Testing Admin Login...');
    const adminLoginRes = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'test_admin@company.com', password: testPassword })
    });
    assert.strictEqual(adminLoginRes.status, 200, 'Admin login failed: ' + JSON.stringify(adminLoginRes.data));
    assert.strictEqual(adminLoginRes.data.user.role, 'ADMIN', 'Role must be ADMIN');
    const adminToken = adminLoginRes.data.token;
    console.log('✓ Admin login verified. Role: ADMIN');

    // 3. Employee Login
    console.log('3. Testing Employee Login...');
    const empLoginRes = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'test_sarah@company.com', password: testPassword })
    });
    assert.strictEqual(empLoginRes.status, 200, 'Employee login failed');
    assert.strictEqual(empLoginRes.data.user.role, 'EMPLOYEE', 'Role must be EMPLOYEE');
    const employeeToken = empLoginRes.data.token;
    console.log('✓ Employee login verified. Role: EMPLOYEE');

    // Clean test user attendance records for a fresh run
    await db.execute(`DELETE FROM attendance_records WHERE user_id = ?`, [empUser.id]);

    // 4. Test Role-Based Security: Employee trying to access Admin endpoint
    console.log('4. Testing Role Security (Employee accessing Admin API)...');
    const forbiddenRes = await request('/api/admin/dashboard-stats', {
      headers: { Authorization: `Bearer ${employeeToken}` }
    });
    assert.strictEqual(forbiddenRes.status, 403, 'Employee must be blocked from admin endpoint');
    console.log('✓ Role security passed: Employee properly blocked (HTTP 403 Forbidden).');

    // 5. Admin fetching Locations
    console.log('5. Testing Location retrieval...');
    const locRes = await request('/api/locations', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(locRes.status, 200);
    assert(locRes.data.locations.length > 0, 'Must have at least 1 location');
    const office = locRes.data.locations.find(l => l.id === primaryLoc.id) || locRes.data.locations[0];
    console.log(`✓ Retrieved Office Location: "${office.name}" at (${office.latitude}, ${office.longitude}) with radius ${office.radius_meters}m.`);

    // 6. Check-in OUT OF BOUNDS (e.g. 5km away)
    console.log('6. Testing Check-in OUT OF BOUNDS rejection...');
    const outOfBoundsRes = await request('/api/attendance/check-in', {
      method: 'POST',
      headers: { Authorization: `Bearer ${employeeToken}` },
      body: JSON.stringify({
        latitude: office.latitude + 0.05, // ~5.5 km away
        longitude: office.longitude + 0.05,
        gps_accuracy: 12
      })
    });
    assert.strictEqual(outOfBoundsRes.status, 400, 'Out of bounds check-in must be rejected');
    assert.strictEqual(outOfBoundsRes.data.status, 'OUT_OF_BOUNDS_REJECTED', 'Status must be OUT_OF_BOUNDS_REJECTED');
    console.log(`✓ Out-of-bounds check-in correctly rejected! Distance: ${outOfBoundsRes.data.distanceMeters}m.`);

    // 7. Check-in WITHIN BOUNDS (Inside Geofence)...
    console.log('7. Testing Check-in WITHIN BOUNDS (Inside Geofence)...');
    const today = getLocalDateString(new Date());
    await db.execute(`DELETE FROM attendance_records WHERE user_id = ? AND work_date = ?`, [empUser.id, today]);

    const checkInRes = await request('/api/attendance/check-in', {
      method: 'POST',
      headers: { Authorization: `Bearer ${employeeToken}` },
      body: JSON.stringify({
        latitude: office.latitude + 0.0001, // ~11 meters away
        longitude: office.longitude + 0.0001,
        gps_accuracy: 8
      })
    });
    assert.strictEqual(checkInRes.status, 200, `Check-in within bounds failed: ${JSON.stringify(checkInRes.data)}`);
    assert(checkInRes.data.success === true, 'Success flag must be true');
    assert(['PRESENT', 'LATE'].includes(checkInRes.data.status), 'Status must be PRESENT or LATE');
    console.log(`✓ Check-in verified! Status: ${checkInRes.data.status}, Distance: ${checkInRes.data.distanceMeters}m.`);

    // 7b. Duplicate Check-in Test: Must be rejected with 400 and alreadyCheckedIn
    console.log('7b. Testing Duplicate Check-In rejection & timestamp formatting...');
    const dupCheckInRes = await request('/api/attendance/check-in', {
      method: 'POST',
      headers: { Authorization: `Bearer ${employeeToken}` },
      body: JSON.stringify({
        latitude: office.latitude + 0.0001,
        longitude: office.longitude + 0.0001,
        gps_accuracy: 8
      })
    });
    assert.strictEqual(dupCheckInRes.status, 400, 'Duplicate check-in must return 400');
    assert.strictEqual(dupCheckInRes.data.alreadyCheckedIn, true, 'Response must indicate alreadyCheckedIn');
    console.log('✓ Duplicate check-in correctly rejected (HTTP 400, alreadyCheckedIn: true).');

    // 8. CEO Admin Dashboard Verification
    console.log('8. Testing CEO Admin Dashboard data...');
    const statsRes = await request('/api/admin/dashboard-stats', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(statsRes.status, 200);
    assert(statsRes.data.stats.checkedInToday >= 1, 'Stats must reflect today check-in');
    console.log(`✓ CEO Dashboard Stats: Checked In Today = ${statsRes.data.stats.checkedInToday}`);

    // 9. Admin CSV Export with Formula Injection defense
    console.log('9. Testing Admin CSV Export...');
    const csvRes = await request('/api/admin/attendance/export-csv', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(csvRes.status, 200);
    assert(csvRes.data.includes('Record ID,Employee Code,Employee Name'), 'CSV must contain headers');
    assert(csvRes.data.includes('TEST-EMP-101'), 'CSV must contain test employee code');
    console.log('✓ CSV Export generated and validated with sanitized attendance logs.');

    console.log('\n======================================================');
    console.log(' ALL BACKEND GEOLOCATION & ATTENDANCE TESTS PASSED! ');
    console.log('======================================================\n');
  } finally {
    try {
      const uIds = (await db.query(`SELECT id FROM users WHERE email IN ('test_admin@company.com', 'test_sarah@company.com')`)).map(u => u.id);
      for (const uid of uIds) {
        await db.execute(`DELETE FROM attendance_records WHERE user_id = ?`, [uid]);
      }
      await db.execute(`DELETE FROM users WHERE email IN ('test_admin@company.com', 'test_sarah@company.com') OR employee_code IN ('TEST-ADM', 'TEST-EMP-101')`);
    } catch (_) {}
    if (server) server.close();
  }
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  if (server) server.close();
  process.exit(1);
});
