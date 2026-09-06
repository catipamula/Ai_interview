import { Response } from 'express';
import { InterviewAuthRequest } from '../middleware/auth.middleware';
export declare const startSession: (req: InterviewAuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const getNextQuestion: (req: InterviewAuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const submitAnswer: (req: InterviewAuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const logProctoringEvent: (req: InterviewAuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const completeSession: (req: InterviewAuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const cancelSession: (req: InterviewAuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const verifyFace: (req: InterviewAuthRequest, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
//# sourceMappingURL=sessions.controller.d.ts.map