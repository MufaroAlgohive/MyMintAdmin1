// Cyber Compliance sidebar badge — polls every 60s for open incidents/failures
// Included on all portal pages to show/hide the red dot on the CC nav link
(function () {
  const poll = async () => {
    try {
      const k = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
      if (!k) return;
      const token = JSON.parse(localStorage.getItem(k))?.access_token;
      if (!token) return;
      const r = await fetch('/api/cyber-compliance?action=badge-count', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const d = await r.json();
      const badge = document.getElementById('ccBadge');
      if (badge) badge.style.display = (d.count && d.count > 0) ? 'block' : 'none';
    } catch {}
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { poll(); setInterval(poll, 60000); });
  } else {
    poll(); setInterval(poll, 60000);
  }
})();
