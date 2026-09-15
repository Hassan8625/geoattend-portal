/**
 * GeoAttend PRO — Employee Portal Controller
 * Real-time GPS Tracking, Geofence Radar, Leaflet Map & Attendance Verification
 */

const EmployeeController = {
  assignedLocation: null,
  currentCoords: null,
  currentAccuracy: 10,
  gpsWatchId: null,
  map: null,
  officeMarker: null,
  officeCircle: null,
  userMarker: null,
  distanceLine: null,

  isSimMode: false,
  simCoords: null,

  async init() {
    console.log('Initializing Employee Portal...');
    await this.loadUserProfileAndLocation();
    this.initLeafletMap();
    this.startGPSTracking();
    this.checkTodayAttendanceStatus();
    this.loadHistory();
  },

  async loadUserProfileAndLocation() {
    try {
      const res = await API.request('/api/auth/me');
      if (res.success && res.user) {
        API.setUser(res.user);
        document.getElementById('emp-welcome-name').textContent = res.user.name.split(' ')[0];

        if (res.user.assigned_location) {
          this.assignedLocation = res.user.assigned_location;
          document.getElementById('emp-assigned-site-name').textContent = this.assignedLocation.name;
          document.getElementById('gps-radius-readout').textContent = `${this.assignedLocation.radius_meters} m`;
        } else {
          // Fetch first active location as fallback
          const locRes = await API.request('/api/locations');
          if (locRes.success && locRes.locations.length > 0) {
            this.assignedLocation = locRes.locations[0];
            document.getElementById('emp-assigned-site-name').textContent = this.assignedLocation.name;
            document.getElementById('gps-radius-readout').textContent = `${this.assignedLocation.radius_meters} m`;
          }
        }

        // Update Face Biometrics status badge
        this.updateBiometricStatusBadge(!!res.user.face_enrolled);
      }
    } catch (err) {
      console.error('Error loading profile:', err);
      showToast('Could not load assigned workplace location.', 'error');
    }
  },

  updateBiometricStatusBadge(isEnrolled) {
    const badge = document.getElementById('emp-bio-status-badge');
    const readout = document.getElementById('gps-bio-readout');
    if (!badge) return;

    if (isEnrolled) {
      badge.className = 'badge badge-success';
      badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Biometrics: Active';
      badge.title = 'Face biometric profile enrolled and ready';
      if (readout) readout.textContent = 'Active (Ready)';
    } else {
      badge.className = 'badge badge-warning';
      badge.innerHTML = '<i class="fa-solid fa-camera"></i> Setup Face ID';
      badge.title = 'Click to enroll your face biometric profile';
      if (readout) readout.textContent = 'Pending Setup';
    }
  },

  initLeafletMap() {
    const mapContainer = document.getElementById('employee-map');
    if (!mapContainer || this.map) return;

    const defaultLat = this.assignedLocation ? this.assignedLocation.latitude : 24.8607;
    const defaultLng = this.assignedLocation ? this.assignedLocation.longitude : 67.0011;

    this.map = L.map('employee-map', {
      center: [defaultLat, defaultLng],
      zoom: 17,
      zoomControl: true
    });

    // High-resolution OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(this.map);

    // Render Office Geofence Circle
    if (this.assignedLocation) {
      this.renderOfficeGeofence();
    }

    // Allow clicking on map during simulation mode to reposition test user
    this.map.on('click', (e) => {
      if (this.isSimMode) {
        this.setSimulatedPosition(e.latlng.lat, e.latlng.lng);
        showToast(`Simulated GPS moved to [${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}]`, 'info');
      }
    });
  },

  renderOfficeGeofence() {
    if (!this.map || !this.assignedLocation) return;

    const lat = this.assignedLocation.latitude;
    const lng = this.assignedLocation.longitude;
    const radius = this.assignedLocation.radius_meters;

    if (this.officeMarker) this.map.removeLayer(this.officeMarker);
    if (this.officeCircle) this.map.removeLayer(this.officeCircle);

    // Office Pin
    const officeIcon = L.divIcon({
      className: 'custom-map-icon',
      html: `<div style="background:#6366f1; width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:white; box-shadow:0 0 12px rgba(99,102,241,0.8); border:2px solid white;">
              <i class="fa-solid fa-building" style="font-size:14px;"></i>
             </div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });

    this.officeMarker = L.marker([lat, lng], { icon: officeIcon })
      .addTo(this.map)
      .bindPopup(`<b>${this.assignedLocation.name}</b><br>Allowed Geofence Radius: ${radius}m`)
      .openPopup();

    // Geofence perimeter boundary circle
    this.officeCircle = L.circle([lat, lng], {
      color: '#6366f1',
      fillColor: '#818cf8',
      fillOpacity: 0.18,
      radius: radius,
      weight: 2,
      dashArray: '4, 4'
    }).addTo(this.map);
  },

  startGPSTracking() {
    if (!navigator.geolocation) {
      this.updateRadarStatus('Geolocation not supported by device', 'error');
      showToast('HTML5 Geolocation is not supported on this browser.', 'error');
      return;
    }

    this.updateRadarStatus('Acquiring high-precision GPS...', 'loading');

    // High accuracy GPS options
    const geoOptions = {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 2000
    };

    // First one-shot position fetch
    navigator.geolocation.getCurrentPosition(
      (pos) => this.onGPSSuccess(pos),
      (err) => this.onGPSError(err),
      geoOptions
    );

    // Watch position continuously as employee moves
    this.gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => this.onGPSSuccess(pos),
      (err) => this.onGPSError(err),
      geoOptions
    );
  },

  onGPSSuccess(position) {
    if (this.isSimMode) return; // Ignore real GPS while simulation is active

    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    const accuracy = position.coords.accuracy || 10;

    this.currentCoords = { lat, lng };
    this.currentAccuracy = accuracy;

    this.updateUIWithCoordinates(lat, lng, accuracy);
  },

  onGPSError(error) {
    if (this.isSimMode) return;

    let msg = 'GPS signal unavailable.';
    if (error.code === 1) {
      msg = 'Location permission denied. Please allow location access in browser settings.';
    } else if (error.code === 2) {
      msg = 'Position unavailable. Check GPS sensor.';
    } else if (error.code === 3) {
      msg = 'GPS request timed out. Retrying...';
    }

    this.updateRadarStatus(msg, 'error');
  },

  updateUIWithCoordinates(lat, lng, accuracy) {
    document.getElementById('gps-accuracy-readout').textContent = `±${Math.round(accuracy)} m`;
    document.getElementById('map-coord-pill').textContent = `Lat: ${lat.toFixed(5)}, Lng: ${lng.toFixed(5)}`;

    if (!this.assignedLocation) {
      this.updateRadarStatus('Office location pending', 'loading');
      return;
    }

    // Calculate distance
    const dist = calculateClientHaversine(
      lat,
      lng,
      this.assignedLocation.latitude,
      this.assignedLocation.longitude
    );

    const isInside = dist <= this.assignedLocation.radius_meters;

    // Update Radar visuals
    document.getElementById('radar-distance-meters').textContent = dist;
    const badge = document.getElementById('radar-boundary-badge');
    const statusText = document.getElementById('radar-status-text');
    const statusChip = document.getElementById('radar-status-chip');
    const checkinBtn = document.getElementById('btn-mark-attendance');
    const checkinSub = document.getElementById('btn-checkin-sub');

    if (isInside) {
      badge.className = 'geofence-badge-pill badge-in-bounds';
      badge.textContent = '🟢 WITHIN BOUNDARY';
      statusText.textContent = `Within Geofence (${dist}m away)`;
      statusChip.style.borderColor = 'rgba(16, 185, 129, 0.4)';

      checkinBtn.classList.remove('btn-outline-secondary');
      checkinBtn.classList.add('btn-primary');
      checkinSub.textContent = `Ready to Check In at ${this.assignedLocation.name}`;
    } else {
      badge.className = 'geofence-badge-pill badge-out-bounds';
      badge.textContent = `🔴 OUT OF BOUNDS (+${dist - this.assignedLocation.radius_meters}m)`;
      statusText.textContent = `Outside Office Boundary (${dist}m away)`;
      statusChip.style.borderColor = 'rgba(239, 68, 68, 0.4)';

      checkinSub.textContent = `You must be within ${this.assignedLocation.radius_meters}m to mark attendance`;
    }

    // Update Map User Marker and distance line
    this.updateMapUserMarker(lat, lng, dist, isInside);
  },

  updateMapUserMarker(lat, lng, dist, isInside) {
    if (!this.map) return;

    const userColor = isInside ? '#10b981' : '#ef4444';

    if (this.userMarker) this.map.removeLayer(this.userMarker);
    if (this.distanceLine) this.map.removeLayer(this.distanceLine);

    // User pin
    const userIcon = L.divIcon({
      className: 'custom-map-icon',
      html: `<div style="background:${userColor}; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:white; box-shadow:0 0 14px ${userColor}; border:2px solid white;">
              <i class="fa-solid fa-user" style="font-size:12px;"></i>
             </div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    this.userMarker = L.marker([lat, lng], { icon: userIcon })
      .addTo(this.map)
      .bindPopup(`<b>Your Position</b><br>Distance to Office: ${dist}m<br>Status: ${isInside ? 'Inside Boundary' : 'Outside Boundary'}`);

    // Connecting line
    if (this.assignedLocation) {
      const officePos = [this.assignedLocation.latitude, this.assignedLocation.longitude];
      this.distanceLine = L.polyline([[lat, lng], officePos], {
        color: isInside ? '#10b981' : '#f59e0b',
        weight: 3,
        dashArray: '6, 6'
      }).addTo(this.map);

      // Fit bounds to show both user and office comfortably
      const bounds = L.latLngBounds([[lat, lng], officePos]);
      this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
    }
  },

  updateRadarStatus(text, type = 'normal') {
    const statusText = document.getElementById('radar-status-text');
    if (statusText) statusText.textContent = text;
  },

  setSimulatedPosition(lat, lng) {
    this.isSimMode = true;
    this.simCoords = { lat, lng };
    this.currentCoords = { lat, lng };
    this.currentAccuracy = 5; // Perfect simulated GPS accuracy
    this.updateUIWithCoordinates(lat, lng, 5);
  },

  async checkTodayAttendanceStatus() {
    try {
      const res = await API.request('/api/attendance/today-status');
      const alertBox = document.getElementById('attendance-status-alert');
      const checkinBtn = document.getElementById('btn-mark-attendance');
      const checkoutBtn = document.getElementById('btn-mark-checkout');

      if (res.success) {
        if (res.hasCheckedIn) {
          const time = formatDisplayTime(res.checkInRecord.server_timestamp);
          alertBox.className = 'attendance-alert-box alert-success';
          alertBox.innerHTML = `
            <i class="fa-solid fa-circle-check"></i>
            <strong>Present Today:</strong> You checked in at <b>${time}</b> (${res.checkInRecord.status}).
          `;
          alertBox.classList.remove('hidden');

          checkinBtn.disabled = true;
          checkinBtn.classList.add('btn-outline-secondary');
          checkinBtn.classList.remove('btn-primary');
          document.getElementById('btn-checkin-sub').textContent = 'Attendance already registered for today';

          // Show checkout button if not already checked out
          if (!res.hasCheckedOut) {
            checkoutBtn.classList.remove('hidden');
          } else {
            checkoutBtn.classList.add('hidden');
            alertBox.innerHTML += `<br><i class="fa-solid fa-clock"></i> Checked out for the day.`;
          }
        } else {
          alertBox.classList.add('hidden');
          checkinBtn.disabled = false;
          checkoutBtn.classList.add('hidden');
        }
      }
    } catch (err) {
      console.error('Error checking today status:', err);
    }
  },

  async handleCheckIn() {
    if (!this.currentCoords) {
      showToast('Waiting for GPS coordinates. Please ensure location is enabled or use testing mode.', 'error');
      return;
    }

    if (!this.assignedLocation) {
      showToast('No assigned workplace location found. Please contact Admin.', 'error');
      return;
    }

    // Set callback to submit attendance once face biometrics and liveness are confirmed
    activeBiometricCallback = async (bioData) => {
      // Auto-enroll user's face if this is their first face scan or re-enrolled
      const currentUser = API.getUser();
      if ((!currentUser || !currentUser.face_enrolled || bioData.autoEnrolled) && bioData.descriptor) {
        try {
          await API.request('/api/auth/enroll-face', {
            method: 'POST',
            body: JSON.stringify({
              face_descriptor: bioData.descriptor,
              profile_photo: bioData.face_snapshot
            })
          });
          if (currentUser) {
            currentUser.face_enrolled = true;
            currentUser.face_descriptor = bioData.descriptor;
            currentUser.profile_photo = bioData.face_snapshot;
            API.setUser(currentUser);
          }
          this.updateBiometricStatusBadge(true);
        } catch (e) {
          console.warn('Auto-enroll background update error:', e);
        }
      }

      await this.executeCheckIn(bioData);
    };

    // Open Biometric Scanner & Active Liveness Modal
    openBiometricScanner();
  },

  async executeCheckIn(bioData = {}) {
    setLoading(true, 'Recording Physical Presence & Biometric Verification...');

    try {
      const payload = {
        latitude: this.currentCoords.lat,
        longitude: this.currentCoords.lng,
        gps_accuracy: this.currentAccuracy,
        location_id: this.assignedLocation ? this.assignedLocation.id : null,
        device_info: navigator.userAgent,
        biometric_verified: bioData.biometric_verified ? 1 : 0,
        biometric_confidence: bioData.biometric_confidence || null,
        face_snapshot: bioData.face_snapshot || null
      };

      const res = await API.request('/api/attendance/check-in', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      setLoading(false);

      if (res.success) {
        showToast(`✓ Attendance Verified! Marked as ${res.status}.`, 'success');
        this.checkTodayAttendanceStatus();
        this.loadHistory();
      }
    } catch (err) {
      setLoading(false);
      console.error('Check-in failed:', err);
      const errMsg = err.message || 'Check-in failed.';
      showToast(errMsg, 'error');

      // Update alert box with rejection details
      const alertBox = document.getElementById('attendance-status-alert');
      if (alertBox) {
        alertBox.className = 'attendance-alert-box alert-danger';
        alertBox.innerHTML = `
          <i class="fa-solid fa-triangle-exclamation"></i>
          <strong>Verification Failed:</strong> ${errMsg}
        `;
        alertBox.classList.remove('hidden');
      }
    }
  },

  async handleCheckOut() {
    if (!this.currentCoords) {
      showToast('Waiting for GPS coordinates.', 'error');
      return;
    }

    setLoading(true, 'Recording Check-Out...');

    try {
      const payload = {
        latitude: this.currentCoords.lat,
        longitude: this.currentCoords.lng,
        gps_accuracy: this.currentAccuracy,
        device_info: navigator.userAgent
      };

      const res = await API.request('/api/attendance/check-out', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      setLoading(false);
      if (res.success) {
        showToast('Check-out recorded successfully. Have a nice day!', 'success');
        this.checkTodayAttendanceStatus();
        this.loadHistory();
      }
    } catch (err) {
      setLoading(false);
      showToast(err.message || 'Check-out failed.', 'error');
    }
  },

  async loadHistory() {
    try {
      const res = await API.request('/api/attendance/my-history?limit=15');
      const tbody = document.getElementById('emp-history-tbody');
      if (!tbody) return;

      if (!res.success || !res.records || res.records.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No attendance logs found yet.</td></tr>`;
        return;
      }

      tbody.innerHTML = res.records.map(r => {
        let statusBadge = `<span class="badge-status status-present"><i class="fa-solid fa-check"></i> Present</span>`;
        if (r.status === 'LATE') {
          statusBadge = `<span class="badge-status status-late"><i class="fa-solid fa-clock"></i> Late</span>`;
        } else if (r.status === 'OUT_OF_BOUNDS_REJECTED') {
          statusBadge = `<span class="badge-status status-rejected"><i class="fa-solid fa-ban"></i> Rejected</span>`;
        }

        const timeStr = formatDisplayTime(r.server_timestamp);

        // Biometric badge
        let bioBadge = `<span class="badge-bio-pending" title="Geofence GPS verified"><i class="fa-solid fa-location-crosshairs"></i> GPS Only</span>`;
        if (r.biometric_verified) {
          const confText = r.biometric_confidence ? `${r.biometric_confidence}%` : 'Pass';
          bioBadge = `<span class="badge-bio-verified" title="AI Facial Liveness Confirmed" onclick="viewAuditPhoto('${encodeURIComponent(r.face_snapshot || '')}', '${confText}', '${timeStr}', '${r.distance_meters}m')">
            <i class="fa-solid fa-face-viewfinder"></i> Match ${confText}
          </span>`;
        }

        return `
          <tr>
            <td><strong>${r.work_date}</strong></td>
            <td><i class="fa-regular fa-clock" style="opacity:0.65; font-size:0.75rem;"></i> <strong>${timeStr}</strong></td>
            <td><span class="tag-pill">${r.check_type}</span></td>
            <td>${statusBadge}</td>
            <td>${bioBadge}</td>
            <td>${r.distance_meters} m</td>
            <td>${r.location_name || 'Assigned Site'}</td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.error('Error loading employee history:', err);
    }
  }
};

// Global helper wrappers called from HTML onclick
function submitAttendanceCheckIn() {
  EmployeeController.handleCheckIn();
}

function submitAttendanceCheckOut() {
  EmployeeController.handleCheckOut();
}

function loadEmployeeHistory() {
  EmployeeController.loadHistory();
}

function refreshGPSLocation(manual = false) {
  if (manual) showToast('Refreshing GPS Coordinates...', 'info');
  EmployeeController.startGPSTracking();
}

function toggleSimulationMode(active) {
  EmployeeController.isSimMode = active;
  const controls = document.getElementById('sim-controls');
  if (active) {
    controls.classList.remove('hidden');
    showToast('Simulation Mode Active. You can click on the map or use presets.', 'info');
    // Default to inside office
    simulateLocation('INSIDE');
  } else {
    controls.classList.add('hidden');
    showToast('Switched back to Real Device Hardware GPS.', 'info');
    EmployeeController.startGPSTracking();
  }
}

function simulateLocation(type) {
  if (!EmployeeController.assignedLocation) return;
  const baseLat = EmployeeController.assignedLocation.latitude;
  const baseLng = EmployeeController.assignedLocation.longitude;

  if (type === 'INSIDE') {
    // ~15 meters away
    EmployeeController.setSimulatedPosition(baseLat + 0.0001, baseLng + 0.0001);
    showToast('Simulated Location: Inside Office (~15m)', 'success');
  } else if (type === 'OUTSIDE') {
    // ~1.5 km away
    EmployeeController.setSimulatedPosition(baseLat + 0.012, baseLng + 0.012);
    showToast('Simulated Location: Far Away (~1.5km Outside)', 'error');
  } else if (type === 'PERIMETER') {
    // ~85 meters away (close to 100m edge)
    EmployeeController.setSimulatedPosition(baseLat + 0.0007, baseLng + 0.0003);
    showToast('Simulated Location: Near Geofence Boundary (~85m)', 'info');
  }
}

/* ==========================================================================
   AI BIOMETRICS MODAL CONTROLLER & EVENT HANDLERS
   ========================================================================== */

let activeBiometricCallback = null;

async function openBiometricScanner() {
  const modal = document.getElementById('modal-biometric-scanner');
  if (modal) modal.classList.remove('hidden');

  const video = document.getElementById('bio-camera-video');
  const hudMsg = document.getElementById('bio-hud-msg');
  const pill1 = document.getElementById('pill-blink-1');
  const pill2 = document.getElementById('pill-blink-2');
  const stepTitle = document.getElementById('bio-instruction-title');
  const stepDesc = document.getElementById('bio-instruction-desc');
  const oval = document.getElementById('bio-oval-target');

  if (pill1) pill1.classList.remove('active');
  if (pill2) pill2.classList.remove('active');
  if (oval) oval.className = 'bio-oval-target active';
  if (hudMsg) hudMsg.textContent = 'Loading AI Neural Models...';

  try {
    await Biometrics.loadModels((pct, msg) => {
      if (hudMsg) hudMsg.textContent = `${msg} (${pct}%)`;
    });

    if (hudMsg) hudMsg.textContent = 'Starting AI Camera...';
    await Biometrics.startCamera(video);
    if (hudMsg) hudMsg.textContent = 'Position face inside the oval...';

    const user = API.getUser() || {};
    const enrolledDescriptor = user.face_descriptor || null;

    Biometrics.startVerificationLoop(
      video,
      enrolledDescriptor,
      // onProgress
      (progress) => {
        if (progress.phase === 'POSITION') {
          if (oval) oval.className = 'bio-oval-target active';
          if (hudMsg) hudMsg.textContent = progress.message;
          if (stepTitle) stepTitle.textContent = 'Center Face in Target Oval';
          if (stepDesc) stepDesc.textContent = 'Hold steady at eye level in good lighting.';
        } else if (progress.phase === 'LIVENESS') {
          if (oval) oval.className = 'bio-oval-target active';
          if (hudMsg) hudMsg.textContent = progress.message;
          if (stepTitle) stepTitle.textContent = 'Active Liveness: Blink Twice';
          if (stepDesc) stepDesc.textContent = `Blinks verified: ${progress.blinkCount}/2 (EAR: ${progress.ear || '--'})`;
          if (progress.blinkCount >= 1 && pill1) pill1.classList.add('active');
          if (progress.blinkCount >= 2 && pill2) pill2.classList.add('active');
        } else if (progress.phase === 'MATCHING') {
          if (oval) oval.className = 'bio-oval-target active';
          if (hudMsg) hudMsg.textContent = 'Liveness Confirmed! Matching 128-D Biometrics...';
          if (stepTitle) stepTitle.textContent = 'Matching Neural Facial Vector';
          if (stepDesc) stepDesc.textContent = 'Comparing embedding against enrolled profile.';
        } else if (progress.phase === 'MISMATCH') {
          if (oval) oval.className = 'bio-oval-target mismatch';
          if (hudMsg) hudMsg.textContent = progress.message;
        }
      },
      // onComplete
      (result) => {
        if (oval) oval.className = 'bio-oval-target matched';
        if (hudMsg) hudMsg.textContent = `Verified! (${result.confidence}% Match)`;
        if (stepTitle) stepTitle.textContent = 'Identity Confirmed!';
        if (stepDesc) stepDesc.textContent = 'Liveness and biometric embedding verified.';

        setTimeout(() => {
          closeBiometricScanner();
          if (activeBiometricCallback) {
            activeBiometricCallback({
              biometric_verified: 1,
              biometric_confidence: result.confidence,
              face_snapshot: result.snapshot
            });
            activeBiometricCallback = null;
          }
        }, 900);
      },
      // onError
      (err) => {
        showToast(err.message || 'Biometric verification error', 'error');
        closeBiometricScanner();
      }
    );
  } catch (err) {
    console.error('Camera or model start error:', err);
    showToast(err.message, 'error');
    if (hudMsg) hudMsg.textContent = 'Camera / Model unavailable. Use Demo Simulator below.';
  }
}

function closeBiometricScanner() {
  Biometrics.stopCamera();
  const modal = document.getElementById('modal-biometric-scanner');
  if (modal) modal.classList.add('hidden');
}

function simulateBiometricPass() {
  // Generate sample snapshot on a canvas for testing on PC
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 240;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, 240, 240);
  ctx.fillStyle = '#6366f1';
  ctx.beginPath();
  ctx.arc(120, 95, 50, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(120, 220, 80, 0, Math.PI * 2);
  ctx.fill();
  const mockSnapshot = canvas.toDataURL('image/jpeg', 0.65);

  showToast('✓ AI Liveness & Biometric Verification Simulated (98.4% match)', 'success');
  closeBiometricScanner();

  if (activeBiometricCallback) {
    activeBiometricCallback({
      biometric_verified: 1,
      biometric_confidence: 98.4,
      face_snapshot: mockSnapshot
    });
    activeBiometricCallback = null;
  }
}

async function openFaceEnrollmentModal() {
  const modal = document.getElementById('modal-face-enrollment');
  if (modal) modal.classList.remove('hidden');

  const video = document.getElementById('enroll-camera-video');
  const hud = document.getElementById('enroll-hud-msg');
  if (hud) hud.textContent = 'Loading AI Neural Models...';

  try {
    await Biometrics.loadModels();
    if (hud) hud.textContent = 'Starting camera for face capture...';
    await Biometrics.startCamera(video);
    if (hud) hud.textContent = 'Look directly at camera in good light, then click Capture.';
  } catch (err) {
    console.error('Enrollment camera error:', err);
    showToast(err.message, 'error');
    if (hud) hud.textContent = 'Camera unavailable. Use the "Simulate" button for testing.';
  }
}

function closeFaceEnrollmentModal() {
  Biometrics.stopCamera();
  const modal = document.getElementById('modal-face-enrollment');
  if (modal) modal.classList.add('hidden');
}

async function captureAndEnrollFace() {
  const video = document.getElementById('enroll-camera-video');
  const btn = document.getElementById('btn-capture-enroll');
  const hud = document.getElementById('enroll-hud-msg');

  if (!video || !video.srcObject) {
    showToast('Camera is not active.', 'error');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analyzing Face Biometrics...';
  if (hud) hud.textContent = 'Extracting 128-D neural face embedding...';

  try {
    await Biometrics.loadModels();
    const detection = await Biometrics.detectFace(video);

    if (!detection) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-camera"></i> Capture & Activate Biometrics';
      showToast('No face detected. Please position your face in good light and look directly at camera.', 'error');
      if (hud) hud.textContent = 'No face detected. Try again.';
      return;
    }

    const descriptor = Array.from(detection.descriptor);
    const snapshot = Biometrics.captureSnapshot(video, 280);

    const res = await API.request('/api/auth/enroll-face', {
      method: 'POST',
      body: JSON.stringify({
        face_descriptor: descriptor,
        profile_photo: snapshot
      })
    });

    if (res.success) {
      const user = API.getUser() || {};
      user.face_enrolled = true;
      user.face_descriptor = descriptor;
      user.profile_photo = snapshot;
      API.setUser(user);

      EmployeeController.updateBiometricStatusBadge(true);
      showToast('✓ Face Biometric Profile Enrolled Successfully!', 'success');
      closeFaceEnrollmentModal();
    }
  } catch (err) {
    console.error('Enrollment error:', err);
    showToast(err.message || 'Face enrollment failed.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-camera"></i> Capture & Activate Biometrics';
  }
}

async function simulateEnrollmentPass() {
  // Generate synthetic 128-D descriptor for testing on PC
  const syntheticDescriptor = Array.from({ length: 128 }, () => parseFloat((Math.random() * 0.2 - 0.1).toFixed(4)));

  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 200;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#38bdf8';
  ctx.beginPath();
  ctx.arc(100, 80, 45, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(100, 190, 70, 0, Math.PI * 2);
  ctx.fill();
  const mockSnapshot = canvas.toDataURL('image/jpeg', 0.65);

  try {
    const res = await API.request('/api/auth/enroll-face', {
      method: 'POST',
      body: JSON.stringify({
        face_descriptor: syntheticDescriptor,
        profile_photo: mockSnapshot
      })
    });

    if (res.success) {
      const user = API.getUser() || {};
      user.face_enrolled = true;
      user.face_descriptor = syntheticDescriptor;
      user.profile_photo = mockSnapshot;
      API.setUser(user);

      EmployeeController.updateBiometricStatusBadge(true);
      showToast('✓ Simulated Face Biometric Profile Activated!', 'success');
      closeFaceEnrollmentModal();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function viewAuditPhoto(checkinImgEncoded, profileOrConfidence, confidenceOrTime, timeOrDist, distOrName, employeeName, employeeCode) {
  const modal = document.getElementById('modal-audit-photo');
  if (!modal) return;

  let checkinImg = '';
  try {
    checkinImg = checkinImgEncoded ? decodeURIComponent(checkinImgEncoded) : '';
  } catch (e) {
    checkinImg = checkinImgEncoded || '';
  }

  let profileImg = '';
  let confidence = '98.4%';
  let timeStr = 'Recent';
  let dist = 'On-site';
  let empName = '';
  let empCode = '';

  if (arguments.length <= 4) {
    // Called from Employee Portal: viewAuditPhoto(checkinImgEncoded, confidence, timeStr, dist)
    confidence = profileOrConfidence || '98.4%';
    timeStr = confidenceOrTime || 'Recent';
    dist = timeOrDist || 'On-site';
    const user = (typeof API !== 'undefined' && API.getUser()) ? API.getUser() : {};
    profileImg = user.profile_photo || '';
    empName = user.name || 'Employee';
    empCode = user.employee_code || '';
  } else {
    // Called from Admin Control Center: viewAuditPhoto(checkinImgEncoded, profileImgEncoded, confidence, timeStr, dist, employeeName, employeeCode)
    try {
      profileImg = profileOrConfidence ? decodeURIComponent(profileOrConfidence) : '';
    } catch (e) {
      profileImg = profileOrConfidence || '';
    }
    confidence = confidenceOrTime || '98.4%';
    timeStr = timeOrDist || 'Recent';
    dist = distOrName || 'On-site';
    empName = employeeName || 'Employee';
    empCode = employeeCode || '';
  }

  const img1 = document.getElementById('audit-checkin-img');
  const img2 = document.getElementById('audit-profile-img');
  const meta1 = document.getElementById('audit-checkin-meta');
  const meta2 = document.getElementById('audit-profile-meta');
  const confText = document.getElementById('audit-confidence-readout');
  const confBar = document.getElementById('audit-confidence-bar');
  const badgeStatus = document.getElementById('audit-badge-status');

  const fallbackCheckin = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect fill="%231e293b" width="200" height="200"/><text fill="%2364748b" x="50%" y="50%" text-anchor="middle" font-size="14">No Snapshot</text></svg>';
  const fallbackProfile = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect fill="%231e293b" width="200" height="200"/><text fill="%2364748b" x="50%" y="50%" text-anchor="middle" font-size="14">No Template</text></svg>';

  if (img1) img1.src = checkinImg || fallbackCheckin;
  if (img2) img2.src = profileImg || fallbackProfile;

  if (meta1) meta1.textContent = `Check-In Live: ${timeStr} (${dist} from site)`;
  if (meta2) meta2.textContent = `${empName} (${empCode || 'Staff'})`;
  if (confText) confText.textContent = confidence;
  
  const numConf = parseFloat(confidence) || 98.4;
  if (confBar) confBar.style.width = `${Math.min(100, Math.max(10, numConf))}%`;

  if (badgeStatus) {
    if (numConf >= 70) {
      badgeStatus.className = 'badge badge-success';
      badgeStatus.textContent = 'AI Verified Presence';
    } else {
      badgeStatus.className = 'badge badge-warning';
      badgeStatus.textContent = 'Low Neural Confidence';
    }
  }

  modal.classList.remove('hidden');
}

function closeAuditModal() {
  const modal = document.getElementById('modal-audit-photo');
  if (modal) modal.classList.add('hidden');
}

window.viewAuditPhoto = viewAuditPhoto;
window.closeAuditModal = closeAuditModal;

