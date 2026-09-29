import { GoogleGenAI } from '@google/genai';

/*
 * Real streamed-quality narration via Gemini TTS -- the same model family
 * measured for real in Book 5's voice-agents work (gemini-2.5-flash-preview-tts,
 * via LiveKit's google.beta.GeminiTTS there; called directly here since this
 * runs in a Node/Next.js backend, not the LiveKit Python runtime). This is
 * the deliberate replacement for both prior attempts' TTS: PrepCity's web
 * `speechSynthesis` and the mobile app's `expo-speech` are OS-level voices
 * with no real streaming architecture behind them, which is exactly why
 * neither could ever sound like an actual person narrating live.
 */

const DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_VOICE = 'Puck';

/** Gemini TTS returns raw 16-bit PCM, 24kHz mono, with no container --
 * unplayable by a plain <audio> element until it has a WAV header. */
const SAMPLE_RATE = 24000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

export interface NarrationResult {
  /** WAV-wrapped audio bytes, ready to hand to an <audio> element or save to disk. */
  audio: Buffer;
  mimeType: 'audio/wav';
  model: string;
  voice: string;
}

function wrapPcmAsWav(pcm: Buffer): Buffer {
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Synthesize one narration line to real audio. Non-streaming for this first
 * pass -- see ARCHITECTURE.md's "deliberately deferred" section for
 * chunk-as-you-go playback, which is the next real improvement here, not a
 * cosmetic one: streaming is exactly what Book 5 measured as the difference
 * between a call that feels instant and one that feels slow.
 */
export async function narrate(
  text: string,
  opts: { model?: string; voice?: string; apiKey?: string } = {},
): Promise<NarrationResult> {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const model = opts.model ?? DEFAULT_MODEL;
  const voice = opts.voice ?? DEFAULT_VOICE;

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  });

  const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!data) {
    throw new Error('Gemini TTS returned no audio data');
  }

  return { audio: wrapPcmAsWav(Buffer.from(data, 'base64')), mimeType: 'audio/wav', model, voice };
}
