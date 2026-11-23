// Run from a DSH shell with node check-windows.mjs. Generates speech in memory.
// --stdin also accepts [{ speaker, id, pcm }] with base64 s16le/16 kHz mono.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createVoiceEmbedding } from '../voice-embedding.js'

function synthesize() {
  const script = `
    $ErrorActionPreference='Stop'
    $ProgressPreference='SilentlyContinue'
    Add-Type -AssemblyName System.Speech
    $tts = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, 16, 1)
    $zh = @('今天早上接到客户的电话，交付时间比原定计划提前了两天。','这次讨论先确定试点范围，稍后再把预算发给大家。','仓库的登记工作已经结束，新的设备下午就能送达。','我昨天看过那份研究报告，还需要补充两个案例。','附近的道路正在维修，请大家从北门进入会场。','系统会在周五更新，我们周四先核对所有清单。')
    $en = @('I spoke with the customer this morning and confirmed the delivery schedule.','Please send everyone the revised budget before the end of the week.','The equipment arrived at the warehouse after lunch yesterday.','I read the research report and would like to discuss two more examples.','The entrance on the north side will be open during construction.','Our team can finish the last round of testing on Thursday afternoon.')
    try {
      $rows = foreach ($name in 'Huihui','Zira','David') {
        $tts.SelectVoice("Microsoft $name Desktop")
        $lines = if ($name -eq 'Huihui') { $zh } else { $en }
        for ($i=0; $i -lt $lines.Count; $i++) {
          $audio = New-Object System.IO.MemoryStream
          try {
            $tts.SetOutputToAudioStream($audio, $format)
            $tts.Speak($lines[$i])
            [PSCustomObject]@{ speaker=$name; id=$i; pcm=[Convert]::ToBase64String($audio.ToArray()) }
            $tts.SetOutputToNull()
          } finally { $audio.Dispose() }
        }
      }
      ConvertTo-Json -InputObject @($rows) -Compress
    } finally { $tts.Dispose() }
  `
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, windowsHide: true,
  }))
}

function stats(values) {
  if (!values.length) return { count: 0 }
  const sorted = values.slice().sort((a, b) => a - b)
  const at = q => +sorted[Math.floor(q * (sorted.length - 1))].toFixed(3)
  return { count: sorted.length, min: at(0), p10: at(0.1), median: at(0.5), p90: at(0.9), max: at(1) }
}

const input = process.argv.includes('--stdin') ? JSON.parse(readFileSync(0, 'utf8').trim().replace(/^\uFEFF/, '')) : synthesize()
const clips = input.map(row => ({ ...row, pcm: Buffer.from(row.pcm, 'base64') }))
const engine = createVoiceEmbedding()
const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0)
try {
  for (const seconds of [null, 2, 1.3]) {
    const output = [], timings = [], same = [], different = []
    for (const clip of clips) {
      const size = Math.min(clip.pcm.length, seconds ? Math.round(seconds * 32000) : clip.pcm.length)
      const offset = Math.floor((clip.pcm.length - size) / 4) * 2
      const started = performance.now()
      const vector = await engine.extract(clip.pcm.subarray(offset, offset + size))
      timings.push(performance.now() - started)
      if (vector === null) continue
      assert.equal(vector.length, 192)
      assert(Math.abs(Math.hypot(...vector) - 1) < 1e-6)
      for (const previous of output) {
        (clip.speaker === previous.speaker ? same : different).push(cosine(vector, previous.vector))
      }
      output.push({ speaker: clip.speaker, vector })
    }
    console.log(JSON.stringify({ seconds: seconds ?? 'full', clips: clips.length, accepted: output.length,
      same: stats(same), different: stats(different), falseMatch50: different.filter(x => x >= 0.50).length,
      falseNew25: same.filter(x => x < 0.25).length, firstMs: +timings[0].toFixed(1), otherMs: stats(timings.slice(1)) }))
    // A cropped public recording can contain a pause. Only require speech in the full clips.
    if (!process.argv.includes('--stdin') || seconds === null) {
      assert(output.length >= Math.ceil(clips.length * 0.8))
      assert(same.length && different.length && stats(same).median > stats(different).median + 0.2)
    }
  }

  const first = clips[0].pcm
  assert.equal(await engine.extract(first.subarray(0, 16000)), null)
  assert.equal(await engine.extract(Buffer.alloc(64000)), null)
  assert.equal(await engine.extract(Buffer.alloc(64001)), null)
  assert.equal(await engine.extract(Buffer.alloc(31 * 32000)), null)
  const noise = Buffer.alloc(64000), tone = Buffer.alloc(64000)
  let random = 12345
  for (let i = 0; i < 32000; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) | 0
    noise.writeInt16LE(random >> 19, 2 * i)
    tone.writeInt16LE(Math.round(4096 * Math.sin(i * 2 * Math.PI * 400 / 16000)), 2 * i)
  }
  assert.equal(await engine.extract(noise), null)
  assert.equal(await engine.extract(tone), null)
  assert.equal(await engine.extract(first, AbortSignal.abort()), null)
  const unaligned = Buffer.concat([Buffer.of(0), first]).subarray(1)
  const a = new AbortController(), b = new AbortController()
  const active = engine.extract(unaligned, a.signal), queued = engine.extract(first, b.signal), next = engine.extract(unaligned)
  b.abort(); a.abort()
  assert.equal(await queued, null); assert.equal(await active, null)
  const restarted = await next, reference = await engine.extract(first)
  assert(cosine(reference, restarted) > 0.99999)
  const pending = engine.extract(first), waiting = engine.extract(first)
  engine.dispose()
  assert.equal(await pending, null); assert.equal(await waiting, null)
  assert.equal(await engine.extract(first), null)
  console.log('PASS short / odd / long / silence / noise / tone / pre-abort / queued and active abort / restart / unaligned slice / dispose')
} finally { engine.dispose() }
