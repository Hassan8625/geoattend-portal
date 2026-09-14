/**
 * GeoAttend PRO — CEO / Admin Control Center Controller
 * Dashboard Metrics, Attendance Auditing, Geofence Map Editor & Staff Directory
 */

const AdminController = {
  currentTab: 'logs',
  locations: [],
  selectedLocation: null,
  
  // Geofence Editor Map objects
  adminMap: null,
  adminOfficeMarker: null,
  adminGeofenceCircle: null,

  // Location Picker Modal Map
  pickerMap: null,
  pickerMarker: null,
  pickerCircle: null,

  // Inspection Modal Map
  inspectionMap: null,
  searchDebounceTimer: null,

  async init() {
    console.log('Initializing CEO / Admin Control Center...');
    await this.loadStats();
    await this.loadLocations();
    await this.loadAttendanceLogs();
    await this.loadEmployees();
    await this.loadSettings();
  },

  async loadStats() {
    try {
      const res = await API.request('/api/admin/dashboard-stats');
      if (res.success && res.stats) {
        const s = res.stats;
        document.getElementById('kpi-total-staff').textContent = s.totalEmployees;
        document.getElementById('kpi-present-today').textContent = s.checkedInToday;
        document.getElementById('kpi-late-today').textContent = s.lateToday;
        document.getElementById('kpi-rejected-today').textContent = s.rejectedAttemptsToday;

        const percent = s.totalEmployees > 0 ? Math.round((s.checkedInToday / s.totalEmployees) * 100) : 0;
        document.getElementById('kpi-present-percent').textContent = `${percent}% attendance rate today`;
      }
    } catch (err) {
      console.error('Error loading admin stats:', err);
    }
  },

  async loadAttendanceLogs() {
    try {
      const date = document.getElementById('filter-date').value;
      const status = document.getElementById('filter-status').value;
      const search = document.getElementById('filter-search').value;

      const params = new URLSearchParams();
      if (date) params.append('date', date);
      if (status && status !== 'ALL') params.append('status', status);
      if (search) params.append('search', search);

      const res = await API.request(`/api/admin/attendance?${params.toString()}`);
      const tbody = document.getElementById('admin-attendance-tbody');
      if (!tbody) return;

      if (!res.success || !res.records || res.records.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted">No attendance records found matching filters.</td></tr>`;
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

        return `
          <tr>
            <td><code class="emp-code-pill">${r.employee_code}</code></td>
            <td><span class="user-cell-name">${r.employee_name}</span></td>
            <td><span class="dept-pill">${r.department || 'General'}</span></td>
            <td class="text-muted"><i class="fa-regular fa-clock"></i> ${r.work_date} <strong>${timeStr}</strong></td>
            <td><span class="dept-pill">${r.check_type}</span></td>
            <td>${statusBadge}</td>
            <td><strong>${r.distance_meters}m</strong> <span class="text-muted text-xs">/ ${r.allowed_radius || 100}m</span></td>
            <td class="text-muted">±${Math.round(r.gps_accuracy)}m</td>
            <td>
              <button class="btn btn-sm btn-outline-secondary" onclick="openMapInspectionModal(${JSON.stringify(r).replace(/"/g, '&quot;')})">
                <i class="fa-solid fa-map-pin"></i> Inspect Pin
              </button>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.error('Error loading attendance logs:', err);
    }
  },

  async loadLocations() {
    try {
      const res = await API.request('/api/locations');
      if (res.success && res.locations) {
        this.locations = res.locations;
        this.renderLocationsList();

        if (this.locations.length > 0 && !this.selectedLocation) {
          this.selectLocationForEditing(this.locations[0].id);
        }

        // Also update Registration site select dropdowns
        this.populateLocationDropdowns();
      }
    } catch (err) {
      console.error('Error loading locations:', err);
    }
  },

  renderLocationsList() {
    const listEl = document.getElementById('locations-list');
    if (!listEl) return;

    if (this.locations.length === 0) {
      listEl.innerHTML = `<p class="text-muted text-sm">No locations registered yet.</p>`;
      return;
    }

    listEl.innerHTML = this.locations.map(loc => {
      const isSel = this.selectedLocation && this.selectedLocation.id === loc.id;
      return `
        <div class="location-item-card ${isSel ? 'selected' : ''}" onclick="AdminController.selectLocationForEditing(${loc.id})">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem;">
            <h4><i class="fa-solid fa-building"></i> ${loc.name}</h4>
            <button type="button" class="btn btn-sm btn-outline-secondary" style="padding: 2px 8px; font-size: 0.72rem;" onclick="event.stopPropagation(); openEditLocationModal(${loc.id})" title="Edit on map">
              <i class="fa-solid fa-pen-to-square"></i> Edit
            </button>
          </div>
          <p>${loc.address || 'No physical address specified'}</p>
          <div class="location-meta-tags">
            <span class="tag-pill"><i class="fa-solid fa-circle-dot"></i> Radius: ${loc.radius_meters}m</span>
            <span class="tag-pill"><i class="fa-solid fa-location-crosshairs"></i> ${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  populateLocationDropdowns() {
    const defaultOpt = `<option value="">⏳ Assign Later by Admin / Primary HQ</option>`;
    const siteOpts = this.locations.map(l => `<option value="${l.id}">📍 ${l.name} (${l.radius_meters}m radius)</option>`).join('');
    const regSelect = document.getElementById('reg-location');
    const adminEmpSelect = document.getElementById('admin-emp-site');
    const editEmpSelect = document.getElementById('edit-emp-site');
    if (regSelect) regSelect.innerHTML = defaultOpt + siteOpts;
    if (adminEmpSelect) adminEmpSelect.innerHTML = `<option value="">🏢 All Sites / Floating</option>` + siteOpts;
    if (editEmpSelect) editEmpSelect.innerHTML = `<option value="">🏢 All Sites / Floating</option>` + siteOpts;
  },

  selectLocationForEditing(id) {
    const loc = this.locations.find(l => l.id === id);
    if (!loc) return;

    this.selectedLocation = { ...loc };
    this.renderLocationsList();

    // Update tweak controls
    document.getElementById('tweak-site-name-display').textContent = loc.name;
    document.getElementById('tweak-radius-val').textContent = `${loc.radius_meters}m`;
    document.getElementById('tweak-radius-slider').value = loc.radius_meters;

    // Initialize or re-center Geofence Editor Map
    this.renderGeofenceEditorMap(loc);
  },

  renderGeofenceEditorMap(loc) {
    const mapContainer = document.getElementById('admin-geofence-map');
    if (!mapContainer) return;

    if (!this.adminMap) {
      this.adminMap = L.map('admin-geofence-map', {
        center: [loc.latitude, loc.longitude],
        zoom: 17
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(this.adminMap);

      // On map click, move location center
      this.adminMap.on('click', (e) => {
        this.updateSelectedLocationCoords(e.latlng.lat, e.latlng.lng);
      });
    } else {
      this.adminMap.setView([loc.latitude, loc.longitude], 17);
    }

    if (this.adminOfficeMarker) this.adminMap.removeLayer(this.adminOfficeMarker);
    if (this.adminGeofenceCircle) this.adminMap.removeLayer(this.adminGeofenceCircle);

    // Draggable marker for office center
    const officeIcon = L.divIcon({
      className: 'custom-map-icon',
      html: `<div style="background:#6366f1; width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:white; box-shadow:0 0 14px rgba(99,102,241,0.9); border:2px solid white; cursor:move;">
              <i class="fa-solid fa-building" style="font-size:16px;"></i>
             </div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    });

    this.adminOfficeMarker = L.marker([loc.latitude, loc.longitude], {
      icon: officeIcon,
      draggable: true
    }).addTo(this.adminMap);

    this.adminOfficeMarker.bindPopup(`<b>${loc.name}</b><br>Drag pin to reposition center.`).openPopup();

    this.adminOfficeMarker.on('dragend', (e) => {
      const pos = e.target.getLatLng();
      this.updateSelectedLocationCoords(pos.lat, pos.lng);
    });

    // Geofence Circle
    this.adminGeofenceCircle = L.circle([loc.latitude, loc.longitude], {
      color: '#10b981',
      fillColor: '#34d399',
      fillOpacity: 0.2,
      radius: loc.radius_meters,
      weight: 2
    }).addTo(this.adminMap);
  },

  updateSelectedLocationCoords(lat, lng) {
    if (!this.selectedLocation) return;
    this.selectedLocation.latitude = lat;
    this.selectedLocation.longitude = lng;

    if (this.adminOfficeMarker) this.adminOfficeMarker.setLatLng([lat, lng]);
    if (this.adminGeofenceCircle) this.adminGeofenceCircle.setLatLng([lat, lng]);

    showToast(`Updated center to [${lat.toFixed(5)}, ${lng.toFixed(5)}]. Remember to click "Save Perimeter".`, 'info');
  },

  handleRadiusSlider(val) {
    const radius = parseInt(val);
    document.getElementById('tweak-radius-val').textContent = `${radius}m`;

    if (this.selectedLocation) {
      this.selectedLocation.radius_meters = radius;
    }

    if (this.adminGeofenceCircle) {
      this.adminGeofenceCircle.setRadius(radius);
    }
  },

  async saveActiveGeofence() {
    if (!this.selectedLocation) {
      showToast('No location selected.', 'error');
      return;
    }

    setLoading(true, 'Saving Geofence Perimeter Settings...');

    try {
      const payload = {
        name: this.selectedLocation.name,
        address: this.selectedLocation.address,
        latitude: this.selectedLocation.latitude,
        longitude: this.selectedLocation.longitude,
        radius_meters: this.selectedLocation.radius_meters
      };

      const res = await API.request(`/api/locations/${this.selectedLocation.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      setLoading(false);

      if (res.success) {
        showToast(`✓ Geofence for "${res.location.name}" successfully updated!`, 'success');
        await this.loadLocations();
      }
    } catch (err) {
      setLoading(false);
      showToast(err.message || 'Failed to save location.', 'error');
    }
  },

  setAdminCurrentLocationAsOffice() {
    if (!navigator.geolocation) {
      showToast('Geolocation not supported on this browser.', 'error');
      return;
    }

    setLoading(true, 'Detecting your current GPS coordinates...');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLoading(false);
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        this.updateSelectedLocationCoords(lat, lng);
        if (this.adminMap) this.adminMap.setView([lat, lng], 17);
        showToast('✓ Pinned your current GPS coordinates as workplace center! Click "Save Perimeter" to confirm.', 'success');
      },
      (err) => {
        setLoading(false);
        showToast('Could not retrieve current GPS coordinates.', 'error');
      },
      { enableHighAccuracy: true }
    );
  },

  async loadEmployees() {
    try {
      const res = await API.request('/api/admin/employees');
      const tbody = document.getElementById('admin-employees-tbody');
      if (!tbody) return;

      if (!res.success || !res.employees || res.employees.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted">No employees found.</td></tr>`;
        return;
      }

      this.employees = res.employees;

      tbody.innerHTML = res.employees.map(e => {
        const isSelf = API.getUser() && API.getUser().id === e.id;
        const roleBadge = e.role === 'ADMIN' 
          ? `<span class="badge-admin"><i class="fa-solid fa-crown"></i> CEO / Admin</span>` 
          : `<span class="badge-employee"><i class="fa-solid fa-user"></i> Employee</span>`;
        
        const activeBadge = e.is_active === 1 
          ? `<span class="status-pill status-active"><i class="fa-solid fa-circle-check"></i> Active</span>`
          : `<span class="status-pill status-inactive"><i class="fa-solid fa-circle-xmark"></i> Inactive</span>`;

        const siteOptions = [
          `<option value="" ${!e.assigned_location_id ? 'selected' : ''}>🏢 All Sites / Floating</option>`,
          ...(this.locations || []).map(loc => `
            <option value="${loc.id}" ${e.assigned_location_id === loc.id ? 'selected' : ''}>
              📍 ${loc.name} (${loc.radius_meters}m)
            </option>
          `)
        ].join('');

        const isUnassigned = !e.assigned_location_id;

        return `
          <tr>
            <td><code class="emp-code-pill">${e.employee_code}</code></td>
            <td>
              <span class="user-cell-name">${e.name}</span>
              ${isSelf ? '<span class="tag-you">You</span>' : ''}
            </td>
            <td class="text-secondary-cell">${e.email}</td>
            <td>${roleBadge}</td>
            <td><span class="dept-pill">${e.department || 'General'}</span></td>
            <td class="location-cell">
              <div class="site-picker-wrap">
                <select class="site-assign-select" onchange="AdminController.assignEmployeeSite(${e.id}, this.value, '${e.name.replace(/'/g, "\\'")}')" title="Click to assign or change workplace site">
                  ${siteOptions}
                </select>
                ${isUnassigned ? '<span class="badge-unassigned-tag"><i class="fa-solid fa-clock"></i> Assign</span>' : ''}
              </div>
            </td>
            <td style="text-align: center;"><span class="checkin-count-badge">${e.total_checkins}</span></td>
            <td>${activeBadge}</td>
            <td>
              <div class="action-btn-group">
                <button class="btn btn-sm btn-outline-info" onclick="AdminController.openEditEmployeeModal(${e.id})" title="Edit details and assigned site">
                  <i class="fa-solid fa-user-pen"></i> Edit
                </button>
                ${!isSelf ? `
                  <button class="btn btn-sm ${e.is_active ? 'btn-outline-danger' : 'btn-outline-success'}" onclick="AdminController.toggleEmployeeActive(${e.id}, ${e.is_active ? 0 : 1})">
                    <i class="fa-solid ${e.is_active ? 'fa-user-slash' : 'fa-user-check'}"></i>
                    ${e.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                ` : '<span class="badge-protected"><i class="fa-solid fa-lock"></i> Protected</span>'}
              </div>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.error('Error loading employees:', err);
    }
  },

  async assignEmployeeSite(id, locationId, name) {
    try {
      setLoading(true, 'Updating workplace site...');
      const assigned_location_id = locationId ? parseInt(locationId) : null;
      const res = await API.request(`/api/admin/employees/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ assigned_location_id })
      });
      setLoading(false);
      if (res.success) {
        const siteName = locationId 
          ? (this.locations.find(l => l.id == locationId)?.name || 'Designated Site')
          : 'All Sites / Floating';
        showToast(`✓ Assigned "${siteName}" to ${name || 'employee'}!`, 'success');
        this.loadEmployees();
      }
    } catch (err) {
      setLoading(false);
      showToast(err.message || 'Failed to update employee site.', 'error');
      this.loadEmployees();
    }
  },

  openEditEmployeeModal(id) {
    const emp = (this.employees || []).find(e => e.id === id);
    if (!emp) return;

    document.getElementById('edit-emp-id').value = emp.id;
    document.getElementById('edit-emp-name').value = emp.name;
    document.getElementById('edit-emp-code').value = emp.employee_code;
    document.getElementById('edit-emp-dept').value = emp.department || '';
    document.getElementById('edit-emp-phone').value = emp.phone || '';
    document.getElementById('edit-emp-role').value = emp.role;
    document.getElementById('edit-emp-status').value = emp.is_active;

    const siteSelect = document.getElementById('edit-emp-site');
    if (siteSelect) {
      let options = `<option value="">🏢 Unassigned / Floating (All Sites)</option>`;
      options += (this.locations || []).map(loc => `
        <option value="${loc.id}" ${emp.assigned_location_id === loc.id ? 'selected' : ''}>
          📍 ${loc.name} (${loc.radius_meters}m radius)
        </option>
      `).join('');
      siteSelect.innerHTML = options;
    }

    const modal = document.getElementById('modal-edit-employee');
    if (modal) modal.classList.remove('hidden');
  },

  closeEditEmployeeModal() {
    const modal = document.getElementById('modal-edit-employee');
    if (modal) modal.classList.add('hidden');
  },

  initLocationPickerMap(lat, lng, radius = 100) {
    const mapEl = document.getElementById('modal-location-picker-map');
    if (!mapEl) return;

    this.pickerMoved = false;

    const initialLat = lat || (this.selectedLocation ? this.selectedLocation.latitude : 31.5204);
    const initialLng = lng || (this.selectedLocation ? this.selectedLocation.longitude : 74.3587);
    const initialRadius = radius || 100;

    this.updatePickerCoordinates(initialLat, initialLng);
    const radInput = document.getElementById('loc-radius');
    if (radInput) radInput.value = initialRadius;
    const radBadge = document.getElementById('modal-loc-radius-val');
    if (radBadge) radBadge.textContent = `${initialRadius}m`;

    if (!this.pickerMap) {
      this.pickerMap = L.map('modal-location-picker-map', {
        center: [initialLat, initialLng],
        zoom: 16,
        zoomControl: true
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(this.pickerMap);

      const officeIcon = L.divIcon({
        className: 'custom-office-pin',
        html: `<div class="pulse-marker" style="background: #6366f1;"><i class="fa-solid fa-building"></i></div>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18]
      });

      this.pickerMarker = L.marker([initialLat, initialLng], {
        draggable: true,
        icon: officeIcon
      }).addTo(this.pickerMap);

      this.pickerCircle = L.circle([initialLat, initialLng], {
        radius: initialRadius,
        color: '#10b981',
        fillColor: '#10b981',
        fillOpacity: 0.22,
        weight: 2
      }).addTo(this.pickerMap);

      this.pickerMarker.on('drag', (e) => {
        AdminController.pickerMoved = true;
        const pos = e.target.getLatLng();
        this.pickerCircle.setLatLng(pos);
        this.updatePickerCoordinates(pos.lat, pos.lng);
      });

      this.pickerMap.on('click', (e) => {
        AdminController.pickerMoved = true;
        const pos = e.latlng;
        this.pickerMarker.setLatLng(pos);
        this.pickerCircle.setLatLng(pos);
        this.updatePickerCoordinates(pos.lat, pos.lng);
      });
    } else {
      this.pickerMap.setView([initialLat, initialLng], 16);
      this.pickerMarker.setLatLng([initialLat, initialLng]);
      this.pickerCircle.setLatLng([initialLat, initialLng]).setRadius(initialRadius);
    }

    setTimeout(() => {
      if (this.pickerMap) this.pickerMap.invalidateSize();
    }, 200);
  },

  updatePickerCoordinates(lat, lng) {
    const latFixed = parseFloat(lat).toFixed(6);
    const lngFixed = parseFloat(lng).toFixed(6);
    const latInput = document.getElementById('loc-lat');
    const lngInput = document.getElementById('loc-lng');
    const badge = document.getElementById('modal-picker-coords-badge');
    if (latInput) latInput.value = latFixed;
    if (lngInput) lngInput.value = lngFixed;
    if (badge) badge.textContent = `${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)}`;
  },

  async toggleEmployeeActive(id, newStatus) {
    try {
      setLoading(true, 'Updating employee status...');
      await API.request(`/api/admin/employees/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: newStatus })
      });
      setLoading(false);
      showToast('Employee status updated successfully.', 'success');
      this.loadEmployees();
    } catch (err) {
      setLoading(false);
      showToast(err.message || 'Failed to update employee.', 'error');
    }
  },

  async loadSettings() {
    try {
      const res = await API.request('/api/settings');
      if (res.success && res.settings) {
        const s = res.settings;
        if (s.company_name) document.getElementById('set-company-name').value = s.company_name;
        if (s.work_start_time) document.getElementById('set-start-time').value = s.work_start_time;
        if (s.late_grace_minutes) {
          document.getElementById('set-grace-minutes').value = s.late_grace_minutes;
          document.getElementById('grace-val-badge').textContent = `${s.late_grace_minutes} Minutes`;
        }
        if (s.auto_check_out_time) document.getElementById('set-checkout-time').value = s.auto_check_out_time;

        // Update active location badge in policy card
        if (this.locations.length > 0) {
          const activeLoc = this.selectedLocation || this.locations[0];
          const badgeEl = document.getElementById('policy-active-site-label');
          if (badgeEl) badgeEl.textContent = `${activeLoc.name} (${activeLoc.radius_meters}m radius)`;
        }

        updateShiftTimelineVisuals();
      }
    } catch (err) {
      console.error('Error loading settings:', err);
    }
  },

  async saveSettings(e) {
    e.preventDefault();
    setLoading(true, 'Saving company policies...');

    try {
      const payload = {
        company_name: document.getElementById('set-company-name').value,
        work_start_time: document.getElementById('set-start-time').value,
        late_grace_minutes: document.getElementById('set-grace-minutes').value,
        auto_check_out_time: document.getElementById('set-checkout-time').value
      };

      const res = await API.request('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      setLoading(false);
      if (res.success) {
        showToast('✓ Attendance policies saved successfully!', 'success');
        updateShiftTimelineVisuals();
      }
    } catch (err) {
      setLoading(false);
      showToast(err.message || 'Failed to save settings.', 'error');
    }
  }
};

/**
 * Updates the visual shift schedule timeline in Company Policies
 */
function updateShiftTimelineVisuals() {
  const startInput = document.getElementById('set-start-time');
  const endInput = document.getElementById('set-checkout-time');
  const graceInput = document.getElementById('set-grace-minutes');

  if (!startInput || !graceInput) return;

  const startTimeStr = startInput.value || '09:00';
  const endTimeStr = endInput ? (endInput.value || '18:00') : '18:00';
  const graceMins = parseInt(graceInput.value) || 15;

  const formatTime = (time24) => {
    const [h, m] = time24.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
  };

  const [startH, startM] = startTimeStr.split(':').map(Number);
  const graceDate = new Date();
  graceDate.setHours(startH, startM + graceMins, 0, 0);
  const graceTimeStr = `${String(graceDate.getHours()).padStart(2, '0')}:${String(graceDate.getMinutes()).padStart(2, '0')}`;

  const startLabel = document.getElementById('timeline-start-label');
  const graceLabel = document.getElementById('timeline-grace-label');
  const endLabel = document.getElementById('timeline-end-label');
  const graceText = document.getElementById('timeline-grace-text');

  if (startLabel) startLabel.textContent = formatTime(startTimeStr);
  if (graceLabel) graceLabel.textContent = formatTime(graceTimeStr);
  if (endLabel) endLabel.textContent = formatTime(endTimeStr);
  if (graceText) graceText.textContent = `${graceMins}m Grace`;
}

function handleGraceSliderChange(val) {
  const badge = document.getElementById('grace-val-badge');
  if (badge) badge.textContent = `${val} Minutes`;
  updateShiftTimelineVisuals();
}

function setRadiusPreset(radius) {
  const slider = document.getElementById('tweak-radius-slider');
  if (slider) {
    slider.value = radius;
    handleRadiusSliderChange(radius);
  }

  // Update active state on preset pills
  document.querySelectorAll('.preset-pill').forEach(pill => {
    if (pill.textContent.trim() === `${radius}m`) {
      pill.classList.add('active');
    } else {
      pill.classList.remove('active');
    }
  });
}

// Global helper wrappers called from HTML onclick
function switchAdminTab(tabName) {
  AdminController.currentTab = tabName;

  // Update tab buttons
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
  const activeBtn = document.getElementById(`tab-btn-${tabName}`);
  if (activeBtn) activeBtn.classList.add('active');

  // Update tab contents
  document.querySelectorAll('.admin-subtab-content').forEach(c => {
    c.classList.add('hidden');
    c.classList.remove('active');
  });

  const activeContent = document.getElementById(`admin-subtab-${tabName}`);
  if (activeContent) {
    activeContent.classList.remove('hidden');
    activeContent.classList.add('active');
  }

  // If geofence tab activated, resize map
  if (tabName === 'geofence' && AdminController.adminMap) {
    setTimeout(() => AdminController.adminMap.invalidateSize(), 200);
  }
}

function loadAdminDashboardData() {
  AdminController.loadStats();
  AdminController.loadAttendanceLogs();
}

function loadAdminAttendanceLogs() {
  AdminController.loadAttendanceLogs();
}

function debounceSearch() {
  clearTimeout(AdminController.searchDebounceTimer);
  AdminController.searchDebounceTimer = setTimeout(() => {
    AdminController.loadAttendanceLogs();
  }, 350);
}

function resetFilters() {
  document.getElementById('filter-date').value = '';
  document.getElementById('filter-status').value = 'ALL';
  document.getElementById('filter-search').value = '';
  AdminController.loadAttendanceLogs();
}

function handleRadiusSliderChange(val) {
  AdminController.handleRadiusSlider(val);
}

function saveActiveGeofenceChanges() {
  AdminController.saveActiveGeofence();
}

function setCurrentAdminLocationAsOffice() {
  AdminController.setAdminCurrentLocationAsOffice();
}

function saveCompanySettings(e) {
  AdminController.saveSettings(e);
}

function exportAttendanceCSV() {
  const token = API.getToken();
  const url = `/api/admin/attendance/export-csv`;

  // Fetch file with authorization header and trigger browser download
  setLoading(true, 'Generating Payroll CSV Export...');
  fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  })
  .then(res => res.blob())
  .then(blob => {
    setLoading(false);
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `Attendance_Report_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('✓ CSV Attendance Report downloaded successfully!', 'success');
  })
  .catch(err => {
    setLoading(false);
    showToast('Failed to export CSV.', 'error');
  });
}

// Modal: Inspection Pin on Map
function openMapInspectionModal(record) {
  const modal = document.getElementById('modal-map-view');
  if (!modal) return;

  modal.classList.remove('hidden');

  const detailsEl = document.getElementById('inspection-details-content');
  const timeStr = formatDisplayTime(record.server_timestamp);

  detailsEl.innerHTML = `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem;">
      <div><strong>Employee:</strong> ${record.employee_name} (${record.employee_code})</div>
      <div><strong>Department:</strong> ${record.department || 'General'}</div>
      <div><strong>Timestamp (Verified):</strong> ${record.work_date} ${timeStr}</div>
      <div><strong>Verification Status:</strong> <span class="badge-status ${record.status === 'PRESENT' ? 'status-present' : record.status === 'LATE' ? 'status-late' : 'status-rejected'}">${record.status}</span></div>
      <div><strong>GPS Accuracy:</strong> ±${Math.round(record.gps_accuracy)} meters</div>
      <div><strong>Distance from Site Center:</strong> ${record.distance_meters} meters (Allowed: ${record.allowed_radius || 100}m)</div>
      <div style="grid-column: span 2;"><strong>Actual GPS Coordinates:</strong> Latitude ${record.latitude.toFixed(6)}, Longitude ${record.longitude.toFixed(6)}</div>
      <div style="grid-column: span 2;"><strong>Audit Notes:</strong> ${record.notes || 'Normal check-in log'}</div>
    </div>
  `;

  // Initialize or re-center inspection map
  setTimeout(() => {
    if (!AdminController.inspectionMap) {
      AdminController.inspectionMap = L.map('inspection-map', {
        center: [record.latitude, record.longitude],
        zoom: 17
      });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(AdminController.inspectionMap);
    } else {
      AdminController.inspectionMap.invalidateSize();
      AdminController.inspectionMap.setView([record.latitude, record.longitude], 17);
    }

    // Clear previous markers
    AdminController.inspectionMap.eachLayer((layer) => {
      if (layer instanceof L.Marker || layer instanceof L.Circle) {
        AdminController.inspectionMap.removeLayer(layer);
      }
    });

    const isVerified = record.status === 'PRESENT' || record.status === 'LATE';
    const pinColor = isVerified ? '#10b981' : '#ef4444';

    // Employee Check-In Pin
    const pinIcon = L.divIcon({
      className: 'custom-map-icon',
      html: `<div style="background:${pinColor}; width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:white; box-shadow:0 0 14px ${pinColor}; border:2px solid white;">
              <i class="fa-solid fa-user-pin" style="font-size:14px;"></i>
             </div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });

    L.marker([record.latitude, record.longitude], { icon: pinIcon })
      .addTo(AdminController.inspectionMap)
      .bindPopup(`<b>${record.employee_name} Check-In</b><br>${record.status} (${record.distance_meters}m away)`)
      .openPopup();
  }, 200);
}

function closeMapInspectionModal() {
  document.getElementById('modal-map-view').classList.add('hidden');
}

// Modal: Create Location
function openCreateLocationModal() {
  document.getElementById('modal-location-title').innerHTML = `<i class="fa-solid fa-map-location-dot"></i> Add Workplace Location`;
  document.getElementById('loc-edit-id').value = '';
  document.getElementById('loc-name').value = '';
  document.getElementById('loc-address').value = '';
  document.getElementById('loc-search-quick').value = '';
  document.getElementById('loc-radius').value = 100;
  setModalRadiusPreset(100);

  const modal = document.getElementById('modal-location-form');
  modal.classList.remove('hidden');

  const baseLat = AdminController.selectedLocation ? AdminController.selectedLocation.latitude : 31.5204;
  const baseLng = AdminController.selectedLocation ? AdminController.selectedLocation.longitude : 74.3587;
  AdminController.initLocationPickerMap(baseLat, baseLng, 100);
}

function closeLocationModal() {
  document.getElementById('modal-location-form').classList.add('hidden');
}

function openEditLocationModal(locationId) {
  const loc = (AdminController.locations || []).find(l => l.id === locationId);
  if (!loc) return;

  document.getElementById('modal-location-title').innerHTML = `<i class="fa-solid fa-pen-to-square"></i> Edit Workplace Location`;
  document.getElementById('loc-edit-id').value = loc.id;
  document.getElementById('loc-name').value = loc.name;
  document.getElementById('loc-address').value = loc.address || '';
  document.getElementById('loc-search-quick').value = '';
  document.getElementById('loc-radius').value = loc.radius_meters;
  setModalRadiusPreset(loc.radius_meters);

  const modal = document.getElementById('modal-location-form');
  modal.classList.remove('hidden');

  AdminController.initLocationPickerMap(loc.latitude, loc.longitude, loc.radius_meters);
}

function updateModalRadius(val) {
  const radius = parseInt(val) || 100;
  const readout = document.getElementById('modal-loc-radius-val');
  if (readout) readout.textContent = `${radius}m`;
  if (AdminController.pickerCircle) {
    AdminController.pickerCircle.setRadius(radius);
  }
  const pills = document.querySelectorAll('#modal-location-form .preset-pill');
  pills.forEach(p => {
    p.classList.toggle('active', parseInt(p.textContent) === radius);
  });
}

function setModalRadiusPreset(val) {
  const input = document.getElementById('loc-radius');
  if (input) input.value = val;
  updateModalRadius(val);
}

function pinCurrentLocationInModal() {
  if (!navigator.geolocation) {
    showToast('Geolocation is not supported by your browser.', 'warning');
    return;
  }

  setLoading(true, 'Acquiring device GPS...');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setLoading(false);
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;

      if (AdminController.pickerMap) {
        AdminController.pickerMap.flyTo([lat, lng], 17);
      }
      if (AdminController.pickerMarker) {
        AdminController.pickerMarker.setLatLng([lat, lng]);
      }
      if (AdminController.pickerCircle) {
        AdminController.pickerCircle.setLatLng([lat, lng]);
      }
      AdminController.pickerMoved = true;
      AdminController.updatePickerCoordinates(lat, lng);
      showToast('✓ Pinned to your current GPS position!', 'success');
    },
    (err) => {
      setLoading(false);
      showToast('Could not acquire GPS: ' + err.message, 'warning');
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function checkAddressForAutoLocate(val) {
  if (!val || typeof val !== 'string') return;
  const trimmed = val.trim();
  const hasPlusCode = /[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}/i.test(trimmed);
  const hasMapsUrl = /@(-?\d+\.\d+),(-?\d+\.\d+)/.test(trimmed);
  if (hasPlusCode || hasMapsUrl) {
    const quick = document.getElementById('loc-search-quick');
    if (quick && !quick.value.trim()) {
      quick.value = trimmed;
    }
    resolveModalLocationSearch();
  }
}

async function handleLocationSubmit(e) {
  e.preventDefault();
  const editId = document.getElementById('loc-edit-id').value;
  const isEditing = Boolean(editId);

  let lat = document.getElementById('loc-lat').value;
  let lng = document.getElementById('loc-lng').value;
  const nameVal = document.getElementById('loc-name').value.trim();
  const addrVal = document.getElementById('loc-address').value.trim() || 'Workplace Site';
  const radiusVal = parseInt(document.getElementById('loc-radius').value) || 100;

  // If the user typed or pasted a Plus Code or Maps link and hasn't manually moved the map pin, auto-resolve it
  const potentialQuery = (document.getElementById('loc-search-quick')?.value || addrVal || '').trim();
  const hasPlusCode = /[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}/i.test(potentialQuery);
  const hasMapsUrl = /@(-?\d+\.\d+),(-?\d+\.\d+)/.test(potentialQuery);

  if (!AdminController.pickerMoved && (hasPlusCode || hasMapsUrl)) {
    try {
      const refLat = AdminController.selectedLocation ? AdminController.selectedLocation.latitude : 31.5204;
      const refLng = AdminController.selectedLocation ? AdminController.selectedLocation.longitude : 74.3587;
      const resolveRes = await API.request('/api/locations/resolve-code', {
        method: 'POST',
        body: JSON.stringify({ query: potentialQuery, refLat, refLng })
      });
      if (resolveRes && resolveRes.success) {
        lat = resolveRes.latitude;
        lng = resolveRes.longitude;
      }
    } catch (_) {}
  }

  if (!lat || !lng) {
    if (AdminController.pickerMarker) {
      const pos = AdminController.pickerMarker.getLatLng();
      lat = pos.lat.toFixed(6);
      lng = pos.lng.toFixed(6);
    } else if (AdminController.selectedLocation) {
      lat = AdminController.selectedLocation.latitude;
      lng = AdminController.selectedLocation.longitude;
    } else {
      lat = 31.5204;
      lng = 74.3587;
    }
  }

  const payload = {
    name: nameVal,
    address: addrVal,
    latitude: parseFloat(lat),
    longitude: parseFloat(lng),
    radius_meters: radiusVal
  };

  setLoading(true, isEditing ? 'Updating office location...' : 'Creating new office location...');

  try {
    const endpoint = isEditing ? `/api/locations/${editId}` : '/api/locations';
    const method = isEditing ? 'PUT' : 'POST';

    const res = await API.request(endpoint, {
      method,
      body: JSON.stringify(payload)
    });

    setLoading(false);
    if (res.success) {
      showToast(`✓ Office Site "${payload.name}" saved successfully!`, 'success');
      closeLocationModal();
      await AdminController.loadLocations();
      if (res.location && res.location.id) {
        AdminController.selectLocationForEditing(res.location.id);
      }
    }
  } catch (err) {
    setLoading(false);
    showToast(err.message || 'Failed to save location.', 'error');
  }
}

// Modal: Add Employee
function openAddEmployeeModal() {
  document.getElementById('modal-employee-form').classList.remove('hidden');
}

function closeAddEmployeeModal() {
  document.getElementById('modal-employee-form').classList.add('hidden');
}

async function handleAdminAddEmployee(e) {
  e.preventDefault();
  setLoading(true, 'Registering new employee...');

  try {
    const payload = {
      name: document.getElementById('admin-emp-name').value,
      employee_code: document.getElementById('admin-emp-code').value,
      email: document.getElementById('admin-emp-email').value,
      department: document.getElementById('admin-emp-dept').value,
      role: document.getElementById('admin-emp-role').value,
      assigned_location_id: document.getElementById('admin-emp-site').value,
      password: document.getElementById('admin-emp-password').value
    };

    const res = await API.request('/api/admin/employees', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    setLoading(false);
    if (res.success) {
      showToast(`✓ Employee "${res.employee.name}" created successfully!`, 'success');
      closeAddEmployeeModal();
      AdminController.loadEmployees();
      AdminController.loadStats();
    }
  } catch (err) {
    setLoading(false);
    showToast(err.message || 'Failed to create employee.', 'error');
  }
}

// Modal: Edit Employee
function closeEditEmployeeModal() {
  AdminController.closeEditEmployeeModal();
}

async function handleAdminEditEmployee(e) {
  e.preventDefault();
  const id = document.getElementById('edit-emp-id').value;
  const name = document.getElementById('edit-emp-name').value.trim();
  const department = document.getElementById('edit-emp-dept').value.trim();
  const phone = document.getElementById('edit-emp-phone').value.trim();
  const role = document.getElementById('edit-emp-role').value;
  const is_active = parseInt(document.getElementById('edit-emp-status').value);
  const rawSite = document.getElementById('edit-emp-site').value;
  const assigned_location_id = rawSite ? parseInt(rawSite) : null;

  setLoading(true, 'Saving employee changes...');
  try {
    const res = await API.request(`/api/admin/employees/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name,
        department,
        phone,
        role,
        is_active,
        assigned_location_id
      })
    });
    setLoading(false);
    if (res.success) {
      showToast(`✓ Updated employee "${name}" and assigned workplace!`, 'success');
      closeEditEmployeeModal();
      AdminController.loadEmployees();
    }
  } catch (err) {
    setLoading(false);
    showToast(err.message || 'Failed to save changes.', 'error');
  }
}

/**
 * Search and locate place from Plus Code, Google Maps URL, or address in Geofence Editor
 */
async function searchAndLocatePlace() {
  const input = document.getElementById('geofence-search-input');
  if (!input || !input.value.trim()) {
    showToast('Please enter a Plus Code, Google Maps URL, or Address.', 'info');
    return;
  }

  const query = input.value.trim();
  setLoading(true, `Locating "${query}"...`);

  try {
    const res = await API.request('/api/locations/resolve-code', {
      method: 'POST',
      body: JSON.stringify({ query })
    });

    setLoading(false);
    if (res.success) {
      const lat = res.latitude;
      const lng = res.longitude;

      AdminController.updateSelectedLocationCoords(lat, lng);
      if (AdminController.adminMap) {
        AdminController.adminMap.setView([lat, lng], 17);
      }

      showToast(`✓ Found location: ${lat.toFixed(5)}, ${lng.toFixed(5)} (${res.source}). Click "Save Perimeter" to save changes!`, 'success');
    }
  } catch (err) {
    setLoading(false);
    showToast(err.message || 'Location could not be resolved.', 'error');
  }
}

async function resolveModalLocationSearch() {
  const quickInput = document.getElementById('loc-search-quick');
  const addrInput = document.getElementById('loc-address');
  let query = (quickInput ? quickInput.value : '').trim();
  
  // Fallback to address field if search bar was empty
  if (!query && addrInput && addrInput.value.trim()) {
    query = addrInput.value.trim();
    if (quickInput) quickInput.value = query;
  }

  if (!query) {
    showToast('Please enter a place name, address, or Plus Code.', 'info');
    return;
  }

  setLoading(true, `Locating "${query}" on map...`);

  try {
    const refLat = AdminController.pickerMarker ? AdminController.pickerMarker.getLatLng().lat : (AdminController.selectedLocation ? AdminController.selectedLocation.latitude : 31.5204);
    const refLng = AdminController.pickerMarker ? AdminController.pickerMarker.getLatLng().lng : (AdminController.selectedLocation ? AdminController.selectedLocation.longitude : 74.3587);

    const res = await API.request('/api/locations/resolve-code', {
      method: 'POST',
      body: JSON.stringify({ query, refLat, refLng })
    });

    setLoading(false);
    if (res.success) {
      const lat = res.latitude;
      const lng = res.longitude;

      if (AdminController.pickerMap) {
        AdminController.pickerMap.flyTo([lat, lng], 17);
      }
      if (AdminController.pickerMarker) {
        AdminController.pickerMarker.setLatLng([lat, lng]);
      }
      if (AdminController.pickerCircle) {
        AdminController.pickerCircle.setLatLng([lat, lng]);
      }
      AdminController.updatePickerCoordinates(lat, lng);

      if (addrInput && (!addrInput.value || addrInput.value.trim() === '')) {
        addrInput.value = res.formattedAddress || query;
      }

      showToast(`✓ Located on map: (${lat.toFixed(4)}, ${lng.toFixed(4)})`, 'success');
    }
  } catch (err) {
    setLoading(false);
    showToast(err.message || 'Could not resolve place. You can also click directly on the map.', 'warning');
  }
}

