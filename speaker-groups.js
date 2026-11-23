// Anonymous speaker numbers are scoped to one meeting and one capture source.
// Prototypes stay in the local meeting record and are excluded from history rows and exports.
function meetingVoiceLabel(groups, source, vector, durationMs, neighbors = []) {
  const unknown = `${source}-unknown`
  if (!Array.isArray(vector) || vector.length < 2 || vector.length > 1024 || !vector.every(Number.isFinite)) return unknown
  const norm = Math.hypot(...vector)
  if (norm < 1e-5) return unknown
  const unit = vector.map(v => v / norm)
  const profiles = groups[source] ??= []
  const ranked = meetingVoiceMatches(profiles,unit)
  // Verified change points exclude the adjacent speaker. Conflicting strong evidence stays unassigned.
  if (ranked[0]?.score >= 0.70 && neighbors.includes(ranked[0].index)) return unknown
  const matches = ranked.filter(match => !neighbors.includes(match.index))
  const best = matches[0]
  // Short clips give less stable scores even when the same person keeps speaking.
  const newSpeakerThreshold = durationMs >= 2000 || neighbors.length ? 0.47 : 0.25
  if (!best || best.score < newSpeakerThreshold) {
    if (profiles.length >= 32) return unknown
    profiles.push({center:unit, count:1})
    return `${source}-voice-${profiles.length}`
  }
  if (best.score < 0.50 || (matches[1] && best.score - matches[1].score < 0.07)) return unknown
  if (best.score >= 0.57) {
    const profile = profiles[best.index]
    const weight = Math.min(profile.count, 12)
    const mean = profile.center.map((x,i) => x * weight + unit[i])
    const length = Math.hypot(...mean)
    profile.center = mean.map(x => x / length)
    profile.count++
  }
  return `${source}-voice-${best.index + 1}`
}

function meetingVoiceMatches(profiles,unit) {
  const matches = profiles.flatMap((profile,index) => profile.center.length === unit.length
    ? [{index,score:unit.reduce((sum,x,i) => sum + x * profile.center[i],0)}] : [])
  return matches.sort((a,b) => b.score - a.score)
}

function meetingTurnLabels(groups,source,parts) {
  const labels = []
  for (let i=0; i<parts.length; i++) {
    const part=parts[i], neighbors=[]
    const previous=labels[i-1], next=parts[i+1]
    if (previous?.startsWith(source+'-voice-') && parts[i-1].to === part.from) {
      neighbors.push(Number(previous.split('-').pop())-1)
    }
    // A returning voice immediately after this turn can be recognized before assigning this turn.
    if (next?.from === part.to && next.embedding?.length) {
      const [best,second] = meetingVoiceMatches(groups[source] || [],next.embedding)
      if (best?.score >= 0.70 && (!second || best.score - second.score >= 0.12)) neighbors.push(best.index)
    }
    labels.push(meetingVoiceLabel(groups,source,part.embedding,part.to-part.from,neighbors))
  }
  return labels
}
