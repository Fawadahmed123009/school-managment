// Fee-record form helpers, externalized from views/fees/list.ejs (CSP: the page
// carries no inline <script>). Two behaviours:
//   1. Auto-fill the amount when a fee head with a default is chosen.
//   2. An instant client-side searchable student selector.
// The student list (a few hundred rows) is embedded by the template as a
// non-executed JSON island (#fees-students) and filtered here by name/roll.
(function () {
  // Auto-fill amount when a fee head with a default is selected
  var feeHead = document.getElementById('feeHead');
  if (feeHead) {
    feeHead.addEventListener('change', function () {
      var opt = this.options[this.selectedIndex];
      var amt = opt && opt.dataset.amount;
      if (amt && Number(amt) > 0) {
        document.getElementById('amount').value = amt;
      }
    });
  }

  // ---- Searchable student selector ----
  var STUDENTS = (function () {
    var el = document.getElementById('fees-students');
    if (el) { try { return JSON.parse(el.textContent); } catch (e) {} }
    return [];
  })();

  var searchInput = document.getElementById('student-search');
  var hiddenInput = document.getElementById('student');
  var resultsBox = document.getElementById('student-results');
  if (!searchInput) return;

  function render(matches) {
    if (matches.length === 0) {
      resultsBox.innerHTML = '<div class="student-search-empty">No matching students</div>';
      resultsBox.style.display = 'block';
      return;
    }
    resultsBox.innerHTML = matches.slice(0, 30).map(function (s) {
      return '<div class="student-search-item" data-id="' + s.id + '" data-label="' + s.name.replace(/"/g, '&quot;') + '">' +
        '<strong>' + s.name + '</strong>' +
        '<span>Roll ' + (s.rollNumber || '—') + ' · ' + s.className + ' (' + s.section + ')</span>' +
        '</div>';
    }).join('');
    resultsBox.style.display = 'block';
  }

  searchInput.addEventListener('input', function () {
    hiddenInput.value = ''; // typing invalidates a previous selection
    var q = searchInput.value.trim().toLowerCase();
    if (!q) { resultsBox.style.display = 'none'; return; }
    var matches = STUDENTS.filter(function (s) {
      return s.name.toLowerCase().indexOf(q) !== -1 ||
             String(s.rollNumber).toLowerCase().indexOf(q) !== -1;
    });
    render(matches);
  });

  resultsBox.addEventListener('click', function (e) {
    var item = e.target.closest('.student-search-item');
    if (!item) return;
    hiddenInput.value = item.dataset.id;
    searchInput.value = item.dataset.label;
    resultsBox.style.display = 'none';
  });

  document.addEventListener('click', function (e) {
    if (e.target !== searchInput && !resultsBox.contains(e.target)) {
      resultsBox.style.display = 'none';
    }
  });

  document.querySelector('form[action="/fees/create"]').addEventListener('submit', function (e) {
    if (!hiddenInput.value) {
      e.preventDefault();
      alert('Please select a student from the search results.');
    }
  });
})();
