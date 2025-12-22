// Build-free client using PeerJS cloud signaling; no backend required at runtime.
// One peer acts as the room hub (deterministic ID). First to claim that ID wins.
// Leader can be anyone; state is broadcast via the hub. Direct leader links are
// used for ping/pong time offset estimation.

const roomInput = document.getElementById('room');
const connectBtn = document.getElementById('connect');
const disconnectBtn = document.getElementById('disconnect');
const connectionStatus = document.getElementById('connectionStatus');
const leaderStatus = document.getElementById('leaderStatus');
const offsetStatus = document.getElementById('offsetStatus');
const syncStatus = document.getElementById('syncStatus');
const shareUrlInput = document.getElementById('shareUrl');
const copyUrlBtn = document.getElementById('copyUrl');
const peersLabel = document.getElementById('peers');
const leaderBtn = document.getElementById('becomeLeader');
const bpmInput = document.getElementById('bpm');
const beatsInput = document.getElementById('beats');
const leadInInput = document.getElementById('leadIn');
const calibrateBtn = document.getElementById('calibrate');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const tapBtn = document.getElementById('tapBtn');
const muteInput = document.getElementById('mute');
const meter = document.getElementById('meter');

let peer = null;
let hubId = null;
let isHub = false;
let hubConn = null;
let selfId = null;
let leaderId = null;
let directLeaderConn = null;
let pingTimer = null;
let resyncTimer = null;
let calibrationTimer = null;
let offsetMs = 0;
let offsetAudioSec = 0;
let pingIntervalMs = 450;
let currentPingIntervalMs = null;
let offsetSamples = []; // Stores objects like { offset: number, rtt: number }
const MAX_OFFSET_SAMPLES = 50; // Number of samples to keep in the sliding window
const MIN_OFFSET_SAMPLES = 3;
const RTT_KEEP_PERCENTILE = 0.6;
const OFFSET_MAD_MULT = 3;
let pllOffsetSec = 0;
let pllSkewSecPerSec = 0;
let pllLastUpdateMs = null;
let syncQuality = 'unknown';
let isCalibrating = false;
let lastOffsetSampleMs = null;
const SYNC_STALE_MS = 8000;

// Tap tempo state
let tapHistory = [];
let lastTapTime = null;
let tapTimeout = null;
let serverTimeOffset = 0;

let peers = new Set();
let peerCount = 1;
let currentState = {
  bpm: Number(bpmInput.value),
  beatsPerBar: Number(beatsInput.value),
  leadInMs: 500,
  startAtLeaderAudio: null, // in seconds, leader audio clock
  playing: false,
};
let beatSec = 60 / currentState.bpm;
let barSec = beatSec * currentState.beatsPerBar;

let audioCtx = null;
let schedulerId = null;
let nextBeatTime = null;
let pendingPlayback = false;
let currentBeatIndex = 0;
let visualTimers = [];

shareUrlInput.value = location.href;
copyUrlBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareUrlInput.value);
    copyUrlBtn.textContent = 'Copied';
    setTimeout(() => (copyUrlBtn.textContent = 'Copy'), 1200);
  } catch (err) {
    copyUrlBtn.textContent = 'Copy failed';
    setTimeout(() => (copyUrlBtn.textContent = 'Copy'), 1400);
  }
});

connectBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) {
    alert('Enter a room name');
    return;
  }
  if (peer) return;
  connect(room);
});

disconnectBtn.addEventListener('click', teardown);

leaderBtn.addEventListener('click', () => {
  if (!peer) {
    alert('Connect to a room first.');
    return;
  }
  if (!isHub) {
    alert('Leader is fixed to the room hub. Reconnect first in the room to lead.');
    return;
  }
  announceLeader(selfId);
  startBtn.disabled = true;
  calibrateBtn.disabled = false;
  calibrateBtn.textContent = 'Calibrate';
});

calibrateBtn.addEventListener('click', () => {
  runCalibration();
});

startBtn.addEventListener('click', () => {
  if (!isLeader()) {
    alert('Only the leader can start. You can take leader and try again.');
    return;
  }
  ensureAudio();
  const nowLeaderAudio = audioCtx.currentTime;
  let startAtLeaderAudio = nowLeaderAudio + currentState.leadInMs / 1000;
  startAtLeaderAudio = Math.ceil(startAtLeaderAudio / barSec) * barSec; // snap to next bar
  startPlayback(startAtLeaderAudio);
  currentState.startAtLeaderAudio = startAtLeaderAudio;
  currentState.playing = true;
  broadcastState();
});

stopBtn.addEventListener('click', () => {
  if (!isLeader()) {
    alert('Only the leader can stop.');
    return;
  }
  stopPlayback();
  currentState.playing = false;
  currentState.startAtLeaderAudio = null;
  broadcastState();
});

tapBtn.addEventListener('click', () => {
  handleTap();
});

bpmInput.addEventListener('input', () => {
  currentState.bpm = Number(bpmInput.value);
  beatSec = 60 / currentState.bpm;
  barSec = beatSec * currentState.beatsPerBar;
  if (isLeader()) {
    startBtn.disabled = true;
    calibrateBtn.disabled = false;
    calibrateBtn.textContent = 'Calibrate';
    stopPlayback();
    autoCalibrate();
    broadcastState();
  }
});

beatsInput.addEventListener('input', () => {
  currentState.beatsPerBar = Number(beatsInput.value);
  renderMeter(currentState.beatsPerBar);
  beatSec = 60 / currentState.bpm;
  barSec = beatSec * currentState.beatsPerBar;
  if (isLeader()) {
    startBtn.disabled = true;
    calibrateBtn.disabled = false;
    calibrateBtn.textContent = 'Calibrate';
    stopPlayback();
    autoCalibrate();
    broadcastState();
  }
});

leadInInput.addEventListener('input', () => {
  currentState.leadInMs = Number(leadInInput.value);
});

function connect(room) {
  setConnectionStatus('Connecting…');
  setSyncStatus('Sync: —');
  hubId = `metronome-${room}-hub`;

  Promise.all([tryCreateHubPeer(hubId), calibrateToServer()])
    .then(([{ instance, hub }]) => {
      peer = instance;
      isHub = hub;
      selfId = peer.id;
      registerPeerHandlers();
      setConnectionStatus(isHub ? 'Connected (hub)' : 'Connected');
      setSyncStatus('Sync: idle');
      leaderBtn.disabled = !isHub;
      peers.add(selfId);
      peerCount = peers.size;
      updatePeerCount();
      if (!isHub) {
        connectToHub();
      } else {
        leaderId = leaderId || selfId;
        setLeaderStatus('Leader: you');
        startBtn.disabled = true;
        calibrateBtn.disabled = false;
        calibrateBtn.textContent = 'Calibrate';
        autoCalibrate();
        broadcastLeader();
        broadcastPeerCount();
      }
    })
    .catch((err) => {
      console.error(err);
      setConnectionStatus('Failed to connect');
      alert('Failed to connect. Check network and retry.');
      teardown();
    });
}

function tryCreateHubPeer(id) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const hubPeer = new Peer(id, { debug: 0 });
    hubPeer.on('open', () => {
      if (settled) return;
      settled = true;
      resolve({ instance: hubPeer, hub: true });
    });
    hubPeer.on('error', (err) => {
      if (settled) return;
      if (err.type === 'unavailable-id') {
        hubPeer.destroy();
        const clientPeer = new Peer(undefined, { debug: 0 });
        clientPeer.on('open', () => resolve({ instance: clientPeer, hub: false }));
        clientPeer.on('error', (e) => reject(e));
      } else {
        reject(err);
      }
    });
  });
}

function registerPeerHandlers() {
  peer.on('connection', (conn) => {
    setupConnection(conn, true);
  });
  peer.on('error', (err) => {
    console.error('peer error', err);
  });
}

function connectToHub() {
  hubConn = peer.connect(hubId, { reliable: true });
  setupConnection(hubConn, false);
}

function setupConnection(conn, incoming) {
  conn.on('open', () => {
    if (!incoming && conn === hubConn) {
      send(conn, { type: 'hello', id: selfId });
    }
    if (isHub && incoming) {
      peers.add(conn.peer);
      peerCount = peers.size;
      updatePeerCount();
      broadcastPeerCount();
    }
  });

  conn.on('data', (msg) => handleMessage(conn, msg));
  conn.on('close', () => {
    if (isHub && peers.has(conn.peer)) {
      peers.delete(conn.peer);
      peerCount = peers.size;
      updatePeerCount();
      broadcastPeerCount();
    }
    if (conn === directLeaderConn) {
      directLeaderConn = null;
      stopPing();
    }
  });
}

function handleMessage(conn, msg) {
  const data = typeof msg === 'string' ? JSON.parse(msg) : msg;

  if (isHub) {
    if (data.type === 'hello') {
      peers.add(data.id);
      peerCount = peers.size;
      updatePeerCount();
      if (!leaderId) {
        leaderId = selfId;
        setLeaderStatus('Leader: you');
        broadcastLeader();
      }
      broadcastPeerCount();
      if (leaderId) send(conn, { type: 'leader', id: leaderId });
      if (currentState) send(conn, { type: 'state', data: currentState });
      return;
    }
    if (data.type === 'leader') {
      broadcastLeader(conn.peer);
    }
    if (data.type === 'state') {
      broadcastState(conn.peer);
    }
  }

  if (data.type === 'leader') {
    if (!isHub && data.id !== hubId) return;
    leaderId = data.id;
    setLeaderStatus(leaderId === selfId ? 'Leader: you' : `Leader: ${leaderId}`);
    if (leaderId && leaderId !== selfId) {
      connectToLeader(leaderId);
    }
    if (isLeader()) {
      startBtn.disabled = false;
      calibrateBtn.disabled = false;
      calibrateBtn.textContent = 'Calibrate';
      autoCalibrate();
      bpmInput.disabled = false;
      beatsInput.disabled = false;
      leadInInput.disabled = false;
    } else {
      startBtn.disabled = true;
      calibrateBtn.disabled = true;
      calibrateBtn.textContent = 'Calibrate';
      bpmInput.disabled = true;
      beatsInput.disabled = true;
      leadInInput.disabled = true;
    }
    return;
  }

  if (data.type === 'state') {
    applyRemoteState(data.data);
    return;
  }

  if (data.type === 'peers') {
    peerCount = data.count;
    updatePeerCount();
    return;
  }

  if (data.type === 'ping' && isLeader()) {
    const t1 = performance.now() + serverTimeOffset;
    ensureAudio();
    const leaderAudioTime = audioCtx.currentTime;
    const t2 = performance.now() + serverTimeOffset;
    send(conn, {
      type: 'pong',
      t0: data.t0,
      t1,
      t2,
      leaderAudioTime,
    });
    return;
  }

  if (data.type === 'pong' && directLeaderConn && conn.peer === directLeaderConn.peer) {
    const t3 = performance.now() + serverTimeOffset;
    const rtt = t3 - data.t0;
    const rttSec = rtt / 1000;
    ensureAudio();
    const localAudioNow = audioCtx.currentTime;
    let newOffsetAudio;
    if (Number.isFinite(data.t1) && Number.isFinite(data.t2)) {
      // NTP-style offset in perf clock, then map leader audio time to receive instant.
      const offsetPerf = ((data.t1 - data.t0) + (data.t2 - t3)) / 2;
      const leaderTimeAtT3 = t3 + offsetPerf;
      const leaderAudioAtT3 = data.leaderAudioTime + (leaderTimeAtT3 - data.t2) / 1000;
      newOffsetAudio = leaderAudioAtT3 - localAudioNow;
    } else {
      // Fallback to simple RTT/2 estimate.
      newOffsetAudio = data.leaderAudioTime + rttSec / 2 - localAudioNow;
    }
    addOffsetSample(newOffsetAudio, rtt);
    return;
  }
}

function send(conn, payload) {
  try {
    conn.send(JSON.stringify(payload));
  } catch (err) {
    console.error('send error', err);
  }
}

function announceLeader(id) {
  if (!isHub) return;
  leaderId = id;
  setLeaderStatus(leaderId === selfId ? 'Leader: you' : `Leader: ${leaderId}`);
  if (isHub) {
    broadcastLeader();
  } else if (hubConn?.open) {
    send(hubConn, { type: 'leader', id });
  }
}

function broadcastLeader(excludePeer) {
  if (!isHub) return;
  peer.connections &&
    Object.values(peer.connections).forEach((arr) =>
      arr.forEach((c) => {
        if (excludePeer && c.peer === excludePeer) return;
        if (c.open) send(c, { type: 'leader', id: selfId });
      })
    );
}

function broadcastState(excludePeer) {
  if (isHub) {
    peer.connections &&
      Object.values(peer.connections).forEach((arr) =>
        arr.forEach((c) => {
          if (excludePeer && c.peer === excludePeer) return;
          if (c.open) send(c, { type: 'state', data: currentState });
        })
      );
  } else if (hubConn?.open) {
    send(hubConn, { type: 'state', data: currentState });
  }
}

function broadcastPeerCount() {
  if (!isHub) return;
  const payload = { type: 'peers', count: peers.size };
  peer.connections &&
    Object.values(peer.connections).forEach((arr) =>
      arr.forEach((c) => {
        if (c.open) send(c, payload);
      })
    );
}

function startPing(interval) {
  if (pingTimer && currentPingIntervalMs === interval) return;
  stopPing();
  currentPingIntervalMs = interval;
  pingTimer = setInterval(() => {
    if (directLeaderConn && directLeaderConn.open) {
      send(directLeaderConn, { type: 'ping', t0: performance.now() + serverTimeOffset });
    }
  }, interval);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  currentPingIntervalMs = null;
}

function connectToLeader(id) {
  if (directLeaderConn && directLeaderConn.peer === id) return;
  if (directLeaderConn) {
    directLeaderConn.close();
    stopPing();
  }
  offsetSamples.length = 0;
  pllOffsetSec = 0;
  pllSkewSecPerSec = 0;
  pllLastUpdateMs = null;
  setOffsetStatus('Sync: connecting…');
  setSyncStatus('Sync: connecting…');

  directLeaderConn = peer.connect(id, { reliable: true });
  directLeaderConn.on('open', () => {
    setOffsetStatus('Sync: calibrating…');
    setSyncStatus('Sync: calibrating…');
    startContinuousSync(); // Start the continuous sync
    startCalibrationTimer();
  });
  directLeaderConn.on('data', (msg) => handleMessage(directLeaderConn, msg));
  directLeaderConn.on('close', () => {
    stopPing();
    stopContinuousSync();
    stopCalibrationTimer();
    setOffsetStatus('Sync: disconnected');
    setSyncStatus('Sync: disconnected');
    startBtn.disabled = true;
    calibrateBtn.disabled = true;
    calibrateBtn.textContent = 'Calibrate';
  });
}

function startContinuousSync() {
  stopContinuousSync();
  pingIntervalMs = 5000;
  startPing(pingIntervalMs);
  resyncTimer = setInterval(() => {
    if (!directLeaderConn || !directLeaderConn.open) return;
    if (!lastOffsetSampleMs) return;
    const ageMs = performance.now() - lastOffsetSampleMs;
    if (ageMs > SYNC_STALE_MS) {
      setOffsetStatus('Sync: stale, resyncing…');
      pingIntervalMs = 150;
      startPing(pingIntervalMs);
      startCalibrationTimer();
    }
  }, 1000);
}

function stopContinuousSync() {
  stopPing();
  if (resyncTimer) {
    clearInterval(resyncTimer);
    resyncTimer = null;
  }
}

function applyRemoteState(data) {
  currentState = { ...currentState, ...data };
  bpmInput.value = currentState.bpm;
  beatsInput.value = currentState.beatsPerBar;
  leadInInput.value = currentState.leadInMs;
  renderMeter(currentState.beatsPerBar);
  beatSec = 60 / currentState.bpm;
  barSec = beatSec * currentState.beatsPerBar;

  if (data.playing && data.startAtLeaderAudio !== null) {
    ensureAudio();
    if (offsetSamples.length === 0) {
      pendingPlayback = true;
    } else {
      startPlayback(data.startAtLeaderAudio);
    }
  } else if (!data.playing) {
    pendingPlayback = false;
    stopPlayback();
  }
  startBtn.disabled = true;
  calibrateBtn.disabled = true;
  bpmInput.disabled = true;
  beatsInput.disabled = true;
  leadInInput.disabled = true;
}

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } else if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function startPlayback(startAtLeader) {
  ensureAudio();
  currentState.startAtLeaderAudio = startAtLeader;
  currentState.playing = true;
  recalcFromLeaderTime();
  if (!schedulerId) schedulerId = setInterval(schedulerTick, 20);
  clearVisualTimers();
}

function stopPlayback() {
  currentState.playing = false;
  currentState.startAtLeaderAudio = null;
  nextBeatTime = null;
  currentBeatIndex = 0;
  if (schedulerId) {
    clearInterval(schedulerId);
    schedulerId = null;
  }
  clearVisualTimers();
  highlightBeat(-1);
}

function recalcFromLeaderTime() {
  if (!isLeader() && offsetSamples.length === 0) return;

  if (!audioCtx || !currentState.playing || currentState.startAtLeaderAudio === null) return;
  const localAudioNow = audioCtx.currentTime + getOffsetAudioSec();
  const beatSec = 60 / currentState.bpm;
  const elapsed = localAudioNow - currentState.startAtLeaderAudio;
  const beatNumber = Math.max(0, Math.floor(elapsed / beatSec));
  currentBeatIndex = beatNumber % currentState.beatsPerBar;
  const beatStartLeader = currentState.startAtLeaderAudio + beatNumber * beatSec;
  const offsetSec = beatStartLeader - localAudioNow;
  nextBeatTime = audioCtx.currentTime + Math.max(0, offsetSec);
}

function schedulerTick() {
  if (!audioCtx || !currentState.playing || nextBeatTime === null) return;
  const lookAhead = 0.06;
  const beatDur = 60 / currentState.bpm;
  while (nextBeatTime < audioCtx.currentTime + lookAhead) {
    scheduleClick(nextBeatTime, currentBeatIndex);
    scheduleVisual(nextBeatTime, currentBeatIndex);
    nextBeatTime += beatDur;
    currentBeatIndex = (currentBeatIndex + 1) % currentState.beatsPerBar;
  }
}

function scheduleClick(time, beatIndex) {
  if (muteInput.checked) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const isAccent = beatIndex === 0;
  const volume = isAccent ? 0.28 : 0.18;
  osc.type = 'square';
  osc.frequency.setValueAtTime(isAccent ? 1100 : 850, time);
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(volume, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.09);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(time);
  osc.stop(time + 0.12);
}

function scheduleVisual(time, beatIndex) {
  if (!audioCtx) return;
  const latencySec = getOutputLatencySec();
  const delayMs = Math.max(0, (time + latencySec - audioCtx.currentTime) * 1000);
  const id = setTimeout(() => {
    if (!currentState.playing) return;
    highlightBeat(beatIndex);
  }, delayMs);
  visualTimers.push(id);
}

function getOutputLatencySec() {
  if (!audioCtx) return 0;
  if (Number.isFinite(audioCtx.outputLatency)) return audioCtx.outputLatency;
  if (Number.isFinite(audioCtx.baseLatency)) return audioCtx.baseLatency;
  return 0;
}

function clearVisualTimers() {
  if (visualTimers.length === 0) return;
  visualTimers.forEach((id) => clearTimeout(id));
  visualTimers = [];
}

function renderMeter(beats) {
  meter.innerHTML = '';
  for (let i = 0; i < beats; i += 1) {
    const div = document.createElement('div');
    div.className = 'beat';
    div.textContent = i === 0 ? 'v' : '-';
    meter.appendChild(div);
  }
}

function highlightBeat(index) {
  const children = meter.querySelectorAll('.beat');
  children.forEach((child, idx) => {
    child.classList.toggle('active', idx === index);
  });
}

function updatePeerCount() {
  peersLabel.textContent = peerCount.toString();
}

function setConnectionStatus(text) {
  connectionStatus.textContent = text;
}

function setLeaderStatus(text) {
  leaderStatus.textContent = text;
}

function setOffsetStatus(offset) {
  if (typeof offset === 'string') {
    offsetStatus.textContent = offset;
  } else if (Number.isFinite(offset)) {
    let suffix = '';
    if (syncQuality === 'fair') suffix = ' (fair)';
    if (syncQuality === 'poor') suffix = ' (poor)';
    offsetStatus.textContent = `Offset: ${Math.round(offset)} ms${suffix}`;
  } else {
    offsetStatus.textContent = 'Offset: —';
  }
}

function setSyncStatus(text) {
  syncStatus.textContent = text;
}

function getOffsetAudioSec() {
  if (!pllLastUpdateMs) return offsetAudioSec;
  const nowMs = performance.now();
  const dtSec = (nowMs - pllLastUpdateMs) / 1000;
  return offsetAudioSec + pllSkewSecPerSec * dtSec;
}

function addOffsetSample(newOffsetAudioSec, rtt) {
  lastOffsetSampleMs = performance.now();
  offsetSamples.push({ offset: newOffsetAudioSec, rtt: rtt });
  if (offsetSamples.length > MAX_OFFSET_SAMPLES) {
    offsetSamples.shift();
  }

  let targetOffsetAudioSec;
  if (offsetSamples.length < MIN_OFFSET_SAMPLES) {
    const sum = offsetSamples.reduce((acc, s) => acc + s.offset, 0);
    targetOffsetAudioSec = sum / offsetSamples.length;
    offsetAudioSec = targetOffsetAudioSec;
    pllOffsetSec = offsetAudioSec;
    pllSkewSecPerSec = 0;
    pllLastUpdateMs = performance.now();
    offsetMs = offsetAudioSec * 1000;
    setOffsetStatus(offsetMs);
    recalcFromLeaderTime();
    return;
  }

  const rtts = offsetSamples.map(s => s.rtt).sort((a, b) => a - b);
  const mid = Math.floor(rtts.length / 2);
  const medianRtt = rtts.length % 2 === 1 ? rtts[mid] : (rtts[mid - 1] + rtts[mid]) / 2;

  const meanRtt = rtts.reduce((acc, r) => acc + r, 0) / rtts.length;
  const stdDevRtt = Math.sqrt(rtts.map(r => (r - meanRtt) ** 2).reduce((acc, val) => acc + val, 0) / rtts.length);

  const rttIndex = Math.max(0, Math.ceil(rtts.length * RTT_KEEP_PERCENTILE) - 1);
  const rttLimit = rtts[rttIndex];
  const rttFiltered = offsetSamples.filter(s => s.rtt <= rttLimit);
  const baseForMad = rttFiltered.length > 0 ? rttFiltered : offsetSamples;
  const offsetsForMad = baseForMad.map(s => s.offset).sort((a, b) => a - b);
  const offsetsMid = Math.floor(offsetsForMad.length / 2);
  const medianOffsetForMad = offsetsForMad.length % 2 === 1
    ? offsetsForMad[offsetsMid]
    : (offsetsForMad[offsetsMid - 1] + offsetsForMad[offsetsMid]) / 2;
  const absDeviations = offsetsForMad.map(o => Math.abs(o - medianOffsetForMad)).sort((a, b) => a - b);
  const madMid = Math.floor(absDeviations.length / 2);
  const mad = absDeviations.length % 2 === 1
    ? absDeviations[madMid]
    : (absDeviations[madMid - 1] + absDeviations[madMid]) / 2;
  const madLimit = mad === 0 ? Number.POSITIVE_INFINITY : OFFSET_MAD_MULT * mad;
  const filteredSamples = baseForMad.filter(s => Math.abs(s.offset - medianOffsetForMad) <= madLimit);

  if (filteredSamples.length === 0) {
    const offsets = offsetSamples.map(s => s.offset).sort((a, b) => a - b);
    const medianOffset = offsets.length % 2 === 1 ? offsets[Math.floor(offsets.length / 2)] : (offsets[Math.floor(offsets.length / 2) - 1] + offsets[Math.floor(offsets.length / 2)]) / 2;
    targetOffsetAudioSec = medianOffset;
  } else {
    const sumOffset = filteredSamples.reduce((acc, s) => acc + s.offset, 0);
    targetOffsetAudioSec = sumOffset / filteredSamples.length;
  }

  // PLL-style update to track offset and drift.
  const nowMs = performance.now();
  if (pllLastUpdateMs === null) {
    pllOffsetSec = targetOffsetAudioSec;
    pllSkewSecPerSec = 0;
    pllLastUpdateMs = nowMs;
  } else {
    const dtSec = Math.max(0.05, (nowMs - pllLastUpdateMs) / 1000);
    const predicted = pllOffsetSec + pllSkewSecPerSec * dtSec;
    const error = targetOffsetAudioSec - predicted;
    const kp = 0.2;
    const ki = 0.02;
    pllOffsetSec = predicted + kp * error;
    pllSkewSecPerSec = pllSkewSecPerSec + ki * error;
    pllLastUpdateMs = nowMs;
  }
  offsetAudioSec = pllOffsetSec;
  offsetMs = offsetAudioSec * 1000;

  const offsetStd = (() => {
    const values = filteredSamples.length > 1 ? filteredSamples.map(s => s.offset) : offsetSamples.map(s => s.offset);
    if (values.length < 2) return 0;
    const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  })();

  const medianRttMs = medianRtt;
  const jitterOkSec = 0.01;
  const jitterBadSec = 0.02;
  const rttOkMs = 120;
  const rttBadMs = 200;
  if (offsetStd > jitterBadSec || medianRttMs > rttBadMs) {
    syncQuality = 'poor';
  } else if (offsetStd > jitterOkSec || medianRttMs > rttOkMs) {
    syncQuality = 'fair';
  } else {
    syncQuality = 'good';
  }

  if (!isCalibrating && directLeaderConn?.open) {
    let desiredInterval = 5000;
    if (syncQuality === 'poor') desiredInterval = 600;
    else if (syncQuality === 'fair') desiredInterval = 1500;
    startPing(desiredInterval);
  }

  setOffsetStatus(offsetMs);
  setSyncStatus(syncQuality === 'good' ? 'Sync: good' : `Sync: ${syncQuality}`);
  recalcFromLeaderTime();
}

function isLeader() {
  return leaderId && leaderId === selfId;
}

function teardown() {
  stopPlayback();
  stopContinuousSync();
  stopCalibrationTimer();
  peers.clear();
  updatePeerCount();
  peer?.destroy();
  peer = null;
  hubConn = null;
  leaderId = null;
  isCalibrating = false;
  syncQuality = 'unknown';
  setConnectionStatus('Disconnected');
  leaderStatus.textContent = '—';
  setSyncStatus('Sync: —');
  startBtn.disabled = true;
  calibrateBtn.disabled = false;
  calibrateBtn.textContent = 'Calibrate';
  bpmInput.disabled = false;
  beatsInput.disabled = false;
  leaderBtn.disabled = false;
  offsetSamples.length = 0;
  pllOffsetSec = 0;
  pllSkewSecPerSec = 0;
  pllLastUpdateMs = null;
  lastOffsetSampleMs = null;
  setOffsetStatus('Offset: —');
}

function stopCalibrationTimer() {
  if (calibrationTimer) {
    clearTimeout(calibrationTimer);
    calibrationTimer = null;
  }
}

function startCalibrationTimer() {
  stopCalibrationTimer();
  calibrationTimer = setTimeout(() => {
    finishCalibration();
  }, 2000);
}

function finishCalibration() {
  stopCalibrationTimer();
  isCalibrating = false;
  pingIntervalMs = 5000;
  startPing(pingIntervalMs);

  if (pendingPlayback && currentState.startAtLeaderAudio) {
    if (isLeader() || offsetSamples.length > 0) {
      startPlayback(currentState.startAtLeaderAudio);
      pendingPlayback = false;
    } else {
      setOffsetStatus('Sync: waiting for leader…');
    }
  }

  calibrateBtn.textContent = 'Calibrated';
  if (isLeader()) {
    calibrateBtn.disabled = false;
    startBtn.disabled = false;
  } else {
    calibrateBtn.disabled = true;
  }
  if (!isLeader()) setSyncStatus('Sync: good');
}

async function calibrateToServer() {
  try {
    const { offset } = await getServerTime();
    serverTimeOffset = offset;
    console.log(`Server time offset: ${offset}ms`);
    if (isLeader()) {
      startBtn.disabled = false;
    }
  } catch (err) {
    console.error('Failed to calibrate to server time:', err);
    if (isLeader()) {
      startBtn.disabled = false; // Allow starting even if server time fails
    }
  }
}

async function getServerTime() {
  if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return { now: 0, rtt: 0, offset: 0 };
  }
  const start = performance.now();
  const res = await fetch('/now');
  const { now: serverNow } = await res.json();
  const end = performance.now();
  const rtt = end - start;
  const offset = serverNow - (end + rtt / 2);
  return { now: serverNow, rtt, offset };
}

function runCalibration() {
  ensureAudio();
  if (isLeader()) {
    offsetMs = 0;
    offsetAudioSec = 0;
    pllOffsetSec = 0;
    pllSkewSecPerSec = 0;
    pllLastUpdateMs = performance.now();
    lastOffsetSampleMs = performance.now();
    syncQuality = 'good';
    setOffsetStatus(offsetMs);
    calibrateBtn.textContent = 'Calibrated';
    calibrateBtn.disabled = false;
    startBtn.disabled = false;
    return;
  }

  calibrateBtn.textContent = 'Calibrating…';
  calibrateBtn.disabled = true;
  startBtn.disabled = true;
  setOffsetStatus('Sync: calibrating…');
  setSyncStatus('Sync: calibrating…');
  isCalibrating = true;
  syncQuality = 'unknown';
  offsetSamples.length = 0;
  pllOffsetSec = 0;
  pllSkewSecPerSec = 0;
  pllLastUpdateMs = null;
  lastOffsetSampleMs = null;
  pingIntervalMs = 150;
  startPing(pingIntervalMs);
  startCalibrationTimer();
}

function autoCalibrate() {
  if (!isLeader()) return;
  runCalibration();
}

function handleTap() {
  const now = performance.now();
  if (lastTapTime) {
    const interval = now - lastTapTime;
    tapHistory.push(interval);
    if (tapHistory.length > 4) {
      tapHistory.shift();
    }
  }
  lastTapTime = now;

  if (tapTimeout) clearTimeout(tapTimeout);
  tapTimeout = setTimeout(() => {
    tapHistory = [];
    lastTapTime = null;
  }, 2000);

  if (tapHistory.length >= 2) {
    const avgInterval = tapHistory.reduce((a, b) => a + b, 0) / tapHistory.length;
    const newBpm = Math.round(60000 / avgInterval);
    if (newBpm >= 30 && newBpm <= 240) {
      bpmInput.value = newBpm;
      currentState.bpm = newBpm;
      beatSec = 60 / currentState.bpm;
      barSec = beatSec * currentState.beatsPerBar;
      if (isLeader()) {
        startBtn.disabled = true;
        calibrateBtn.disabled = false;
        calibrateBtn.textContent = 'Calibrate';
        stopPlayback();
        autoCalibrate();
        broadcastState();
      }
    }
  }
}

renderMeter(currentState.beatsPerBar);
setConnectionStatus('Disconnected');
setLeaderStatus('—');
