const express = require('express');
const db = require('../db');
const jwt = require('jsonwebtoken');
const { protect, adminOnly, JWT_SECRET } = require('../auth');
const { OpenLocationCode } = require('open-location-code');

const olc = new OpenLocationCode();
const router = express.Router();

/**
 * @route   POST /api/locations/resolve-code
 * @desc    Resolve a Google Plus Code, Google Maps URL, or Coordinate string to lat/lng
 * @access  Private (Admin / CEO only)
 */
router.post('/resolve-code', protect, adminOnly, async (req, res) => {
  try {
    const { query, refLat = 31.5204, refLng = 74.3587 } = req.body || {};
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ success: false, message: 'Search query is required.' });
    }

    const trimmed = query.trim();

    // 1. Check if Google Maps URL (e.g. https://www.google.com/maps/@31.4287,74.2796,17z or place/.../@31.5529,74.3221...)
    const urlMatch = trimmed.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (urlMatch) {
      return res.json({
        success: true,
        latitude: parseFloat(urlMatch[1]),
        longitude: parseFloat(urlMatch[2]),
        source: 'Google Maps Link',
        formattedAddress: trimmed
      });
    }

    // 2. Check if raw coordinates (e.g. 31.5525, 74.3221)
    const coordMatch = trimmed.match(/^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/);
    if (coordMatch) {
      return res.json({
        success: true,
        latitude: parseFloat(coordMatch[1]),
        longitude: parseFloat(coordMatch[2]),
        source: 'Direct Coordinates',
        formattedAddress: `${coordMatch[1]}, ${coordMatch[2]}`
      });
    }

    // 3. Check if Google Plus Code (e.g. H83C+2VM or 8J3PH83C+2VM)
    const plusMatch = trimmed.match(/([23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3})/i);
    if (plusMatch) {
      const code = plusMatch[1].toUpperCase();
      if (olc.isFull(code)) {
        const d = olc.decode(code);
        return res.json({
          success: true,
          latitude: parseFloat(d.latitudeCenter.toFixed(6)),
          longitude: parseFloat(d.longitudeCenter.toFixed(6)),
          source: 'Google Plus Code',
          formattedAddress: trimmed
        });
      } else if (olc.isShort(code)) {
        // Attempt recovery with reference coordinates (defaulting to Lahore / city center)
        const recovered = olc.recoverNearest(code, parseFloat(refLat), parseFloat(refLng));
        const d = olc.decode(recovered);
        return res.json({
          success: true,
          latitude: parseFloat(d.latitudeCenter.toFixed(6)),
          longitude: parseFloat(d.longitudeCenter.toFixed(6)),
          source: 'Google Plus Code (Resolved)',
          formattedAddress: trimmed
        });
      }
    }

    // 4. Fallback to OpenStreetMap Nominatim Geocoding with Smart Candidate Parsing
    let cleaned = trimmed.replace(/[–—]/g, '-').replace(/,\s*[a-zA-Z]{1,2}$/, ', Lahore').trim();
    const candidates = [cleaned];
    const parts = cleaned.split(',').map(s => s.trim()).filter(s => s.length > 2);
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i].toLowerCase().includes('lahore') && !parts[i].toLowerCase().includes('pakistan')) {
        candidates.push(`${parts[i]}, Lahore`);
      }
      candidates.push(parts[i]);
    }

    for (const cand of candidates) {
      try {
        const geoUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cand)}&limit=1`;
        const geoRes = await fetch(geoUrl, {
          headers: { 'User-Agent': 'GeoAttend-App/1.0' }
        });
        if (geoRes.ok) {
          const results = await geoRes.json();
          if (results && results.length > 0) {
            return res.json({
              success: true,
              latitude: parseFloat(results[0].lat),
              longitude: parseFloat(results[0].lon),
              source: 'Address Search',
              formattedAddress: results[0].display_name
            });
          }
        }
      } catch (_) {}
    }

    return res.status(404).json({
      success: false,
      message: 'Could not resolve this address. You can drag the map pin or paste the Google Plus Code (e.g. C7HH+XQ2).'
    });
  } catch (err) {
    console.error('Resolve error:', err);
    res.status(500).json({ success: false, message: 'Failed to resolve location code.' });
  }
});

/**
 * @route   GET /api/locations
 * @desc    Get office / site locations (public returns active, admin returns all)
 * @access  Public / Private
 */
router.get('/', async (req, res) => {
  try {
    let isAdmin = false;
    let token = null;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded && decoded.role === 'ADMIN') {
          isAdmin = true;
        }
      } catch (e) {
        // Token invalid, fall back to public view
      }
    }

    const query = isAdmin
      ? `SELECT id, name, address, latitude, longitude, radius_meters, is_active, created_at FROM locations ORDER BY id ASC`
      : `SELECT id, name, address, latitude, longitude, radius_meters, is_active, created_at FROM locations WHERE is_active = 1 ORDER BY id ASC`;

    const locations = await db.query(query);

    res.json({ success: true, locations });
  } catch (err) {
    console.error('Error fetching locations:', err);
    res.status(500).json({ success: false, message: 'Server error loading locations.' });
  }
});

/**
 * @route   POST /api/locations
 * @desc    Create a new geofence location
 * @access  Private (Admin / CEO only)
 */
router.post('/', protect, adminOnly, async (req, res) => {
  try {
    const { name, address, latitude, longitude, radius_meters } = req.body;

    if (!name || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Name, latitude, and longitude are required.'
      });
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const radius = radius_meters ? parseInt(radius_meters) : 100;

    if (isNaN(lat) || lat < -90 || lat > 90 || isNaN(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ success: false, message: 'Invalid GPS coordinates.' });
    }

    if (radius < 10 || radius > 5000) {
      return res.status(400).json({ success: false, message: 'Geofence radius must be between 10m and 5000m.' });
    }

    const result = await db.execute(`
      INSERT INTO locations (name, address, latitude, longitude, radius_meters)
      VALUES (?, ?, ?, ?, ?)
    `, [name.trim(), address ? address.trim() : '', lat, lng, radius]);

    const newLocation = await db.queryOne(`SELECT * FROM locations WHERE id = ?`, [result.lastInsertRowid]);

    res.status(201).json({
      success: true,
      message: `Geofence "${newLocation.name}" created successfully!`,
      location: newLocation
    });
  } catch (err) {
    console.error('Error creating location:', err);
    res.status(500).json({ success: false, message: 'Failed to create location.' });
  }
});

/**
 * @route   PUT /api/locations/:id
 * @desc    Update an existing location's coordinates or radius
 * @access  Private (Admin / CEO only)
 */
router.put('/:id', protect, adminOnly, async (req, res) => {
  try {
    const locationId = parseInt(req.params.id);
    const { name, address, latitude, longitude, radius_meters, is_active } = req.body;

    const existing = await db.queryOne(`SELECT * FROM locations WHERE id = ?`, [locationId]);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Location not found.' });
    }

    const lat = latitude !== undefined ? parseFloat(latitude) : existing.latitude;
    const lng = longitude !== undefined ? parseFloat(longitude) : existing.longitude;
    const radius = radius_meters !== undefined ? parseInt(radius_meters) : existing.radius_meters;
    const active = is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active;

    if (isNaN(lat) || lat < -90 || lat > 90 || isNaN(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ success: false, message: 'Invalid GPS coordinates.' });
    }

    await db.execute(`
      UPDATE locations
      SET name = ?, address = ?, latitude = ?, longitude = ?, radius_meters = ?, is_active = ?
      WHERE id = ?
    `, [
      name !== undefined ? name.trim() : existing.name,
      address !== undefined ? address.trim() : existing.address,
      lat,
      lng,
      radius,
      active,
      locationId
    ]);

    const updated = await db.queryOne(`SELECT * FROM locations WHERE id = ?`, [locationId]);

    res.json({
      success: true,
      message: `Location "${updated.name}" updated successfully.`,
      location: updated
    });
  } catch (err) {
    console.error('Error updating location:', err);
    res.status(500).json({ success: false, message: 'Failed to update location.' });
  }
});

/**
 * @route   DELETE /api/locations/:id
 * @desc    Deactivate a location
 * @access  Private (Admin / CEO only)
 */
router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const locationId = parseInt(req.params.id);

    const result = await db.execute(`UPDATE locations SET is_active = 0 WHERE id = ?`, [locationId]);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: 'Location not found.' });
    }

    res.json({ success: true, message: 'Location deactivated successfully.' });
  } catch (err) {
    console.error('Error deactivating location:', err);
    res.status(500).json({ success: false, message: 'Failed to delete location.' });
  }
});

module.exports = router;
