/**
 * OCR mark-entry page wrapper. All cascade logic (Session → Grade → Section →
 * Phase → Week → Subject → Test) lives in the shared test-cascade-filters.js;
 * this script only reacts to the final test choice: it reveals the capture
 * areas and wires up the per-test score-scale editor (total / pass marks).
 */
(function() {
  var uploadDrop = document.getElementById('upload-drop');
  var cameraDrop = document.getElementById('camera-drop');
  var testSettings = document.getElementById('test-settings');
  var totalMarksInput = document.getElementById('ocr-total-marks');
  var passMarksInput = document.getElementById('ocr-pass-marks');
  var saveMarksBtn = document.getElementById('ocr-save-marks');
  var marksStatus = document.getElementById('ocr-marks-status');

  // Show/hide both the file-picker drop and the camera-capture panel together
  function setShowPhotoAreas(visible) {
    if (uploadDrop) uploadDrop.style.display = visible ? 'block' : 'none';
    if (cameraDrop) cameraDrop.style.display = visible ? 'block' : 'none';
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function getHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    var meta = document.querySelector('meta[name="auth-token"]');
    if (meta && meta.content) headers['Authorization'] = 'Bearer ' + meta.content;
    return headers;
  }

  // ── Test score-scale editor (total / pass marks) ────────────────────
  // Populated lazily from the API once a test is chosen; saves via PATCH.
  function setMarksStatus(text, ok) {
    if (!marksStatus) return;
    marksStatus.textContent = text || '';
    marksStatus.style.color = ok ? 'var(--ok, green)' : 'var(--error, red)';
  }

  function showTestSettings(show) {
    if (testSettings) testSettings.style.display = show ? '' : 'none';
  }

  async function loadTestMarks(id) {
    if (!totalMarksInput) return;
    setMarksStatus('Loading…', true);
    try {
      var res = await fetch('/api/v1/tests/' + id + '/marks', { headers: getHeaders() });
      var data = await res.json();
      if (data.status === 'success') {
        totalMarksInput.value = data.data.totalMarks;
        passMarksInput.value = data.data.passMarks;
        setMarksStatus('', true);
      } else {
        setMarksStatus(data.message || 'Could not load marks', false);
      }
    } catch (err) {
      setMarksStatus('Could not load marks', false);
    }
  }

  if (saveMarksBtn) {
    saveMarksBtn.addEventListener('click', async function() {
      var id = window.selectedTestId;
      if (!id) return;
      saveMarksBtn.disabled = true;
      setMarksStatus('Saving…', true);
      try {
        var res = await fetch('/api/v1/tests/' + id + '/marks', {
          method: 'PATCH',
          headers: getHeaders(),
          body: JSON.stringify({ totalMarks: totalMarksInput.value, passMarks: passMarksInput.value }),
        });
        var data = await res.json();
        if (data.status === 'success') {
          setMarksStatus('Saved.', true);
        } else {
          setMarksStatus(data.message || 'Save failed', false);
        }
      } catch (err) {
        setMarksStatus('Save failed', false);
      } finally {
        saveMarksBtn.disabled = false;
      }
    });
  }

  // ── React to test selection from shared cascade filters ────────────────
  document.addEventListener('cascade:test-changed', function(e) {
    var testId = e.detail.testId;
    if (testId) {
      window.selectedTestId = testId;
      setShowPhotoAreas(true);
      showTestSettings(true);
      loadTestMarks(testId);
    } else {
      setShowPhotoAreas(false);
      showTestSettings(false);
    }
  });
})();
