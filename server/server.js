const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
require('dotenv').config();

// Initialize Database & Tables
require('./db');

const authRoutes = require('./routes/authRoutes');
const attendanceRoutes = require('./routes/attendanceRoutes');
const locationRoutes = require('./routes/locationRoutes');
const adminRoutes = require('./routes/adminRoutes');
const settingsRoutes = require('./routes/settingsRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust first proxy hop (Render, Replit, Nginx, Cloudflare) for accurate client IP rate limiting
app.set('trust proxy', 1);

// Security & Parsing Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for external CDN assets (Leaflet, FontAwesome)
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, '..', 'public')));

// Mount API Routes
app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    service: 'Geolocation Attendance Portal'
  });
});

// Fallback to index.html for SPA client-side routing
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({
    success: false,
    message: 'An unexpected server error occurred.'
  });
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Geolocation Attendance Portal running successfully!`);
  console.log(` URL: http://localhost:${PORT}`);
  console.log(` Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(`====================================================`);
});
