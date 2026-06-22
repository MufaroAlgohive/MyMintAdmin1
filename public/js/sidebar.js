/**
 * Mint CRM — Unified Sidebar
 * Single source of truth. Mirrors index.html exactly.
 * Include immediately after <aside class="sidebar"></aside> on every protected page.
 * Requires: access-guard.js (for mintMe / access-guard:ready event).
 */
(function () {
  'use strict';

  /* ── CSS ─────────────────────────────────────────────────────────────── */
  var CSS = [
    '.sidebar{position:fixed;left:0;top:0;width:220px;height:100vh;background:#fff;border-right:1px solid #ede9fe;display:flex;flex-direction:column;padding:0;z-index:1000;overflow:hidden;}',
    '.sidebar-header{display:flex;align-items:center;gap:10px;padding:20px 20px 16px;border-bottom:1px solid #f3f0ff;cursor:pointer;position:relative;user-select:none;}',
    '.sidebar-logo{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '.sidebar-brand{display:flex;flex-direction:column;flex:1;min-width:0;}',
    '.sidebar-brand-name{font-size:14px;font-weight:700;color:#0f172a;letter-spacing:-0.01em;line-height:1.2;}',
    '.sidebar-brand-sub{font-size:10px;color:#94a3b8;font-weight:500;letter-spacing:0.04em;text-transform:uppercase;}',
    '.sidebar-nav{flex:1;display:flex;flex-direction:column;gap:2px;width:100%;padding:16px 12px;overflow-y:auto;}',
    '.sidebar-section-label{font-size:10px;font-weight:600;color:#94a3b8;letter-spacing:0.08em;text-transform:uppercase;padding:8px 8px 4px;margin-top:8px;display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer;user-select:none;background:none;border:none;width:100%;text-align:left;font-family:inherit;}',
    '.sidebar-section-label:first-child{margin-top:0;}',
    '.sidebar-section-label:hover{color:#7c3aed;}',
    '.sidebar-section-label .sec-chevron{width:11px;height:11px;flex-shrink:0;transition:transform 0.2s ease;opacity:.7;}',
    '.sidebar-section-label.collapsed .sec-chevron{transform:rotate(-90deg);}',
    '.sidebar-section{display:grid;grid-template-rows:1fr;transition:grid-template-rows 0.2s ease;}',
    '.sidebar-section.collapsed{grid-template-rows:0fr;}',
    '.sidebar-section>div{overflow:hidden;min-height:0;display:flex;flex-direction:column;gap:2px;}',
    '.sidebar-section-label .sec-right{margin-left:auto;display:flex;align-items:center;gap:6px;}',
    '.sidebar-section-label .sec-dot{width:7px;height:7px;border-radius:999px;background:#ef4444;box-shadow:0 0 0 2px #fff;display:none;flex-shrink:0;}',
    '.sidebar-section-label.has-alert .sec-dot{display:block;}',
    '.nav-icon{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;cursor:pointer;transition:all 0.15s ease;text-decoration:none;color:#64748b;font-size:13px;font-weight:500;white-space:nowrap;}',
    '.nav-icon svg{width:18px;height:18px;fill:#94a3b8;transition:fill 0.15s ease;flex-shrink:0;}',
    '.nav-icon:hover{background:#f5f3ff;color:#5b21b6;}',
    '.nav-icon:hover svg{fill:#7c3aed;}',
    '.nav-icon.active{background:#ede9fe;color:#5b21b6;font-weight:600;}',
    '.nav-icon.active svg{fill:#7c3aed;}',
    '.nav-notification-dot{width:8px;height:8px;margin-left:auto;border-radius:999px;background:#ef4444;box-shadow:0 0 0 3px #fff;display:none;flex-shrink:0;}',
    '.nav-icon.has-notification .nav-notification-dot{display:block;}',
    '.nav-pending-count{margin-left:auto;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#ef4444;color:#fff;font-size:10px;font-weight:700;display:none;align-items:center;justify-content:center;flex-shrink:0;line-height:1;box-sizing:border-box;}',
    '.nav-pending-count.visible{display:flex;}',
    '.sidebar-footer{border-top:1px solid #f1f5f9;padding:12px;}',
    '.sidebar-user{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;margin-bottom:4px;}',
    '.sidebar-avatar{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#7c3aed,#a855f7);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;}',
    '.sidebar-user-info{flex:1;min-width:0;}',
    '.sidebar-user-name{font-size:12px;font-weight:600;color:#1e293b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.sidebar-user-role{font-size:10px;color:#94a3b8;font-weight:500;}',
    '.sidebar-signout{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;cursor:pointer;color:#ef4444;font-size:13px;font-weight:500;transition:all 0.15s ease;border:none;background:none;width:100%;text-align:left;}',
    '.sidebar-signout svg{width:18px;height:18px;fill:#ef4444;flex-shrink:0;}',
    '.sidebar-signout:hover{background:#fef2f2;}',
    '#viewSwitcherDropdown{display:grid;grid-template-rows:0fr;transition:grid-template-rows 0.2s ease;}',
    '#viewSwitcherDropdown.vs-open{grid-template-rows:1fr;}',
    '#viewSwitcherDropdown>div{overflow:hidden;}',
  ].join('');

  /* Right-side of each section label: a red alert dot (shown when collapsed AND
     something inside has an alert) + the collapse chevron. */
  var SEC_CHEV = '<span class="sec-right"><span class="sec-dot" aria-hidden="true"></span><svg class="sec-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg></span>';

  /* ── HTML ────────────────────────────────────────────────────────────── */
  var HTML = ''
    /* Header */
    + '<div class="sidebar-header" onclick="mintHubDropdownToggle(event)">'
    +   '<div class="sidebar-logo"><img src="/icon.png" alt="Mint" style="width:34px;height:34px;border-radius:8px;"/></div>'
    +   '<div class="sidebar-brand"><span class="sidebar-brand-name">Mint</span><span class="sidebar-brand-sub">Mint Hub</span></div>'
    +   '<svg id="mintHubChevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round" style="flex-shrink:0;transition:transform 0.2s;margin-right:-2px;"><polyline points="6 9 12 15 18 9"/></svg>'
    +   '<div id="mintHubDropdown" style="display:none;position:absolute;top:calc(100% + 6px);left:8px;right:8px;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.14),0 0 0 1px rgba(139,92,246,0.12);z-index:9999;overflow:hidden;" onclick="event.stopPropagation()">'
    +     '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#f5f3ff;border-bottom:1px solid #ede9fe;">'
    +       '<img src="/icon.png" style="width:26px;height:26px;border-radius:7px;flex-shrink:0;"/>'
    +       '<div style="flex:1;min-width:0;"><div style="font-size:12px;font-weight:700;color:#0f172a;line-height:1.3;">Mint Hub</div><div style="font-size:10px;color:#7c3aed;font-weight:500;">Admin Portal &middot; Active</div></div>'
    +       '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>'
    +     '</div>'
    +     '<div onclick="mintAppLaunch()" style="display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;border-top:1px solid #f1f5f9;" onmouseover="this.style.background=\'#f5f3ff\'" onmouseout="this.style.background=\'\'">'
    +       '<div style="width:26px;height:26px;border-radius:7px;background:#f0fdf4;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><img src="/icon.png" style="width:18px;height:18px;border-radius:4px;"/></div>'
    +       '<div style="flex:1;min-width:0;"><div style="font-size:11px;font-weight:600;color:#0f172a;line-height:1.3;">Mint App</div><div style="font-size:10px;color:#059669;font-weight:500;">Investor-facing portal</div></div>'
    +       '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>'
    +     '</div>'
    +     '<div onclick="window.open(\'https://mint-mailers.vercel.app/\',\'_blank\')" style="display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;border-top:1px solid #f1f5f9;" onmouseover="this.style.background=\'#f5f3ff\'" onmouseout="this.style.background=\'\'">'
    +       '<div style="width:26px;height:26px;border-radius:7px;background:#fef3c7;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#d97706;"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8l8 5 8-5v10zm-8-7L4 6h16l-8 5z"/></svg></div>'
    +       '<div style="flex:1;min-width:0;"><div style="font-size:11px;font-weight:600;color:#0f172a;line-height:1.3;">Mint Mailers</div><div style="font-size:10px;color:#d97706;font-weight:500;">Email campaign platform</div></div>'
    +       '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>'
    +     '</div>'
    +   '</div>'
    + '</div>'
    /* View switcher */
    + '<div style="padding:0 12px 2px;">'
    +   '<button id="viewSwitcherBtn" onclick="viewSwitcherToggle(event)" style="display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border-radius:10px;background:#ede9fe;border:none;cursor:pointer;text-align:left;box-sizing:border-box;transition:background 0.15s;outline:none;" onmouseover="this.style.background=\'#ddd6fe\'" onmouseout="this.style.background=\'#ede9fe\'">'
    +     '<svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:#7c3aed;flex-shrink:0;"><path d="M3 3h7v7H3zm0 11h7v7H3zm11-11h7v7h-7zm0 11h7v7h-7z"/></svg>'
    +     '<span style="flex:1;font-size:13px;font-weight:600;color:#5b21b6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Investments</span>'
    +     '<svg id="viewSwitcherChevron" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round" style="width:12px;height:12px;flex-shrink:0;transition:transform 0.2s;"><polyline points="6 9 12 15 18 9"/></svg>'
    +   '</button>'
    +   '<div id="viewSwitcherDropdown"><div><div style="padding:3px 0 2px 10px;">'
    +     '<div style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;background:#f5f3ff;">'
    +       '<svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#7c3aed;flex-shrink:0;"><path d="M3 3h7v7H3zm0 11h7v7H3zm11-11h7v7h-7zm0 11h7v7h-7z"/></svg>'
    +       '<span style="flex:1;font-size:12px;font-weight:600;color:#5b21b6;">Investments</span>'
    +       '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="#7c3aed" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    +     '</div>'
    +   '</div></div></div>'
    + '</div>'
    /* Nav — each section label is a toggle that collapses its items */
    + '<nav class="sidebar-nav">'
    +   '<button type="button" class="sidebar-section-label" data-section="main" onclick="mintSidebarToggleSection(\'main\')">Main' + SEC_CHEV + '</button>'
    +   '<div class="sidebar-section" data-section="main"><div>'
    +     '<a class="nav-icon" href="/index.html"><svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>Clients</a>'
    +     '<a class="nav-icon" href="/studio.html"><svg viewBox="0 0 24 24"><path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/></svg>Client View Studio</a>'
    +   '</div></div>'
    +   '<button type="button" class="sidebar-section-label" data-section="investments" onclick="mintSidebarToggleSection(\'investments\')">Investments' + SEC_CHEV + '</button>'
    +   '<div class="sidebar-section" data-section="investments"><div>'
    +     '<a class="nav-icon" href="/dashboard.html"><svg viewBox="0 0 24 24"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>Dashboard</a>'
    +     '<a class="nav-icon" href="/factsheets.html"><svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>Factsheets</a>'
    +     '<a class="nav-icon" href="/investors.html"><svg viewBox="0 0 24 24"><path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/></svg>Investors</a>'
    +     '<a class="nav-icon" href="/orderbook.html"><svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/></svg>Order Book<span class="nav-notification-dot" data-orderbook-notification-dot aria-hidden="true"></span></a>'
    +     '<a class="nav-icon" href="/gifting.html"><svg viewBox="0 0 24 24"><path d="M20 6h-2.18c.11-.31.18-.65.18-1a2.996 2.996 0 0 0-5.5-1.65l-.5.67-.5-.68C10.96 2.54 10.05 2 9 2 7.34 2 6 3.34 6 5c0 .35.07.69.18 1H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-5-2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM9 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm11 15H4v-2h16v2zm0-5H4V8h5.08L7 10.83 8.62 12 11 8.76l1-1.36 1 1.36L15.38 12 17 10.83 14.92 8H20v6z"/></svg>Gifting</a>'
    +   '</div></div>'
    +   '<button type="button" class="sidebar-section-label" data-section="banking" onclick="mintSidebarToggleSection(\'banking\')">Banking' + SEC_CHEV + '</button>'
    +   '<div class="sidebar-section" data-section="banking"><div>'
    +     '<a class="nav-icon" href="/eft.html"><svg viewBox="0 0 24 24"><path d="M20 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z"/></svg>EFT Payments<span class="nav-pending-count" aria-hidden="true"></span></a>'
    +   '</div></div>'
    +   '<button type="button" class="sidebar-section-label" data-section="system" onclick="mintSidebarToggleSection(\'system\')">System' + SEC_CHEV + '</button>'
    +   '<div class="sidebar-section" data-section="system"><div>'
    +     '<a class="nav-icon" href="/settings.html"><svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.62l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.62l2.03 1.58c-.05.32-.07.64-.07.94s.02.62.07.94l-2.03 1.58c-.18.14-.23.41-.12.62l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.62l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>Settings</a>'
    +     '<a class="nav-icon" id="teamNavLink" href="/team.html" style="display:none"><svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>Team</a>'
    +     '<a class="nav-icon" href="/cyber-compliance.html" id="ccNavLink" style="position:relative;"><svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 4l5 2.18V11c0 3.5-2.33 6.79-5 7.93-2.67-1.14-5-4.43-5-7.93V7.18L12 5z"/></svg>Cyber Compliance<span id="ccBadge" style="display:none;position:absolute;top:5px;right:6px;width:8px;height:8px;background:#ff3b30;border-radius:50%;border:2px solid #fff;"></span></a>'
    +   '</div></div>'
    + '</nav>'
    /* Footer */
    + '<div class="sidebar-footer">'
    +   '<div class="sidebar-user">'
    +     '<div class="sidebar-avatar" id="sidebarAvatarInitials">A</div>'
    +     '<div class="sidebar-user-info">'
    +       '<div class="sidebar-user-name" id="sidebarUserEmail">Admin</div>'
    +       '<div class="sidebar-user-role" id="sidebarUserRole">Administrator</div>'
    +     '</div>'
    +   '</div>'
    +   '<button class="sidebar-signout" id="signOutBtn">'
    +     '<svg viewBox="0 0 24 24"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5-5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg>'
    +     'Sign out'
    +   '</button>'
    + '</div>';

  /* ── Global functions (referenced by onclick in HTML) ────────────────── */
  window.mintHubDropdownToggle = function (e) {
    e.stopPropagation();
    var dd = document.getElementById('mintHubDropdown');
    var ch = document.getElementById('mintHubChevron');
    var open = dd.style.display !== 'block';
    dd.style.display = open ? 'block' : 'none';
    if (ch) ch.style.transform = open ? 'rotate(180deg)' : '';
    if (open) {
      setTimeout(function () {
        var close = function (ev) {
          if (!ev.target.closest('.sidebar-header')) {
            dd.style.display = 'none';
            if (ch) ch.style.transform = '';
            document.removeEventListener('click', close);
          }
        };
        document.addEventListener('click', close);
      }, 0);
    }
  };

  window.mintAppLaunch = function () {
    var dd = document.getElementById('mintHubDropdown');
    var ch = document.getElementById('mintHubChevron');
    if (dd) dd.style.display = 'none';
    if (ch) ch.style.transform = '';
    var ov = document.getElementById('mintAppOverlay');
    var fr = document.getElementById('mintAppFrame');
    if (ov && fr) {
      fr.src = 'https://mint-henna.vercel.app/';
      ov.style.display = 'block';
    } else {
      window.open('https://mint-henna.vercel.app/', '_blank');
    }
  };

  window.mintAppClose = function () {
    var ov = document.getElementById('mintAppOverlay');
    var fr = document.getElementById('mintAppFrame');
    if (ov) ov.style.display = 'none';
    if (fr) fr.src = '';
  };

  window.viewSwitcherToggle = function (e) {
    e.stopPropagation();
    var dd = document.getElementById('viewSwitcherDropdown');
    var ch = document.getElementById('viewSwitcherChevron');
    var open = !dd.classList.contains('vs-open');
    dd.classList.toggle('vs-open', open);
    if (ch) ch.style.transform = open ? 'rotate(180deg)' : '';
    if (open) {
      setTimeout(function () {
        var close = function (ev) {
          var btn = document.getElementById('viewSwitcherBtn');
          if (!ev.target.closest('#viewSwitcherBtn') && !ev.target.closest('#viewSwitcherDropdown')) {
            dd.classList.remove('vs-open');
            if (ch) ch.style.transform = '';
            document.removeEventListener('click', close);
          }
        };
        document.addEventListener('click', close);
      }, 0);
    }
  };

  /* ── Collapsible sections ────────────────────────────────────────────── */
  var SECTIONS_KEY = 'mint-sidebar-sections';

  function readSectionState() {
    try { return JSON.parse(localStorage.getItem(SECTIONS_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }

  window.mintSidebarToggleSection = function (key) {
    var sec = document.querySelector('.sidebar-section[data-section="' + key + '"]');
    var lbl = document.querySelector('.sidebar-section-label[data-section="' + key + '"]');
    if (!sec || !lbl) return;
    var collapsed = !sec.classList.contains('collapsed');
    sec.classList.toggle('collapsed', collapsed);
    lbl.classList.toggle('collapsed', collapsed);
    var st = readSectionState();
    st[key] = collapsed;
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(st)); } catch (_) {}
    updateSectionAlerts();
  };

  /* Apply saved collapse state. Default: collapsed, EXCEPT the section holding
     the current page (so you always see where you are). User toggles persist
     and override the default. Run synchronously before paint to avoid a flash. */
  function applySectionState() {
    var saved = readSectionState();
    var activeKey = null;
    var activeIcon = document.querySelector('aside.sidebar .nav-icon.active');
    if (activeIcon) {
      var wrap = activeIcon.closest('.sidebar-section');
      if (wrap) activeKey = wrap.getAttribute('data-section');
    }
    document.querySelectorAll('aside.sidebar .sidebar-section').forEach(function (sec) {
      var key = sec.getAttribute('data-section');
      var lbl = document.querySelector('.sidebar-section-label[data-section="' + key + '"]');
      var collapsed = (key in saved) ? !!saved[key] : (key !== activeKey);
      sec.classList.toggle('collapsed', collapsed);
      if (lbl) lbl.classList.toggle('collapsed', collapsed);
    });
    updateSectionAlerts();
  }

  /* Does this section contain a live alert? Covers all three nav alert types:
     the Order Book red dot (.nav-icon.has-notification), the EFT pending count
     (.nav-pending-count.visible), and the Cyber Compliance badge (#ccBadge). */
  function sectionHasAlert(sec) {
    if (sec.querySelector('.nav-icon.has-notification')) return true;
    if (sec.querySelector('.nav-pending-count.visible')) return true;
    var cc = sec.querySelector('#ccBadge');
    if (cc && cc.style.display && cc.style.display !== 'none') return true;
    return false;
  }

  /* Bubble inner alerts up to the section header — but only while the section is
     COLLAPSED, so a minimized section never hides a notification. When expanded
     the inner dots are visible, so the header dot is redundant. */
  function updateSectionAlerts() {
    document.querySelectorAll('aside.sidebar .sidebar-section').forEach(function (sec) {
      var key = sec.getAttribute('data-section');
      var lbl = document.querySelector('.sidebar-section-label[data-section="' + key + '"]');
      if (!lbl) return;
      lbl.classList.toggle('has-alert', sec.classList.contains('collapsed') && sectionHasAlert(sec));
    });
  }

  /* Inner alerts update asynchronously (polling, cc-badge.js, etc.). Watch the
     nav for class/style changes and re-evaluate the section dots whenever one flips. */
  function observeSectionAlerts() {
    var nav = document.querySelector('aside.sidebar .sidebar-nav');
    if (!nav || nav._alertObserver) return;
    var obs = new MutationObserver(function () { updateSectionAlerts(); });
    obs.observe(nav, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    nav._alertObserver = obs;
  }

  /* ── Helpers ─────────────────────────────────────────────────────────── */
  function injectCSS() {
    if (document.getElementById('mint-sidebar-css')) return;
    var s = document.createElement('style');
    s.id = 'mint-sidebar-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function markActive() {
    var path = window.location.pathname.replace(/\/$/, '') || '/index.html';
    document.querySelectorAll('aside.sidebar .nav-icon').forEach(function (el) {
      var href = (el.getAttribute('href') || '').split('?')[0];
      el.classList.toggle('active', !!href && (path === href || path.endsWith(href)));
    });
  }

  function updateUser(email, role) {
    var nameEl   = document.getElementById('sidebarUserEmail');
    var avatarEl = document.getElementById('sidebarAvatarInitials');
    var roleEl   = document.getElementById('sidebarUserRole');
    if (nameEl)   nameEl.textContent   = email || 'Admin';
    if (avatarEl) avatarEl.textContent = (email || 'A')[0].toUpperCase();
    if (roleEl)   roleEl.textContent   = role === 'admin' ? 'Administrator' : 'Team Member';
  }

  function setupSignOut() {
    var btn = document.getElementById('signOutBtn');
    if (!btn || btn._sidebarSignOutBound) return;
    btn._sidebarSignOutBound = true;
    btn.addEventListener('click', function () {
      try {
        var client = window.supabaseClient;
        if (client && client.auth) {
          var p = client.auth.signOut ? client.auth.signOut() : null;
          if (p && typeof p.finally === 'function') {
            p.finally(function () { window.location.href = '/signin.html'; });
            return;
          }
        }
      } catch (_) {}
      try {
        var k = Object.keys(localStorage).find(function (x) { return x.startsWith('sb-') && x.endsWith('-auth-token'); });
        if (k) localStorage.removeItem(k);
      } catch (_) {}
      window.location.href = '/signin.html';
    });
  }

  /* ── Init ────────────────────────────────────────────────────────────── */

  /*
   * Inject CSS + HTML synchronously NOW.
   * The <script src="/js/sidebar.js"> tag sits immediately after
   * <aside class="sidebar"></aside> so the aside is already in the DOM.
   * This lets subsequent synchronous page scripts find #signOutBtn etc.
   */
  injectCSS();
  (function injectNow() {
    var aside = document.querySelector('aside.sidebar');
    if (aside) {
      aside.innerHTML = HTML;
      markActive();          // know the current page before deciding which section opens
      applySectionState();   // apply collapse state synchronously → no flash
    }
  })();

  /* Wire up behaviour once the whole DOM is ready */
  function onReady() {
    markActive();
    setupSignOut();
    observeSectionAlerts();
    updateSectionAlerts();

    window.addEventListener('access-guard:ready', function (e) {
      updateUser(e.detail.email, e.detail.role);
    });

    if (window.mintMe) updateUser(window.mintMe.email, window.mintMe.role);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
