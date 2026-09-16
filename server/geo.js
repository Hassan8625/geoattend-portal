/**
 * Geolocation & Geofencing Math Utilities
 */

/**
 * Calculates the great-circle distance between two geographic points
 * using the spherical Haversine formula.
 * @param {number} lat1 Latitude of point 1 (in degrees)
 * @param {number} lon1 Longitude of point 1 (in degrees)
 * @param {number} lat2 Latitude of point 2 (in degrees)
 * @param {number} lon2 Longitude of point 2 (in degrees)
 * @returns {number} Distance in meters rounded to nearest integer
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Mean radius of Earth in meters
  const toRad = deg => (deg * Math.PI) / 180;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

/**
 * Checks if a user's location is inside an office geofence circle
 * @param {number} userLat 
 * @param {number} userLng 
 * @param {number} officeLat 
 * @param {number} officeLng 
 * @param {number} radiusMeters 
 * @returns {{ isInside: boolean, distanceMeters: number, allowedRadius: number }}
 */
function checkGeofence(userLat, userLng, officeLat, officeLng, radiusMeters) {
  const distanceMeters = haversineDistance(userLat, userLng, officeLat, officeLng);
  return {
    isInside: distanceMeters <= radiusMeters,
    distanceMeters,
    allowedRadius: radiusMeters
  };
}

/**
 * Validates coordinate ranges and GPS accuracy
 * @param {number} lat 
 * @param {number} lng 
 * @param {number} accuracy In meters
 * @returns {{ valid: boolean, error?: string }}
 */
function validateCoordinates(lat, lng, accuracy) {
  if (typeof lat !== 'number' || isNaN(lat) || lat < -90 || lat > 90) {
    return { valid: false, error: 'Invalid latitude value (-90 to 90).' };
  }
  if (typeof lng !== 'number' || isNaN(lng) || lng < -180 || lng > 180) {
    return { valid: false, error: 'Invalid longitude value (-180 to 180).' };
  }
  if (typeof accuracy !== 'number' || isNaN(accuracy) || accuracy < 0) {
    return { valid: false, error: 'Invalid GPS accuracy value.' };
  }
  // If GPS accuracy is worse than 200m, signal is too imprecise (e.g. coarse cellular fallback)
  if (accuracy > 200) {
    return {
      valid: false,
      error: `GPS signal accuracy is too weak (${Math.round(accuracy)}m). Please enable High Accuracy Location on your device.`
    };
  }

  return { valid: true };
}

/**
 * Format Date to YYYY-MM-DD in company timezone (defaults to Asia/Karachi)
 */
function getLocalDateString(date = new Date(), timeZone = 'Asia/Karachi') {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(date);
  } catch (_) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

/**
 * Retrieve configured company timezone from database system_settings
 */
async function getCompanyTimezone(dbInstance) {
  try {
    const row = await dbInstance.queryOne(`SELECT value FROM system_settings WHERE key = 'company_timezone'`);
    return (row && row.value) ? row.value : 'Asia/Karachi';
  } catch (_) {
    return 'Asia/Karachi';
  }
}

/**
 * Format Date to YYYY-MM-DD in company timezone (dynamically fetched from system_settings)
 */
async function getCompanyLocalDateString(dbInstance, date = new Date()) {
  const tz = await getCompanyTimezone(dbInstance);
  return getLocalDateString(date, tz);
}

module.exports = {
  haversineDistance,
  checkGeofence,
  validateCoordinates,
  getLocalDateString,
  getCompanyTimezone,
  getCompanyLocalDateString
};
