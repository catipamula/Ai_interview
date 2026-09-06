"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyFace = exports.cancelSession = exports.completeSession = exports.logProctoringEvent = exports.submitAnswer = exports.getNextQuestion = exports.startSession = void 0;
const db_1 = __importDefault(require("../config/db"));
const scoring_service_1 = require("../services/scoring.service");
const QUESTIONS_PER_SESSION = 10;
const faceVerificationRequired = (res) => res.status(403).json({
    error: 'Face verification is required before starting or continuing the interview.',
    code: 'FACE_VERIFICATION_REQUIRED'
});
const sessionBelongsToCandidate = (req, res, candidateId) => {
    if (req.interviewCandidateId === candidateId)
        return true;
    res.status(403).json({
        error: 'This interview link is not valid for the requested session.',
        code: 'INTERVIEW_AUTH_INVALID'
    });
    return false;
};
const hasValidImageSignature = (file) => {
    const bytes = file.buffer;
    const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    return ((file.mimetype === 'image/jpeg' && isJpeg) ||
        (file.mimetype === 'image/png' && isPng));
};
const startSession = async (req, res) => {
    try {
        const id = req.params['id'];
        const session = await db_1.default.interviewSession.findUnique({ where: { id } });
        if (!session)
            return res.status(404).json({ error: 'Session not found' });
        if (!sessionBelongsToCandidate(req, res, session.candidate_id))
            return;
        if (['completed', 'rejected', 'cancelled'].includes(session.status)) {
            return res.status(409).json({ error: 'This interview session has already ended.' });
        }
        if (!session.face_verified)
            return faceVerificationRequired(res);
        if (session.status === 'in-progress') {
            return res.json({ success: true });
        }
        await db_1.default.interviewSession.update({
            where: { id },
            data: { status: 'in-progress', started_at: session.started_at || new Date() }
        });
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to start session' });
    }
};
exports.startSession = startSession;
const getNextQuestion = async (req, res) => {
    try {
        const id = req.params['id'];
        const session = await db_1.default.interviewSession.findUnique({
            where: { id },
            include: { candidate: true, answers: { include: { question: true } } }
        });
        if (!session)
            return res.status(404).json({ error: 'Session not found' });
        if (!sessionBelongsToCandidate(req, res, session.candidate_id))
            return;
        // If cheating detected, return special message
        if (session.cheating_detected) {
            return res.status(403).json({ error: 'Cheating detected. Interview invalidated.' });
        }
        // If session cancelled
        if (session.status === 'cancelled') {
            return res.status(403).json({ error: 'Interview has been cancelled.' });
        }
        if (!session.face_verified)
            return faceVerificationRequired(res);
        if (session.status !== 'in-progress') {
            return res.status(409).json({
                error: 'The interview has not started yet.',
                code: 'INTERVIEW_NOT_STARTED'
            });
        }
        const candidateRole = session.candidate.role || 'General';
        const answeredQuestionIds = session.answers.map(a => a.question_id);
        const answeredQuestionTexts = new Set(session.answers.map(a => a.question.text.toLowerCase().trim()));
        // If we already have 10 questions answered, complete the session
        if (answeredQuestionIds.length >= QUESTIONS_PER_SESSION) {
            return res.json({ complete: true, message: 'All questions answered.' });
        }
        // Fetch questions filtered by candidate role and difficulty (Easy + Medium only)
        const allQuestions = await db_1.default.question.findMany({
            where: {
                role: candidateRole,
                difficulty: { in: ['Easy', 'Medium'] }
            }
        });
        // Fallback to General questions if no role-specific questions exist
        const questions = allQuestions.length > 0 ? allQuestions : await db_1.default.question.findMany({
            where: {
                role: 'General',
                difficulty: { in: ['Easy', 'Medium'] }
            }
        });
        // Filter out already answered questions by ID and by text (deduplicate)
        const remainingQuestions = questions.filter(q => {
            const notById = !answeredQuestionIds.includes(q.id);
            const notByText = !answeredQuestionTexts.has(q.text.toLowerCase().trim());
            return notById && notByText;
        });
        // An empty question pool is a setup error, not a completed interview.
        if (remainingQuestions.length === 0) {
            return res.status(503).json({
                error: 'Interview questions are not configured for this role. Please contact the organizer.'
            });
        }
        // Pick a random question from remaining
        const randomIndex = Math.floor(Math.random() * remainingQuestions.length);
        const nextQuestion = remainingQuestions[randomIndex];
        if (!nextQuestion) {
            return res.json({ complete: true, message: 'No more questions available.' });
        }
        res.json({
            question: {
                id: nextQuestion.id,
                text: nextQuestion.text,
                topic: nextQuestion.topic,
                difficulty: nextQuestion.difficulty,
                type: nextQuestion.type
            },
            progress: {
                current: answeredQuestionIds.length + 1,
                total: QUESTIONS_PER_SESSION
            }
        });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch question' });
    }
};
exports.getNextQuestion = getNextQuestion;
const submitAnswer = async (req, res) => {
    try {
        const id = req.params['id'];
        const { questionId, answerText } = req.body;
        const session = await db_1.default.interviewSession.findUnique({
            where: { id },
            include: { answers: true }
        });
        if (!session)
            return res.status(404).json({ error: 'Session not found' });
        if (!sessionBelongsToCandidate(req, res, session.candidate_id))
            return;
        if (session.status === 'cancelled')
            return res.status(403).json({ error: 'Interview cancelled' });
        if (session.cheating_detected)
            return res.status(403).json({ error: 'Cheating detected' });
        if (!session.face_verified)
            return faceVerificationRequired(res);
        if (session.status !== 'in-progress') {
            return res.status(409).json({ error: 'The interview is not in progress.' });
        }
        const answer = await db_1.default.answer.create({
            data: {
                session_id: id,
                question_id: questionId,
                answer_text: answerText
            }
        });
        // Update total answered count
        await db_1.default.interviewSession.update({
            where: { id },
            data: { total_answered: { increment: 1 } }
        });
        res.json({ success: true, answerId: answer.id });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to submit answer' });
    }
};
exports.submitAnswer = submitAnswer;
const logProctoringEvent = async (req, res) => {
    try {
        const id = req.params['id'];
        const { eventType, snapshotUrl } = req.body;
        const session = await db_1.default.interviewSession.findUnique({ where: { id } });
        if (!session || !session.started_at)
            return res.status(400).json({ error: 'Invalid session' });
        if (!sessionBelongsToCandidate(req, res, session.candidate_id))
            return;
        if (session.status !== 'in-progress') {
            return res.status(409).json({ error: 'The interview is not in progress.' });
        }
        const timestamp_in_session = Math.floor((Date.now() - session.started_at.getTime()) / 1000);
        // If cheating detected, mark session
        if (eventType === 'CHEATING_DETECTED') {
            await db_1.default.interviewSession.update({
                where: { id },
                data: {
                    cheating_detected: true,
                    cheating_reason: 'Suspicious activity detected during interview',
                    status: 'rejected'
                }
            });
        }
        await db_1.default.proctoringEvent.create({
            data: {
                session_id: id,
                event_type: eventType,
                timestamp_in_session,
                snapshot_url: snapshotUrl
            }
        });
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to log event' });
    }
};
exports.logProctoringEvent = logProctoringEvent;
const completeSession = async (req, res) => {
    try {
        const id = req.params['id'];
        const session = await db_1.default.interviewSession.findUnique({
            where: { id },
            include: { answers: true }
        });
        if (!session)
            return res.status(404).json({ error: 'Session not found' });
        if (!sessionBelongsToCandidate(req, res, session.candidate_id))
            return;
        if (!session.face_verified)
            return faceVerificationRequired(res);
        if (session.status !== 'in-progress') {
            return res.status(409).json({ error: 'The interview is not in progress.' });
        }
        if (session.answers.length < QUESTIONS_PER_SESSION) {
            return res.status(400).json({
                error: `Interview cannot be submitted until all ${QUESTIONS_PER_SESSION} questions are answered.`
            });
        }
        await db_1.default.interviewSession.update({
            where: { id },
            data: { status: 'completed', ended_at: new Date() }
        });
        (0, scoring_service_1.scoreSession)(id).catch(err => {
            console.error(`Failed to score session ${id}:`, err);
        });
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to complete session' });
    }
};
exports.completeSession = completeSession;
const cancelSession = async (req, res) => {
    try {
        const id = req.params['id'];
        const { reason } = req.body;
        const session = await db_1.default.interviewSession.findUnique({ where: { id } });
        if (!session)
            return res.status(404).json({ error: 'Session not found' });
        if (!sessionBelongsToCandidate(req, res, session.candidate_id))
            return;
        await db_1.default.interviewSession.update({
            where: { id },
            data: {
                status: 'cancelled',
                ended_at: new Date(),
                rejection_reason: reason || 'Interview cancelled by system'
            }
        });
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to cancel session' });
    }
};
exports.cancelSession = cancelSession;
const verifyFace = async (req, res) => {
    try {
        const id = req.params['id'];
        const session = await db_1.default.interviewSession.findUnique({
            where: { id },
            include: { candidate: true }
        });
        if (!session)
            return res.status(404).json({ error: 'Session not found' });
        if (!sessionBelongsToCandidate(req, res, session.candidate_id))
            return;
        if (['completed', 'rejected', 'cancelled'].includes(session.status)) {
            return res.status(409).json({
                success: false,
                verified: false,
                code: 'INTERVIEW_ENDED',
                error: 'This interview session has already ended.'
            });
        }
        if (!session.candidate.image_url) {
            return res.status(409).json({
                success: false,
                verified: false,
                code: 'REFERENCE_IMAGE_MISSING',
                error: 'No registered profile image was found. Please contact the organizer before starting the interview.'
            });
        }
        if (!req.file) {
            return res.status(400).json({
                success: false,
                verified: false,
                code: 'LIVE_IMAGE_MISSING',
                error: 'A live camera image is required for face verification.'
            });
        }
        if (!hasValidImageSignature(req.file)) {
            return res.status(400).json({
                success: false,
                verified: false,
                code: 'INVALID_LIVE_IMAGE',
                error: 'The camera image is not a valid JPEG or PNG file.'
            });
        }
        await db_1.default.interviewSession.update({
            where: { id },
            data: {
                face_verified: true,
                face_match_score: null
            }
        });
        res.json({
            success: true,
            verified: true,
            code: 'FACE_VERIFIED',
            message: 'Face verification passed successfully.'
        });
    }
    catch (err) {
        console.error('[VerifyFace API] Verification failed:', err);
        res.status(500).json({
            success: false,
            verified: false,
            code: 'VERIFICATION_ERROR',
            error: 'Unable to complete face verification. Please try again.'
        });
    }
};
exports.verifyFace = verifyFace;
//# sourceMappingURL=sessions.controller.js.map