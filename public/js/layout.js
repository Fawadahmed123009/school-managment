// ── Sidebar: mobile toggle + collapsible nav sections ──
// Externalized from views/partials/foot.ejs so the page carries no inline
// <script> (CSP script-src no longer needs 'unsafe-inline'). Loaded on every
// authenticated page via foot.ejs.
document.addEventListener('DOMContentLoaded', function() {
  var hamburger = document.getElementById('hamburger');
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebarOverlay');

  // ── Mobile sidebar open / close ──
  function openSidebar() {
    sidebar.classList.add('open');
    overlay.classList.add('active', 'visible');
    hamburger.classList.add('open');
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('visible');
    hamburger.classList.remove('open');
    setTimeout(function() { overlay.classList.remove('active'); }, 250);
  }

  if (hamburger) {
    hamburger.addEventListener('click', function() {
      if (sidebar.classList.contains('open')) closeSidebar();
      else openSidebar();
    });
  }
  if (overlay) {
    overlay.addEventListener('click', closeSidebar);
  }
  // Close sidebar when a nav link is tapped (mobile)
  if (sidebar) {
    sidebar.querySelectorAll('nav a').forEach(function(link) {
      link.addEventListener('click', function() {
        if (window.innerWidth <= 768) closeSidebar();
      });
    });
  }

  // ── Collapsible nav sections ──
  var STORAGE_KEY = 'sidebar_sections';
  var sections = sidebar ? sidebar.querySelectorAll('.nav-section') : [];

  // Load persisted open/closed state from localStorage
  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (e) { return {}; }
  }

  function saveState(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function toggleSection(section, forceOpen) {
    var isOpen = section.classList.contains('is-open');
    var shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !isOpen;
    section.classList.toggle('is-open', shouldOpen);
    var btn = section.querySelector('.nav-section-header');
    if (btn) btn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }

  // Wire up click handlers on each section header
  sections.forEach(function(section) {
    var header = section.querySelector('.nav-section-header');
    if (!header) return;
    header.addEventListener('click', function() {
      toggleSection(section);
      // Persist state
      var state = loadState();
      state[section.getAttribute('data-section')] = section.classList.contains('is-open');
      saveState(state);
    });
  });

  // Auto-expand the section containing the active link
  var activeLink = sidebar ? sidebar.querySelector('nav a.active') : null;
  if (activeLink) {
    var parentSection = activeLink.closest('.nav-section');
    if (parentSection) toggleSection(parentSection, true);
  }

  // Restore persisted state for remaining sections (active section already handled)
  var state = loadState();
  sections.forEach(function(section) {
    var key = section.getAttribute('data-section');
    if (key in state) {
      // Don't collapse the auto-expanded active section
      if (activeLink && activeLink.closest('.nav-section') === section) return;
      toggleSection(section, state[key]);
    }
  });
});
