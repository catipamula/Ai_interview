import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';

export interface PythonFaceResult {
  verified: boolean;
  score: number;
  distance: number;
  message: string;
  ref_face_found: boolean;
  live_face_found: boolean;
}

export async function compareFacesWithPython(
  referenceImageUrl: string,
  liveSnapshotDataUrl: string
): Promise<PythonFaceResult> {
  return new Promise((resolve) => {
    try {
      // Find python executable in face-test-python/venv
      const rootDir = path.resolve(__dirname, '../../..');
      const venvPythonWin = path.join(rootDir, 'face-test-python', 'venv', 'Scripts', 'python.exe');
      const venvPythonLinux = path.join(rootDir, 'face-test-python', 'venv', 'bin', 'python');

      let pythonExec = 'python';
      if (fs.existsSync(venvPythonWin)) {
        pythonExec = venvPythonWin;
      } else if (fs.existsSync(venvPythonLinux)) {
        pythonExec = venvPythonLinux;
      }

      const scriptPath = path.join(__dirname, 'compare_faces.py');

      // Resolve reference image path on disk
      let refPathOnDisk = referenceImageUrl;
      if (referenceImageUrl.startsWith('/uploads/')) {
        refPathOnDisk = path.join(__dirname, '../../public', referenceImageUrl);
      } else if (referenceImageUrl.startsWith('http')) {
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

      execFile(pythonExec, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
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
          const result: PythonFaceResult = JSON.parse(jsonLine);
          console.log('[PythonFaceService] Python OpenCV result:', result);
          resolve(result);
        } catch (parseErr) {
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
    } catch (err) {
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
