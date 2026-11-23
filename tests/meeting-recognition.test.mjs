import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {recognizeMeetingTurns} from '../recognize-turns.js'

const grouping = await readFile(new URL('../speaker-groups.js',import.meta.url),'utf8')
const label = Function(grouping+'\nreturn meetingVoiceLabel')()
const vector = similarity => [similarity,Math.sqrt(1 - similarity ** 2)]

test('similar voices on longer turns can enroll separately and return to their previous numbers', () => {
  const state = {}, a = [1,0], b = vector(0.43)
  assert.equal(label(state,'mic',a,3000),'mic-voice-1')
  assert.equal(label(state,'mic',b,3000),'mic-voice-2')
  assert.equal(label(state,'mic',a,3000),'mic-voice-1')
  assert.equal(label(state,'system',b,3000),'system-voice-1')
  assert.equal(label(state,'mic',null,250),'mic-unknown')
  assert.equal(label({mic:[{center:a,count:1}]},'mic',b,1400),'mic-unknown')
})

test('Chinese mode flags kana for audio review and auto-detection preserves multilingual text', async () => {
  const signal = new AbortController().signal, pcm = Buffer.alloc(12000), voices = {extract:()=>null}
  const engine = {transcribe:async()=>({text:'こんにちは。'})}
  const zh = await recognizeMeetingTurns(pcm,'zh',signal,engine,voices)
  assert.equal(zh.parts[0].languageUncertain,true)
  assert.equal(zh.text,'')
  assert.equal(zh.parts[0].to,375)
  assert.equal((await recognizeMeetingTurns(pcm,'auto',signal,engine,voices)).text,'こんにちは。')
  engine.transcribe = async()=>({text:'请在3点讨论 API。'})
  assert.equal((await recognizeMeetingTurns(pcm,'zh',signal,engine,voices)).text,'请在3点讨论 API。')
})

test('an embedding failure preserves transcription while caller cancellation stops it', async () => {
  const controller=new AbortController(), pcm=Buffer.alloc(40000,1)
  const voices={extract(){throw Error('unavailable')}}, engine={transcribe:async()=>({text:'会议开始。'})}
  const result=await recognizeMeetingTurns(pcm,'zh',controller.signal,engine,voices)
  assert.equal(result.text,'会议开始。');assert.equal(result.parts[0].embedding,null)
  controller.abort();await assert.rejects(recognizeMeetingTurns(pcm,'zh',controller.signal,engine,voices),{name:'AbortError'})
})
