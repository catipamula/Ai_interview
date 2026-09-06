import { Request, Response, NextFunction } from 'express';
export interface AuthRequest extends Request {
    organizerId?: string;
}
export interface InterviewAuthRequest extends Request {
    interviewSessionId?: string;
    interviewCandidateId?: string;
}
export declare const requireAuth: (req: AuthRequest, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
/**
 * Candidate interview APIs use a short-lived JWT issued only after a valid
 * invitation is accepted. The token is bound to one InterviewSession, so a
 * session UUID from localStorage is never sufficient authorization by itself.
 */
export declare const requireInterviewAuth: (req: InterviewAuthRequest, res: Response, next: NextFunction) => Response<any, Record<string, any>> | undefined;
//# sourceMappingURL=auth.middleware.d.ts.map