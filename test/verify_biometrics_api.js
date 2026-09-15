/**
 * Automated Verification Test for AI Biometrics & Active Liveness Endpoints
 */
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('../server/db');

const authRoutes = require('../server/routes/authRoutes');
const attendanceRoutes = require('../server/routes/attendanceRoutes');
const adminRoutes = require('../server/routes/adminRoutes');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/admin', adminRoutes);

const TEST_PORT = 3101;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server;

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
  const data = await response.json();
  return { status: response.status, data };
}

async function runBiometricTests() {
  console.log('--- Starting AI Face Biometrics Verification Tests ---');

  // Start temporary server
  await new Promise(res => {
    server = app.listen(TEST_PORT, () => {
      console.log(`Biometrics test server running on port ${TEST_PORT}`);
      res();
    });
  });

  try {
    // 1. Login as Employee
    console.log('1. Logging in as Sarah Jenkins (Employee)...');
    const loginRes = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'sarah@company.com', password: 'employee123' })
    });

    if (loginRes.status !== 200 || !loginRes.data.token) {
      throw new Error('Employee login failed: ' + JSON.stringify(loginRes.data));
    }
    const token = loginRes.data.token;
    console.log('✓ Employee logged in successfully.');

    // 2. Check initial face enrollment status
    console.log('2. Checking initial face status...');
    const statusRes = await request('/api/auth/face-status', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log(`✓ Initial Face Enrolled: ${statusRes.data.face_enrolled}`);

    // 3. Test Invalid Face Enrollment (wrong dimension)
    console.log('3. Testing validation on invalid face descriptor (5 dimensions instead of 128)...');
    const invalidEnrollRes = await request('/api/auth/enroll-face', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        face_descriptor: [0.1, 0.2, 0.3, 0.4, 0.5],
        profile_photo: 'data:image/jpeg;base64,mock'
      })
    });

    if (invalidEnrollRes.status !== 400) {
      throw new Error(`Expected HTTP 400 for invalid descriptor, got ${invalidEnrollRes.status}`);
    }
    console.log('✓ Invalid 5-dimensional descriptor properly rejected with HTTP 400.');

    // 4. Test Valid 128D Face Enrollment
    console.log('4. Testing valid 128D face descriptor enrollment...');
    const mock128D = Array.from({ length: 128 }, (_, i) => Math.sin(i) * 0.1);
    const mockPhoto = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD...testphoto';

    const validEnrollRes = await request('/api/auth/enroll-face', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        face_descriptor: mock128D,
        profile_photo: mockPhoto
      })
    });

    if (validEnrollRes.status !== 200 || !validEnrollRes.data.success) {
      throw new Error('Valid face enrollment failed: ' + JSON.stringify(validEnrollRes.data));
    }
    console.log('✓ 128D Facial Vector enrolled and saved successfully.');

    // 5. Verify status returns enrolled
    const verifyStatusRes = await request('/api/auth/face-status', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!verifyStatusRes.data.face_enrolled || verifyStatusRes.data.face_descriptor.length !== 128) {
      throw new Error('Face status did not reflect enrolled descriptor.');
    }
    console.log('✓ Face status confirmed enrolled with 128D vector.');

    // Clean up any test records for today so check-in succeeds
    const today = new Date().toISOString().split('T')[0];
    await db.execute(`DELETE FROM attendance_records WHERE user_id = ? AND work_date = ?`, [loginRes.data.user.id, today]);

    // 6. Test Biometrically Verified Check-in
    console.log('6. Submitting Check-In with Biometric Verification & Audit Snapshot...');
    const checkinRes = await request('/api/attendance/check-in', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        latitude: 31.552600,
        longitude: 74.322180,
        gps_accuracy: 8.5,
        check_type: 'CHECK_IN',
        biometric_verified: 1,
        biometric_confidence: 98.7,
        face_snapshot: 'data:image/jpeg;base64,mockAuditSnapshotForCEODashboard',
        device_info: 'Chrome 128 / Windows (AI Biometric Face Verified)'
      })
    });

    if (checkinRes.status !== 200 || !checkinRes.data.success) {
      throw new Error('Check-in failed: ' + JSON.stringify(checkinRes.data));
    }
    console.log(`✓ Biometric Check-In Recorded: Status=${checkinRes.data.record.status}, Dist=${checkinRes.data.record.distance_meters}m, BioVerified=${checkinRes.data.record.biometric_verified}`);

    // 7. Verify Employee History returns biometric fields
    console.log('7. Verifying Employee History returns biometric data...');
    const historyRes = await request('/api/attendance/my-history', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const latestRecord = historyRes.data.records[0];
    if (!latestRecord || latestRecord.biometric_verified !== 1) {
      throw new Error('Latest history record does not have biometric_verified=1');
    }
    console.log(`✓ Employee history verified: BioVerified=${latestRecord.biometric_verified}, Confidence=${latestRecord.biometric_confidence}%`);

    // 8. Test Admin Dashboard view of biometric records
    console.log('8. Logging in as Admin to inspect attendance and employee directory...');
    const adminLogin = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'admin@company.com', password: 'admin123' })
    });
    const adminToken = adminLogin.data.token;

    const adminAttendanceRes = await request('/api/admin/attendance', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const adminRecord = adminAttendanceRes.data.records.find(r => r.id === latestRecord.id);
    if (!adminRecord || !adminRecord.face_snapshot || !adminRecord.employee_profile_photo) {
      throw new Error('Admin attendance query missing face_snapshot or employee_profile_photo.');
    }
    console.log('✓ Admin attendance records contain live snapshot, enrolled photo, and confidence score.');

    const adminEmployeesRes = await request('/api/admin/employees', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const sarahInDirectory = adminEmployeesRes.data.employees.find(e => e.email === 'sarah@company.com');
    if (!sarahInDirectory || sarahInDirectory.face_enrolled !== 1) {
      throw new Error('Employee directory does not reflect face_enrolled=1');
    }
    console.log(`✓ Admin employee directory shows ${sarahInDirectory.name} as Face Enrolled.`);

    console.log('\n======================================================');
    console.log(' ALL BIOMETRIC API TESTS PASSED WITH 100% SUCCESS! ');
    console.log('======================================================\n');
  } finally {
    server.close();
  }
}

runBiometricTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
