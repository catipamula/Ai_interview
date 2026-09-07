'use client';

import { use, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LiveDetection, ProctoringService } from '@/lib/proctoring';

type VerificationState = 'idle' | 'capturing' | 'verifying' | 'success' | 'failed';
const MAX_CAPTURE_ATTEMPTS = 3;
const RECOVERABLE_FRAME_CODES = new Set(['NO_LIVE_FACE', 'POOR_IMAGE']);

const wait = (milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds));

function cameraErrorMessage(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Camera permission is required to verify your identity before starting the interview.';
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return 'No camera was detected on this device.';
    }
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      return 'The camera is being used by another application. Close it and reload this page.';
    }
  }

  return 'Unable to access the camera and microphone. Please check your device permissions.';
}

async function waitForVideoFrame(video: HTMLVideoElement) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) return;

  await new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('The camera is not ready. Please wait a moment and try again.'));
    }, 5000);
    const onLoadedData = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener('loadeddata', onLoadedData);
    };

    video.addEventListener('loadeddata', onLoadedData, { once: true });
  });
}

async function captureCameraFrame(video: HTMLVideoElement): Promise<Blob> {
  await waitForVideoFrame(video);

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to capture a camera image. Please try again.');

  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Unable to capture a camera image. Please try again.'));
    }, 'image/jpeg', 0.9);
  });
}

export default function DeviceCheckPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const candidateProctorRef = useRef<ProctoringService | null>(null);
  const livenessBaselineRef = useRef<{ x: number; y: number; width: number } | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [starting, setStarting] = useState(false);
  const [verificationState, setVerificationState] = useState<VerificationState>('idle');
  const [verificationMessage, setVerificationMessage] = useState(
    'Position your face clearly inside the camera, with only one person visible.'
  );
  const [liveDetections, setLiveDetections] = useState<LiveDetection[]>([]);
  const [liveStatus, setLiveStatus] = useState('Detecting live face...');
  const [liveStatusColor, setLiveStatusColor] = useState('#60a5fa');
  const [videoSize, setVideoSize] = useState({ width: 640, height: 480 });
  const [faceOverlay, setFaceOverlay] = useState<{ right: number; top: number; width: number; height: number } | null>(null);

  useEffect(() => {
    let disposed = false;
    let localStream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let animationFrame: number | null = null;

    const requestPermissions = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('No camera was detected on this device.');
        return;
      }

      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: true
        });

        if (disposed) {
          mediaStream.getTracks().forEach(track => track.stop());
          return;
        }

        localStream = mediaStream;
        streamRef.current = mediaStream;
        setStream(mediaStream);
        if (videoRef.current) videoRef.current.srcObject = mediaStream;

        try {
          audioContext = new AudioContext();
          const analyser = audioContext.createAnalyser();
          const microphone = audioContext.createMediaStreamSource(mediaStream);
          microphone.connect(analyser);
          analyser.fftSize = 256;
          const dataArray = new Uint8Array(analyser.frequencyBinCount);

          const checkAudioLevel = () => {
            analyser.getByteFrequencyData(dataArray);
            const sum = dataArray.reduce((total, value) => total + value, 0);
            setAudioLevel(sum / dataArray.length);
            animationFrame = window.requestAnimationFrame(checkAudioLevel);
          };
          checkAudioLevel();
        } catch (audioError) {
          console.warn('Microphone level preview is unavailable:', audioError);
        }
      } catch (permissionError) {
        if (!disposed) setError(cameraErrorMessage(permissionError));
      }
    };

    void requestPermissions();

    return () => {
      disposed = true;
      localStream?.getTracks().forEach(track => track.stop());
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      if (audioContext) void audioContext.close();
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(() => {
    if (!stream || !videoRef.current) return;
    let disposed = false;
    const video = videoRef.current;

    const proctor = new ProctoringService(
      () => undefined,
      detections => {
        if (disposed) return;
        setLiveDetections(detections);
        const person = detections.filter(item => item.kind === 'person').sort((a, b) => b.score - a.score)[0];
        if (person) {
          const [x, y, width, height] = person.bbox;
          const center = { x: x + width / 2, y: y + height * 0.18, width };
          const sourceWidth = video.videoWidth || 640;
          const sourceHeight = video.videoHeight || 480;
          const squareSize = Math.min(width * 0.72, height * 0.48);
          const squareX = x + (width - squareSize) / 2;
          const squareY = Math.max(0, y + height * 0.01);
          setFaceOverlay({
            right: (squareX / sourceWidth) * 100,
            top: (squareY / sourceHeight) * 100,
            width: (squareSize / sourceWidth) * 100,
            height: (squareSize / sourceHeight) * 100
          });
          const baseline = livenessBaselineRef.current;
          if (!baseline) {
            livenessBaselineRef.current = center;
            setLiveStatus('Live face detected — move slightly');
            setLiveStatusColor('#fbbf24');
          } else {
            const movement = Math.hypot(center.x - baseline.x, center.y - baseline.y);
            if (movement >= Math.max(10, baseline.width * 0.06)) {
              setLiveStatus('Liveness verified');
              setLiveStatusColor('#10b981');
            }
          }
        } else {
          livenessBaselineRef.current = null;
          setFaceOverlay(null);
          setLiveStatus('Detecting live face...');
          setLiveStatusColor('#60a5fa');
        }
      }
    );
    candidateProctorRef.current = proctor;

    void proctor.initialize()
      .then(() => {
        if (!disposed) proctor.startProctoring(video);
      })
      .catch(error => {
        console.error('Candidate object detection failed to load:', error);
        if (!disposed) proctor.startProctoring(video);
      });

    return () => {
      disposed = true;
      proctor.stopProctoring();
      candidateProctorRef.current = null;
    };
  }, [stream]);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStream(null);
  };

  const handleStart = async () => {
    if (!stream || !videoRef.current || starting) return;

    const sessionId = localStorage.getItem('sessionId');
    const interviewAccessToken = sessionStorage.getItem('interviewAccessToken');
    if (!sessionId || !interviewAccessToken) {
      setVerificationState('failed');
      setVerificationMessage('Interview access has expired. Please reopen your invitation link.');
      return;
    }

    setStarting(true);
    setVerificationState('capturing');
    setVerificationMessage('Capturing a live camera image...');

    try {
      const verificationStartedAt = Date.now();
      let verified = false;
      for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
        setVerificationState('capturing');
        setVerificationMessage(
          attempt === 1
            ? 'Capturing a live camera image...'
            : `Capturing a clearer frame (${attempt}/${MAX_CAPTURE_ATTEMPTS})...`
        );

        const liveImage = await captureCameraFrame(videoRef.current);
        const formData = new FormData();
        formData.append('liveImage', liveImage, 'live-verification.jpg');

        setVerificationState('verifying');
        setVerificationMessage('Verifying your identity...');

        const verificationResponse = await fetch(`/api/sessions/${sessionId}/verify-face`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${interviewAccessToken}` },
          body: formData
        });
        const verificationData = await verificationResponse.json().catch(() => ({}));

        if (!verificationResponse.ok) {
          throw new Error(
            verificationData.error ||
            'Unable to complete face verification. Please try again.'
          );
        }

        if (verificationData.verified === true) {
          setVerificationMessage('Liveness verified. Matching face...');
          await wait(700);
          const remainingDetectionTime = 2200 - (Date.now() - verificationStartedAt);
          if (remainingDetectionTime > 0) await wait(remainingDetectionTime);
          verified = true;
          break;
        }

        const canRetryFrame = RECOVERABLE_FRAME_CODES.has(verificationData.code);
        if (canRetryFrame && attempt < MAX_CAPTURE_ATTEMPTS) {
          setVerificationMessage(
            `${verificationData.message || 'The camera frame was unclear'} Retrying automatically...`
          );
          await wait(650);
          continue;
        }

        setVerificationState('failed');
        setVerificationMessage(
          verificationData.message ||
          'Face verification failed. The live face does not match the registered candidate.'
        );
        return;
      }

      if (!verified) return;

      setVerificationState('success');
      setVerificationMessage('Face Verified Successfully. Starting your interview...');

      const startResponse = await fetch(`/api/sessions/${sessionId}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${interviewAccessToken}` }
      });
      if (!startResponse.ok) {
        const startData = await startResponse.json().catch(() => ({}));
        throw new Error(startData.error || 'Unable to start the interview. Please try again.');
      }

      stopCamera();
      window.setTimeout(() => router.push(`/interview/${token}/session`), 600);
    } catch (verificationError) {
      setVerificationState('failed');
      setVerificationMessage(
        verificationError instanceof TypeError
          ? 'Connection error during verification. Please try again.'
          : verificationError instanceof Error
          ? verificationError.message
          : 'Connection error during verification. Please try again.'
      );
    } finally {
      setStarting(false);
    }
  };

  const startButtonLabel = (() => {
    if (verificationState === 'capturing') return 'Capturing Image...';
    if (verificationState === 'verifying') return 'Verifying Identity...';
    if (verificationState === 'success') return 'Starting Interview...';
    if (verificationState === 'failed') return 'Try Face Verification Again';
    return 'Verify Face & Start Interview';
  })();

  const statusColor = verificationState === 'success'
    ? '#6ee7b7'
    : verificationState === 'failed'
      ? '#fca5a5'
      : '#cbd5e1';

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '1rem' }}>
      <div className="glass animate-fade-in" style={{ padding: '2.5rem', borderRadius: '1rem', maxWidth: '600px', width: '100%', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '1rem' }} className="gradient-text">
          Candidate Verification
        </h1>

        {error ? (
          <div style={{ color: '#fca5a5', padding: '1rem', backgroundColor: 'rgba(239, 68, 68, 0.2)', borderRadius: '0.5rem', marginBottom: '1.5rem' }}>
            {error}
          </div>
        ) : (
          <p style={{ color: '#cbd5e1', marginBottom: '1.5rem' }}>
            Confirm your camera and microphone, then verify your face before the interview begins.
          </p>
        )}

        <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', backgroundColor: '#000', borderRadius: '0.5rem', overflow: 'hidden', marginBottom: '1.25rem', border: '2px solid rgba(59,130,246,0.3)' }}>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onLoadedMetadata={(event) => setVideoSize({
              width: event.currentTarget.videoWidth || 640,
              height: event.currentTarget.videoHeight || 480
            })}
            style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
          />
          {liveDetections.filter(item => item.kind === 'restricted').map((detection, index) => {
            const videoWidth = videoSize.width;
            const videoHeight = videoSize.height;
            const [x, y, width, height] = detection.bbox;
            return <div key={`${detection.label}-${index}`} aria-hidden="true" style={{ position: 'absolute', right: `${(x / videoWidth) * 100}%`, top: `${(y / videoHeight) * 100}%`, width: `${(width / videoWidth) * 100}%`, height: `${(height / videoHeight) * 100}%`, border: '3px solid #ef4444', boxShadow: '0 0 12px #ef4444', pointerEvents: 'none' }}><span style={{ position: 'absolute', left: 0, top: 0, transform: 'translateY(-100%)', whiteSpace: 'nowrap', padding: '3px 7px', color: '#fff', backgroundColor: '#ef4444', fontSize: '0.68rem', fontWeight: 700 }}>{detection.label} {Math.round(detection.score * 100)}%</span></div>;
          })}
          {stream && faceOverlay && (
            <div aria-hidden="true" style={{ position: 'absolute', right: `${faceOverlay.right}%`, top: `${faceOverlay.top}%`, width: `${faceOverlay.width}%`, height: `${faceOverlay.height}%`, border: `3px solid ${liveStatusColor}`, borderRadius: '10px', boxShadow: `0 0 14px ${liveStatusColor}`, pointerEvents: 'none', transition: 'all .18s linear' }} />
          )}
          {stream && <div role="status" aria-live="polite" style={{ position: 'absolute', left: '50%', bottom: '8px', transform: 'translateX(-50%)', whiteSpace: 'nowrap', borderRadius: '999px', padding: '4px 10px', color: '#fff', backgroundColor: liveStatusColor, fontSize: '0.72rem', fontWeight: 700 }}>{verificationState === 'success' ? 'Face matched successfully' : liveStatus}</div>}
          {!stream && !error && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
              Opening camera...
            </div>
          )}
        </div>

        <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', justifyContent: 'center' }}>
          <span style={{ fontSize: '0.875rem', color: '#cbd5e1' }}>Microphone Level:</span>
          <div style={{ flex: 1, maxWidth: '200px', height: '8px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ height: '100%', backgroundColor: 'var(--success)', width: `${Math.min(100, (audioLevel / 128) * 100)}%`, transition: 'width 0.1s linear' }} />
          </div>
        </div>

        <div
          role="status"
          aria-live="polite"
          style={{
            color: statusColor,
            padding: '0.9rem 1rem',
            backgroundColor: verificationState === 'failed'
              ? 'rgba(239, 68, 68, 0.12)'
              : verificationState === 'success'
                ? 'rgba(16, 185, 129, 0.12)'
                : 'rgba(59, 130, 246, 0.1)',
            borderRadius: '0.5rem',
            marginBottom: '1rem',
            lineHeight: 1.5
          }}
        >
          {verificationMessage}
        </div>

        <p style={{ color: '#94a3b8', fontSize: '0.78rem', lineHeight: 1.5, marginBottom: '1.25rem' }}>
          Your camera image is used only to verify your identity for this interview. Continuous video is not recorded by this verification step.
        </p>

        <button
          className="btn-primary"
          style={{ width: '100%', opacity: (stream && !starting) ? 1 : 0.5, cursor: (stream && !starting) ? 'pointer' : 'not-allowed' }}
          disabled={!stream || starting}
          onClick={handleStart}
        >
          {startButtonLabel}
        </button>
      </div>
    </div>
  );
}
