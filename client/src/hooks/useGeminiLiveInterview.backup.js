import { useRef, useState } from "react";
import { updateTranscriptState } from "../utils/transcriptUtils";
import { connectGeminiLive } from "../services/geminiService";
import { API_URL } from "../config/geminiConfig";
import { toBase64, floatToPcm16, resample } from "../utils/audioUtils";

export function useGeminiLiveInterview() {
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState("Not connected");
  const [error, setError] = useState("");
  const [audioLevel, setAudioLevel] = useState(0);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);

  const sessionRef = useRef(null);
  const audioContextRef = useRef(null);
  const micStreamRef = useRef(null);
  const micSourceRef = useRef(null);
  const processorRef = useRef(null);
  const micMuteGainRef = useRef(null);
  const outputAnalyserRef = useRef(null);
  const outputGainRef = useRef(null);
  const animationFrameRef = useRef(null);

  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  const connectedRef = useRef(false);
  const outputTextRef = useRef("");
  const inputTextRef = useRef("");
  const nextPlayTimeRef = useRef(0);

  function addMessage(role, text, append = true) {
    if (!text?.trim()) return;

    setMessages((previous) =>
      updateTranscriptState(previous, role, append ? text : text),
    );
  }

  function monitorAudio() {
    const analyser = outputAnalyserRef.current;
    if (!analyser) return;

    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      if (!outputAnalyserRef.current) return;

      analyser.getByteFrequencyData(data);
      const average = data.reduce((sum, value) => sum + value, 0) / data.length;

      setAudioLevel(Math.min(1, average / 100));
      animationFrameRef.current = requestAnimationFrame(tick);
    };

    tick();
  }

  async function start() {
    if (startingRef.current || connectedRef.current) return;

    startingRef.current = true;
    stoppingRef.current = false;
    setError("");
    setMessages([]);
    setStatus("Connecting to Gemini Live...");

    try {
      const tokenResponse = await fetch(`${API_URL}/api/voice/session`, {
        method: "POST",
      });
      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || !tokenData.token) {
        throw new Error(tokenData.message || "Gemini Live token nahi mila.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if (stoppingRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      micStreamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      await audioContext.resume();

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      outputAnalyserRef.current = analyser;

      const outputGain = audioContext.createGain();
      outputGain.gain.value = 1;
      outputGainRef.current = outputGain;

      analyser.connect(outputGain);
      outputGain.connect(audioContext.destination);

      // Mic processor ko active rakhein, lekin mic ko speakers par na bajayein.
      const micMuteGain = audioContext.createGain();
      micMuteGain.gain.value = 0;
      micMuteGainRef.current = micMuteGain;
      micMuteGain.connect(audioContext.destination);

      const session = await connectGeminiLive(tokenData.token, {
        onopen: () => {
          if (stoppingRef.current) return;
          connectedRef.current = true;
          setStatus("Connected — you can speak");
        },

        onmessage: (message) => {
          if (stoppingRef.current) return;

          const content = message.serverContent;
          if (!content) return;

          // Candidate transcript
          const incoming = content.inputTranscription?.text?.trim();

          if (incoming) {
            const current = inputTextRef.current;

            if (!current) {
              inputTextRef.current = incoming;
            } else if (incoming.startsWith(current)) {
              inputTextRef.current = incoming;
            } else if (!current.startsWith(incoming)) {
              inputTextRef.current = `${current} ${incoming}`.trim();
            }

            setMessages((previous) =>
              updateTranscriptState(
                previous,
                "Candidate",
                inputTextRef.current,
              ),
            );
          }

          // AI transcript
          const spokenText = content.outputTranscription?.text?.trim();

          if (spokenText) {
            const current = outputTextRef.current;

            if (!current) {
              outputTextRef.current = spokenText;
            } else if (spokenText.startsWith(current)) {
              outputTextRef.current = spokenText;
            } else if (!current.startsWith(spokenText)) {
              outputTextRef.current = `${current} ${spokenText}`.trim();
            }

            setMessages((previous) =>
              updateTranscriptState(previous, "AI", outputTextRef.current),
            );
          }

          // Play audio chunks in order at 24 kHz.
          const context = audioContextRef.current;
          const parts = content.modelTurn?.parts || [];

          for (const part of parts) {
            const audio = part.inlineData;

            if (
              !context ||
              !audio?.data ||
              !audio.mimeType?.startsWith("audio/pcm")
            ) {
              continue;
            }

            const binary = atob(audio.data);
            const pcm = new Int16Array(binary.length / 2);

            for (let i = 0; i < pcm.length; i++) {
              let value =
                binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);

              if (value >= 32768) value -= 65536;
              pcm[i] = value;
            }

            const buffer = context.createBuffer(1, pcm.length, 24000);
            const channel = buffer.getChannelData(0);

            for (let i = 0; i < pcm.length; i++) {
              channel[i] = pcm[i] / 32768;
            }

            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(outputAnalyserRef.current);

            const startAt = Math.max(
              context.currentTime,
              nextPlayTimeRef.current,
            );

            setIsAiSpeaking(true);
            source.start(startAt);
            nextPlayTimeRef.current = startAt + buffer.duration;

            source.onended = () => {
              if (
                audioContextRef.current === context &&
                context.currentTime >= nextPlayTimeRef.current - 0.04
              ) {
                setIsAiSpeaking(false);
              }
            };
          }

          if (content.turnComplete) {
            outputTextRef.current = "";
            inputTextRef.current = "";
            setIsAiSpeaking(false);
            setStatus("Connected — you can speak");
          }
        },

        onerror: (event) => {
          if (stoppingRef.current) return;
          console.error("[Gemini Live] Error:", event);
          setError(event?.message || "Gemini Live connection error.");
          setStatus("Connection error");
        },

        onclose: () => {
          if (stoppingRef.current) return;
          connectedRef.current = false;
          setIsAiSpeaking(false);
          setStatus("Disconnected");
        },
      });

      if (stoppingRef.current) {
        session.close();
        return;
      }

      sessionRef.current = session;

      const micSource = audioContext.createMediaStreamSource(stream);
      micSourceRef.current = micSource;

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        if (
          !connectedRef.current ||
          !sessionRef.current ||
          stoppingRef.current
        ) {
          return;
        }

        const input = event.inputBuffer.getChannelData(0);
        const downsampled = resample(input, audioContext.sampleRate, 16000);
        const pcm = floatToPcm16(downsampled);

        try {
          sessionRef.current.sendRealtimeInput({
            audio: {
              data: toBase64(
                new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
              ),
              mimeType: "audio/pcm;rate=16000",
            },
          });
        } catch (err) {
          console.error("[Gemini Live] Mic send failed:", err);
        }
      };

      micSource.connect(processor);
      processor.connect(micMuteGain);

      monitorAudio();

      // Start a natural conversation, not the fixed question bank.
      session.sendClientContent({
        turns: [
          {
            role: "user",
            parts: [
              {
                text:
                  "Start a natural voice conversation in simple Hindi or Hinglish. " +
                  "Greet me warmly and briefly, then ask me what you can help me with. " +
                  "Speak aloud. Listen to my replies and respond naturally to what I actually say. " +
                  "Ask relevant follow-up questions when useful. Keep replies concise. " +
                  "This is a conversational demo, not a fixed interview.",
              },
            ],
          },
        ],
        turnComplete: true,
      });

      setStatus("Connected — starting conversation");
    } catch (err) {
      console.error("[Gemini Live] Start failed:", err);
      setError(err.message || "Voice connection start nahi ho paaya.");
      setStatus("Unable to connect");
      await stop();
    } finally {
      startingRef.current = false;
    }
  }

  async function stop() {
    stoppingRef.current = true;
    connectedRef.current = false;

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      try {
        processorRef.current.disconnect();
      } catch {}
    }

    try {
      micSourceRef.current?.disconnect();
      outputAnalyserRef.current?.disconnect();
      outputGainRef.current?.disconnect();
      micMuteGainRef.current?.disconnect();
      sessionRef.current?.close();

      micStreamRef.current?.getTracks().forEach((track) => track.stop());

      if (
        audioContextRef.current &&
        audioContextRef.current.state !== "closed"
      ) {
        await audioContextRef.current.close();
      }
    } catch (err) {
      console.warn("[Cleanup] Warning:", err);
    }

    sessionRef.current = null;
    audioContextRef.current = null;
    micStreamRef.current = null;
    micSourceRef.current = null;
    processorRef.current = null;
    micMuteGainRef.current = null;
    outputAnalyserRef.current = null;
    outputGainRef.current = null;
    nextPlayTimeRef.current = 0;
    inputTextRef.current = "";
    outputTextRef.current = "";

    setAudioLevel(0);
    setIsAiSpeaking(false);
    setStatus("Disconnected");
    stoppingRef.current = false;
  }

  return {
    messages,
    status,
    error,
    audioLevel,
    isAiSpeaking,
    startingRef,
    start,
    stop,
  };
}
