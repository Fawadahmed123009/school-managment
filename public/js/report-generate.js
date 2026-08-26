(function () {
  const reportType = document.getElementById('reportType');
  if (!reportType) return;

  reportType.addEventListener('change', function () {
    const value = this.value;
    document.querySelectorAll('.report-fields').forEach(function (el) {
      el.style.display = el.dataset.for === value ? '' : 'none';
    });
  });
})();
