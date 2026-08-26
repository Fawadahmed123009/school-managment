// Adapts an API-style service (one that writes JSON via responseStatus:
// res.status(code).json({ status, data|message })) for use inside an EJS view
// route, which must redirect/re-render instead of emitting JSON.
//
// The domain services are shared with the /api/v1 controllers, so they always
// respond on `res` directly. A view route can't let that happen — it needs to
// redirect (Post/Redirect/Get) or re-render the form. Pass the returned `res`
// to the service in place of the real one, then inspect `result`:
//   result.ok      -> service responded with { status: "success" }
//   result.message -> the failure message, if any
//   result.statusCode / result.body -> raw captured values, if needed.
function captureServiceResponse() {
  const result = { statusCode: null, body: null, ok: false, message: null };
  const res = {
    status(code) {
      result.statusCode = code;
      return res;
    },
    json(payload) {
      result.body = payload;
      result.ok = !!payload && payload.status === "success";
      if (payload && typeof payload.message === "string") result.message = payload.message;
      return res;
    },
    send(payload) {
      return res.json(payload);
    },
    // No-op tolerances so a service that also touches res (cookies, headers,
    // etc.) can't crash the view flow. None of these affect the real response.
    cookie() { return res; },
    clearCookie() { return res; },
    set() { return res; },
    header() { return res; },
    setHeader() { return res; },
    type() { return res; },
    end() { return res; },
    redirect() { return res; },
  };
  return { res, result };
}

module.exports = { captureServiceResponse };
