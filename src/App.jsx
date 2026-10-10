import { useRef, useState } from 'react';
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

function formatDb(level) {
  if (level <= 0.00001) return '−∞ dBFS';
  return `${(20 * Math.log10(level)).toFixed(1)} dBFS`;
}

function rms(samples) {
  if (!samples.length) return 0;

  let sum = 0;

  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }

  return Math.sqrt(sum / samples.length);
}

function appendAudio(first, second) {
  const result = new Float32Array(first.length + second.length);
  result.set(first);
  result.set(second, first.length);
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

  const sessionRef = useRef(null);
  const busyRef = useRef(false);

  async function stopSession() {
    const session = sessionRef.current;

    if (!session) return;

    // Clear the reference first to prevent duplicate cleanup.
    sessionRef.current = null;

    if (session.processor) {
      session.processor.onaudioprocess = null;
      session.processor.disconnect();
    }

    try {
      session.source?.disconnect();
    } catch {
      // The audio source may already be disconnected.
    }

    session.stream?.getTracks().forEach((track) => track.stop());

    try {
      session.denoiseState?.destroy();
    } catch {
      // The denoising state may already have been released.
    }

    if (session.audioContext &&
        session.audioContext.state !== 'closed') {
      try {
        await session.audioContext.close();
      } catch {
        // The browser may already have closed the context.
      }
    }

    setRunning(false);
    setLoading(false);
    setEngineStatus('Stopped');
    setInputLevel('—');
    setOutputLevel('—');
    setProcessingTime('—');
  }

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

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          'Microphone access is unavailable. Open the site on localhost or HTTPS and try again.'
        );
      }

      // Request microphone access. Audio stays in this browser.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });

      setEngineStatus('Loading WebAssembly');

      // Load the real RNNoise WebAssembly engine.
      const rnnoise = await Rnnoise.load();
      denoiseState = rnnoise.createDenoiseState();

      // RNNoise expects 48 kHz audio, processed in 480-sample frames.
      audioContext = new AudioContext({
        sampleRate: SAMPLE_RATE,
      });

      await audioContext.resume();

      if (audioContext.sampleRate !== SAMPLE_RATE) {
        throw new Error(
          `This audio device is running at ${audioContext.sampleRate} Hz. ClearVoice currently requires 48000 Hz for this processing pipeline.`
        );
      }

      source = audioContext.createMediaStreamSource(stream);

      // ScriptProcessor is used for this quick prototype.
      // A production version should move processing to an AudioWorklet.
      processor = audioContext.createScriptProcessor(4096, 1, 1);

      const session = {
        stream,
        audioContext,
        denoiseState,
        source,
        processor,
        pendingInput: new Float32Array(0),
        pendingOutput: new Float32Array(0),
        lastMetricsUpdate: 0,
      };

      processor.onaudioprocess = (event) => {
        const startedAt = performance.now();

        const input = event.inputBuffer.getChannelData(0);
        const output = event.outputBuffer.getChannelData(0);

        // Preserve samples between callbacks so no RNNoise frame is cut.
        const combined = appendAudio(session.pendingInput, input);
        const completeLength =
          Math.floor(combined.length / FRAME_SIZE) * FRAME_SIZE;

        const processed = new Float32Array(completeLength);

        for (let offset = 0; offset < completeLength; offset += FRAME_SIZE) {
          const frame = new Float32Array(
            combined.subarray(offset, offset + FRAME_SIZE)
          );

          // RNNoise processes the frame in place.
          session.denoiseState.processFrame(frame);

          processed.set(frame, offset);
        }

        session.pendingInput = combined.slice(completeLength);

        // Keep processed samples queued until a complete output block
        // is available. This introduces startup buffering.
        session.pendingOutput = appendAudio(
          session.pendingOutput,
          processed
        );

        if (session.pendingOutput.length >= output.length) {
          output.set(session.pendingOutput.subarray(0, output.length));
          session.pendingOutput = session.pendingOutput.slice(output.length);
        } else {
          output.fill(0);
        }

        const finishedAt = performance.now();

        // Update React state at most about four times per second.
        if (finishedAt - session.lastMetricsUpdate >= 250) {
          session.lastMetricsUpdate = finishedAt;

          setInputLevel(formatDb(rms(input)));
          setOutputLevel(formatDb(rms(output)));

          // Processing time measures this callback's CPU work,
          // not end-to-end audio latency.
          setProcessingTime(
            `${(finishedAt - startedAt).toFixed(2)} ms`
          );
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      sessionRef.current = session;

      setRunning(true);
      setEngineStatus('RNNoise WASM active');
    } catch (err) {
      if (processor) {
        processor.onaudioprocess = null;

        try {
          processor.disconnect();
        } catch {
          // Ignore cleanup errors.
        }
      }

      try {
        source?.disconnect();
      } catch {
        // Ignore cleanup errors.
      }

      stream?.getTracks().forEach((track) => track.stop());

      try {
        denoiseState?.destroy();
      } catch {
        // Ignore cleanup errors.
      }

      if (audioContext && audioContext.state !== 'closed') {
        try {
          await audioContext.close();
        } catch {
          // Ignore cleanup errors.
        }
      }

      setRunning(false);
      setEngineStatus('Not running');
      setError(
        err?.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow microphone access in your browser and try again.'
          : err?.message || 'Could not start audio processing.'
      );
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }

  async function handleSessionButton() {
    if (sessionRef.current) {
      await stopSession();
    } else {
      await startSession();
    }
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
        <h1>
          Hear what <span>matters.</span>
        </h1>
        <p className="hero-copy">
          Real-time speech-focused noise suppression using
          WebAssembly, running locally in your browser.
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
                className={`mode-card ${
                  mode === item.name ? 'selected' : ''
                }`}
                aria-pressed={mode === item.name}
                onClick={() => setMode(item.name)}
                disabled={running || loading}
              >
                <span className="mode-symbol">{item.symbol}</span>
                <span>{item.name}</span>
                {mode === item.name && (
                  <span className="check">✓</span>
                )}
              </button>
            ))}
          </div>

          <div className="privacy-note">
            <span>◈</span>
            <div>
              <strong>Local audio processing</strong>
              <p>
                Microphone audio is processed in your browser.
                This app does not upload your audio to a server.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="start-button"
            onClick={handleSessionButton}
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
            Use headphones to avoid audio feedback. The first output
            block may be silent while the audio buffer fills.
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
                      Math.abs(
                        Math.sin(i * 0.7) * Math.cos(i * 0.21)
                      ) *
                        75
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
              <small>Microphone level · dBFS</small>
            </div>

            <div className="metric">
              <span>OUTPUT LEVEL</span>
              <strong style={{ fontSize: 15 }}>{outputLevel}</strong>
              <small>Processed output · dBFS</small>
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

          <p
            style={{
              color: '#8996ac',
              fontSize: 10,
              lineHeight: 1.7,
              marginTop: 14,
            }}
          >
            Note: the displayed levels are not a measured noise-reduction
            score. Meeting, Classroom, Traffic and Fan are profile labels;
            they do not currently change the RNNoise model.
          </p>
        </div>
      </section>

      <footer>
        <span>CLEARVOICE © 2026</span>
        <span>LOCAL-FIRST AUDIO · BUILT FOR CLARITY</span>
      </footer>
    </main>
  );
}

export default App;