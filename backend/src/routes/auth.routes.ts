import { Router } from 'express';
import { registerOrganizer, loginOrganizer, requestPasswordReset, resetPassword } from '../controllers/auth.controller';

const router = Router();

router.post('/register', registerOrganizer);
router.post('/login', loginOrganizer);
router.post('/forgot-password', requestPasswordReset);
router.post('/reset-password', resetPassword);

export default router;
