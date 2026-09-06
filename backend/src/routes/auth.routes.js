"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("../controllers/auth.controller");
const router = (0, express_1.Router)();
router.post('/register', auth_controller_1.registerOrganizer);
router.post('/login', auth_controller_1.loginOrganizer);
router.post('/forgot-password', auth_controller_1.requestPasswordReset);
router.post('/reset-password', auth_controller_1.resetPassword);
exports.default = router;
//# sourceMappingURL=auth.routes.js.map