"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareFacesWithPython = compareFacesWithPython;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const child_process_1 = require("child_process");
const PYTHON_TIMEOUT_MS = 30_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const FACE_DISTANCE_TOLERANCE = 0.6;
function failureResult(code, message) {
    return {
        success: false,
        verified: false,
        code,
        distance: null,
        threshold: FACE_DISTANCE_TOLERANCE,
        message,
        reference_face_count: 0,
        live_face_count: 0
    };
}
function findBackendRoot() {
    const candidates = [
        path_1.default.resolve(__dirname, '../..'),
        path_1.default.resolve(process.cwd())
    ];
    return candidates.find(candidate => fs_1.default.existsSync(path_1.default.join(candidate, 'src', 'services', 'compare_faces.py'))) || null;
}
function resolveReferenceImagePath(backendRoot, referenceImageUrl) {
    const prefix = '/uploads/candidates/';
    if (!referenceImageUrl.startsWith(prefix))
        return null;
    const filename = referenceImageUrl.slice(prefix.length);
    if (!filename || filename !== path_1.default.basename(filename))
        return null;
    const uploadRoot = path_1.default.resolve(backendRoot, 'public', 'uploads', 'candidates');
    const resolvedPath = path_1.default.resolve(uploadRoot, filename);
    if (!resolvedPath.startsWith(`${uploadRoot}${path_1.default.sep}`))
        return null;
    try {
        const stat = fs_1.default.statSync(resolvedPath);
        if (!stat.isFile() || stat.size === 0 || stat.size > 5 * 1024 * 1024)
            return null;
    }
    catch {
        return null;
    }
    return resolvedPath;
}
function findPythonExecutable(projectRoot) {
    const venvPythonWindows = path_1.default.join(projectRoot, 'face-test-python', 'venv', 'Scripts', 'python.exe');
    const venvPythonUnix = path_1.default.join(projectRoot, 'face-test-python', 'venv', 'bin', 'python');
    if (fs_1.default.existsSync(venvPythonWindows))
        return venvPythonWindows;
    if (fs_1.default.existsSync(venvPythonUnix))
        return venvPythonUnix;
    return 'python';
}
function isPythonFaceResult(value) {
    if (!value || typeof value !== 'object')
        return false;
    const result = value;
    return (typeof result.success === 'boolean' &&
        typeof result.verified === 'boolean' &&
        typeof result.code === 'string' &&
        (typeof result.distance === 'number' || result.distance === null) &&
        typeof result.threshold === 'number' &&
        typeof result.message === 'string' &&
        typeof result.reference_face_count === 'number' &&
        typeof result.live_face_count === 'number');
}
async function compareFacesWithPython(referenceImageUrl, liveImageBuffer) {
    const backendRoot = findBackendRoot();
    if (!backendRoot) {
        return failureResult('SERVICE_UNAVAILABLE', 'Unable to complete face verification. Please try again.');
    }
    const referenceImagePath = resolveReferenceImagePath(backendRoot, referenceImageUrl);
    if (!referenceImagePath) {
        return failureResult('INVALID_REFERENCE_IMAGE', 'No registered profile image was found. Please contact the organizer.');
    }
    if (!liveImageBuffer.length || liveImageBuffer.length > 2 * 1024 * 1024) {
        return failureResult('INVALID_LIVE_IMAGE', 'The camera image is invalid. Please try again.');
    }
    const projectRoot = path_1.default.resolve(backendRoot, '..');
    const pythonExecutable = findPythonExecutable(projectRoot);
    const scriptPath = path_1.default.join(backendRoot, 'src', 'services', 'compare_faces.py');
    return new Promise(resolve => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        let timeout;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            if (timeout)
                clearTimeout(timeout);
            resolve(result);
        };
        let child;
        try {
            child = (0, child_process_1.spawn)(pythonExecutable, [
                scriptPath,
                '--ref', referenceImagePath,
                '--live-stdin',
                '--tolerance', FACE_DISTANCE_TOLERANCE.toString()
            ], {
                cwd: backendRoot,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        }
        catch (error) {
            console.error('[PythonFaceService] Failed to start verifier:', error);
            finish(failureResult('SERVICE_UNAVAILABLE', 'Face verification service is unavailable. Please try again.'));
            return;
        }
        timeout = setTimeout(() => {
            child.kill();
            finish(failureResult('SERVICE_UNAVAILABLE', 'Face verification took too long. Please try again.'));
        }, PYTHON_TIMEOUT_MS);
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            if (Buffer.byteLength(stdout, 'utf8') > MAX_PROCESS_OUTPUT_BYTES) {
                child.kill();
                finish(failureResult('SERVICE_UNAVAILABLE', 'Unable to complete face verification. Please try again.'));
            }
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
            if (Buffer.byteLength(stderr, 'utf8') > MAX_PROCESS_OUTPUT_BYTES) {
                child.kill();
            }
        });
        child.on('error', error => {
            console.error('[PythonFaceService] Failed to start verifier:', error.message);
            finish(failureResult('SERVICE_UNAVAILABLE', 'Face verification service is unavailable. Please try again.'));
        });
        child.on('close', exitCode => {
            if (settled)
                return;
            if (exitCode !== 0) {
                console.error('[PythonFaceService] Verifier exited unexpectedly:', {
                    exitCode,
                    stderr: stderr.slice(0, 1000)
                });
                finish(failureResult('SERVICE_UNAVAILABLE', 'Unable to complete face verification. Please try again.'));
                return;
            }
            try {
                const jsonLine = stdout
                    .trim()
                    .split(/\r?\n/)
                    .reverse()
                    .find(line => line.trim().startsWith('{'));
                const parsed = JSON.parse(jsonLine || '{}');
                if (!isPythonFaceResult(parsed))
                    throw new Error('Unexpected verifier response');
                finish(parsed);
            }
            catch (error) {
                console.error('[PythonFaceService] Invalid verifier response:', error);
                finish(failureResult('SERVICE_UNAVAILABLE', 'Unable to complete face verification. Please try again.'));
            }
        });
        child.stdin.on('error', error => {
            if (!settled) {
                console.error('[PythonFaceService] Could not send camera image:', error.message);
            }
        });
        child.stdin.end(liveImageBuffer);
    });
}
//# sourceMappingURL=pythonFace.service.js.map