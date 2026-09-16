const assert = require('assert');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');

// Ensure JWT_SECRET is present for testing
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_environment_secure_jwt_secret_at_least_32_chars_long!';

const db = require('../server/db');
const { getLocalDateString } = require('../server/geo');
const authRoutes = require('../server/routes/authRoutes');
const attendanceRoutes = require('../server/routes/attendanceRoutes');
const locationRoutes = require('../server/routes/locationRoutes');
const adminRoutes = require('../server/routes/adminRoutes');
const settingsRoutes = require('../server/routes/settingsRoutes');

// Set up isolated test app
const testApp = express();
testApp.use(express.json());
testApp.use(cookieParser());
testApp.use('/api/auth', authRoutes);
testApp.use('/api/attendance', attendanceRoutes);
testApp.use('/api/locations', locationRoutes);
testApp.use('/api/admin', adminRoutes);
testApp.use('/api/settings', settingsRoutes);

let server;
const PORT = 3098;
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

async function runBiometricTests() {
  console.log('--- Starting Hardened Biometrics & Geofence Security Tests ---');

  // Start HTTP Server
  await new Promise((resolve) => {
    server = testApp.listen(PORT, resolve);
  });
  console.log(`Biometrics test server running on port ${PORT}`);

  try {
    // 0. Provision isolated test accounts
    console.log('0. Provisioning test accounts...');
    const salt = await bcrypt.genSalt(10);
    const testPassword = 'SecurePassword123!';
    const testHash = await bcrypt.hash(testPassword, salt);

    await db.execute(`DELETE FROM users WHERE email IN ('bio_test_emp@company.com', 'bio_test_admin@company.com')`);

    // Ensure an active location exists
    let primaryLoc = await db.queryOne(`SELECT id FROM locations WHERE is_active = 1 LIMIT 1`);
    if (!primaryLoc) {
      const locRes = await db.execute(`
        INSERT INTO locations (name, address, latitude, longitude, radius_meters, is_active)
        VALUES ('Test HQ', '123 Test St', 31.552588, 74.322172, 100, 1)
      `);
      primaryLoc = { id: locRes.lastInsertRowid };
    }

    await db.execute(`
      INSERT INTO users (name, email, password_hash, employee_code, role, assigned_location_id, department, phone, token_version)
      VALUES ('Bio Admin', 'bio_test_admin@company.com', ?, 'BIO-ADM', 'ADMIN', ?, 'Executive', '+1-555-0200', 1)
    `, [testHash, primaryLoc.id]);

    await db.execute(`
      INSERT INTO users (name, email, password_hash, employee_code, role, assigned_location_id, department, phone, token_version)
      VALUES ('Bio Employee', 'bio_test_emp@company.com', ?, 'BIO-EMP', 'EMPLOYEE', ?, 'Engineering', '+1-555-0201', 1)
    `, [testHash, primaryLoc.id]);

    const empUser = await db.queryOne(`SELECT * FROM users WHERE email = 'bio_test_emp@company.com'`);

    // 1. Log in as Employee
    console.log('1. Logging in as test employee...');
    const loginRes = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'bio_test_emp@company.com', password: testPassword })
    });
    assert.strictEqual(loginRes.status, 200, 'Employee login failed');
    let token = loginRes.data.token;
    console.log('✓ Employee logged in successfully.');

    // 2. Reject malformed face descriptor (5 dimensions instead of 128)
    console.log('2. Testing validation on invalid descriptor (wrong dimension)...');
    const invalidEnroll = await request('/api/auth/enroll-face', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        face_descriptor: [0.1, 0.2, 0.3, 0.4, 0.5],
        profile_photo: 'data:image/jpeg;base64,mock'
      })
    });
    assert.strictEqual(invalidEnroll.status, 400, 'Invalid descriptor must return 400');
    console.log('✓ Malformed vector properly rejected with HTTP 400.');

    // 3. Enroll valid 128D Face Descriptor
    console.log('3. Enrolling valid 128D face descriptor...');
    const enrolledVector = Array.from({ length: 128 }, (_, i) => Math.sin(i) * 0.1);
    const validEnroll = await request('/api/auth/enroll-face', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        face_descriptor: enrolledVector,
        profile_photo: 'data:image/jpeg;base64,mockPhoto'
      })
    });
    assert.strictEqual(validEnroll.status, 200, 'Valid enrollment must succeed');
    console.log('✓ 128D face descriptor successfully enrolled.');

    // 4. Test re-enrollment lockout (non-admin self-overwrite blocked)
    console.log('4. Testing biometric re-enrollment lockout...');
    const reEnrollAttempt = await request('/api/auth/enroll-face', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        face_descriptor: Array.from({ length: 128 }, () => 0.5),
        profile_photo: 'data:image/jpeg;base64,overwritePhoto'
      })
    });
    assert.strictEqual(reEnrollAttempt.status, 403, 'Unauthorized re-enrollment must return 403 Forbidden');
    console.log('✓ Re-enrollment lock enforced: Employee cannot self-overwrite face without admin reset.');

    // Clean any prior attendance for today
    const today = getLocalDateString(new Date());
    await db.execute(`DELETE FROM attendance_records WHERE user_id = ? AND work_date = ?`, [empUser.id, today]);

    // 5. SECURITY TEST: Spoof attempt with client-supplied boolean
    console.log('5. Testing spoof rejection: Client sends biometric_verified: 1 without descriptor...');
    const spoofRes = await request('/api/attendance/check-in', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        latitude: 31.552600,
        longitude: 74.322180,
        gps_accuracy: 8.0,
        biometric_verified: 1, // Spoofed flag
        biometric_confidence: 99.9
      })
    });
    assert.strictEqual(spoofRes.status, 400, 'Spoofed flag without valid vector must be rejected');
    console.log('✓ Security verified: Server refuses to trust client biometric_verified boolean (HTTP 400).');

    // 6. SECURITY TEST: Face Mismatch Rejection
    console.log('6. Testing mismatch rejection: Client sends mismatched 128D face descriptor...');
    // Create an inverted / distinct vector with distance > 0.58
    const mismatchedVector = enrolledVector.map(v => v + 0.3);
    const mismatchRes = await request('/api/attendance/check-in', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        latitude: 31.552600,
        longitude: 74.322180,
        gps_accuracy: 8.0,
        face_descriptor: mismatchedVector
      })
    });
    assert.strictEqual(mismatchRes.status, 400, 'Face mismatch must be rejected');
    assert(mismatchRes.data.message.includes('Facial biometric mismatch'), 'Error message must specify mismatch');
    console.log(`✓ Security verified: Face mismatch rejected by server: "${mismatchRes.data.message}"`);

    // 7. POSITIVE TEST: Server-Side Match Verification
    console.log('7. Testing valid server-side biometric verification (matching 128D vector)...');
    // Minor noise well within 0.58 distance threshold
    const matchingVector = enrolledVector.map((v, i) => v + (i % 2 === 0 ? 0.005 : -0.005));
    const verifiedCheckinRes = await request('/api/attendance/check-in', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        latitude: 31.552600,
        longitude: 74.322180,
        gps_accuracy: 8.0,
        face_descriptor: matchingVector,
        face_snapshot: 'data:image/jpeg;base64,mockVerifiedSnapshot'
      })
    });
    assert.strictEqual(verifiedCheckinRes.status, 200, 'Matching check-in must succeed: ' + JSON.stringify(verifiedCheckinRes.data));
    assert.strictEqual(verifiedCheckinRes.data.biometric_verified, 1, 'Server must mark biometric_verified = 1');
    assert(verifiedCheckinRes.data.biometric_confidence > 75, 'Confidence must be calculated server-side');
    console.log(`✓ Server-side biometric check-in verified! BioVerified=${verifiedCheckinRes.data.biometric_verified}, Confidence=${verifiedCheckinRes.data.biometric_confidence}%`);

    // 8. GEOFENCE CHECK-OUT SECURITY TEST: Out-of-bounds check-out must be rejected
    console.log('8. Testing Geofence Check-Out: Out-of-bounds rejection...');
    const outOfBoundsCheckout = await request('/api/attendance/check-out', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        latitude: 31.552600 + 0.05, // ~5.5km away
        longitude: 74.322180 + 0.05,
        gps_accuracy: 10
      })
    });
    assert.strictEqual(outOfBoundsCheckout.status, 400, 'Out-of-bounds check-out must return 400');
    assert.strictEqual(outOfBoundsCheckout.data.status, 'OUT_OF_BOUNDS_REJECTED', 'Status must be OUT_OF_BOUNDS_REJECTED');
    console.log(`✓ Geofence Check-Out enforced: Out-of-bounds check-out rejected (${outOfBoundsCheckout.data.distanceMeters}m away).`);

    // 9. GEOFENCE CHECK-OUT SUCCESS: Inside office boundary
    console.log('9. Testing Geofence Check-Out: Valid on-site check-out...');
    const validCheckout = await request('/api/attendance/check-out', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        latitude: 31.552600,
        longitude: 74.322180,
        gps_accuracy: 8.0
      })
    });
    assert.strictEqual(validCheckout.status, 200, 'On-site check-out must succeed');
    console.log('✓ On-site check-out completed successfully.');

    // 10. TOKEN REVOCATION TEST: Logout immediately revokes token
    console.log('10. Testing Token Revocation on Logout...');
    const logoutRes = await request('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(logoutRes.status, 200, 'Logout must succeed');

    const postLogoutAttempt = await request('/api/attendance/today-status', {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(postLogoutAttempt.status, 401, 'Revoked token must return 401 Unauthorized');
    console.log('✓ Token revocation verified: Revoked token rejected with HTTP 401.');

    // 11. RE-LOGIN TEST: User logs back in after logout and token_version bump
    console.log('11. Testing Re-login after Logout (token_version bump regression check)...');
    const reloginRes = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        identifier: 'bio_test_emp@company.com',
        password: 'SecurePassword123!'
      })
    });
    assert.strictEqual(reloginRes.status, 200, 'Re-login must succeed after logout');
    const newToken = reloginRes.data.token;
    assert(newToken, 'New login token must be provided');

    const authCheck = await request('/api/auth/me', {
      headers: { Authorization: `Bearer ${newToken}` }
    });
    assert.strictEqual(authCheck.status, 200, 'Authenticated request with new token must succeed');
    assert.strictEqual(authCheck.data.user.face_descriptor, undefined, 'Raw face_descriptor must not be leaked on /me');
    console.log('✓ Re-login verified! User can log back in normally; token_version correctly synced.');

    console.log('\n======================================================');
    console.log(' ALL BIOMETRIC & GEOFENCE SECURITY TESTS PASSED! ');
    console.log('======================================================\n');
  } finally {
    try {
      const uIds = (await db.query(`SELECT id FROM users WHERE email IN ('bio_test_emp@company.com', 'bio_test_admin@company.com')`)).map(u => u.id);
      for (const uid of uIds) {
        await db.execute(`DELETE FROM attendance_records WHERE user_id = ?`, [uid]);
      }
      await db.execute(`DELETE FROM users WHERE email IN ('bio_test_emp@company.com', 'bio_test_admin@company.com')`);
    } catch (_) {}
    if (server) server.close();
  }
}

runBiometricTests().catch(err => {
  console.error('Biometric test execution error:', err);
  if (server) server.close();
  process.exit(1);
});
