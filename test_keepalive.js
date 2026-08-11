import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey });

// 0.25 seconds of silence at 16kHz PCM mono 16-bit:
// 16000 samples/sec * 0.25 sec = 4000 samples.
// Each sample is 2 bytes (Int16) -> 8000 bytes of zeros.
const silentBuffer = Buffer.alloc(8000);
const silentBase64 = silentBuffer.toString('base64');

try {
  console.log("Connecting to Gemini Live...");
  const session = await ai.live.connect({
    model: "gemini-3.1-flash-live-preview",
    callbacks: {
      onopen: () => {
        console.log("Connected! Starting keepalive interval...");
        
        // Send a silent audio packet every 1 second to prevent idle timeout
        const intervalId = setInterval(() => {
          console.log("Sending silent keepalive packet...");
          session.sendRealtimeInput({
            audio: { data: silentBase64, mimeType: "audio/pcm;rate=16000" }
          });
        }, 1000);

        // Keep session open for 20 seconds
        setTimeout(() => {
          clearInterval(intervalId);
          console.log("20 seconds elapsed. Manually closing session.");
          session.close();
          process.exit(0);
        }, 20000);
      },
      onerror: (err) => {
        console.error("Connection error:", err);
      },
      onclose: () => {
        console.log("Connection closed by server.");
      }
    }
  });

} catch (err) {
  console.error("Catch block error:", err);
  process.exit(1);
}
