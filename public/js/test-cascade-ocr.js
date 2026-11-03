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

  // Read an API response whatever it contains. A non-JSON body means the request
  // never reached the API (expired session redirected to the login page, a proxy
  // error page, a dropped mobile connection); the status is then reported instead
  // of a bare "Save failed", so the teacher knows why nothing was saved.
  async function readApiResponse(res) {
    var text = '';
    try { text = await res.text(); } catch (e) { /* unreadable body */ }
    try {
      return { payload: JSON.parse(text), status: res.status };
    } catch (e) {
      return { nonJson: true, status: res.status, redirected: res.redirected, body: text };
    }
  }

  function describeApiResponse(r) {
    if (r.nonJson) {
      if (!r.status) return 'No response from the server — check the connection and try again.';
      if (r.redirected) return 'Your session expired — sign in again, then reload this page.';
      return 'The server replied with an unexpected page (HTTP ' + r.status + '). Please try again.';
    }
    if (r.payload && r.payload.message) return r.payload.message;
    if (r.status === 401) return 'Your session is no longer valid — sign in again and retry.';
    if (r.status === 403) return 'You are not allowed to change this test’s marks scale.';
    if (r.status === 404) return 'This test no longer exists — pick it again.';
    if (r.status >= 500) return 'Server error (HTTP ' + r.status + ') — please try again in a moment.';
    return 'Save failed (HTTP ' + r.status + ').';
  }

  // A cleared number input reads as an empty string, and Number('') is 0 — which
  // would save "no pass threshold" instead of refusing. Blank becomes NaN so the
  // guards below catch it, matching the service-side validation.
  function readScale(input) {
    var raw = String((input && input.value) || '').trim();
    return raw === '' ? NaN : Number(raw);
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
      // Guard the scale before the round-trip, so a cleared field gives a message
      // here rather than a server rejection of an empty/NaN value.
      var total = readScale(totalMarksInput);
      var pass = readScale(passMarksInput);
      if (!Number.isFinite(total) || total < 1) {
        setMarksStatus('Total marks is required — enter a number of at least 1.', false);
        return;
      }
      if (!Number.isFinite(pass) || pass < 0) {
        setMarksStatus('Pass marks is required — enter 0 when there is no pass threshold.', false);
        return;
      }
      if (pass > total) {
        setMarksStatus('Pass marks cannot exceed total marks.', false);
        return;
      }
      saveMarksBtn.disabled = true;
      setMarksStatus('Saving…', true);
      try {
        var res = await fetch('/api/v1/tests/' + id + '/marks', {
          method: 'PATCH',
          headers: getHeaders(),
          body: JSON.stringify({ totalMarks: total, passMarks: pass }),
        });
        var r = await readApiResponse(res);
        if (r.nonJson || !r.payload || r.payload.status !== 'success') {
          setMarksStatus(describeApiResponse(r), false);
        } else {
          setMarksStatus('Saved.', true);
        }
      } catch (err) {
        setMarksStatus('Could not reach the server — check the connection and try again.', false);
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
