import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
console.log("Using API Key starting with:", apiKey ? apiKey.substring(0, 10) : 'none');

const ai = new GoogleGenAI({ apiKey });

try {
  console.log("Connecting to Gemini Live API...");
  const session = await ai.live.connect({
    model: "gemini-3.1-flash-live-preview",
    callbacks: {
      onopen: () => {
        console.log("Connection opened successfully!");
        // Keep it open to see if it closes automatically
      },
      onerror: (err) => {
        console.error("Connection error callback:", err);
      },
      onclose: () => {
        console.log("Connection closed by server.");
      }
    }
  });

  // Wait 15 seconds
  setTimeout(() => {
    console.log("Time's up. Manually closing session.");
    session.close();
    process.exit(0);
  }, 15000);

} catch (err) {
  console.error("Catch block error:", err);
  process.exit(1);
}
