'use client';

import { use, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DeviceCheckPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let audioContext: AudioContext;
    let analyser: AnalyserNode;
    let microphone: MediaStreamAudioSourceNode;
    let animationFrame: number;

    const requestPermissions = async () => {
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        setStream(mediaStream);
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
        }

        audioContext = new AudioContext();
        analyser = audioContext.createAnalyser();
        microphone = audioContext.createMediaStreamSource(mediaStream);
        microphone.connect(analyser);
        analyser.fftSize = 256;
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const checkAudioLevel = () => {
          analyser.getByteFrequencyData(dataArray);
          const sum = dataArray.reduce((a, b) => a + b, 0);
          const average = sum / dataArray.length;
          setAudioLevel(average);
          animationFrame = requestAnimationFrame(checkAudioLevel);
        };
        checkAudioLevel();
      } catch (err) {
        setError('Camera and microphone access is required to proceed. Please check your permissions.');
      }
    };

    requestPermissions();

    return () => {
      if (stream) stream.getTracks().forEach(track => track.stop());
      if (audioContext) audioContext.close();
      if (animationFrame) cancelAnimationFrame(animationFrame);
    };
  }, [token]);

  const handleStart = async () => {
    if (!stream) return;
    setStarting(true);

    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      alert('Session not found. Please go back to the invitation link and try again.');
      setStarting(false);
      return;
    }

    try {
      const res = await fetch(`/api/sessions/${sessionId}/start`, { method: 'POST' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server error (${res.status})`);
      }
      router.push(`/interview/${token}/session`);
    } catch (err: any) {
      alert(err.message || 'Failed to start session. Please check your connection.');
      setStarting(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '1rem' }}>
      <div className="glass animate-fade-in" style={{ padding: '2.5rem', borderRadius: '1rem', maxWidth: '600px', width: '100%', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '1.5rem' }} className="gradient-text">
          Device Check
        </h1>

        {error ? (
          <div style={{ color: '#fca5a5', padding: '1rem', backgroundColor: 'rgba(239, 68, 68, 0.2)', borderRadius: '0.5rem', marginBottom: '1.5rem' }}>
            {error}
          </div>
        ) : (
          <p style={{ color: '#cbd5e1', marginBottom: '2rem' }}>Please ensure your camera and microphone are working before you begin.</p>
        )}

        <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', backgroundColor: '#000', borderRadius: '0.5rem', overflow: 'hidden', marginBottom: '1.5rem' }}>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
          {!stream && !error && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
              Requesting permissions...
            </div>
          )}
        </div>

        <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', justifyContent: 'center' }}>
          <span style={{ fontSize: '0.875rem', color: '#cbd5e1' }}>Microphone Level:</span>
          <div style={{ flex: 1, maxWidth: '200px', height: '8px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ height: '100%', backgroundColor: 'var(--success)', width: `${Math.min(100, (audioLevel / 128) * 100)}%`, transition: 'width 0.1s linear' }} />
          </div>
        </div>


        <button
          className="btn-primary"
          style={{ width: '100%', opacity: (stream && !starting) ? 1 : 0.5, cursor: (stream && !starting) ? 'pointer' : 'not-allowed' }}
          disabled={!stream || starting}
          onClick={handleStart}
        >
          {starting ? 'Starting Interview…' : 'My Devices Work - Start Interview'}
        </button>
      </div>

    </div>
  );
}
