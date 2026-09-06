export interface PythonFaceResult {
    success: boolean;
    verified: boolean;
    code: string;
    distance: number | null;
    threshold: number;
    message: string;
    reference_face_count: number;
    live_face_count: number;
}
export declare function compareFacesWithPython(referenceImageUrl: string, liveImageBuffer: Buffer): Promise<PythonFaceResult>;
//# sourceMappingURL=pythonFace.service.d.ts.map