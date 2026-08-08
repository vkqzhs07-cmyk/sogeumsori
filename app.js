const notes = [
  { name: '임', hz: 483 }, { name: '남', hz: 545 }, { name: '무', hz: 590 },
  { name: '황', hz: 660 }, { name: '태', hz: 740 }, { name: '고', hz: 828 }, { name: '중', hz: 894 }
];
let selected = 0, baseHz = 660, audioContext, analyser, stream, raf, samples = [], attemptActive = false, pitchHistory = [], calibrating = false, lastAnalysisAt = 0;
const $ = id => document.getElementById(id);
localStorage.removeItem('sogeum-calibration');
const targetHz = () => notes[selected].hz;
const hzText = hz => `${hz.toFixed(1)} Hz`;

function drawNotes() {
  $('noteButtons').innerHTML = notes.map((n, i) => `<button class="note-button ${i === selected ? 'selected' : ''}" data-note="${i}" type="button">${n.name}</button>`).join('');
  document.querySelectorAll('[data-note]').forEach(b => b.onclick = () => { selected = Number(b.dataset.note); updateTarget(); drawNotes(); resetLive(); });
}
function updateTarget() { const n = notes[selected]; $('targetName').textContent = n.name; $('targetPitch').textContent = `소금 기준 · ${hzText(targetHz())}`; }
function resetLive() { pitchHistory = []; $('needle').style.left = '50%'; $('liveScore').textContent = '—'; $('meterMessage').textContent = '음정을 기다리고 있어요'; $('centText').textContent = '길게, 고르게 불어 보세요'; $('feedback').textContent = '소금을 준비해요!'; const circle = $('scoreCircle'); if (circle) { circle.style.background = '#f6c74c'; circle.style.color = '#503900'; circle.style.transform = 'scale(1)'; } }
function centsFromTarget(hz) { return 1200 * Math.log2(hz / targetHz()); }
// 국악기의 자연스러운 시김새와 음정 폭을 고려한 넉넉한 판정입니다.
// ±55 cent는 '정확', ±100 cent는 '좋음'으로 인정합니다.
function scoreFromCents(cents) {
  const distance = Math.abs(cents);
  if (distance <= 35) return 100;
  if (distance <= 55) return Math.round(100 - (distance - 35) * .4);
  if (distance <= 100) return Math.round(92 - (distance - 55) * .36);
  return Math.max(0, Math.round(76 - (distance - 100) * .5));
}
function feedback(cents, score) { if (score >= 92) return '올바른 소리예요!'; if (score >= 76) return '좋아요, 자연스럽게 이어 불어요'; return cents < 0 ? '조금 더 높게 불어요' : '조금 더 낮게 불어요'; }
function updateLive(hz) {
  const cents = centsFromTarget(hz), score = scoreFromCents(cents), pos = Math.max(3, Math.min(97, 50 + cents / 3));
  $('scoreCircle').classList.toggle('is-correct', score >= 92);
  $('scoreCircle').classList.toggle('is-close', score >= 76 && score < 92);
  const circle = $('scoreCircle');
  circle.style.background = score >= 92 ? '#168b77' : score >= 76 ? '#f0a44a' : '#f6c74c';
  circle.style.color = score >= 92 ? 'white' : '#503900';
  circle.style.transform = score >= 92 ? 'scale(1.06)' : 'scale(1)';
  $('needle').style.left = `${pos}%`; $('liveScore').textContent = score; $('meterMessage').textContent = feedback(cents, score); $('centText').textContent = `${cents > 0 ? '+' : ''}${Math.round(cents)} cent · 들린 음 ${hzText(hz)}`; $('feedback').textContent = feedback(cents, score); $('detectedText').textContent = `목표 ${notes[selected].name} ${hzText(targetHz())}`;
  // 노래방처럼 음이 잠시 안정된 경우에만 기록합니다. 세게 불 때의 배음/흔들림은 점수에 넣지 않습니다.
  if (attemptActive) samples.push(score);
}
// 자기상관(autocorrelation) 방식: 브라우저에서 별도 설치 없이 단일 음의 주파수를 추정합니다.
function autoCorrelate(buffer, sampleRate) {
  let rms = 0; for (let i=0;i<buffer.length;i++) rms += buffer[i]*buffer[i];
  rms = Math.sqrt(rms / buffer.length); if (rms < .003) return -1;
  const minLag = Math.floor(sampleRate / 1400), maxLag = Math.min(Math.ceil(sampleRate / 100), buffer.length - 2);
  const corr = new Float32Array(maxLag + 1); let best = -Infinity, peak = -1;
  for (let lag=minLag; lag<=maxLag; lag++) { let sum=0; for (let i=0;i<buffer.length-lag;i++) sum += buffer[i]*buffer[i+lag]; corr[lag] = sum / (buffer.length-lag); if (corr[lag] > best) { best=corr[lag]; peak=lag; } }
  if (peak <= minLag || peak >= maxLag) return -1;
  const x1=corr[peak-1], x2=corr[peak], x3=corr[peak+1], shift=(x3-x1)/(2*(2*x2-x1-x3));
  return sampleRate / (peak + (Number.isFinite(shift) ? shift : 0));
}
function median(values) { const sorted = [...values].sort((a,b) => a-b); return sorted[Math.floor(sorted.length / 2)]; }
function storeCalibration() {
  localStorage.setItem('sogeum-calibration', JSON.stringify(Object.fromEntries(notes.filter(n => n.hz).map(n => [n.name, n.hz]))));
}
function captureCalibration() {
  if (!stream) { $('status').textContent = '먼저 마이크를 켠 뒤 다시 눌러 주세요.'; return; }
  calibrating = true; pitchHistory = []; samples = []; $('captureButton').disabled = true;
  $('status').textContent = `${notes[selected].name}을 약 1초 동안 고르게 불어 주세요. 지금 소리를 기준음으로 저장합니다.`;
}
function finishCalibration(hz) {
  notes[selected].hz = hz; storeCalibration(); calibrating = false; $('captureButton').disabled = false;
  $('calibrationPanel').hidden = true; updateTarget(); drawNotes(); resetLive();
  $('status').textContent = `${notes[selected].name} 기준음 ${hzText(hz)}를 저장했어요. 버튼의 ✓는 저장된 율명입니다.`;
}
function listen() {
  const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data);
  let energy = 0; for (const v of data) energy += v * v; energy = Math.sqrt(energy / data.length);
  const hz = autoCorrelate(data, audioContext.sampleRate);
  // 입력 세기는 음정 판정에 쓰지 않습니다. 너무 작거나 입력이 찌그러진 경우에만 측정을 잠시 보류합니다.
  if (hz > 140 && hz < 1600 && energy >= .003 && energy < .985) {
    // 이전보다 약 10배 긴 시간(약 1초)의 소리를 모아 판단합니다.
    // 순간적인 입김, 떨림, 배음은 화면의 음정과 점수에 거의 반영되지 않습니다.
    pitchHistory.push(hz); if (pitchHistory.length > 25) pitchHistory.shift();
    if (pitchHistory.length >= 12) {
      const stableHz = median(pitchHistory), deviations = pitchHistory.map(v => Math.abs(1200 * Math.log2(v / stableHz))), wobble = median(deviations);
      if (wobble < 45) { updateLive(stableHz); if (calibrating) finishCalibration(stableHz); }
      else { $('meterMessage').textContent = '소리를 고르게 유지해요'; $('centText').textContent = '음이 안정되면 점수를 보여 드려요'; $('feedback').textContent = '천천히 길게 불어 보세요'; }
    }
  } else if (energy >= .985) {
    pitchHistory = []; $('meterMessage').textContent = '소리가 너무 커요'; $('centText').textContent = '입력이 찌그러져 음정을 정확히 들을 수 없어요'; $('feedback').textContent = '조금 부드럽게 불어 보세요';
  } else { pitchHistory = []; }
  raf = requestAnimationFrame(listen);
}
async function start() {
  if (!navigator.mediaDevices?.getUserMedia) { $('status').textContent = '이 브라우저에서는 마이크 기능을 사용할 수 없어요. Chrome 또는 Edge에서 열어 주세요.'; return; }
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); audioContext = new (window.AudioContext || window.webkitAudioContext)(); if (audioContext.state !== 'running') await audioContext.resume(); analyser = audioContext.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = .15; audioContext.createMediaStreamSource(stream).connect(analyser); $('startButton').disabled = true; $('stopButton').disabled = false; $('status').textContent = '마이크가 켜졌어요. 소리를 1초 이상 고르게 유지하면 안정된 음만 평가해요.'; attemptActive = true; samples = []; resetLive(); listen(); } catch (e) { $('status').textContent = e?.name === 'NotAllowedError' ? '마이크 권한이 차단되었어요. 브라우저와 기기 설정에서 이 사이트의 마이크를 허용해 주세요.' : e?.name === 'NotFoundError' ? '사용할 수 있는 마이크를 찾지 못했어요.' : '마이크를 시작하지 못했어요. 모바일에서는 Safari 또는 Chrome에서 직접 이 페이지를 열어 주세요.'; }
}
function stop() { cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); audioContext?.close(); attemptActive = false; $('startButton').disabled = false; $('stopButton').disabled = true; if (samples.length) { const avg = Math.round(samples.reduce((a,b)=>a+b,0)/samples.length); $('averageScore').textContent = `${avg}점`; $('attemptCount').textContent = `${Number($('attemptCount').textContent.replace('번','')) + 1}번`; $('status').textContent = `이번 연습은 ${avg}점이에요. ${avg >= 80 ? '훌륭해요!' : '기준음을 들으며 다시 해 볼까요?'}`; } else $('status').textContent = '충분히 들리는 소리가 없었어요. 마이크 가까이에서 다시 해 보세요.'; }
// 소금의 숨결 섞인 맑은 음색을 흉내 낸 기준음입니다. 피아노 음색은 사용하지 않습니다.
async function playReference() {
  const c = new (window.AudioContext || window.webkitAudioContext)();
  if (c.state !== 'running') await c.resume();
  const now = c.currentTime, duration = 1.35;
  const output = c.createGain(); output.gain.setValueAtTime(.0001, now); output.gain.exponentialRampToValueAtTime(.22, now + .08); output.gain.exponentialRampToValueAtTime(.13, now + .28); output.gain.exponentialRampToValueAtTime(.0001, now + duration); output.connect(c.destination);
  // 부드러운 기본음과 약한 홀수 배음으로 관악기의 열린 소리를 만듭니다.
  [[1,.82],[2,.12],[3,.18],[4,.045],[5,.075]].forEach(([multiple, level]) => {
    const osc = c.createOscillator(), gain = c.createGain(); osc.type = 'sine'; osc.frequency.setValueAtTime(targetHz() * multiple, now); osc.detune.setValueAtTime((multiple - 1) * 1.5, now); gain.gain.value = level; osc.connect(gain).connect(output); osc.start(now); osc.stop(now + duration);
  });
  // 아주 약한 바람 소리를 더해 소금의 숨결을 표현합니다.
  const noise = c.createBufferSource(), buffer = c.createBuffer(1, c.sampleRate * duration, c.sampleRate), data = buffer.getChannelData(0), noiseFilter = c.createBiquadFilter(), noiseGain = c.createGain();
  for (let i=0; i<data.length; i++) data[i] = Math.random() * 2 - 1;
  noise.buffer = buffer; noiseFilter.type = 'bandpass'; noiseFilter.frequency.value = 2800; noiseFilter.Q.value = .7; noiseGain.gain.setValueAtTime(.0001,now); noiseGain.gain.exponentialRampToValueAtTime(.009,now+.1); noiseGain.gain.exponentialRampToValueAtTime(.0001,now+duration); noise.connect(noiseFilter).connect(noiseGain).connect(output); noise.start(now); noise.stop(now + duration); setTimeout(() => c.close(), 1700);
}
$('startButton').onclick=start; $('stopButton').onclick=stop; $('referenceButton').onclick=playReference; $('baseFrequency').oninput=e=>{baseHz=Number(e.target.value); $('baseFrequencyOut').textContent=`${baseHz} Hz`; updateTarget(); resetLive();}; $('resetButton').onclick=()=>{$('averageScore').textContent='아직 기록이 없어요';$('attemptCount').textContent='0번';};
document.querySelector('.meter').style.background = 'linear-gradient(90deg,#f39b66,#f7d865 20%,#55b79a 32%,#55b79a 68%,#f7d865 80%,#f39b66)';
$('calibrateButton').onclick = () => { $('calibrationName').textContent = notes[selected].name; $('calibrationPanel').hidden = false; };
$('captureButton').onclick = captureCalibration;
$('cancelCalibration').onclick = () => { calibrating = false; $('captureButton').disabled = false; $('calibrationPanel').hidden = true; };
$('clearCalibration').onclick = () => { notes.forEach(n => delete n.hz); localStorage.removeItem('sogeum-calibration'); calibrating = false; $('calibrationPanel').hidden = true; updateTarget(); drawNotes(); resetLive(); $('status').textContent = '저장한 기준음을 모두 지우고 기본 기준으로 돌아갔어요.'; };
drawNotes(); updateTarget();
