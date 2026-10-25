import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("GEMINI_API_KEY missing. Check server/.env");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

async function main() {
  try {
    const response = await ai.interactions.create({
      model: "gemini-3.8-flash",
      input: "Reply with exactly: Gemini connection successful",
    });

    console.log("Gemini response:", response.output_text);
  } catch (error) {
    console.error("Gemini test failed:", error.message);
    process.exitCode = 1;
  }
}

main();
