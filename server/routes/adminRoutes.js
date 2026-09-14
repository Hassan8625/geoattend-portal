const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { protect, adminOnly } = require('../auth');
const { getLocalDateString } = require('../geo');

const router = express.Router();

// Apply auth and adminOnly middleware to all admin routes
router.use(protect);
router.use(adminOnly);

/**
 * @route   GET /api/admin/dashboard-stats
 * @desc    Get live metrics for the CEO dashboard
 * @access  Private (Admin / CEO only)
 */
router.get('/dashboard-stats', async (req, res) => {
  try {
    const today = getLocalDateString(new Date());

    const totalEmpRow = await db.queryOne(`SELECT COUNT(*) as count FROM users WHERE role = 'EMPLOYEE' AND is_active = 1`);
    const totalEmployees = parseInt(totalEmpRow ? totalEmpRow.count : 0);
    
    const presentRow = await db.queryOne(`
      SELECT COUNT(DISTINCT user_id) as count 
      FROM attendance_records 
      WHERE work_date = ? AND check_type = 'CHECK_IN' AND status = 'PRESENT'
    `, [today]);
    const presentToday = parseInt(presentRow ? presentRow.count : 0);

    const lateRow = await db.queryOne(`
      SELECT COUNT(DISTINCT user_id) as count 
      FROM attendance_records 
      WHERE work_date = ? AND check_type = 'CHECK_IN' AND status = 'LATE'
    `, [today]);
    const lateToday = parseInt(lateRow ? lateRow.count : 0);

    const rejectedRow = await db.queryOne(`
      SELECT COUNT(*) as count 
      FROM attendance_records 
      WHERE work_date = ? AND status = 'OUT_OF_BOUNDS_REJECTED'
    `, [today]);
    const rejectedToday = parseInt(rejectedRow ? rejectedRow.count : 0);

    const totalLocRow = await db.queryOne(`SELECT COUNT(*) as count FROM locations WHERE is_active = 1`);
    const totalLocations = parseInt(totalLocRow ? totalLocRow.count : 0);

    res.json({
      success: true,
      stats: {
        totalEmployees,
        checkedInToday: presentToday + lateToday,
        presentToday,
        lateToday,
        absentToday: Math.max(0, totalEmployees - (presentToday + lateToday)),
        rejectedAttemptsToday: rejectedToday,
        totalLocations,
        date: today
      }
    });
  } catch (err) {
    console.error('Error loading dashboard stats:', err);
    res.status(500).json({ success: false, message: 'Server error loading stats.' });
  }
});

/**
 * @route   GET /api/admin/attendance
 * @desc    Query and filter all employee attendance logs
 * @access  Private (Admin / CEO only)
 */
router.get('/attendance', async (req, res) => {
  try {
    const { date, status, location_id, search, limit = 100, page = 1 } = req.query;

    let query = `
      SELECT a.id, a.user_id, a.location_id, a.check_type, a.latitude, a.longitude,
             a.gps_accuracy, a.distance_meters, a.status, a.server_timestamp, a.work_date,
             a.device_info, a.notes,
             u.name as employee_name, u.employee_code, u.department, u.email as employee_email,
             l.name as location_name, l.radius_meters as allowed_radius
      FROM attendance_records a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN locations l ON a.location_id = l.id
      WHERE 1=1
    `;

    const params = [];

    if (date) {
      query += ` AND a.work_date = ?`;
      params.push(date);
    }

    if (status && status !== 'ALL') {
      query += ` AND a.status = ?`;
      params.push(status);
    }

    if (location_id && location_id !== 'ALL') {
      query += ` AND a.location_id = ?`;
      params.push(parseInt(location_id));
    }

    if (search) {
      query += ` AND (u.name LIKE ? OR u.employee_code LIKE ? OR u.department LIKE ?)`;
      const term = `%${search.trim()}%`;
      params.push(term, term, term);
    }

    query += ` ORDER BY a.server_timestamp DESC LIMIT ? OFFSET ?`;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit), offset);

    const records = await db.query(query, params);

    res.json({ success: true, count: records.length, records });
  } catch (err) {
    console.error('Error querying attendance logs:', err);
    res.status(500).json({ success: false, message: 'Server error loading attendance logs.' });
  }
});

/**
 * @route   GET /api/admin/attendance/export-csv
 * @desc    Export attendance records as CSV for CEO / HR payroll
 * @access  Private (Admin / CEO only)
 */
router.get('/attendance/export-csv', async (req, res) => {
  try {
    const { date_from, date_to } = req.query;

    let query = `
      SELECT a.id, u.employee_code, u.name as employee_name, u.department, 
             a.work_date, a.server_timestamp, a.check_type, a.status,
             l.name as location_name, a.distance_meters, a.gps_accuracy,
             a.latitude, a.longitude, a.notes
      FROM attendance_records a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN locations l ON a.location_id = l.id
      WHERE 1=1
    `;
    const params = [];

    if (date_from) {
      query += ` AND a.work_date >= ?`;
      params.push(date_from);
    }
    if (date_to) {
      query += ` AND a.work_date <= ?`;
      params.push(date_to);
    }

    query += ` ORDER BY a.server_timestamp DESC`;

    const records = await db.query(query, params);

    // Build CSV content
    const headers = [
      'Record ID',
      'Employee Code',
      'Employee Name',
      'Department',
      'Work Date',
      'Server Timestamp (UTC)',
      'Type',
      'Status',
      'Verified Location',
      'Distance From Center (m)',
      'GPS Accuracy (m)',
      'Latitude',
      'Longitude',
      'Audit Notes'
    ];

    const rows = records.map(r => [
      r.id,
      `"${r.employee_code || ''}"`,
      `"${r.employee_name || ''}"`,
      `"${r.department || ''}"`,
      `"${r.work_date || ''}"`,
      `"${r.server_timestamp || ''}"`,
      r.check_type,
      r.status,
      `"${r.location_name || 'N/A'}"`,
      r.distance_meters,
      r.gps_accuracy,
      r.latitude,
      r.longitude,
      `"${(r.notes || '').replace(/"/g, '""')}"`
    ]);

    const csvData = [headers.join(','), ...rows.map(row => row.join(','))].join('\r\n');

    const filename = `Attendance_Report_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvData);
  } catch (err) {
    console.error('CSV export error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate CSV export.' });
  }
});

/**
 * @route   GET /api/admin/employees
 * @desc    List all registered employees
 * @access  Private (Admin / CEO only)
 */
router.get('/employees', async (req, res) => {
  try {
    const employees = await db.query(`
      SELECT u.id, u.name, u.email, u.employee_code, u.role, u.department, u.phone, 
             u.is_active, u.created_at, u.assigned_location_id,
             l.name as assigned_location_name,
             (SELECT COUNT(*) FROM attendance_records WHERE user_id = u.id AND status IN ('PRESENT', 'LATE')) as total_checkins
      FROM users u
      LEFT JOIN locations l ON u.assigned_location_id = l.id
      ORDER BY u.role ASC, u.name ASC
    `);

    res.json({ success: true, employees });
  } catch (err) {
    console.error('Error fetching employees:', err);
    res.status(500).json({ success: false, message: 'Server error loading employees.' });
  }
});

/**
 * @route   POST /api/admin/employees
 * @desc    Admin manually adds an employee
 * @access  Private (Admin / CEO only)
 */
router.post('/employees', async (req, res) => {
  try {
    const { name, email, password, employee_code, department, phone, assigned_location_id, role } = req.body;

    if (!name || !email || !password || !employee_code) {
      return res.status(400).json({ success: false, message: 'Name, email, password, and employee code are required.' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedCode = employee_code.trim().toUpperCase();

    const existing = await db.queryOne(`SELECT id FROM users WHERE email = ? OR employee_code = ?`, [trimmedEmail, trimmedCode]);
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email or Employee Code already in use.' });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const userRole = role === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE';
    const result = await db.execute(`
      INSERT INTO users (name, email, password_hash, employee_code, role, assigned_location_id, department, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      name.trim(),
      trimmedEmail,
      password_hash,
      trimmedCode,
      userRole,
      assigned_location_id ? parseInt(assigned_location_id) : null,
      department ? department.trim() : 'General',
      phone ? phone.trim() : null
    ]);

    const created = await db.queryOne(`SELECT id, name, email, employee_code, role, department FROM users WHERE id = ?`, [result.lastInsertRowid]);

    res.status(201).json({
      success: true,
      message: `Employee "${created.name}" created successfully.`,
      employee: created
    });
  } catch (err) {
    console.error('Error adding employee:', err);
    res.status(500).json({ success: false, message: 'Server error adding employee.' });
  }
});

/**
 * @route   PUT /api/admin/employees/:id
 * @desc    Update employee status, department, role, or assigned location
 * @access  Private (Admin / CEO only)
 */
router.put('/employees/:id', async (req, res) => {
  try {
    const employeeId = parseInt(req.params.id);
    const { name, department, phone, assigned_location_id, role, is_active } = req.body;

    const existing = await db.queryOne(`SELECT * FROM users WHERE id = ?`, [employeeId]);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }

    // Protect CEO / primary admin account from self-demotion or deactivation
    if (existing.id === req.user.id && (is_active === 0 || role === 'EMPLOYEE')) {
      return res.status(400).json({ success: false, message: 'You cannot deactivate or demote your own administrator account.' });
    }

    await db.execute(`
      UPDATE users 
      SET name = ?, department = ?, phone = ?, assigned_location_id = ?, role = ?, is_active = ?
      WHERE id = ?
    `, [
      name !== undefined ? name.trim() : existing.name,
      department !== undefined ? department.trim() : existing.department,
      phone !== undefined ? phone.trim() : existing.phone,
      assigned_location_id !== undefined ? (assigned_location_id ? parseInt(assigned_location_id) : null) : existing.assigned_location_id,
      role !== undefined ? role : existing.role,
      is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
      employeeId
    ]);

    const updated = await db.queryOne(`SELECT id, name, email, employee_code, role, department, is_active FROM users WHERE id = ?`, [employeeId]);

    res.json({
      success: true,
      message: `Employee "${updated.name}" updated successfully.`,
      employee: updated
    });
  } catch (err) {
    console.error('Error updating employee:', err);
    res.status(500).json({ success: false, message: 'Failed to update employee.' });
  }
});

module.exports = router;
