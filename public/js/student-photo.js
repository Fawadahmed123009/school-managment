(function () {
  const panel = document.getElementById("capture-panel");
  if (!panel) return;
  const postUrl = panel.dataset.postUrl;
  const video = document.getElementById("cam-video");
  const canvas = document.getElementById("cam-canvas");
  const preview = document.getElementById("cam-preview");
  const status = document.getElementById("cam-status");
  const btnStart = document.getElementById("cam-start");
  const btnCapture = document.getElementById("cam-capture");
  const btnSwitch = document.getElementById("cam-switch");
  const btnSave = document.getElementById("cam-save");
  const btnRetake = document.getElementById("cam-retake");
  const btnStop = document.getElementById("cam-stop");

  let stream = null;
  let facing = "environment"; // default to back camera
  let capturedBlob = null;

  function setStatus(msg) { if (status) status.textContent = msg || ""; }

  // Always release the camera — or the light stays on after leaving the page.
  function stopStream() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (video) video.srcObject = null;
  }

  function setButtons(state) {
    const m = {
      idle:     { start: true,  capture: false, switch: false, save: false, retake: false, stop: false },
      live:     { start: false, capture: true,  switch: true,  save: false, retake: false, stop: true  },
      captured: { start: false, capture: false, switch: false, save: true,  retake: true,  stop: true  },
    }[state];
    btnStart.disabled = !m.start;
    btnCapture.disabled = !m.capture;
    btnSwitch.disabled = !m.switch;
    btnSave.disabled = !m.save;
    btnRetake.disabled = !m.retake;
    btnStop.disabled = !m.stop;
  }

  function canSwitch() {
    const track = stream && stream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return false;
    const caps = track.getCapabilities();
    return Array.isArray(caps.facingMode) && caps.facingMode.length > 1;
  }

  async function startCamera(reqFacing) {
    stopStream();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("This browser/device has no camera API. Use the upload option below.");
      setButtons("idle");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: reqFacing } },
        audio: false,
      });
      video.srcObject = stream;
      facing = reqFacing;
      video.style.display = "";
      preview.style.display = "none";
      capturedBlob = null;
      setButtons("live");
      btnSwitch.disabled = !canSwitch();
      setStatus("Camera live. Position the student, then Capture.");
    } catch (err) {
      stopStream();
      setButtons("idle");
      const why = err && (err.message || err.name) ? (err.message || err.name) : "unknown error";
      setStatus("Camera unavailable: " + why + ". Use the upload option below.");
    }
  }

  btnStart.addEventListener("click", () => startCamera(facing));
  btnSwitch.addEventListener("click", () => startCamera(facing === "environment" ? "user" : "environment"));

  btnCapture.addEventListener("click", () => {
    if (!stream) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) { setStatus("Camera not ready yet — try again."); return; }
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(video, 0, 0, w, h);
    canvas.toBlob((blob) => {
      if (!blob) { setStatus("Capture failed."); return; }
      capturedBlob = blob;
      preview.src = URL.createObjectURL(blob);
      video.style.display = "none";
      preview.style.display = "";
      setButtons("captured");
      setStatus("Captured. Save photo to keep it, or Retake.");
    }, "image/jpeg", 0.9);
  });

  btnRetake.addEventListener("click", () => {
    capturedBlob = null;
    preview.src = "";
    preview.style.display = "none";
    video.style.display = "";
    if (stream) {
      setButtons("live");
      setStatus("Position the student, then Capture.");
    } else {
      setButtons("idle");
      setStatus("Camera stopped. Start camera to retake.");
    }
  });

  btnSave.addEventListener("click", async () => {
    if (!capturedBlob) return;
    btnSave.disabled = true;
    setStatus("Saving…");
    try {
      const fd = new FormData();
      fd.append("photo", capturedBlob, "capture.jpg");
      const resp = await fetch(postUrl, {
        method: "POST",
        body: fd,
        headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json", "X-CSRF-Token": window.CSRF_TOKEN },
        redirect: "manual",
      });
      let data = null;
      try { data = await resp.json(); } catch (e) { data = null; }
      if (data && data.status === "success") {
        setStatus("Saved.");
        window.location.href = postUrl + "?ok=1";
      } else {
        setStatus("Save failed: " + ((data && data.message) || "unexpected response"));
        btnSave.disabled = false;
      }
    } catch (err) {
      setStatus("Save failed: " + (err.message || err));
      btnSave.disabled = false;
    }
  });

  btnStop.addEventListener("click", () => {
    stopStream();
    video.style.display = "";
    preview.style.display = "none";
    capturedBlob = null;
    setButtons("idle");
    setStatus("Camera stopped. Use upload below or start the camera again.");
  });

  window.addEventListener("beforeunload", stopStream);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopStream(); });

  setButtons("idle");
})();
