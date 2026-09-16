const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const INSECURE_DEFAULTS = [
  'geo_attendance_secure_jwt_token_key_2026_super_secret',
  'geofence_attendance_super_secret_jwt_key_2025_secure'
];

if (!JWT_SECRET || INSECURE_DEFAULTS.includes(JWT_SECRET) || JWT_SECRET.length < 32) {
  console.error('====================================================');
  console.error(' [FATAL SECURITY ERROR] JWT_SECRET is not properly configured!');
  console.error(' A secure, unique JWT_SECRET of at least 32 characters is required.');
  console.error(' Current status: ' + (!JWT_SECRET ? 'MISSING' : INSECURE_DEFAULTS.includes(JWT_SECRET) ? 'INSECURE DEFAULT' : 'TOO SHORT (<32 chars)'));
  console.error(' Please set JWT_SECRET in your environment or .env file.');
  console.error('====================================================');
  throw new Error('Fatal: JWT_SECRET environment variable is missing, insecure, or too short (<32 chars). Server boot aborted.');
}

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
      employee_code: user.employee_code,
      token_version: user.token_version !== undefined ? user.token_version : 1
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Express middleware to protect routes requiring authentication
 */
async function protect(req, res, next) {
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
    const user = await db.queryOne(`
      SELECT id, name, email, employee_code, role, assigned_location_id, department, phone, is_active, token_version
      FROM users WHERE id = ?
    `, [decoded.id]);

    if (!user || user.is_active !== 1) {
      return res.status(401).json({ success: false, message: 'Account not found or has been deactivated.' });
    }

    // Check token revocation version
    const expectedVersion = user.token_version !== undefined && user.token_version !== null ? user.token_version : 1;
    const tokenVersion = decoded.token_version !== undefined && decoded.token_version !== null ? decoded.token_version : 1;
    if (tokenVersion !== expectedVersion) {
      return res.status(401).json({ success: false, message: 'Session has been invalidated. Please log in again.' });
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
