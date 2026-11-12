const express = require("express");
const expensesRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdmin = require("../../../middlewares/isAdmin");

const {
  createExpenseHeadController,
  getAllExpenseHeadsController,
  toggleExpenseHeadController,
} = require("../../../controllers/expenses/expenseHead.controller");

const {
  createExpenseEntryController,
  getExpenseEntriesController,
} = require("../../../controllers/expenses/expenseEntry.controller");

// Expenses — Phase 3. ADMIN ONLY on every route (isAdmin resolves the role from
// the DB): managers never see expense heads, entries or totals, mirroring the
// Salary (Phase 2) restriction. No existing route is altered.
expensesRouter.route("/expense-heads")
  .get(isLoggedIn, isAdmin, getAllExpenseHeadsController)
  .post(isLoggedIn, isAdmin, createExpenseHeadController);
expensesRouter.route("/expense-heads/:id/toggle")
  .put(isLoggedIn, isAdmin, toggleExpenseHeadController);
expensesRouter.route("/expense-entries")
  .get(isLoggedIn, isAdmin, getExpenseEntriesController)
  .post(isLoggedIn, isAdmin, createExpenseEntryController);

module.exports = expensesRouter;
