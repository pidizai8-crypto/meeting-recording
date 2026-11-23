import { splitSpeakerTurns } from './speaker-turns.js'

// Speech recognition remains usable if speaker inference is unavailable on this host.
export async function recognizeMeetingTurns(pcm, language, signal, engine, voices) {
  let segments
  try {
    segments = await splitSpeakerTurns(pcm, (chunk, cancel) => voices.extract(chunk,cancel), signal)
  } catch {
    signal.throwIfAborted()
    segments = [{ startSample:0, endSample:pcm.length / 2, embedding:null }]
  }
  const parts = []
  for (const {startSample,endSample,embedding} of segments) {
    signal.throwIfAborted()
    const result = await engine.transcribe(pcm.subarray(startSample * 2,endSample * 2),{ signal,language })
    const text = result.text.trim()
    // SenseVoice treats zh as a decoding hint. An occasional Japanese result can still pass through.
    const languageUncertain = language === 'zh' && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
    parts.push({from:startSample / 16,to:endSample / 16,text:languageUncertain ? '' : text,
      languageUncertain,embedding:embedding ? Array.from(embedding) : null})
  }
  return {text:parts.map(p => p.text).filter(Boolean).join(' '),parts}
}
