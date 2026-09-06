import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthRequest extends Request {
  organizerId?: string;
}

export interface InterviewAuthRequest extends Request {
  interviewSessionId?: string;
  interviewCandidateId?: string;
}

interface InterviewTokenPayload {
  purpose: 'candidate-interview';
  sessionId: string;
  candidateId: string;
}

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  try {
    const secret = process.env.JWT_SECRET || 'supersecret_for_local_dev';
    const decoded = jwt.verify(token, secret) as { id: string };
    req.organizerId = decoded.id;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

/**
 * Candidate interview APIs use a short-lived JWT issued only after a valid
 * invitation is accepted. The token is bound to one InterviewSession, so a
 * session UUID from localStorage is never sufficient authorization by itself.
 */
export const requireInterviewAuth = (
  req: InterviewAuthRequest,
  res: Response,
  next: NextFunction
) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      error: 'Interview access has expired. Please reopen your invitation link.',
      code: 'INTERVIEW_AUTH_REQUIRED'
    });
  }

  try {
    const secret = process.env.JWT_SECRET || 'supersecret_for_local_dev';
    const decoded = jwt.verify(token, secret) as Partial<InterviewTokenPayload>;
    const routeSessionId = req.params['id'] as string | undefined;

    if (
      decoded.purpose !== 'candidate-interview' ||
      !decoded.sessionId ||
      !decoded.candidateId ||
      !routeSessionId ||
      decoded.sessionId !== routeSessionId
    ) {
      return res.status(403).json({
        error: 'This interview link is not valid for the requested session.',
        code: 'INTERVIEW_AUTH_INVALID'
      });
    }

    req.interviewSessionId = decoded.sessionId;
    req.interviewCandidateId = decoded.candidateId;
    next();
  } catch {
    return res.status(401).json({
      error: 'Interview access has expired. Please reopen your invitation link.',
      code: 'INTERVIEW_AUTH_INVALID'
    });
  }
};
