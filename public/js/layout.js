// ── Sidebar toggle (mobile) ──
// Externalized from views/partials/foot.ejs so the page carries no inline
// <script> (CSP script-src no longer needs 'unsafe-inline'). Loaded on every
// authenticated page via foot.ejs.
document.addEventListener('DOMContentLoaded', function() {
  var hamburger = document.getElementById('hamburger');
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebarOverlay');

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
});
