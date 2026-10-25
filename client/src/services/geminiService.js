import { GoogleGenAI } from "@google/genai";
import { MODEL } from "../config/geminiConfig";

export function connectGeminiLive(token, callbacks) {
  const ai = new GoogleGenAI({
    apiKey: token,
    httpOptions: { apiVersion: "v1beta" },
  });

  return ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: ["AUDIO"],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
    callbacks,
  });
}
