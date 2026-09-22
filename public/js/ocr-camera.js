/**
 * Shared camera capture for the OCR "scan & enter" pages (fees + marks).
 * Same UX as the student-photo page (public/js/student-photo.js), but instead
 * of saving the photo itself, the captured frame is injected into the page's
 * hidden #photo-input file input so the existing extract → review → confirm
 * flow runs unchanged (and the image gets archived to R2 server-side).
 *
 * Each page marks its camera area with class="cam-capture-panel"; multiple
 * panels on one page each get an independent instance.
 */
(function () {
  const panels = document.querySelectorAll(".cam-capture-panel");
  if (!panels.length) return;

  panels.forEach(function (panel) {
    const targetId = panel.dataset.targetInput;
    const fileInput = targetId
      ? document.getElementById(targetId)
      : document.getElementById("photo-input");
    const video = panel.querySelector(".cam-video");
    const canvas = panel.querySelector(".cam-canvas");
    const preview = panel.querySelector(".cam-preview");
    const status = panel.querySelector(".cam-status");
    const btnStart = panel.querySelector(".cam-start");
    const btnCapture = panel.querySelector(".cam-capture");
    const btnSwitch = panel.querySelector(".cam-switch");
    const btnUse = panel.querySelector(".cam-use");
    const btnRetake = panel.querySelector(".cam-retake");
    const btnStop = panel.querySelector(".cam-stop");

    let stream = null;
    let facing = "environment"; // documents → back camera by default
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
        idle:     { start: true,  capture: false, switch: false, use: false, retake: false, stop: false },
        live:     { start: false, capture: true,  switch: true,  use: false, retake: false, stop: true  },
        captured: { start: false, capture: false, switch: false, use: true,  retake: true,  stop: true  },
      }[state];
      btnStart.disabled = !m.start;
      btnCapture.disabled = !m.capture;
      btnSwitch.disabled = !m.switch;
      btnUse.disabled = !m.use;
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
        setStatus("This browser/device has no camera API. Use the file upload instead.");
        setButtons("idle");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: reqFacing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        video.srcObject = stream;
        facing = reqFacing;
        video.style.display = "";
        preview.style.display = "none";
        capturedBlob = null;
        setButtons("live");
        btnSwitch.disabled = !canSwitch();
        setStatus("Camera live. Fill the frame with the sheet, then Capture.");
      } catch (err) {
        stopStream();
        setButtons("idle");
        const why = err && (err.message || err.name) ? (err.message || err.name) : "unknown error";
        setStatus("Camera unavailable: " + why + ". Use the file upload instead.");
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
        setStatus("Captured. Use photo to start OCR from it, or Retake.");
      }, "image/jpeg", 0.92);
    });

    btnRetake.addEventListener("click", () => {
      capturedBlob = null;
      preview.src = "";
      preview.style.display = "none";
      video.style.display = "";
      if (stream) {
        setButtons("live");
        setStatus("Fill the frame with the sheet, then Capture.");
      } else {
        setButtons("idle");
        setStatus("Camera stopped. Start camera to retake.");
      }
    });

    // Feed the captured frame into the hidden file input and run the page's
    // existing 'change' handler (upload → extract → review).
    btnUse.addEventListener("click", () => {
      if (!capturedBlob || !fileInput) return;
      try {
        const file = new File([capturedBlob], "capture.jpg", { type: "image/jpeg" });
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
      } catch (err) {
        setStatus("Could not attach the photo: " + (err.message || err));
        return;
      }
      stopStream();
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    btnStop.addEventListener("click", () => {
      stopStream();
      video.style.display = "";
      preview.style.display = "none";
      capturedBlob = null;
      setButtons("idle");
      setStatus("Camera stopped. Use the file upload or start the camera again.");
    });

    window.addEventListener("beforeunload", stopStream);
    document.addEventListener("visibilitychange", () => { if (document.hidden) stopStream(); });

    setButtons("idle");
  });
})();
