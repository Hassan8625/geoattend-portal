const express = require('express');
const db = require('../db');
const { protect, adminOnly } = require('../auth');

const router = express.Router();

/**
 * @route   GET /api/settings
 * @desc    Get system settings
 * @access  Private
 */
router.get('/', protect, async (req, res) => {
  try {
    const rows = await db.query(`SELECT key, value FROM system_settings`);
    const settings = {};
    rows.forEach(r => {
      settings[r.key] = r.value;
    });

    res.json({ success: true, settings });
  } catch (err) {
    console.error('Error fetching settings:', err);
    res.status(500).json({ success: false, message: 'Server error loading settings.' });
  }
});

/**
 * @route   PUT /api/settings
 * @desc    Update system settings (Work hours, late grace threshold)
 * @access  Private (Admin / CEO only)
 */
router.put('/', protect, adminOnly, async (req, res) => {
  try {
    const updates = req.body; // e.g. { work_start_time: '09:00', late_grace_minutes: '15', company_name: 'Acme Inc' }

    for (const [key, val] of Object.entries(updates)) {
      if (typeof val === 'string' || typeof val === 'number') {
        await db.execute(`
          INSERT INTO system_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `, [key, String(val)]);
      }
    }

    const rows = await db.query(`SELECT key, value FROM system_settings`);
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });

    res.json({ success: true, message: 'Settings saved successfully.', settings });
  } catch (err) {
    console.error('Error saving settings:', err);
    res.status(500).json({ success: false, message: 'Failed to update settings.' });
  }
});

module.exports = router;
