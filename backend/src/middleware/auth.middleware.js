"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireInterviewAuth = exports.requireAuth = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const requireAuth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }
    try {
        const secret = process.env.JWT_SECRET || 'supersecret_for_local_dev';
        const decoded = jsonwebtoken_1.default.verify(token, secret);
        req.organizerId = decoded.id;
        next();
    }
    catch (error) {
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};
exports.requireAuth = requireAuth;
/**
 * Candidate interview APIs use a short-lived JWT issued only after a valid
 * invitation is accepted. The token is bound to one InterviewSession, so a
 * session UUID from localStorage is never sufficient authorization by itself.
 */
const requireInterviewAuth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({
            error: 'Interview access has expired. Please reopen your invitation link.',
            code: 'INTERVIEW_AUTH_REQUIRED'
        });
    }
    try {
        const secret = process.env.JWT_SECRET || 'supersecret_for_local_dev';
        const decoded = jsonwebtoken_1.default.verify(token, secret);
        const routeSessionId = req.params['id'];
        if (decoded.purpose !== 'candidate-interview' ||
            !decoded.sessionId ||
            !decoded.candidateId ||
            !routeSessionId ||
            decoded.sessionId !== routeSessionId) {
            return res.status(403).json({
                error: 'This interview link is not valid for the requested session.',
                code: 'INTERVIEW_AUTH_INVALID'
            });
        }
        req.interviewSessionId = decoded.sessionId;
        req.interviewCandidateId = decoded.candidateId;
        next();
    }
    catch {
        return res.status(401).json({
            error: 'Interview access has expired. Please reopen your invitation link.',
            code: 'INTERVIEW_AUTH_INVALID'
        });
    }
};
exports.requireInterviewAuth = requireInterviewAuth;
//# sourceMappingURL=auth.middleware.js.map