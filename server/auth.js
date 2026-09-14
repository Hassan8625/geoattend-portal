const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'geo_attendance_secure_jwt_token_key_2026_super_secret';
const JWT_EXPIRES_IN = '7d';

/**
 * Generate JWT token for an authenticated user
 */
function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      employee_code: user.employee_code
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Express middleware to protect routes requiring authentication
 */
function protect(req, res, next) {
  let token = null;

  // Check Authorization header
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies && req.cookies.token) {
    // Check Cookie
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user still exists in database and is active
    const user = db.prepare(`
      SELECT id, name, email, employee_code, role, assigned_location_id, department, phone, is_active
      FROM users WHERE id = ?
    `).get(decoded.id);

    if (!user || user.is_active !== 1) {
      return res.status(401).json({ success: false, message: 'Account not found or has been deactivated.' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session. Please log in again.' });
  }
}

/**
 * Express middleware to restrict access to ADMIN / CEO only
 */
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({
      success: false,
      message: 'Access denied: CEO / Administrator privilege required.'
    });
  }
  next();
}

module.exports = {
  generateToken,
  protect,
  adminOnly,
  JWT_SECRET
};
