const express = require("express");
const cors = require("cors");
const { GoogleGenAI } = require("@google/genai");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "20kb" }));

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is missing in .env");
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// AI models in priority order
const MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
];

const MAX_RETRIES = 2;
const REQUEST_TIMEOUT = 30000;

// Delay helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Extract API error status
function getErrorStatus(error) {
  if (error.status) return Number(error.status);

  const message = String(error.message || "");
  const match = message.match(/"code"\s*:\s*(\d+)/);

  return match ? Number(match[1]) : 500;
}

// Generate AI response with model fallback
async function generateAIResponse(prompt) {
  let lastError;

  for (const model of MODELS) {
    console.log(`\nTrying AI model: ${model}`);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[${model}] Attempt ${attempt + 1}/${MAX_RETRIES + 1}`);

        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            httpOptions: {
              timeout: REQUEST_TIMEOUT,
            },
          },
        });

        if (!response.text) {
          throw new Error("Empty response from Gemini");
        }

        console.log(`Success with model: ${model}`);

        return {
          answer: response.text,
          model,
        };
      } catch (error) {
        lastError = error;

        const status = getErrorStatus(error);

        console.error(`[${model}] Error (${status}): ${error.message}`);

        // Do not retry invalid requests or authentication errors
        if (![404, 429, 503].includes(status)) {
          throw error;
        }

        // Switch immediately when model is unavailable
        if (status === 404) {
          console.log(`Model ${model} unavailable. Switching model...`);
          break;
        }

        // Rate limit: avoid retrying the same model
        if (status === 429) {
          console.log(`Rate limited on ${model}. Trying next model...`);
          break;
        }

        // Retry 503 errors
        if (attempt < MAX_RETRIES) {
          const delay =
            Math.pow(2, attempt) * 2000 + Math.floor(Math.random() * 1000);

          console.log(`Retrying after ${delay}ms...`);

          await sleep(delay);
        }
      }
    }

    console.log(`Moving to next available model...`);
  }

  throw lastError || new Error("All AI models failed");
}

// Chat API
app.post("/api/ai/chat", async (req, res) => {
  try {
    const { prompt } = req.body || {};

    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({
        success: false,
        error: "Prompt is required",
      });
    }

    const result = await generateAIResponse(prompt.trim());

    return res.status(200).json({
      success: true,
      model: result.model,
      answer: result.answer,
    });
  } catch (error) {
    const status = getErrorStatus(error);

    console.error("Final AI Error:", error.message);

    if (status === 503) {
      return res.status(503).json({
        success: false,
        error: "All available AI models are busy.",
        message: "Please try again later.",
      });
    }

    if (status === 429) {
      return res.status(429).json({
        success: false,
        error: "AI rate limit exceeded.",
        message: "Please try again later.",
      });
    }

    if (status === 404) {
      return res.status(502).json({
        success: false,
        error: "AI models are unavailable.",
        message: "Check model availability.",
      });
    }

    return res.status(500).json({
      success: false,
      error: "AI request failed.",
    });
  }
});

app.post("/api/ai/interview", async (req, res) => {
  try {
    const { role, difficulty } = req.body;

    if (
      typeof role !== "string" ||
      !role.trim() ||
      role.length > 100 ||
      !["beginner", "intermediate", "advanced"].includes(difficulty)
    ) {
      return res.status(400).json({
        error: "Valid role and difficulty are required",
      });
    }

    const prompt = `
      You are a technical interviewer.

      Job role: ${role}
      Difficulty: ${difficulty}

      Generate 5 technical interview questions.

      For each question include:
      - Question
      - Expected answer
      - Explanation

      Return clear, structured text.
    `;

    const result = await generateAIResponse(prompt);

    res.json({
      success: true,
      role,
      difficulty,
      model: result.model,
      questions: result.answer,
    });
  } catch (error) {
    console.error("Interview generation failed:", error);

    res.status(503).json({
      success: false,
      error: "Unable to generate interview questions",
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "AI Backend API is running",
    configuredModels: MODELS,
  });
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Configured AI Models:", MODELS);
});
