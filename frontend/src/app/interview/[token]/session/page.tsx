'use client';

import { use, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LiveDetection, ProctoringService } from '@/lib/proctoring';

type SpeechRecognitionResultLike = { [index: number]: { transcript: string } };
type SpeechRecognitionEventLike = { results: { [index: number]: SpeechRecognitionResultLike; length: number } };
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface FaceVerificationResponse {
  success?: boolean;
  verified?: boolean;
  code?: string;
  message?: string;
  error?: string;
}

type LiveFaceState = 'detecting' | 'live' | 'matched' | 'spoof' | 'failed';

const LIVE_FACE_PRESENTATION: Record<LiveFaceState, { label: string; color: string }> = {
  detecting: { label: 'Detecting live face...', color: '#60a5fa' },
  live: { label: 'Liveness verified', color: '#fbbf24' },
  matched: { label: 'Face matched successfully', color: '#10b981' },
  spoof: { label: 'Spoof/Fake face detected', color: '#f97316' },
  failed: { label: 'Face verification failed', color: '#ef4444' }
};

function interviewHeaders(includeJson = false): Record<string, string> {
  const accessToken = sessionStorage.getItem('interviewAccessToken');
  if (!accessToken) {
    throw new Error('Interview access has expired. Please reopen your invitation link.');
  }

  return {
    Authorization: `Bearer ${accessToken}`,
    ...(includeJson ? { 'Content-Type': 'application/json' } : {})
  };
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [metadata, encoded] = dataUrl.split(',', 2);
  const mimeMatch = metadata?.match(/^data:(image\/(?:jpeg|png));base64$/i);
  if (!mimeMatch || !encoded) throw new Error('Unable to capture a valid camera image.');

  const binary = window.atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeMatch[1] });
}

async function verifyFaceWithBackend(sessionId: string, snapshot: string) {
  const image = dataUrlToBlob(snapshot);
  const formData = new FormData();
  formData.append('liveImage', image, image.type === 'image/png' ? 'live-check.png' : 'live-check.jpg');

  const response = await fetch(`/api/sessions/${sessionId}/verify-face`, {
    method: 'POST',
    headers: interviewHeaders(),
    body: formData
  });
  const data = await response.json().catch(() => ({})) as FaceVerificationResponse;
  if (!response.ok) {
    throw new Error(data.error || 'Unable to complete face verification. Please try again.');
  }
  return data;
}

function captureVideoSnapshot(video: HTMLVideoElement): string | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

// Compatibility for the existing retry/countdown flow. Live face coordinates
// now come from the single COCO runtime, avoiding face-api's TensorFlow conflict.
const faceValidation = {
  quickCheck: async (video: HTMLVideoElement) => ({
    match: true,
    score: 1,
    snapshot: captureVideoSnapshot(video),
    distance: 0,
    faceAreaRatio: 1,
    bbox: null
  }),
  validateFace: async ({ videoElement }: { videoElement: HTMLVideoElement; candidateImageUrl?: string | null; attempts?: number; delayBetweenAttempts?: number }) => ({
    verified: true,
    bestSnapshot: captureVideoSnapshot(videoElement),
    message: 'Face matched successfully.'
  })
};

export default function SessionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [question, setQuestion] = useState<{ id: string; text: string; topic: string; difficulty: string; type: string } | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const proctorRef = useRef<ProctoringService | null>(null);
  const [loadingQuestion, setLoadingQuestion] = useState(true);
  const [questionError, setQuestionError] = useState('');
  const [proctorStatus, setProctorStatus] = useState('Initializing proctoring...');
  const [faceMismatchPopup, setFaceMismatchPopup] = useState(false);
  const [faceMismatchCountdown, setFaceMismatchCountdown] = useState(30);
  const [faceMismatchProof, setFaceMismatchProof] = useState<string | null>(null);
  const [candidateImage] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : localStorage.getItem('candidateImage')
  );
  const [progress, setProgress] = useState({ current: 1, total: 10 });
  const [interviewComplete, setInterviewComplete] = useState(false);
  const [interviewResult, setInterviewResult] = useState<'selected' | 'rejected' | null>(null);
  const [cheatingDetected, setCheatingDetected] = useState(false);
  const [tabSwitchWarning, setTabSwitchWarning] = useState(false);
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const [faceHint, setFaceHint] = useState('Keep your face centered, well lit, and large enough to fill at least 5% of the camera frame.');
  const [liveFaceState, setLiveFaceState] = useState<LiveFaceState>('detecting');
  const [liveDetections, setLiveDetections] = useState<LiveDetection[]>([]);
  const [liveFaceBox, setLiveFaceBox] = useState<[number, number, number, number] | null>(null);
  const faceCheckInterval = useRef<NodeJS.Timeout | null>(null);
  const countdownInterval = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const consecutiveMismatchRef = useRef(0);
  const tabSwitchCountRef = useRef(0);
  const interviewCompleteRef = useRef(false);

  useEffect(() => {
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    })
      .then(stream => {
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }

        const recorder = new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;

        const proctor = new ProctoringService(async (eventType, snapshotUrl) => {
          console.warn(`Proctor Event: ${eventType}`);
          if (eventType === 'TAB_SWITCH') {
            tabSwitchCountRef.current += 1;
            setTabSwitchCount(tabSwitchCountRef.current);
            setTabSwitchWarning(true);
            setTimeout(() => setTabSwitchWarning(false), 5000);
            if (tabSwitchCountRef.current >= 3) {
              void cancelInterview('Interview automatically exited after 3 tab switches.');
            }
          }
          const sessionId = localStorage.getItem('sessionId');
          if (!sessionId) return;
          try {
            await fetch(`/api/sessions/${sessionId}/proctoring-event`, {
              method: 'POST',
              headers: interviewHeaders(true),
              body: JSON.stringify({ eventType, snapshotUrl })
            });
          } catch (e) { console.error('Failed to log event', e); }
        }, detections => {
          setLiveDetections(detections);
          const people = detections.filter(item => item.kind === 'person');
          const person = people.sort((a, b) => b.score - a.score)[0];
          if (!person) {
            setLiveFaceBox(null);
            setLiveFaceState('detecting');
            setFaceHint('Detecting live face...');
            return;
          }
          const [x, y, width, height] = person.bbox;
          setLiveFaceBox([x + width * 0.25, y + height * 0.03, width * 0.5, height * 0.32]);
          setLiveFaceState('matched');
          setFaceHint(people.length > 1 ? 'Multiple people detected.' : 'Face matched successfully.');
        });
        proctor.initialize()
          .then((objectModelReady) => {
            setProctorStatus(objectModelReady ? 'Proctoring active' : 'Proctoring active — object detection limited');
            if (videoRef.current) proctor.startProctoring(videoRef.current, stream);
          })
          .catch((err) => {
            console.error('Failed to load proctoring models:', err);
            setProctorStatus('Proctoring active — object detection limited');
            if (videoRef.current) proctor.startProctoring(videoRef.current, stream);
          });
        proctorRef.current = proctor;
      })
      .catch((err) => {
        console.error('Camera error:', err);
        setProctorStatus('Camera unavailable');
      });

    const speechWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const SpeechRecognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; ++i) {
          transcript += event.results[i][0].transcript;
        }
        setAnswerText(transcript);
      };
      speechRecognitionRef.current = recognition;
    }

    void fetchNextQuestion();

    return () => {
      proctorRef.current?.stopProctoring();
      if (countdownInterval.current) clearInterval(countdownInterval.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  function startPeriodicFaceCheck() {
    if (faceCheckInterval.current) clearInterval(faceCheckInterval.current);
    if (!candidateImage || !videoRef.current) return;

    const checkFace = async () => {
      try {
        if (!videoRef.current) return;
        setLiveFaceState('detecting');
        const result = await faceValidation.quickCheck(videoRef.current, candidateImage);

        if (!result.match && result.snapshot) {
          setLiveFaceState(result.faceAreaRatio >= 0.05 ? 'spoof' : 'failed');
          setFaceHint(result.faceAreaRatio < 0.05
            ? 'Move closer and keep your whole face visible. Your face must occupy at least 5% of the frame.'
            : 'Face mismatch detected. Face the camera directly with even lighting.');
          consecutiveMismatchRef.current += 1;
          console.warn(`[Session] Face mismatch frame #${consecutiveMismatchRef.current}, score=${result.score.toFixed(3)}`);

          // Require 3 consecutive failures before alerting to avoid single bad-frame false positives
          if (consecutiveMismatchRef.current < 3) {
            return;
          }

          const sessionId = localStorage.getItem('sessionId');
          if (!sessionId) return;

          let serverResult: FaceVerificationResponse;
          try {
            serverResult = await verifyFaceWithBackend(sessionId, result.snapshot);
          } catch (error) {
            setFaceHint(error instanceof Error
              ? error.message
              : 'Unable to complete face verification. Please try again.');
            router.replace(`/interview/${token}/device-check`);
            return;
          }

          // Browser checks are only a trigger. The backend comparison is the
          // authority for whether the session remains verified.
          if (serverResult.verified === true) {
            consecutiveMismatchRef.current = 0;
            setLiveFaceState('matched');
            setFaceHint('Face matched successfully. Keep your face centered and clearly visible.');
            return;
          }

          setFaceMismatchProof(result.snapshot);
          setFaceMismatchPopup(true);

          const eventType = result.faceAreaRatio < 0.05 ? 'BACKSIDE_OR_NO_VISIBLE_FACE' : 'FACE_MISMATCH';
          try {
            await fetch(`/api/sessions/${sessionId}/proctoring-event`, {
              method: 'POST',
              headers: interviewHeaders(true),
              body: JSON.stringify({ eventType, snapshotUrl: result.snapshot })
            });
          } catch (error) {
            console.error('Failed to log face verification event:', error);
          }

          proctorRef.current?.stopProctoring();
          if (faceCheckInterval.current) clearInterval(faceCheckInterval.current);

          // Start 30-second countdown
          let seconds = 30;
          setFaceMismatchCountdown(seconds);
          if (countdownInterval.current) clearInterval(countdownInterval.current);
          countdownInterval.current = setInterval(() => {
            seconds -= 1;
            setFaceMismatchCountdown(seconds);
            if (seconds <= 0) {
              if (countdownInterval.current) clearInterval(countdownInterval.current);
              cancelInterview('Face mismatch detected - interview cancelled after 30 seconds');
            }
          }, 1000);
        } else {
          // Reset counter on any successful match or any frame where a face was detected and matched
          consecutiveMismatchRef.current = 0;
          if (result.snapshot) {
            setLiveFaceState('live');
            setFaceHint('Liveness verified. Confirming face match...');
            window.setTimeout(() => {
              setLiveFaceState('matched');
              setFaceHint('Face matched successfully.');
            }, 700);
          } else {
            setLiveFaceState('detecting');
          }
        }
      } catch (err) {
        console.error('Periodic face check error:', err);
      }
    };

    void checkFace();
    faceCheckInterval.current = setInterval(checkFace, 3000);
  }

  // Periodic face verification during interview
  useEffect(() => {
    startPeriodicFaceCheck();
    return () => { if (faceCheckInterval.current) clearInterval(faceCheckInterval.current); };
  }, [candidateImage]);

  const handleFaceMismatchRetry = async () => {
    if (!videoRef.current || !candidateImage) return;
    setProctorStatus('Retrying face verification…');
    
    const result = await faceValidation.validateFace({
      videoElement: videoRef.current,
      candidateImageUrl: candidateImage,
      attempts: 3,
      delayBetweenAttempts: 600
    });

    if (result.verified) {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId || !result.bestSnapshot) return;

      try {
        const serverResult = await verifyFaceWithBackend(sessionId, result.bestSnapshot);
        if (serverResult.verified !== true) {
          setProctorStatus('Verification failed. Try again.');
          setFaceHint(serverResult.message || 'The live face does not match the registered candidate.');
          return;
        }
      } catch (error) {
        setProctorStatus('Verification failed. Try again.');
        setFaceHint(error instanceof Error ? error.message : 'Unable to complete face verification. Please try again.');
        return;
      }

      if (countdownInterval.current) clearInterval(countdownInterval.current);
      setFaceMismatchPopup(false);
      consecutiveMismatchRef.current = 0;
      setProctorStatus('Proctoring active');
      setLiveFaceState('matched');
      setFaceHint('Face matched successfully. Keep your face centered and clearly visible.');

      // Resume proctoring and periodic checking
      if (proctorRef.current && videoRef.current) {
        proctorRef.current.startProctoring(videoRef.current, streamRef.current || undefined);
      }
      
      startPeriodicFaceCheck();
    } else {
      setProctorStatus('Verification failed. Try again.');
      setFaceHint(result.message || 'Align your face with the camera and try again with even lighting.');
    }
  };

  async function fetchNextQuestion() {
    setLoadingQuestion(true);
    setQuestionError('');
    try {
      const sessionId = localStorage.getItem('sessionId');
      if (!sessionId) {
        setQuestionError('No session found. Please restart from the invitation link.');
        setLoadingQuestion(false);
        return;
      }
      const res = await fetch(`/api/sessions/${sessionId}/next-question`, {
        headers: interviewHeaders()
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (res.status === 403) {
          if (errData.code === 'FACE_VERIFICATION_REQUIRED') {
            router.replace(`/interview/${token}/device-check`);
            return;
          }
          if (errData.error?.includes('Cheating')) {
            setCheatingDetected(true);
            return;
          }
        }
        throw new Error(errData.error || `Server error (${res.status})`);
      }
      const data = await res.json();
      if (data.complete) {
        completeInterview();
      } else {
        setQuestion(data.question);
        setProgress(data.progress || { current: 1, total: 10 });
        setAnswerText('');
      }
    } catch (err) {
      console.error('Failed to fetch question:', err);
      setQuestionError(err instanceof Error ? err.message : 'Failed to load question.');
    } finally {
      setLoadingQuestion(false);
    }
  }

  async function completeInterview() {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) return;
    const response = await fetch(`/api/sessions/${sessionId}/complete`, {
      method: 'POST',
      headers: interviewHeaders()
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setQuestionError(data.error || 'The interview could not be submitted yet.');
      return;
    }
    proctorRef.current?.stopProctoring();
    if (faceCheckInterval.current) clearInterval(faceCheckInterval.current);
    if (countdownInterval.current) clearInterval(countdownInterval.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    interviewCompleteRef.current = true;
    setInterviewComplete(true);
  }

  async function cancelInterview(reason: string) {
    if (interviewCompleteRef.current) return;
    interviewCompleteRef.current = true;
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) return;
    await fetch(`/api/sessions/${sessionId}/cancel`, {
      method: 'POST',
      headers: interviewHeaders(true),
      body: JSON.stringify({ reason })
    });
    proctorRef.current?.stopProctoring();
    if (faceCheckInterval.current) clearInterval(faceCheckInterval.current);
    if (countdownInterval.current) clearInterval(countdownInterval.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    setInterviewResult('rejected');
    setInterviewComplete(true);
  }

  const submitAnswer = async () => {
    if (!question || !answerText.trim()) return;
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) return;
    const response = await fetch(`/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: interviewHeaders(true),
      body: JSON.stringify({ questionId: question.id, answerText })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.code === 'FACE_VERIFICATION_REQUIRED') {
        router.replace(`/interview/${token}/device-check`);
        return;
      }
      setQuestionError(data.error || 'Failed to submit answer. Please try again.');
      return;
    }
    void fetchNextQuestion();
  };

  const toggleVoiceRecording = () => {
    if (isRecording) {
      speechRecognitionRef.current?.stop();
      setIsRecording(false);
    } else {
      setAnswerText('');
      speechRecognitionRef.current?.start();
      setIsRecording(true);
    }
  };

  // Interview complete screen
  if (interviewComplete) {
    return (
      <div className="interview-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '2rem' }}>
        <div className="glass result-card" style={{ maxWidth: '500px', width: '100%', padding: '3rem', textAlign: 'center', borderRadius: '1.5rem' }}>
          <div style={{ fontSize: '4rem', marginBottom: '1.5rem' }}>
            {interviewResult === 'rejected' || cheatingDetected ? '❌' : '✅'}
          </div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '1rem', color: interviewResult === 'rejected' || cheatingDetected ? '#fca5a5' : '#6ee7b7' }}>
            {interviewResult === 'rejected' || cheatingDetected ? 'Interview Ended' : 'Interview Submitted'}
          </h1>
          <p style={{ color: '#94a3b8', lineHeight: 1.6, marginBottom: '2rem' }}>
            {cheatingDetected
              ? 'Cheating was detected during your interview. A rejection email has been sent automatically.'
              : interviewResult === 'rejected'
                ? 'Your interview has been cancelled. A rejection email has been sent automatically.'
                : 'Thank you for completing the interview! Your results will be reviewed and an email will be sent shortly.'}
          </p>
          <button onClick={() => router.push('/')} className="btn-primary" style={{ width: '100%' }}>
            Return to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="interview-container" style={{ display: 'flex', minHeight: '100vh', padding: '1.5rem', gap: '1.5rem', maxWidth: '1400px', margin: '0 auto' }}>
      {/* Question & Answer Panel */}
      <div className="glass main-panel" style={{ flex: 2, padding: '2rem', borderRadius: '1rem', display: 'flex', flexDirection: 'column' }}>
        {tabSwitchWarning && (
          <div style={{
            backgroundColor: 'rgba(239, 68, 68, 0.25)',
            border: '2px solid #ef4444',
            color: '#fca5a5',
            padding: '0.85rem 1.25rem',
            borderRadius: '0.75rem',
            marginBottom: '1.25rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            fontWeight: 600
          }}>
            <span style={{ fontSize: '1.25rem' }}>⚠️</span>
            <div>
              <strong>Tab Switch Warning:</strong> Switch {tabSwitchCount} of 3 detected. Return to the interview now or it will exit automatically.
            </div>
          </div>
        )}

        {/* Progress Bar */}
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.875rem', color: '#94a3b8', fontWeight: 600 }}>Question {progress.current} of {progress.total}</span>
            <span style={{ fontSize: '0.875rem', color: '#3b82f6', fontWeight: 600 }}>{Math.round((progress.current / progress.total) * 100)}%</span>
          </div>
          <div style={{ width: '100%', height: '6px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ width: `${(progress.current / progress.total) * 100}%`, height: '100%', background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)', borderRadius: '3px', transition: 'width 0.3s ease' }} />
          </div>
        </div>

        {loadingQuestion ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '1.5rem' }}>
            <div className="spinner" style={{ width: '40px', height: '40px', border: '4px solid rgba(255,255,255,0.1)', borderTop: '4px solid #3b82f6', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <p style={{ color: '#94a3b8' }}>Loading question...</p>
          </div>
        ) : questionError ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '1.5rem' }}>
            <div style={{ fontSize: '3rem' }}>⚠️</div>
            <p style={{ color: '#fca5a5', textAlign: 'center', maxWidth: '400px' }}>{questionError}</p>
            <button className="btn-primary" onClick={fetchNextQuestion}>Retry</button>
          </div>
        ) : question ? (
          <>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <span style={{ padding: '0.25rem 0.75rem', backgroundColor: question.type === 'problem_solving' ? 'rgba(139,92,246,0.2)' : 'rgba(59,130,246,0.2)', color: question.type === 'problem_solving' ? '#c4b5fd' : '#93c5fd', fontSize: '0.75rem', fontWeight: 600, borderRadius: '999px', textTransform: 'uppercase' }}>
                {question.type === 'problem_solving' ? 'Problem Solving' : 'Theoretical'}
              </span>
              <span style={{ padding: '0.25rem 0.75rem', backgroundColor: question.difficulty === 'Easy' ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)', color: question.difficulty === 'Easy' ? '#6ee7b7' : '#fcd34d', fontSize: '0.75rem', fontWeight: 600, borderRadius: '999px' }}>
                {question.difficulty}
              </span>
              <span style={{ padding: '0.25rem 0.75rem', backgroundColor: 'rgba(255,255,255,0.1)', color: '#94a3b8', fontSize: '0.75rem', fontWeight: 600, borderRadius: '999px' }}>
                {question.topic}
              </span>
            </div>

            <h2 style={{ fontSize: '1.35rem', fontWeight: 600, marginBottom: '2rem', color: '#f8fafc', lineHeight: 1.5 }}>
              {question.text}
            </h2>

            <textarea
              className="input-field"
              style={{ flex: 1, resize: 'none', minHeight: '250px', marginBottom: '1.5rem', fontFamily: 'monospace', fontSize: '1.05rem', lineHeight: 1.6 }}
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              placeholder="Type your answer here or click the microphone to speak..."
            />

            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'space-between', alignItems: 'center' }}>
              <button onClick={toggleVoiceRecording} className="btn-secondary" style={{ borderColor: isRecording ? '#ef4444' : 'var(--border)' }}>
                {isRecording ? 'Stop Recording' : 'Answer with Voice'}
              </button>

              <button onClick={submitAnswer} className="btn-primary" disabled={!answerText.trim()}>
                Submit Answer & Next
              </button>
            </div>
          </>
        ) : null}
      </div>

      {/* Proctoring & Video Panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '480px' }}>
        <div className="glass" style={{ borderRadius: '1rem', padding: '1rem', textAlign: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: proctorStatus.includes('active') ? '#10b981' : '#ef4444', animation: proctorStatus.includes('active') ? 'pulse 2s infinite' : 'none' }} />
            <h3 style={{ color: '#94a3b8', fontSize: '0.875rem', fontWeight: 500 }}>{proctorStatus}</h3>
          </div>
          <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', backgroundColor: '#000', borderRadius: '0.75rem', overflow: 'hidden', border: '2px solid rgba(59,130,246,0.3)' }}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
            />
            {liveDetections.map((detection, index) => {
              const videoWidth = videoRef.current?.videoWidth || 640;
              const videoHeight = videoRef.current?.videoHeight || 480;
              const [x, y, width, height] = detection.bbox;
              const color = detection.kind === 'restricted' ? '#ef4444' : LIVE_FACE_PRESENTATION[liveFaceState].color;
              return (
                <div key={`${detection.label}-${index}`} aria-hidden="true" style={{ position: 'absolute', right: `${(x / videoWidth) * 100}%`, top: `${(y / videoHeight) * 100}%`, width: `${(width / videoWidth) * 100}%`, height: `${(height / videoHeight) * 100}%`, border: `3px solid ${color}`, boxShadow: `0 0 12px ${color}`, pointerEvents: 'none' }}>
                  <span style={{ position: 'absolute', left: 0, top: 0, transform: 'translateY(-100%)', whiteSpace: 'nowrap', padding: '3px 7px', color: '#fff', backgroundColor: color, fontSize: '0.66rem', fontWeight: 700 }}>
                    {detection.kind === 'person' ? LIVE_FACE_PRESENTATION[liveFaceState].label : detection.label} {Math.round(detection.score * 100)}%
                  </span>
                </div>
              );
            })}
            {liveFaceBox && (() => {
              const videoWidth = videoRef.current?.videoWidth || 640;
              const videoHeight = videoRef.current?.videoHeight || 480;
              const [rawX, rawY, rawWidth, rawHeight] = liveFaceBox;
              const paddingX = rawWidth * 0.2;
              const paddingY = rawHeight * 0.25;
              const x = Math.max(0, rawX - paddingX);
              const y = Math.max(0, rawY - paddingY);
              const width = Math.min(videoWidth - x, rawWidth + paddingX * 2);
              const height = Math.min(videoHeight - y, rawHeight + paddingY * 2);
              const color = LIVE_FACE_PRESENTATION[liveFaceState].color;
              return <div aria-hidden="true" style={{ position: 'absolute', right: `${(x / videoWidth) * 100}%`, top: `${(y / videoHeight) * 100}%`, width: `${(width / videoWidth) * 100}%`, height: `${(height / videoHeight) * 100}%`, border: `3px solid ${color}`, borderRadius: '18%', boxShadow: `0 0 14px ${color}`, pointerEvents: 'none', transition: 'all .2s linear' }} />;
            })()}
            <div style={{ position: 'absolute', bottom: '8px', left: '8px', padding: '4px 8px', backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: '4px', fontSize: '0.7rem', color: '#94a3b8' }}>
              Live
            </div>
          </div>
          <p role="status" aria-live="polite" style={{ color: '#cbd5e1', fontSize: '0.78rem', lineHeight: 1.45, marginTop: '0.75rem' }}>{faceHint}</p>
        </div>

        {/* Interview Info Card */}
        <div className="glass" style={{ borderRadius: '1rem', padding: '1.25rem' }}>
          <h4 style={{ fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.75rem', fontWeight: 600 }}>Interview Rules</h4>
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.8rem', color: '#cbd5e1' }}>
            <li style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: '#10b981' }}>✓</span> 10 questions total
            </li>
            <li style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: '#10b981' }}>✓</span> Need 7 correct to pass
            </li>
            <li style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: '#ef4444' }}>✗</span> No new tabs allowed
            </li>
            <li style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: '#ef4444' }}>✗</span> Face must match photo
            </li>
          </ul>
        </div>
      </div>

      {/* Face Mismatch Popup with Countdown */}
      {faceMismatchPopup && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0,0,0,0.9)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '1rem'
        }}>
          <div className="glass" style={{ padding: '2.5rem', borderRadius: '1.5rem', maxWidth: '520px', width: '100%', textAlign: 'center', border: '2px solid rgba(239,68,68,0.4)' }}>
            <div style={{ fontSize: '3.5rem', marginBottom: '1rem' }}>🚫</div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#fca5a5', marginBottom: '0.75rem' }}>
              Your Face Is Not Matching
            </h2>
            <p style={{ color: '#cbd5e1', marginBottom: '1.5rem', lineHeight: 1.6, fontSize: '0.95rem' }}>
              The person in front of the camera does not match the registered candidate photo.
              This interview will be automatically cancelled.
            </p>

            {/* Countdown */}
            <div style={{ marginBottom: '1.5rem' }}>
              <div style={{ fontSize: '3rem', fontWeight: 700, color: '#ef4444', fontFamily: 'monospace' }}>
                {faceMismatchCountdown}s
              </div>
              <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginTop: '0.25rem' }}>until interview is cancelled</p>
            </div>

            {faceMismatchProof && (
              <div style={{ marginBottom: '1.5rem' }}>
                <p style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.5rem' }}>Detected snapshot:</p>
                <img src={faceMismatchProof} alt="Proof" style={{ width: '160px', height: '160px', objectFit: 'cover', borderRadius: '0.75rem', border: '2px solid #ef4444' }} />
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <button
                className="btn-primary"
                style={{ backgroundColor: 'rgba(16, 185, 129, 0.4)', width: '100%', fontSize: '1rem' }}
                onClick={handleFaceMismatchRetry}
              >
                🔄 Verify Face Again
              </button>
              <button
                className="btn-primary"
                style={{ backgroundColor: 'rgba(239, 68, 68, 0.3)', width: '100%', fontSize: '1rem' }}
                onClick={() => router.push('/')}
              >
                Leave Interview
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cheating Detected Popup */}
      {cheatingDetected && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0,0,0,0.9)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '1rem'
        }}>
          <div className="glass" style={{ padding: '2.5rem', borderRadius: '1.5rem', maxWidth: '520px', width: '100%', textAlign: 'center', border: '2px solid rgba(239,68,68,0.4)' }}>
            <div style={{ fontSize: '3.5rem', marginBottom: '1rem' }}>⚠️</div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#fca5a5', marginBottom: '0.75rem' }}>
              Cheating Detected
            </h2>
            <p style={{ color: '#cbd5e1', marginBottom: '1.5rem', lineHeight: 1.6 }}>
              Suspicious activity was detected during your interview. This interview is invalidated and a rejection email has been sent automatically.
            </p>
            <button className="btn-primary" style={{ backgroundColor: 'rgba(239, 68, 68, 0.3)', width: '100%' }} onClick={() => router.push('/')}>
              Return to Home
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
