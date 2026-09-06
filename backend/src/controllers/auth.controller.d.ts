import { Request, Response } from 'express';
export declare const registerOrganizer: (req: Request, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const loginOrganizer: (req: Request, res: Response) => Promise<Response<any, Record<string, any>> | undefined>;
export declare const requestPasswordReset: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const resetPassword: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
//# sourceMappingURL=auth.controller.d.ts.map