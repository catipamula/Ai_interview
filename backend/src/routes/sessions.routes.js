"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const sessions_controller_1 = require("../controllers/sessions.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
const liveImageUpload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: {
        files: 1,
        fileSize: 2 * 1024 * 1024
    },
    fileFilter: (_req, file, cb) => {
        if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
            cb(null, true);
            return;
        }
        cb(new Error('Only JPEG and PNG camera images are allowed'));
    }
});
const receiveLiveImage = (req, res, next) => {
    liveImageUpload.single('liveImage')(req, res, (error) => {
        if (!error) {
            next();
            return;
        }
        if (error instanceof multer_1.default.MulterError && error.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({
                success: false,
                verified: false,
                code: 'IMAGE_TOO_LARGE',
                error: 'The camera image is too large. Please try again.'
            });
            return;
        }
        res.status(400).json({
            success: false,
            verified: false,
            code: 'INVALID_IMAGE_TYPE',
            error: error instanceof Error ? error.message : 'Invalid camera image'
        });
    });
};
router.use('/:id', auth_middleware_1.requireInterviewAuth);
router.post('/:id/start', sessions_controller_1.startSession);
router.get('/:id/next-question', sessions_controller_1.getNextQuestion);
router.post('/:id/answer', sessions_controller_1.submitAnswer);
router.post('/:id/proctoring-event', sessions_controller_1.logProctoringEvent);
router.post('/:id/complete', sessions_controller_1.completeSession);
router.post('/:id/cancel', sessions_controller_1.cancelSession);
router.post('/:id/verify-face', receiveLiveImage, sessions_controller_1.verifyFace);
exports.default = router;
//# sourceMappingURL=sessions.routes.js.map