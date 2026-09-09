document.addEventListener('DOMContentLoaded', function() {
  // ── Navbar scroll shadow + hero transparency ──
  var nav = document.getElementById('lpNav');
  var hero = document.getElementById('hero');
  function updateNav() {
    var heroBottom = hero.offsetTop + hero.offsetHeight - nav.offsetHeight;
    var overHero = window.scrollY < heroBottom;
    nav.classList.toggle('hero-over', overHero);
    nav.classList.toggle('scrolled', window.scrollY > 20);
  }
  updateNav();
  window.addEventListener('scroll', updateNav);
  window.addEventListener('resize', updateNav);

  // ── Mobile hamburger ──
  var hamburger = document.getElementById('lpHamburger');
  var navLinks = document.getElementById('navLinks');
  hamburger.addEventListener('click', function() {
    navLinks.classList.toggle('open');
  });
  navLinks.querySelectorAll('a').forEach(function(a) {
    a.addEventListener('click', function() { navLinks.classList.remove('open'); });
  });

  // ── Hero slideshow ──
  var slides = document.querySelectorAll('.hero-slide');
  var dots = document.querySelectorAll('.hero-dot');
  var current = 0;
  var transitioning = false;

  function goTo(idx) {
    if (idx === current || transitioning) return;
    transitioning = true;
    var oldIdx = current;
    current = idx;
    dots[oldIdx].classList.remove('active');
    dots[current].classList.add('active');

    // Phase 1: fade out old slide — z-index:1 keeps it ON TOP of new slide
    // so the outgoing image fully covers the incoming one during fade-out
    slides[oldIdx].style.zIndex = '1';
    slides[oldIdx].classList.remove('active');

    // Phase 2: after old has fully faded, start new slide fade-in
    setTimeout(function() {
      slides[oldIdx].style.zIndex = '';   // release manual z-index
      slides[current].classList.add('active');
    }, 650);

    // Unlock after full transition settles
    setTimeout(function() {
      transitioning = false;
    }, 1350);
  }
  dots.forEach(function(dot) {
    dot.addEventListener('click', function() {
      goTo(parseInt(dot.dataset.slide, 10));
    });
  });
  setInterval(function() {
    goTo((current + 1) % slides.length);
  }, 5000);

  // ── Scroll animations ──
  var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, { threshold: 0.15 });
  document.querySelectorAll('.fade-up').forEach(function(el) {
    observer.observe(el);
  });

  // ── Counter animation ──
  var countObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        var el = entry.target;
        var target = parseInt(el.dataset.count, 10);
        if (!target) return;
        var duration = 1200;
        var startTime = null;
        function step(ts) {
          if (!startTime) startTime = ts;
          var progress = Math.min((ts - startTime) / duration, 1);
          var ease = 1 - Math.pow(1 - progress, 3);
          el.textContent = Math.floor(ease * target);
          if (progress < 1) requestAnimationFrame(step);
          else el.textContent = target + (el.dataset.count === '98' ? '%' : '+');
        }
        requestAnimationFrame(step);
        countObserver.unobserve(el);
      }
    });
  }, { threshold: 0.5 });
  document.querySelectorAll('.stat-num[data-count]').forEach(function(el) {
    countObserver.observe(el);
  });

  // ── Contact form (demo — no backend) ──
  var contactForm = document.getElementById('contactForm');
  if (contactForm) {
    contactForm.addEventListener('submit', function(e) {
      e.preventDefault();
      alert('Thank you! We will get back to you soon.');
    });
  }
});
