
import { useEffect, useRef, useState } from 'react';
import { Rnnoise } from '@shiguredo/rnnoise-wasm';
import './App.css';

const FRAME_SIZE = 480;
const SAMPLE_RATE = 48000;

const MODES = [
  { name: 'Meeting', symbol: '◉' },
  { name: 'Classroom', symbol: '▤' },
  { name: 'Traffic', symbol: '↗' },
  { name: 'Fan', symbol: '≋' },
];

function rms(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

function formatDb(level) {
  return level < 0.00001
    ? '−∞ dBFS'
    : `${(20 * Math.log10(level)).toFixed(1)} dBFS`;
}

function appendAudio(a, b) {
  const result = new Float32Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

function App() {
  const [mode, setMode] = useState('Meeting');
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [inputLevel, setInputLevel] = useState('—');
  const [outputLevel, setOutputLevel] = useState('—');
  const [processingTime, setProcessingTime] = useState('—');
  const [engineStatus, setEngineStatus] = useState('Not loaded');
  const [recordings, setRecordings] = useState([]);
  const [isRecording, setIsRecording] = useState(false);

  const sessionRef = useRef(null);
  const busyRef = useRef(false);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.stop();
      }

      if (sessionRef.current) {
        const session = sessionRef.current;
        sessionRef.current = null;
        session.processor.onaudioprocess = null;

        try { session.source.disconnect(); } catch {}
        try { session.processor.disconnect(); } catch {}

        session.stream.getTracks().forEach((track) => track.stop());

        try { session.denoiseState.destroy(); } catch {}

        if (session.audioContext.state !== 'closed') {
          session.audioContext.close().catch(() => {});
        }
      }
    };
  }, []);

  async function startSession() {
    if (busyRef.current || sessionRef.current) return;

    busyRef.current = true;
    setLoading(true);
    setError('');
    setEngineStatus('Requesting microphone');

    let stream;
    let audioContext;
    let denoiseState;
    let source;
    let processor;
    let recordingDestination;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          'Microphone access requires HTTPS or localhost.'
        );
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });

      setEngineStatus('Loading RNNoise WASM');

      const rnnoise = await Rnnoise.load();
      denoiseState = rnnoise.createDenoiseState();

      audioContext = new AudioContext({
        sampleRate: SAMPLE_RATE,
      });

      await audioContext.resume();

      if (audioContext.sampleRate !== SAMPLE_RATE) {
        throw new Error(
          `Audio device uses ${audioContext.sampleRate} Hz. ` +
          'This version requires 48000 Hz.'
        );
      }

      source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      recordingDestination =
        audioContext.createMediaStreamDestination();

      const session = {
        stream,
        audioContext,
        denoiseState,
        source,
        processor,
        recordingDestination,
        pendingInput: new Float32Array(0),
        pendingOutput: new Float32Array(0),
        lastMetricsUpdate: 0,
      };

      processor.onaudioprocess = (event) => {
        const startedAt = performance.now();
        const input = event.inputBuffer.getChannelData(0);
        const output = event.outputBuffer.getChannelData(0);

        const combined = appendAudio(session.pendingInput, input);
        const completeLength =
          Math.floor(combined.length / FRAME_SIZE) * FRAME_SIZE;

        const processed = new Float32Array(completeLength);

        for (
          let offset = 0;
          offset < completeLength;
          offset += FRAME_SIZE
        ) {
          const frame = new Float32Array(
            combined.subarray(offset, offset + FRAME_SIZE)
          );

          // RNNoise processes each 480-sample frame in place.
          session.denoiseState.processFrame(frame);
          processed.set(frame, offset);
        }

        session.pendingInput = combined.slice(completeLength);

        session.pendingOutput = appendAudio(
          session.pendingOutput,
          processed
        );

        output.fill(0);

        const count = Math.min(
          output.length,
          session.pendingOutput.length
        );

        output.set(session.pendingOutput.subarray(0, count));
        session.pendingOutput =
          session.pendingOutput.slice(count);

        const finishedAt = performance.now();

        if (finishedAt - session.lastMetricsUpdate >= 250) {
          session.lastMetricsUpdate = finishedAt;
          setInputLevel(formatDb(rms(input)));
          setOutputLevel(formatDb(rms(output)));
          setProcessingTime(
            `${(finishedAt - startedAt).toFixed(2)} ms`
          );
        }
      };

      // One processed signal feeds both live playback and recording.
      source.connect(processor);
      processor.connect(audioContext.destination);
      processor.connect(recordingDestination);

      sessionRef.current = session;
      setRunning(true);
      setEngineStatus('RNNoise WASM active');
    } catch (err) {
      try { processor?.disconnect(); } catch {}
      try { source?.disconnect(); } catch {}

      stream?.getTracks().forEach((track) => track.stop());

      try { denoiseState?.destroy(); } catch {}

      if (audioContext && audioContext.state !== 'closed') {
        await audioContext.close().catch(() => {});
      }

      setRunning(false);
      setEngineStatus('Not running');
      setError(
        err?.name === 'NotAllowedError'
          ? 'Microphone permission denied. Allow access and try again.'
          : err?.message || 'Could not start audio processing.'
      );
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }

  async function stopSession() {
    const session = sessionRef.current;
    if (!session) return;

    // Finish the current recording before closing the audio context.
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }

    sessionRef.current = null;
    session.processor.onaudioprocess = null;

    try { session.source.disconnect(); } catch {}
    try { session.processor.disconnect(); } catch {}

    session.stream.getTracks().forEach((track) => track.stop());

    try { session.denoiseState.destroy(); } catch {}

    if (session.audioContext.state !== 'closed') {
      await session.audioContext.close().catch(() => {});
    }

    setRunning(false);
    setLoading(false);
    setEngineStatus('Stopped');
    setInputLevel('—');
    setOutputLevel('—');
    setProcessingTime('—');
  }

  async function toggleSession() {
    if (running) {
      await stopSession();
    } else {
      await startSession();
    }
  }

  function startRecording() {
    const stream =
      sessionRef.current?.recordingDestination?.stream;

    if (!stream) {
      setError('Start noise cancellation before recording.');
      return;
    }

    if (!window.MediaRecorder) {
      setError('Your browser does not support audio recording.');
      return;
    }

    try {
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setError('Recording failed. Please try again.');
        setIsRecording(false);
      };

      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];

        if (!chunks.length) {
          setError('No audio data was captured. Try recording again.');
          setIsRecording(false);
          return;
        }

        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type });

        if (blob.size === 0) {
          setError('The recording is empty. Please try again.');
          setIsRecording(false);
          return;
        }

        const url = URL.createObjectURL(blob);
        const extension = type.includes('mp4') ? 'm4a' : 'webm';

        setRecordings((previous) => [
          ...previous,
          {
            id: `${Date.now()}-${Math.random()}`,
            name: `ClearVoice Recording ${previous.length + 1}`,
            date: new Date().toLocaleString(),
            url,
            extension,
            size: blob.size,
          },
        ]);

        setIsRecording(false);
        setError('');
      };

      recorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setError('');
    } catch (err) {
      setError(err.message || 'Could not start recording.');
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;

    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  }

  function deleteRecording(id) {
    setRecordings((previous) => {
      const item = previous.find((recording) => recording.id === id);
      if (item) URL.revokeObjectURL(item.url);
      return previous.filter((recording) => recording.id !== id);
    });
  }

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">C</div>
          <div>
            <h2>ClearVoice</h2>
            <p>REAL-TIME AUDIO ENHANCEMENT</p>
          </div>
        </div>
        <span className="status">
          <span className="status-dot" />
          {running ? 'Processing audio' : 'Ready to start'}
        </span>
      </header>

      <section className="hero">
        <span className="eyebrow">YOUR AUDIO, REIMAGINED</span>
        <h1>Hear what <span>matters.</span></h1>
        <p className="hero-copy">
          Real-time speech noise suppression using RNNoise WebAssembly,
          processed locally in your browser.
        </p>
      </section>

      <section className="dashboard">
        <div className="panel controls">
          <div className="panel-heading">
            <div>
              <span className="section-label">01 / CONFIGURATION</span>
              <h2>Sound environment</h2>
            </div>
            <span className="headphone-icon">♫</span>
          </div>

          <p className="muted">
            Select a profile label for your session.
          </p>

          <div className="mode-grid">
            {MODES.map((item) => (
              <button
                key={item.name}
                type="button"
                className={`mode-card ${mode === item.name ? 'selected' : ''}`}
                aria-pressed={mode === item.name}
                onClick={() => setMode(item.name)}
                disabled={running || loading}
              >
                <span className="mode-symbol">{item.symbol}</span>
                <span>{item.name}</span>
                {mode === item.name && <span className="check">✓</span>}
              </button>
            ))}
          </div>

          <div className="privacy-note">
            <span>◈</span>
            <div>
              <strong>Local audio processing</strong>
              <p>
                Audio is processed in your browser. This app does not
                upload recordings to a server.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="start-button"
            onClick={toggleSession}
            disabled={loading}
          >
            <span>
              {loading
                ? 'Starting audio engine…'
                : running
                  ? 'Stop noise cancellation'
                  : 'Start noise cancellation'}
            </span>
            <span>{loading ? '…' : running ? 'Ⅱ' : '→'}</span>
          </button>

          {error && (
            <div
              role="alert"
              style={{
                marginTop: 14,
                padding: 12,
                borderRadius: 10,
                background: '#351c27',
                color: '#ffb8c5',
                fontSize: 12,
                lineHeight: 1.6,
                overflowWrap: 'anywhere',
              }}
            >
              {error}
            </div>
          )}

          <p className="demo-note">
            Use headphones to avoid feedback. Your browser must allow
            microphone access.
          </p>
        </div>

        <div className="panel monitor">
          <div className="panel-heading">
            <div>
              <span className="section-label">02 / MONITOR</span>
              <h2>Audio workspace</h2>
            </div>
            <span className="live-badge">
              {running ? 'PROCESSING' : loading ? 'STARTING' : 'STANDBY'}
            </span>
          </div>

          <div className="wave-area">
            <div className={`wave ${running ? 'animated' : ''}`}>
              {Array.from({ length: 48 }, (_, i) => (
                <span
                  key={i}
                  style={{
                    height: `${
                      12 +
                      Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.21)) * 75
                    }%`,
                  }}
                />
              ))}
            </div>
            <p>
              {running
                ? 'Microphone connected · RNNoise running'
                : 'Start a session to process microphone audio'}
            </p>
          </div>

          <div className="metric-grid">
            <div className="metric">
              <span>ACTIVE PROFILE</span>
              <strong>{mode}</strong>
              <small>Profile label only</small>
            </div>
            <div className="metric">
              <span>WASM ENGINE</span>
              <strong style={{ fontSize: 14 }}>{engineStatus}</strong>
              <small>Runtime status</small>
            </div>
            <div className="metric">
              <span>INPUT LEVEL</span>
              <strong style={{ fontSize: 15 }}>{inputLevel}</strong>
              <small>Microphone · dBFS</small>
            </div>
            <div className="metric">
              <span>OUTPUT LEVEL</span>
              <strong style={{ fontSize: 15 }}>{outputLevel}</strong>
              <small>Processed audio · dBFS</small>
            </div>
            <div className="metric">
              <span>PROCESSING TIME</span>
              <strong>{processingTime}</strong>
              <small>Per audio callback</small>
            </div>
            <div className="metric">
              <span>PROCESSING METHOD</span>
              <strong>RNNoise</strong>
              <small>WebAssembly · 48 kHz</small>
            </div>
          </div>

          <div className="workspace-footer">
            <span className="footer-dot" />
            <p>
              {running
                ? 'Audio processing active in this browser.'
                : 'Waiting for microphone permission and engine startup.'}
            </p>
          </div>
          <p style={{ color: '#8996ac', fontSize: 10, lineHeight: 1.7 }}>
            Meeting, Classroom, Traffic and Fan are profile labels; they
            do not currently change the RNNoise model. Actual clarity
            depends on your microphone and background noise.
          </p>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-heading">
          <div>
            <span className="section-label">03 / AUDIO LIBRARY</span>
            <h2>My Recordings</h2>
          </div>
          <span className="live-badge">{recordings.length} SAVED</span>
        </div>

        <p className="muted">
          Start noise cancellation, record your voice, then stop and save
          to see the processed audio here.
        </p>

        {!isRecording ? (
          <button
            className="start-button"
            type="button"
            onClick={startRecording}
            disabled={!running}
          >
            <span>Start recording</span>
            <span>●</span>
          </button>
        ) : (
          <button
            className="start-button"
            type="button"
            onClick={stopRecording}
            style={{ background: '#ffb8c5' }}
          >
            <span>Stop and save recording</span>
            <span>■</span>
          </button>
        )}

        {!running && (
          <p className="demo-note">
            Start noise cancellation before recording.
          </p>
        )}

        {recordings.length === 0 ? (
          <div
            style={{
              marginTop: 18,
              padding: 24,
              border: '1px dashed #344055',
              borderRadius: 12,
              textAlign: 'center',
              color: '#8996ac',
              fontSize: 13,
            }}
          >
            No recordings yet. Your saved recordings will appear here.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 18, marginTop: 22 }}>
            {recordings.map((recording) => (
              <div
                key={recording.id}
                style={{
                  padding: 16,
                  border: '1px solid #293249',
                  borderRadius: 12,
                  background: '#141a29',
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <strong>{recording.name}</strong>
                    <p className="muted" style={{ margin: '6px 0' }}>
                      {recording.date}
                    </p>
                    <small style={{ color: '#8996ac' }}>
                      {(recording.size / 1024).toFixed(1)} KB
                    </small>
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteRecording(recording.id)}
                    style={{
                      background: 'transparent',
                      border: '1px solid #344055',
                      color: '#ffb8c5',
                      padding: '7px 10px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      alignSelf: 'flex-start',
                    }}
                  >
                    Delete
                  </button>
                </div>

                <audio
                  controls
                  preload="metadata"
                  src={recording.url}
                  style={{ display: 'block', width: '100%', marginTop: 14 }}
                >
                  Your browser does not support audio playback.
                </audio>

                <a
                  href={recording.url}
                  download={`${recording.name}.${recording.extension}`}
                  style={{
                    display: 'inline-block',
                    marginTop: 12,
                    color: '#72f0cf',
                    fontSize: 13,
                  }}
                >
                  Download recording
                </a>
              </div>
            ))}
          </div>
        )}

        <p className="demo-note">
          Recordings remain available while this page stays open. Download
          them to keep copies after refreshing or closing the page.
        </p>
      </section>

      <footer>
        <span>CLEARVOICE © 2026</span>
        <span>LOCAL-FIRST AUDIO · BUILT FOR CLARITY</span>
      </footer>
    </main>
  );
}

export default App;
