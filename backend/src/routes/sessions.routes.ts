import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { startSession, getNextQuestion, submitAnswer, logProctoringEvent, completeSession, verifyFace, cancelSession } from '../controllers/sessions.controller';
import { requireInterviewAuth } from '../middleware/auth.middleware';

const router = Router();

const liveImageUpload = multer({
  storage: multer.memoryStorage(),
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

const receiveLiveImage = (req: Request, res: Response, next: NextFunction) => {
  liveImageUpload.single('liveImage')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
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

router.use('/:id', requireInterviewAuth);

router.post('/:id/start', startSession);
router.get('/:id/next-question', getNextQuestion);
router.post('/:id/answer', submitAnswer);
router.post('/:id/proctoring-event', logProctoringEvent);
router.post('/:id/complete', completeSession);
router.post('/:id/cancel', cancelSession);
router.post('/:id/verify-face', receiveLiveImage, verifyFace);

export default router;
