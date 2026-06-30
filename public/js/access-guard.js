// Page-level access guard for the Mint admin portal.
// Each protected page sets `window.PAGE_ACCESS_KEY` and includes this script
// to enforce that only signed-in team members with the right role/page_access
// can view the page. It also hides nav links the user can't access.
//
// Public pages (signin, signup, forgot-password, reset-password) must NOT
// include this script.

(function () {
  const PAGE_KEY = window.PAGE_ACCESS_KEY || null;

  // Map of href → page key, used to hide nav links the user cannot access.
  const NAV_PAGE_MAP = {
    '/index.html':      'clients',
    '/dashboard.html':  'dashboard',
    '/strategies.html': 'strategies',
    '/factsheets.html': 'factsheets',
    '/factsheet.html':  'factsheets',
    '/investors.html':  'investors',
    '/eft.html':        'eft',
    '/orderbook.html':  'orderbook',
    '/gifting.html':    'gifting',
    '/finances.html':   'finances',
    '/settings.html':    'settings',
    '/cyber-compliance.html': 'cyber-compliance',
    '/team.html':             '__admin_only__'
  };

  const getStoredToken = () => {
    try {
      const key = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
      if (!key) return null;
      const parsed = JSON.parse(localStorage.getItem(key));
      return parsed?.access_token || null;
    } catch { return null; }
  };

  const redirectToSignIn = (reason) => {
    const target = '/signin.html' + (reason ? ('?reason=' + reason) : '');
    if (window.location.pathname !== '/signin.html') window.location.replace(target);
  };

  const applyNavVisibility = (role, pageAccess, approverTier) => {
    const isMasterAdmin = role === 'master_admin' || approverTier === 'master';
    document.querySelectorAll('.nav-icon, [data-nav-page]').forEach(link => {
      const href = link.getAttribute('href') || '';
      const path = href.split('?')[0].split('#')[0];
      const key = link.getAttribute('data-nav-page') || NAV_PAGE_MAP[path];
      if (!key) return;
      if (key === '__admin_only__') {
        link.style.display = isMasterAdmin ? '' : 'none';
      } else if (!isMasterAdmin && !pageAccess.includes(key)) {
        link.style.display = 'none';
      }
    });
  };

  // Helper available to page JS: check a granular permission.
  // Usage: window.mintCan('orderbook', 'edit_fill_price') → false | 'pending' | 'direct' | true
  const buildPermHelper = (permissions, approverTier, role) => {
    const isMasterAdmin = role === 'master_admin' || approverTier === 'master';
    return (section, field) => {
      // Master Admins and Devs bypass everything
      if (approverTier === 'dev' || isMasterAdmin) return true;
      if (!permissions || typeof permissions !== 'object') return false;
      const sec = permissions[section];
      if (!sec || typeof sec !== 'object') return false;
      return sec[field] !== undefined ? sec[field] : false;
    };
  };

  const run = async () => {
    const token = getStoredToken();
    if (!token) { redirectToSignIn('signin-required'); return; }

    let me;
    try {
      const r = await fetch('/api/team?action=me', { headers: { Authorization: 'Bearer ' + token } });
      me = await r.json();
    } catch {
      redirectToSignIn('network');
      return;
    }

    if (!me || !me.ok) {
      try {
        const key = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
        if (key) localStorage.removeItem(key);
      } catch {}
      redirectToSignIn(me?.error === 'Not a team member' ? 'not-a-member' : 'signin-required');
      return;
    }

    const role = me.role;
    const pageAccess = Array.isArray(me.page_access) ? me.page_access : [];
    const approverTier = me.approver_tier || null;
    const permissions = me.permissions || {};
    const isMasterAdmin = role === 'master_admin' || approverTier === 'master';

    applyNavVisibility(role, pageAccess, approverTier);

    // Expose permission helper to page scripts
    window.mintCan = buildPermHelper(permissions, approverTier, role);
    window.mintMe = { role, pageAccess, approverTier, permissions, email: me.email };

    if (PAGE_KEY) {
      // '__admin_only__' = only master_admin or dev can access page level
      const allowed = PAGE_KEY === '__admin_only__'
        ? isMasterAdmin || approverTier === 'dev'
        : isMasterAdmin || approverTier === 'dev' || pageAccess.includes(PAGE_KEY);
      if (!allowed) {
        const fallback = pageAccess[0]
          ? Object.keys(NAV_PAGE_MAP).find(p => NAV_PAGE_MAP[p] === pageAccess[0]) || '/signin.html?reason=no-access'
          : '/signin.html?reason=no-access';
        window.location.replace(fallback);
        return;
      }
    }

    try { document.documentElement.style.opacity = '1'; } catch {}
    window.dispatchEvent(new CustomEvent('access-guard:ready', {
      detail: { role, page_access: pageAccess, approver_tier: approverTier, permissions, email: me.email }
    }));
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
