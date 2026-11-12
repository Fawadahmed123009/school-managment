const express = require("express");
const incomeRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdmin = require("../../../middlewares/isAdmin");

const {
  createIncomeHeadController,
  getAllIncomeHeadsController,
  toggleIncomeHeadController,
} = require("../../../controllers/income/incomeHead.controller");

const {
  createIncomeEntryController,
  getIncomeEntriesController,
} = require("../../../controllers/income/incomeEntry.controller");

// Income — flexible ad-hoc income (parallel to Phase 3 Expenses). ADMIN ONLY on
// every route (isAdmin resolves the role from the DB): managers never see income
// heads, entries or totals, mirroring the Expenses/Salary restriction. No
// existing route is altered.
incomeRouter.route("/income-heads")
  .get(isLoggedIn, isAdmin, getAllIncomeHeadsController)
  .post(isLoggedIn, isAdmin, createIncomeHeadController);
incomeRouter.route("/income-heads/:id/toggle")
  .put(isLoggedIn, isAdmin, toggleIncomeHeadController);
incomeRouter.route("/income-entries")
  .get(isLoggedIn, isAdmin, getIncomeEntriesController)
  .post(isLoggedIn, isAdmin, createIncomeEntryController);

module.exports = incomeRouter;