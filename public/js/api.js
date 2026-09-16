/**
 * GeoAttend PRO — API Client & Toast Notification Utilities
 */

const API = {
  TOKEN_KEY: 'geoattend_auth_token',
  USER_KEY: 'geoattend_auth_user',

  getToken() {
    return localStorage.getItem(this.TOKEN_KEY);
  },

  setToken(token) {
    localStorage.setItem(this.TOKEN_KEY, token);
  },

  getUser() {
    try {
      const data = localStorage.getItem(this.USER_KEY);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      return null;
    }
  },

  setUser(user) {
    localStorage.setItem(this.USER_KEY, JSON.stringify(user));
  },

  clearSession() {
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.USER_KEY);
  },

  async request(endpoint, options = {}) {
    const token = this.getToken();
    const headers = {
      'Content-Type': 'application/json',
      'Bypass-Tunnel-Reminder': 'true',
      'bypass-tunnel-reminder': 'true',
      'ngrok-skip-browser-warning': 'true',
      ...(options.headers || {})
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const response = await fetch(endpoint, {
        credentials: 'include',
        ...options,
        headers
      });

      const contentType = response.headers.get('content-type') || '';
      let data = null;
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      if (!response.ok) {
        // If 401 Unauthorized, session may have expired
        if (response.status === 401 && !endpoint.includes('/auth/login')) {
          this.clearSession();
          window.dispatchEvent(new CustomEvent('auth:expired'));
        }

        let errorMsg = `Request failed (HTTP ${response.status})`;
        if (response.status === 511) {
          errorMsg = 'Tunnel verification required: your phone switched network (Wi-Fi to 4G). Please refresh the page in browser.';
        } else if (data && data.message) {
          errorMsg = data.message;
        }

        const error = new Error(errorMsg);
        error.status = response.status;
        error.data = data;
        throw error;
      }

      return data;
    } catch (err) {
      throw err;
    }
  }
};

/**
 * Format timestamps into friendly local device time (e.g. "02:40 PM")
 */
function formatDisplayTime(timestamp) {
  if (!timestamp) return '--:--';
  try {
    let s = String(timestamp).trim();
    if (!s.endsWith('Z') && !s.includes('+')) {
      s = s.replace(' ', 'T') + 'Z';
    }
    const d = new Date(s);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  } catch (_) {
    return timestamp;
  }
}

function formatDisplayDate(timestamp) {
  if (!timestamp) return '';
  try {
    let s = String(timestamp).trim();
    if (!s.endsWith('Z') && !s.includes('+')) {
      s = s.replace(' ', 'T') + 'Z';
    }
    const d = new Date(s);
    return d.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch (_) {
    return timestamp;
  }
}

/**
 * Global Toast Notification
 */
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  let icon = 'fa-info-circle';
  if (type === 'success') icon = 'fa-circle-check';
  if (type === 'error') icon = 'fa-triangle-exclamation';

  const iconEl = document.createElement('i');
  iconEl.className = `fa-solid ${icon}`;

  const spanEl = document.createElement('span');
  spanEl.textContent = String(message || '');

  toast.appendChild(iconEl);
  toast.appendChild(spanEl);

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Global Loading Overlay
 */
function setLoading(show, text = 'Verifying GPS & Security Tokens...') {
  const overlay = document.getElementById('loading-overlay');
  const textEl = document.getElementById('loading-text');
  if (!overlay) return;

  if (show) {
    if (textEl) textEl.textContent = text;
    overlay.classList.remove('hidden');
  } else {
    overlay.classList.add('hidden');
  }
}

/**
 * Spherical Haversine formula client-side for immediate UI distance rendering
 */
function calculateClientHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

window.haversineDistance = calculateClientHaversine;
