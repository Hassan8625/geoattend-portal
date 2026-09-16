/**
 * GeoAttend PRO — Master Application Controller
 * Handles App State, Routing, Auth Forms, Session Checks, and Digital Clock
 */

const App = {
  currentUser: null,

  async init() {
    console.log('GeoAttend PRO starting up...');
    this.initTheme();
    this.startDigitalClock();
    this.setupEventListeners();
    populateRegistrationLocations();
    await this.checkAuthSession();
  },

  initTheme() {
    const saved = localStorage.getItem('geoattend_theme') || 'dark';
    this.applyTheme(saved);
  },

  applyTheme(theme) {
    const body = document.body;
    const btn = document.getElementById('theme-toggle-btn');
    if (theme === 'light') {
      body.classList.remove('dark-theme');
      body.classList.add('light-theme');
      if (btn) btn.setAttribute('title', 'Switch to Dark Mode');
    } else {
      body.classList.remove('light-theme');
      body.classList.add('dark-theme');
      if (btn) btn.setAttribute('title', 'Switch to Light Mode');
    }
    localStorage.setItem('geoattend_theme', theme);
  },

  toggleTheme() {
    const isLight = document.body.classList.contains('light-theme');
    const targetTheme = isLight ? 'dark' : 'light';
    this.applyTheme(targetTheme);
    showToast(`Switched to ${targetTheme === 'light' ? 'Light Mode ☀️' : 'Dark Mode 🌙'}`, 'info', 1800);
  },

  startDigitalClock() {
    const clockEl = document.getElementById('live-digital-clock');
    const dateEl = document.getElementById('live-digital-date');

    function update() {
      const now = new Date();
      if (clockEl) {
        clockEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }
      if (dateEl) {
        dateEl.textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      }
    }

    update();
    setInterval(update, 1000);
  },

  setupEventListeners() {
    // Listen for auth expired event
    window.addEventListener('auth:expired', () => {
      showToast('Session expired. Please log in again.', 'info');
      this.showView('auth');
    });

    // Logout button
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => this.handleLogout());
    }
  },

  async checkAuthSession() {
    const token = API.getToken();
    if (!token) {
      this.showView('auth');
      return;
    }

    try {
      const res = await API.request('/api/auth/me');
      if (res.success && res.user) {
        this.currentUser = res.user;
        API.setUser(res.user);
        this.updateHeaderUserProfile(res.user);

        if (res.user.role === 'ADMIN') {
          this.showView('admin');
          AdminController.init();
        } else {
          this.showView('employee');
          EmployeeController.init();
        }
      } else {
        this.showView('auth');
      }
    } catch (err) {
      console.warn('Session check failed or expired:', err);
      API.clearSession();
      this.showView('auth');
    }
  },

  showView(viewName) {
    document.querySelectorAll('.view-section').forEach(section => {
      section.classList.remove('active');
    });

    const targetSection = document.getElementById(`view-${viewName}`);
    if (targetSection) {
      targetSection.classList.add('active');
    }

    // Toggle header nav profile visibility
    const navProfile = document.getElementById('user-nav-profile');
    if (navProfile) {
      if (viewName === 'auth') {
        navProfile.classList.add('hidden');
      } else {
        navProfile.classList.remove('hidden');
      }
    }
  },

  updateHeaderUserProfile(user) {
    const nameEl = document.getElementById('nav-user-name');
    const roleEl = document.getElementById('nav-user-role');
    const initialsEl = document.getElementById('nav-user-initials');

    if (nameEl) nameEl.textContent = user.name;
    if (roleEl) {
      if (user.role === 'ADMIN') {
        roleEl.textContent = 'CEO / Admin';
        roleEl.className = 'nav-user-role badge-admin';
      } else {
        roleEl.textContent = user.employee_code || 'Employee';
        roleEl.className = 'nav-user-role badge-employee';
      }
    }

    if (initialsEl) {
      const parts = user.name.split(' ');
      const initials = parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0][0];
      initialsEl.textContent = initials.toUpperCase();
    }
  },

  async handleLogout() {
    try {
      await API.request('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      // Ignore logout network errors
    }

    API.clearSession();
    this.currentUser = null;
    showToast('You have been logged out safely.', 'info');
    this.showView('auth');
  }
};

// Form Handlers
async function handleLogin(e) {
  e.preventDefault();
  const identifier = document.getElementById('login-identifier').value.trim();
  const password = document.getElementById('login-password').value;

  setLoading(true, 'Authenticating user & verifying credentials...');

  try {
    const res = await API.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password })
    });

    setLoading(false);

    if (res.success && res.token && res.user) {
      API.setToken(res.token);
      API.setUser(res.user);
      App.currentUser = res.user;
      App.updateHeaderUserProfile(res.user);

      showToast(`✓ Welcome back, ${res.user.name}!`, 'success');

      if (res.user.role === 'ADMIN') {
        App.showView('admin');
        AdminController.init();
      } else {
        App.showView('employee');
        EmployeeController.init();
      }
    }
  } catch (err) {
    setLoading(false);
    console.error('Login error:', err);
    showToast(err.message || 'Login failed. Please check credentials.', 'error');
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value.trim();
  const employee_code = document.getElementById('reg-code').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const department = document.getElementById('reg-dept').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  const assigned_location_id = document.getElementById('reg-location').value;
  const password = document.getElementById('reg-password').value;

  setLoading(true, 'Creating employee account...');

  try {
    const res = await API.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name,
        employee_code,
        email,
        department,
        phone,
        assigned_location_id,
        password
      })
    });

    setLoading(false);

    if (res.success && res.token && res.user) {
      API.setToken(res.token);
      API.setUser(res.user);
      App.currentUser = res.user;
      App.updateHeaderUserProfile(res.user);

      showToast('✓ Registration successful! Welcome to the portal.', 'success');
      App.showView('employee');
      EmployeeController.init();
    }
  } catch (err) {
    setLoading(false);
    console.error('Registration error:', err);
    showToast(err.message || 'Registration failed.', 'error');
  }
}

function switchAuthTab(tab) {
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const formLogin = document.getElementById('form-login');
  const formRegister = document.getElementById('form-register');

  if (tab === 'login') {
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    formLogin.classList.remove('hidden');
    formRegister.classList.add('hidden');
  } else {
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    formRegister.classList.remove('hidden');
    formLogin.classList.add('hidden');

    populateRegistrationLocations();
  }
}

async function populateRegistrationLocations() {
  const select = document.getElementById('reg-location');
  if (!select) return;

  try {
    const res = await API.request('/api/locations/options');
    if (res.success && res.locations && res.locations.length > 0) {
      let html = `<option value="">⏳ Assign Later by Admin / Primary HQ</option>`;
      html += res.locations.map(l => `<option value="${l.id}">📍 ${escapeHtml(l.name)}</option>`).join('');
      select.innerHTML = html;
      // If there is a single active site, pre-select it
      if (res.locations.length === 1) {
        select.value = res.locations[0].id;
      }
    }
  } catch (err) {
    console.warn('Could not populate registration locations:', err);
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function togglePasswordVisibility(fieldId) {
  const field = document.getElementById(fieldId);
  if (field) {
    field.type = field.type === 'password' ? 'text' : 'password';
  }
}

function toggleTheme() {
  App.toggleTheme();
}

// Bootstrap on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
