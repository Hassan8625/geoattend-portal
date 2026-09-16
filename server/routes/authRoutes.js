const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { generateToken, protect, JWT_SECRET } = require('../auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again in 15 minutes.'
  }
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many accounts registered from this IP. Please try again later.'
  }
});

/**
 * @route   POST /api/auth/register
 * @desc    Register a new employee
 * @access  Public
 */
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { name, email, password, employee_code, phone, department, assigned_location_id } = req.body;

    if (!name || !email || !password || !employee_code) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, employee code, and password are required.'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long.'
      });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedCode = employee_code.trim().toUpperCase();

    // Check if email or employee code already exists
    const existing = await db.queryOne(`
      SELECT id, email, employee_code FROM users 
      WHERE email = ? OR employee_code = ?
    `, [trimmedEmail, trimmedCode]);

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Registration failed. An account matching these employee details is already registered or unavailable.'
      });
    }

    // Location assignment: if specific location provided, assign it; if 'unassigned' or empty, keep as null for later admin assignment
    let targetLocationId = null;
    if (assigned_location_id && assigned_location_id !== 'unassigned') {
      const locExists = await db.queryOne(`SELECT id FROM locations WHERE id = ? AND is_active = 1`, [parseInt(assigned_location_id)]);
      if (locExists) {
        targetLocationId = locExists.id;
      }
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const result = await db.execute(`
      INSERT INTO users (name, email, password_hash, employee_code, role, assigned_location_id, phone, department)
      VALUES (?, ?, ?, ?, 'EMPLOYEE', ?, ?, ?)
    `, [
      name.trim(),
      trimmedEmail,
      password_hash,
      trimmedCode,
      targetLocationId,
      phone ? phone.trim() : null,
      department ? department.trim() : 'General'
    ]);

    const newUser = await db.queryOne(`
      SELECT id, name, email, employee_code, role, assigned_location_id, department, phone
      FROM users WHERE id = ?
    `, [result.lastInsertRowid]);

    const token = generateToken(newUser);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.status(201).json({
      success: true,
      message: 'Account created successfully! Welcome to the portal.',
      token,
      user: newUser
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, message: 'Server error during registration.' });
  }
});

/**
 * @route   POST /api/auth/login
 * @desc    Authenticate user & get token
 * @access  Public
 */
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { identifier, password } = req.body; // identifier can be email or employee_code

    if (!identifier || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email/employee code and password.'
      });
    }

    const trimmedId = identifier.trim();

    // Query by email OR employee_code OR full name
    const candidates = await db.query(`
      SELECT u.id, u.name, u.email, u.password_hash, u.employee_code, u.role, 
             u.assigned_location_id, u.department, u.phone, u.is_active,
             u.token_version, u.face_enrolled, u.profile_photo,
             l.name as location_name, l.latitude as location_lat, l.longitude as location_lng, l.radius_meters
      FROM users u
      LEFT JOIN locations l ON u.assigned_location_id = l.id
      WHERE LOWER(u.email) = LOWER(?) OR UPPER(u.employee_code) = UPPER(?) OR LOWER(u.name) = LOWER(?)
    `, [trimmedId, trimmedId, trimmedId]);

    if (!candidates || candidates.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid credentials. Please verify your identifier and password.' });
    }

    let user = null;
    for (const candidate of candidates) {
      const isMatch = await bcrypt.compare(password, candidate.password_hash);
      if (isMatch) {
        user = candidate;
        break;
      }
    }

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials. Please verify your identifier and password.' });
    }

    const token = generateToken(user);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    const userPayload = {
      id: user.id,
      name: user.name,
      email: user.email,
      employee_code: user.employee_code,
      role: user.role,
      department: user.department,
      phone: user.phone,
      face_enrolled: !!user.face_enrolled,
      profile_photo: user.profile_photo || null,
      assigned_location: user.assigned_location_id ? {
        id: user.assigned_location_id,
        name: user.location_name,
        latitude: user.location_lat,
        longitude: user.location_lng,
        radius_meters: user.radius_meters
      } : null
    };

    res.json({
      success: true,
      message: `Welcome back, ${user.name}!`,
      token,
      user: userPayload
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error during login.' });
  }
});

/**
 * @route   POST /api/auth/enroll-face
 * @desc    Enroll employee 128-dimensional facial biometric template & reference snapshot
 * @access  Private (Employee or Admin)
 */
router.post('/enroll-face', protect, async (req, res) => {
  try {
    const { face_descriptor, profile_photo } = req.body || {};

    if (!face_descriptor || !Array.isArray(face_descriptor) || face_descriptor.length !== 128) {
      return res.status(400).json({
        success: false,
        message: 'Invalid biometric template: exactly 128 facial embedding floats are required.'
      });
    }

    // Gating: If already enrolled, employees cannot self-overwrite biometrics without admin reset
    const existing = await db.queryOne(`SELECT face_enrolled FROM users WHERE id = ?`, [req.user.id]);
    if (existing && existing.face_enrolled && req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Biometric profile is already enrolled and locked. Please contact an administrator to request a biometric reset.'
      });
    }

    const descriptorJson = JSON.stringify(face_descriptor);
    const photoData = profile_photo && typeof profile_photo === 'string' ? profile_photo : null;

    await db.execute(`
      UPDATE users 
      SET face_descriptor = ?, face_enrolled = 1, profile_photo = COALESCE(?, profile_photo)
      WHERE id = ?
    `, [descriptorJson, photoData, req.user.id]);

    res.json({
      success: true,
      message: 'Facial biometric template successfully enrolled and activated!',
      face_enrolled: true,
      profile_photo: photoData
    });
  } catch (err) {
    console.error('Face enrollment error:', err);
    res.status(500).json({ success: false, message: 'Failed to enroll facial biometric profile.' });
  }
});

/**
 * @route   GET /api/auth/face-status
 * @desc    Check if current user has an enrolled biometric profile
 * @access  Private
 */
router.get('/face-status', protect, async (req, res) => {
  try {
    const row = await db.queryOne(`
      SELECT face_enrolled, profile_photo 
      FROM users WHERE id = ?
    `, [req.user.id]);

    res.json({
      success: true,
      face_enrolled: !!(row && row.face_enrolled),
      profile_photo: row ? row.profile_photo : null
    });
  } catch (err) {
    console.error('Face status error:', err);
    res.status(500).json({ success: false, message: 'Error retrieving biometric status.' });
  }
});

/**
 * @route   GET /api/auth/me
 * @desc    Get currently logged in user profile & assigned workplace location
 * @access  Private
 */
router.get('/me', protect, async (req, res) => {
  const user = await db.queryOne(`
    SELECT u.id, u.name, u.email, u.employee_code, u.role, 
           u.assigned_location_id, u.department, u.phone, u.created_at,
           u.face_enrolled, u.profile_photo,
           l.name as location_name, l.address as location_address,
           l.latitude as location_lat, l.longitude as location_lng, l.radius_meters
    FROM users u
    LEFT JOIN locations l ON u.assigned_location_id = l.id
    WHERE u.id = ?
  `, [req.user.id]);

  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      employee_code: user.employee_code,
      role: user.role,
      department: user.department,
      phone: user.phone,
      face_enrolled: !!user.face_enrolled,
      profile_photo: user.profile_photo || null,
      created_at: user.created_at,
      assigned_location: user.assigned_location_id ? {
        id: user.assigned_location_id,
        name: user.location_name,
        address: user.location_address,
        latitude: user.location_lat,
        longitude: user.location_lng,
        radius_meters: user.radius_meters
      } : null
    }
  });
});

/**
 * @route   POST /api/auth/logout
 * @desc    Log out user, clear cookie, and revoke token
 * @access  Public
 */
router.post('/logout', async (req, res) => {
  try {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded && decoded.id) {
          await db.execute(`UPDATE users SET token_version = token_version + 1 WHERE id = ?`, [decoded.id]);
        }
      } catch (_) {}
    }
  } catch (_) {}
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out successfully.' });
});

module.exports = router;

