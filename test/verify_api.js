const assert = require('assert');
const http = require('http');
const app = require('express')();
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('../server/db');
const { haversineDistance, checkGeofence, getLocalDateString } = require('../server/geo');
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
  // Same coordinates -> distance should be 0
  const d0 = haversineDistance(24.8607, 67.0011, 24.8607, 67.0011);
  assert.strictEqual(d0, 0, 'Distance to same point must be 0');

  // Small displacement (~111 meters is ~0.001 deg latitude)
  const dClose = haversineDistance(24.8607, 67.0011, 24.8617, 67.0011);
  assert(dClose > 100 && dClose < 120, `Expected ~111m, got ${dClose}m`);

  // Large displacement (~11.1 km is ~0.1 deg)
  const dFar = haversineDistance(24.8607, 67.0011, 24.9607, 67.0011);
  assert(dFar > 10000 && dFar < 12000, `Expected ~11km, got ${dFar}m`);

  console.log('✓ Haversine Math verified successfully.');

  // Start HTTP Server
  await new Promise((resolve) => {
    server = testApp.listen(PORT, resolve);
  });
  console.log(`Test server running on port ${PORT}`);

  try {
    // 2. Admin Login
    console.log('2. Testing Admin Login...');
    const adminRes = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'admin@company.com', password: 'admin123' })
    });
    assert.strictEqual(adminRes.status, 200, 'Admin login failed');
    assert.strictEqual(adminRes.data.user.role, 'ADMIN', 'Role must be ADMIN');
    const adminToken = adminRes.data.token;
    console.log('✓ Admin login verified. Role: ADMIN');

    // 3. Employee Login
    console.log('3. Testing Employee Login...');
    const empRes = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'sarah@company.com', password: 'employee123' })
    });
    assert.strictEqual(empRes.status, 200, 'Employee login failed');
    assert.strictEqual(empRes.data.user.role, 'EMPLOYEE', 'Role must be EMPLOYEE');
    const employeeToken = empRes.data.token;
    console.log('✓ Employee login verified. Role: EMPLOYEE');

    // Clean test user attendance records for a fresh run
    db.prepare(`DELETE FROM attendance_records WHERE user_id = ?`).run(empRes.data.user.id);

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
    const office = locRes.data.locations[0];
    console.log(`✓ Retrieved Office Location: "${office.name}" at (${office.latitude}, ${office.longitude}) with radius ${office.radius_meters}m.`);

    // 6. Check-in OUT OF BOUNDS (e.g. 5km away)
    console.log('6. Testing Check-in OUT OF BOUNDS rejection...');
    const outOfBoundsRes = await request('/api/attendance/check-in', {
      method: 'POST',
      headers: { Authorization: `Bearer ${employeeToken}` },
      body: JSON.stringify({
        latitude: office.latitude + 0.05, // ~5.5 km away
        longitude: office.longitude + 0.05,
        gps_accuracy: 12,
        location_id: office.id
      })
    });
    assert.strictEqual(outOfBoundsRes.status, 400, 'Out of bounds check-in must be rejected');
    assert.strictEqual(outOfBoundsRes.data.status, 'OUT_OF_BOUNDS_REJECTED', 'Status must be OUT_OF_BOUNDS_REJECTED');
    console.log(`✓ Out-of-bounds check-in correctly rejected! Distance reported: ${outOfBoundsRes.data.distanceMeters}m (Allowed: ${outOfBoundsRes.data.allowedRadius}m).`);

    // 7. Check-in WITHIN BOUNDS (Inside Geofence)...
    console.log('7. Testing Check-in WITHIN BOUNDS (Inside Geofence)...');
    // Clear any previous successful check-ins for sarah today to test cleanly, keeping rejected audit
    const today = getLocalDateString(new Date());
    db.prepare(`DELETE FROM attendance_records WHERE user_id = ? AND work_date = ? AND status IN ('PRESENT', 'LATE')`).run(empRes.data.user.id, today);

    const checkInRes = await request('/api/attendance/check-in', {
      method: 'POST',
      headers: { Authorization: `Bearer ${employeeToken}` },
      body: JSON.stringify({
        latitude: office.latitude + 0.0001, // ~11 meters away
        longitude: office.longitude + 0.0001,
        gps_accuracy: 8,
        location_id: office.id
      })
    });
    assert.strictEqual(checkInRes.status, 200, `Check-in within bounds failed: ${JSON.stringify(checkInRes.data)}`);
    assert(checkInRes.data.success === true, 'Success flag must be true');
    assert(['PRESENT', 'LATE'].includes(checkInRes.data.status), 'Status must be PRESENT or LATE');
    console.log(`✓ Check-in verified! Status: ${checkInRes.data.status}, Distance: ${checkInRes.data.distanceMeters}m, Timestamp: ${checkInRes.data.serverTimestamp}`);

    // 8. CEO Admin Dashboard Verification
    console.log('8. Testing CEO Admin Dashboard data...');
    const statsRes = await request('/api/admin/dashboard-stats', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(statsRes.status, 200);
    assert(statsRes.data.stats.checkedInToday >= 1, 'Stats must reflect today check-in');
    assert(statsRes.data.stats.rejectedAttemptsToday >= 1, 'Stats must reflect rejected attempt');
    console.log(`✓ CEO Dashboard Stats: Checked In Today = ${statsRes.data.stats.checkedInToday}, Rejected Attempts = ${statsRes.data.stats.rejectedAttemptsToday}`);

    // 9. Admin CSV Export
    console.log('9. Testing Admin CSV Export...');
    const csvRes = await request('/api/admin/attendance/export-csv', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(csvRes.status, 200);
    assert(csvRes.data.includes('Record ID,Employee Code,Employee Name'), 'CSV must contain headers');
    assert(csvRes.data.includes('EMP-101'), 'CSV must contain Sarah Jenkins employee code');
    console.log('✓ CSV Export generated and validated with full attendance logs.');

    console.log('\n======================================================');
    console.log(' ALL BACKEND GEOLOCATION & ATTENDANCE TESTS PASSED! ');
    console.log('======================================================\n');
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  if (server) server.close();
  process.exit(1);
});
