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

  const applyNavVisibility = (role, pageAccess) => {
    const isAdmin = role === 'admin';
    document.querySelectorAll('.nav-icon, [data-nav-page]').forEach(link => {
      const href = link.getAttribute('href') || '';
      const path = href.split('?')[0].split('#')[0];
      const key = link.getAttribute('data-nav-page') || NAV_PAGE_MAP[path];
      if (!key) return;
      if (key === '__admin_only__') {
        link.style.display = isAdmin ? '' : 'none';
      } else if (!isAdmin && !pageAccess.includes(key)) {
        link.style.display = 'none';
      }
    });
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
      // Token invalid or not a team member
      try {
        const key = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
        if (key) localStorage.removeItem(key);
      } catch {}
      redirectToSignIn(me?.error === 'Not a team member' ? 'not-a-member' : 'signin-required');
      return;
    }

    const role = me.role;
    const pageAccess = Array.isArray(me.page_access) ? me.page_access : [];

    applyNavVisibility(role, pageAccess);

    if (PAGE_KEY) {
      const allowed = role === 'admin' || pageAccess.includes(PAGE_KEY);
      if (!allowed) {
        // Send the user somewhere they CAN go, or sign-in if nothing.
        const fallback = role === 'admin'
          ? '/index.html'
          : (pageAccess[0]
              ? Object.keys(NAV_PAGE_MAP).find(p => NAV_PAGE_MAP[p] === pageAccess[0]) || '/signin.html?reason=no-access'
              : '/signin.html?reason=no-access');
        window.location.replace(fallback);
        return;
      }
    }

    // Reveal page (some pages set <style>html{opacity:0}</style> to avoid flash)
    try { document.documentElement.style.opacity = '1'; } catch {}
    window.dispatchEvent(new CustomEvent('access-guard:ready', { detail: { role, page_access: pageAccess, email: me.email } }));
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
