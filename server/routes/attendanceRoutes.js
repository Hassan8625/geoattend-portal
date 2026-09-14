const express = require('express');
const db = require('../db');
const { protect } = require('../auth');
const { haversineDistance, validateCoordinates, getLocalDateString } = require('../geo');

const router = express.Router();

/**
 * Checks whether the current time is past the late threshold
 */
async function isLateCheckIn(serverDate) {
  try {
    const startTimeSetting = await db.queryOne(`SELECT value FROM system_settings WHERE key = 'work_start_time'`);
    const graceSetting = await db.queryOne(`SELECT value FROM system_settings WHERE key = 'late_grace_minutes'`);
    const tzSetting = await db.queryOne(`SELECT value FROM system_settings WHERE key = 'company_timezone'`);
    const timeZone = (tzSetting && tzSetting.value) ? tzSetting.value : 'Asia/Karachi';

    const [startH, startM] = (startTimeSetting ? startTimeSetting.value : '09:00').split(':').map(Number);
    const graceMinutes = graceSetting ? parseInt(graceSetting.value) : 15;

    // Evaluate current hour and minute in company timezone (e.g. Asia/Karachi)
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const parts = formatter.formatToParts(serverDate);
    const currentH = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const currentM = parseInt(parts.find(p => p.type === 'minute').value, 10);

    const currentTotalMinutes = currentH * 60 + currentM;
    const thresholdTotalMinutes = startH * 60 + startM + graceMinutes;

    return currentTotalMinutes > thresholdTotalMinutes;
  } catch (e) {
    return false;
  }
}

/**
 * @route   POST /api/attendance/check-in
 * @desc    Verify employee GPS location against authorized geofence and record attendance
 * @access  Private (Employee or Admin)
 */
router.post('/check-in', protect, async (req, res) => {
  try {
    const { latitude, longitude, gps_accuracy, location_id, device_info, notes } = req.body || {};

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const accuracy = gps_accuracy !== undefined ? parseFloat(gps_accuracy) : 10;

    // 1. Validate incoming GPS coordinate data
    const coordValidation = validateCoordinates(lat, lng, accuracy);
    if (!coordValidation.valid) {
      return res.status(400).json({
        success: false,
        message: coordValidation.error
      });
    }

    // 2. Determine target geofence location
    let targetLocation = null;
    if (location_id) {
      targetLocation = await db.queryOne(`SELECT * FROM locations WHERE id = ? AND is_active = 1`, [parseInt(location_id)]);
    }

    // If no specific location given or not found, use user's assigned location or nearest active location
    if (!targetLocation) {
      if (req.user.assigned_location_id) {
        targetLocation = await db.queryOne(`SELECT * FROM locations WHERE id = ? AND is_active = 1`, [req.user.assigned_location_id]);
      }
    }

    if (!targetLocation) {
      // Find the nearest active location among all active branches
      const allActiveLocations = await db.query(`SELECT * FROM locations WHERE is_active = 1`);
      if (allActiveLocations.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No active office or site locations are configured in the system. Please contact the CEO / Admin.'
        });
      }

      // Sort by distance to find closest location
      allActiveLocations.sort((a, b) => {
        const distA = haversineDistance(lat, lng, a.latitude, a.longitude);
        const distB = haversineDistance(lat, lng, b.latitude, b.longitude);
        return distA - distB;
      });
      targetLocation = allActiveLocations[0];
    }

    // 3. Calculate distance using spherical Haversine formula
    const distanceMeters = haversineDistance(lat, lng, targetLocation.latitude, targetLocation.longitude);
    const isInsideGeofence = distanceMeters <= targetLocation.radius_meters;

    const now = new Date();
    const serverTimestamp = now.toISOString();
    const workDate = getLocalDateString(now);

    // 4. Check if employee already marked check-in for today
    const existingCheckIn = await db.queryOne(`
      SELECT * FROM attendance_records 
      WHERE user_id = ? AND work_date = ? AND check_type = 'CHECK_IN' AND status IN ('PRESENT', 'LATE')
    `, [req.user.id, workDate]);

    if (existingCheckIn) {
      return res.status(400).json({
        success: false,
        alreadyCheckedIn: true,
        message: `You have already marked your attendance for today (${existingCheckIn.server_timestamp.split('T')[1].substring(0, 5)}).`,
        record: existingCheckIn
      });
    }

    // 5. If OUT OF BOUNDS: record rejected audit attempt so the CEO can inspect
    if (!isInsideGeofence) {
      await db.execute(`
        INSERT INTO attendance_records 
        (user_id, location_id, check_type, latitude, longitude, gps_accuracy, distance_meters, status, server_timestamp, work_date, device_info, notes)
        VALUES (?, ?, 'CHECK_IN', ?, ?, ?, ?, 'OUT_OF_BOUNDS_REJECTED', ?, ?, ?, ?)
      `, [
        req.user.id,
        targetLocation.id,
        lat,
        lng,
        accuracy,
        distanceMeters,
        serverTimestamp,
        workDate,
        device_info || req.headers['user-agent'] || 'Mobile Browser',
        `Attempted check-in outside geofence. Exceeded by ${distanceMeters - targetLocation.radius_meters}m.`
      ]);

      return res.status(400).json({
        success: false,
        verified: false,
        status: 'OUT_OF_BOUNDS_REJECTED',
        distanceMeters,
        allowedRadius: targetLocation.radius_meters,
        targetLocationName: targetLocation.name,
        message: `Location verification failed: You are ${distanceMeters}m away from "${targetLocation.name}". Allowed radius is ${targetLocation.radius_meters}m.`
      });
    }

    // 6. IF INSIDE GEOFENCE: verify if on-time or late
    const late = await isLateCheckIn(now);
    const finalStatus = late ? 'LATE' : 'PRESENT';

    const result = await db.execute(`
      INSERT INTO attendance_records 
      (user_id, location_id, check_type, latitude, longitude, gps_accuracy, distance_meters, status, server_timestamp, work_date, device_info, notes)
      VALUES (?, ?, 'CHECK_IN', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.user.id,
      targetLocation.id,
      lat,
      lng,
      accuracy,
      distanceMeters,
      finalStatus,
      serverTimestamp,
      workDate,
      device_info || req.headers['user-agent'] || 'Mobile Browser',
      notes || (late ? 'Marked late' : 'Verified on-time check-in')
    ]);

    const savedRecord = await db.queryOne(`
      SELECT a.*, l.name as location_name, u.name as user_name, u.employee_code
      FROM attendance_records a
      JOIN locations l ON a.location_id = l.id
      JOIN users u ON a.user_id = u.id
      WHERE a.id = ?
    `, [result.lastInsertRowid]);

    return res.status(200).json({
      success: true,
      verified: true,
      status: finalStatus,
      distanceMeters,
      allowedRadius: targetLocation.radius_meters,
      locationName: targetLocation.name,
      serverTimestamp,
      message: `Verified! Attendance marked as ${finalStatus} at ${targetLocation.name} (${distanceMeters}m from office center).`,
      record: savedRecord
    });
  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).json({ success: false, message: 'Server error processing check-in.' });
  }
});

/**
 * @route   POST /api/attendance/check-out
 * @desc    Mark check-out for the day
 * @access  Private
 */
router.post('/check-out', protect, async (req, res) => {
  try {
    const { latitude, longitude, gps_accuracy, device_info } = req.body || {};
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const accuracy = gps_accuracy !== undefined ? parseFloat(gps_accuracy) : 10;

    const coordValidation = validateCoordinates(lat, lng, accuracy);
    if (!coordValidation.valid) {
      return res.status(400).json({ success: false, message: coordValidation.error });
    }

    const now = new Date();
    const serverTimestamp = now.toISOString();
    const workDate = getLocalDateString(now);

    // Check if user has checked in today
    const existingCheckIn = await db.queryOne(`
      SELECT * FROM attendance_records 
      WHERE user_id = ? AND work_date = ? AND check_type = 'CHECK_IN' AND status IN ('PRESENT', 'LATE')
    `, [req.user.id, workDate]);

    if (!existingCheckIn) {
      return res.status(400).json({
        success: false,
        message: 'No check-in record found for today. You must check in before checking out.'
      });
    }

    // Check if already checked out
    const existingCheckOut = await db.queryOne(`
      SELECT * FROM attendance_records 
      WHERE user_id = ? AND work_date = ? AND check_type = 'CHECK_OUT'
    `, [req.user.id, workDate]);

    if (existingCheckOut) {
      return res.status(400).json({
        success: false,
        message: 'You have already checked out for today.'
      });
    }

    const targetLocation = (await db.queryOne(`SELECT * FROM locations WHERE id = ?`, [existingCheckIn.location_id])) || {
      latitude: lat,
      longitude: lng,
      radius_meters: 100
    };

    const distanceMeters = haversineDistance(lat, lng, targetLocation.latitude, targetLocation.longitude);

    await db.execute(`
      INSERT INTO attendance_records 
      (user_id, location_id, check_type, latitude, longitude, gps_accuracy, distance_meters, status, server_timestamp, work_date, device_info, notes)
      VALUES (?, ?, 'CHECK_OUT', ?, ?, ?, ?, 'PRESENT', ?, ?, ?, ?)
    `, [
      req.user.id,
      existingCheckIn.location_id,
      lat,
      lng,
      accuracy,
      distanceMeters,
      serverTimestamp,
      workDate,
      device_info || req.headers['user-agent'],
      'Daily work completion check-out'
    ]);

    res.json({
      success: true,
      message: 'Check-out completed successfully! Have a great evening.',
      timestamp: serverTimestamp
    });
  } catch (err) {
    console.error('Check-out error:', err);
    res.status(500).json({ success: false, message: 'Server error processing check-out.' });
  }
});

/**
 * @route   GET /api/attendance/today-status
 * @desc    Get logged in user's check-in/out status for today
 * @access  Private
 */
router.get('/today-status', protect, async (req, res) => {
  try {
    const today = getLocalDateString(new Date());

    const checkIn = await db.queryOne(`
      SELECT a.*, l.name as location_name 
      FROM attendance_records a
      LEFT JOIN locations l ON a.location_id = l.id
      WHERE a.user_id = ? AND a.work_date = ? AND a.check_type = 'CHECK_IN' AND a.status IN ('PRESENT', 'LATE')
      ORDER BY a.id DESC LIMIT 1
    `, [req.user.id, today]);

    const checkOut = await db.queryOne(`
      SELECT a.*, l.name as location_name 
      FROM attendance_records a
      LEFT JOIN locations l ON a.location_id = l.id
      WHERE a.user_id = ? AND a.work_date = ? AND a.check_type = 'CHECK_OUT'
      ORDER BY a.id DESC LIMIT 1
    `, [req.user.id, today]);

    res.json({
      success: true,
      today,
      hasCheckedIn: !!checkIn,
      hasCheckedOut: !!checkOut,
      checkInRecord: checkIn || null,
      checkOutRecord: checkOut || null
    });
  } catch (err) {
    console.error('Error fetching today status:', err);
    res.status(500).json({ success: false, message: 'Server error fetching attendance status.' });
  }
});

/**
 * @route   GET /api/attendance/my-history
 * @desc    Get attendance history for current logged-in employee
 * @access  Private
 */
router.get('/my-history', protect, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;

    const records = await db.query(`
      SELECT a.id, a.check_type, a.status, a.latitude, a.longitude, a.distance_meters, 
             a.gps_accuracy, a.server_timestamp, a.work_date, a.notes,
             l.name as location_name
      FROM attendance_records a
      LEFT JOIN locations l ON a.location_id = l.id
      WHERE a.user_id = ?
      ORDER BY a.server_timestamp DESC
      LIMIT ?
    `, [req.user.id, limit]);

    res.json({ success: true, records });
  } catch (err) {
    console.error('Error fetching history:', err);
    res.status(500).json({ success: false, message: 'Server error fetching history.' });
  }
});

module.exports = router;
