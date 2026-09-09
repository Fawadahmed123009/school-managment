const express = require('express');
const academicYearRouter = express.Router();
// middleware
const isAdminOrManager = require('../../../middlewares/isAdminOrManager');
const isLoggedIn = require('../../../middlewares/isLoggedIn');
const { getAcademicYearsController, createAcademicYearController, getAcademicYearController, updateAcademicYearController, deleteAcademicYearController } = require('../../../controllers/academic/academicYear.controller');

academicYearRouter.route('/academic-years')
 .get( isLoggedIn, isAdminOrManager, getAcademicYearsController)
 .post( isLoggedIn, isAdminOrManager, createAcademicYearController)
academicYearRouter.route('/academic-years/:academicYearId')
 .get( isLoggedIn, isAdminOrManager, getAcademicYearController)
 .patch( isLoggedIn, isAdminOrManager, updateAcademicYearController)
 .delete( isLoggedIn, isAdminOrManager, deleteAcademicYearController)
module.exports = academicYearRouter;
