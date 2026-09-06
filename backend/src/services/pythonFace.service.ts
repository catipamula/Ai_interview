import path from 'path';
import fs from 'fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

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

const PYTHON_TIMEOUT_MS = 30_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const FACE_DISTANCE_TOLERANCE = 0.6;

function failureResult(code: string, message: string): PythonFaceResult {
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

function findBackendRoot(): string | null {
  const candidates = [
    path.resolve(__dirname, '../..'),
    path.resolve(process.cwd())
  ];

  return candidates.find(candidate =>
    fs.existsSync(path.join(candidate, 'src', 'services', 'compare_faces.py'))
  ) || null;
}

function resolveReferenceImagePath(backendRoot: string, referenceImageUrl: string): string | null {
  const prefix = '/uploads/candidates/';
  if (!referenceImageUrl.startsWith(prefix)) return null;

  const filename = referenceImageUrl.slice(prefix.length);
  if (!filename || filename !== path.basename(filename)) return null;

  const uploadRoot = path.resolve(backendRoot, 'public', 'uploads', 'candidates');
  const resolvedPath = path.resolve(uploadRoot, filename);
  if (!resolvedPath.startsWith(`${uploadRoot}${path.sep}`)) return null;

  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > 5 * 1024 * 1024) return null;
  } catch {
    return null;
  }

  return resolvedPath;
}

function findPythonExecutable(projectRoot: string): string {
  const venvPythonWindows = path.join(projectRoot, 'face-test-python', 'venv', 'Scripts', 'python.exe');
  const venvPythonUnix = path.join(projectRoot, 'face-test-python', 'venv', 'bin', 'python');

  if (fs.existsSync(venvPythonWindows)) return venvPythonWindows;
  if (fs.existsSync(venvPythonUnix)) return venvPythonUnix;
  return 'python';
}

function isPythonFaceResult(value: unknown): value is PythonFaceResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<PythonFaceResult>;
  return (
    typeof result.success === 'boolean' &&
    typeof result.verified === 'boolean' &&
    typeof result.code === 'string' &&
    (typeof result.distance === 'number' || result.distance === null) &&
    typeof result.threshold === 'number' &&
    typeof result.message === 'string' &&
    typeof result.reference_face_count === 'number' &&
    typeof result.live_face_count === 'number'
  );
}

export async function compareFacesWithPython(
  referenceImageUrl: string,
  liveImageBuffer: Buffer
): Promise<PythonFaceResult> {
  const backendRoot = findBackendRoot();
  if (!backendRoot) {
    return failureResult('SERVICE_UNAVAILABLE', 'Unable to complete face verification. Please try again.');
  }

  const referenceImagePath = resolveReferenceImagePath(backendRoot, referenceImageUrl);
  if (!referenceImagePath) {
    return failureResult(
      'INVALID_REFERENCE_IMAGE',
      'No registered profile image was found. Please contact the organizer.'
    );
  }

  if (!liveImageBuffer.length || liveImageBuffer.length > 2 * 1024 * 1024) {
    return failureResult('INVALID_LIVE_IMAGE', 'The camera image is invalid. Please try again.');
  }

  const projectRoot = path.resolve(backendRoot, '..');
  const pythonExecutable = findPythonExecutable(projectRoot);
  const scriptPath = path.join(backendRoot, 'src', 'services', 'compare_faces.py');

  return new Promise(resolve => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timeout: NodeJS.Timeout | undefined;

    const finish = (result: PythonFaceResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        pythonExecutable,
        [
          scriptPath,
          '--ref', referenceImagePath,
          '--live-stdin',
          '--tolerance', FACE_DISTANCE_TOLERANCE.toString()
        ],
        {
          cwd: backendRoot,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      ) as ChildProcessWithoutNullStreams;
    } catch (error) {
      console.error('[PythonFaceService] Failed to start verifier:', error);
      finish(failureResult(
        'SERVICE_UNAVAILABLE',
        'Face verification service is unavailable. Please try again.'
      ));
      return;
    }

    timeout = setTimeout(() => {
      child.kill();
      finish(failureResult(
        'SERVICE_UNAVAILABLE',
        'Face verification took too long. Please try again.'
      ));
    }, PYTHON_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill();
        finish(failureResult(
          'SERVICE_UNAVAILABLE',
          'Unable to complete face verification. Please try again.'
        ));
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (Buffer.byteLength(stderr, 'utf8') > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill();
      }
    });

    child.on('error', error => {
      console.error('[PythonFaceService] Failed to start verifier:', error.message);
      finish(failureResult(
        'SERVICE_UNAVAILABLE',
        'Face verification service is unavailable. Please try again.'
      ));
    });

    child.on('close', exitCode => {
      if (settled) return;

      if (exitCode !== 0) {
        console.error('[PythonFaceService] Verifier exited unexpectedly:', {
          exitCode,
          stderr: stderr.slice(0, 1000)
        });
        finish(failureResult(
          'SERVICE_UNAVAILABLE',
          'Unable to complete face verification. Please try again.'
        ));
        return;
      }

      try {
        const jsonLine = stdout
          .trim()
          .split(/\r?\n/)
          .reverse()
          .find(line => line.trim().startsWith('{'));
        const parsed: unknown = JSON.parse(jsonLine || '{}');
        if (!isPythonFaceResult(parsed)) throw new Error('Unexpected verifier response');
        finish(parsed);
      } catch (error) {
        console.error('[PythonFaceService] Invalid verifier response:', error);
        finish(failureResult(
          'SERVICE_UNAVAILABLE',
          'Unable to complete face verification. Please try again.'
        ));
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
