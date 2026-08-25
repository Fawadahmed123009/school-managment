const express = require("express");
const router = express.Router();

router.get("/", (req, res) => {
  res.render("landing", {
    schoolName: res.locals.schoolName || "Avenir Academy",
  });
});

module.exports = router;
