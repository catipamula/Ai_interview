"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareFacesWithPython = compareFacesWithPython;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const child_process_1 = require("child_process");
async function compareFacesWithPython(referenceImageUrl, liveSnapshotDataUrl) {
    return new Promise((resolve) => {
        try {
            // Find python executable in face-test-python/venv
            const rootDir = path_1.default.resolve(__dirname, '../../..');
            const venvPythonWin = path_1.default.join(rootDir, 'face-test-python', 'venv', 'Scripts', 'python.exe');
            const venvPythonLinux = path_1.default.join(rootDir, 'face-test-python', 'venv', 'bin', 'python');
            let pythonExec = 'python';
            if (fs_1.default.existsSync(venvPythonWin)) {
                pythonExec = venvPythonWin;
            }
            else if (fs_1.default.existsSync(venvPythonLinux)) {
                pythonExec = venvPythonLinux;
            }
            const scriptPath = path_1.default.join(__dirname, 'compare_faces.py');
            // Resolve reference image path on disk
            let refPathOnDisk = referenceImageUrl;
            if (referenceImageUrl.startsWith('/uploads/')) {
                refPathOnDisk = path_1.default.join(__dirname, '../../public', referenceImageUrl);
            }
            else if (referenceImageUrl.startsWith('http')) {
                // If external URL, pass as is
                refPathOnDisk = referenceImageUrl;
            }
            console.log('[PythonFaceService] Executing OpenCV + face_recognition python:', {
                pythonExec,
                scriptPath,
                refPathOnDisk
            });
            const args = [
                scriptPath,
                '--ref', refPathOnDisk,
                '--live', liveSnapshotDataUrl,
                '--tolerance', '0.75'
            ];
            (0, child_process_1.execFile)(pythonExec, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    console.warn('[PythonFaceService] Python process error:', error.message, stderr);
                    // Fail closed when the server verifier cannot run.
                    return resolve({
                        verified: false,
                        score: 0,
                        distance: 1,
                        message: 'Python face verification failed to run.',
                        ref_face_found: false,
                        live_face_found: false
                    });
                }
                try {
                    // Find the line that is a valid JSON (starts with '{' and ends with '}')
                    const lines = stdout.trim().split('\n');
                    let jsonLine = '{}';
                    for (let i = lines.length - 1; i >= 0; i--) {
                        const line = lines[i]?.trim() || '';
                        if (line.startsWith('{') && line.endsWith('}')) {
                            jsonLine = line;
                            break;
                        }
                    }
                    const result = JSON.parse(jsonLine);
                    console.log('[PythonFaceService] Python OpenCV result:', result);
                    resolve(result);
                }
                catch (parseErr) {
                    console.error('[PythonFaceService] Failed to parse JSON stdout:', stdout);
                    resolve({
                        verified: false,
                        score: 0,
                        distance: 1,
                        message: 'Python face verification returned an invalid result.',
                        ref_face_found: false,
                        live_face_found: false
                    });
                }
            });
        }
        catch (err) {
            console.error('[PythonFaceService] Unexpected error:', err);
            resolve({
                verified: false,
                score: 0,
                distance: 1,
                message: 'Python face verification failed unexpectedly.',
                ref_face_found: false,
                live_face_found: false
            });
        }
    });
}
//# sourceMappingURL=pythonFace.service.js.map