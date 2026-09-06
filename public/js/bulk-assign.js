(function () {
  var targetType = document.getElementById('targetType');
  var classField = document.getElementById('class-field');
  var classSelect = document.getElementById('classLevel');
  var feeHeadSelect = document.getElementById('feeHead');
  var amountInput = document.getElementById('amount');
  var previewText = document.getElementById('preview-text');
  var form = document.getElementById('bulk-assign-form');
  var submitBtn = document.getElementById('submit-btn');

  if (!targetType || !classField || !classSelect || !feeHeadSelect || !form) return;

  function toggleClassField() {
    var isClass = targetType.value === 'class';
    classField.style.display = isClass ? '' : 'none';
    classSelect.required = isClass;
  }
  targetType.addEventListener('change', function () {
    toggleClassField();
    updatePreview();
  });
  toggleClassField();

  // Auto-fill amount from fee head default
  feeHeadSelect.addEventListener('change', function () {
    var opt = this.options[this.selectedIndex];
    var amt = opt && opt.dataset.amount;
    if (amt && Number(amt) > 0 && !amountInput.value) {
      amountInput.placeholder = 'Default: Rs ' + Number(amt).toLocaleString();
    }
    updatePreview();
  });

  function updatePreview() {
    var headText = feeHeadSelect.options[feeHeadSelect.selectedIndex]
      ? feeHeadSelect.options[feeHeadSelect.selectedIndex].text : '';
    if (targetType.value === 'class' && classSelect.value) {
      var classText = classSelect.options[classSelect.selectedIndex]
        ? classSelect.options[classSelect.selectedIndex].text : '';
      previewText.textContent = headText + ' → ' + classText;
    } else if (targetType.value === 'all') {
      previewText.textContent = headText + ' → All students';
    } else {
      previewText.textContent = '';
    }
  }
  classSelect.addEventListener('change', updatePreview);

  form.addEventListener('submit', function (e) {
    if (targetType.value === 'class' && !classSelect.value) {
      e.preventDefault();
      alert('Please select a class.');
      return;
    }
    if (!feeHeadSelect.value) {
      e.preventDefault();
      alert('Please select a fee head.');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';
  });
})();
