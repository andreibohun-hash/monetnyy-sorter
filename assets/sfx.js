'use strict';
/* =====================================================================================================
   assets/sfx.js — звук «Монетного сортера»: WebAudio-синтез, ни одного файла (PROTO-BASE §8).

   Главное — звон монеты. У каждого металла своя «косточка» (набор обертонов и затухание):
     медь    — глухая: низкий треугольник, обертоны слабые, гаснет за ~90 мс;
     серебро — звонкое: негармоничные обертоны диска (×2,76, ×5,4, ×8,9), долгий хвост;
     золото  — богатое: основа + октава + квинта и вторая основа с биением;
     эмаль   — стеклянная: чистый высокий синус, короткая атака.
   Высота — лесенка мажорной пентатоники до: каждая следующая монета в столбике на ступень выше,
   десятая приходит в тонику (и поверх неё аккорд ролла). Разброс: основной тон ±CFG.sfx.pitchJitter
   (малый, иначе лесенка расстраивается), обертоны ±CFG.sfx.timbreJitter (5% — «каждая монета своя»).
   Звенящих голосов не больше CFG.sfx.maxVoices: новый голос глушит самый старый.
   Случайность — свой генератор с сидом (Math.random не используется).
   ===================================================================================================== */
const Sfx = (function(){
const S = { ac: null, muted: false, log: null };
let bus = null, master = null, noiseBuf = null, rollG = null, spinG = null, spinOsc = null, spinF = null, spinN = null, tickAt = 0;
const voices = [];
let seed = 20261113;
function rnd(){ seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const jit = (k) => 1 + (rnd() * 2 - 1) * k;
const SCALE = [0, 2, 4, 7, 9];                                   // мажорная пентатоника, полутона от тоники
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const scaleHz = (base, step) => hz(base + 12 * Math.floor(step / 5) + SCALE[((step % 5) + 5) % 5]);
// Ступень лесенки для i-й монеты слоя (0…9): девять шагов вверх, десятая — в тонику двумя октавами выше начала.
const ladderStep = (i) => i >= 9 ? 10 : i;
// Косточки металлов: base — MIDI-нота первой ступени; parts — [множитель частоты, громкость]; decay — затухание основы, с;
// click — [частота полосы щелчка, громкость]; beat — расстройка второй основы (биение), Гц.
const TIMBRE = {
  copper: { base: 60, type: 'triangle', parts: [[1, 1], [2.32, 0.22], [3.9, 0.06]], decay: 0.075, click: [1100, 0.5], gain: 0.42, beat: 0 },
  silver: { base: 72, type: 'sine', parts: [[1, 0.7], [2.76, 0.6], [5.4, 0.34], [8.93, 0.14]], decay: 0.36, click: [5200, 0.3], gain: 0.2, beat: 0 },
  gold:   { base: 72, type: 'sine', parts: [[1, 1], [2, 0.5], [3, 0.3], [4.02, 0.12]], decay: 0.5, click: [3200, 0.24], gain: 0.2, beat: 5 },
  glass:  { base: 84, type: 'sine', parts: [[1, 1], [2.7, 0.18], [4.3, 0.06]], decay: 0.2, click: [7500, 0.16], gain: 0.15, beat: 0 },
};
const on = () => S.ac && !S.muted && S.ac.state === 'running';
const note = (name, info) => { if (S.log) S.log('sound', name, info); };

S.init = function(){
  if (S.ac){ if (S.ac.state === 'suspended') S.ac.resume(); return; }
  try { S.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { S.ac = null; return; }
  const ac = S.ac;
  master = ac.createGain(); master.gain.value = S.muted ? 0 : CFG.sfx.master;
  const comp = ac.createDynamicsCompressor(); comp.threshold.value = -16; comp.knee.value = 14; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.16;
  bus = ac.createGain(); bus.connect(comp); comp.connect(master); master.connect(ac.destination);
  // маленькое «помещение»: две линии задержки с обратной связью — у звона появляется воздух
  const send = ac.createGain(); send.gain.value = CFG.sfx.room; bus.connect(send);
  for (const [dt, fb] of [[0.031, 0.34], [0.047, 0.3]]){
    const d = ac.createDelay(0.2), g = ac.createGain(), lp = ac.createBiquadFilter(); d.delayTime.value = dt; g.gain.value = fb; lp.type = 'lowpass'; lp.frequency.value = 4200;
    send.connect(d); d.connect(lp); lp.connect(g); g.connect(d); lp.connect(comp);
  }
  noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const ch = noiseBuf.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = rnd() * 2 - 1;
  // постоянные дорожки: перекат монет по лотку и гул разгона диска (громкость ведёт оболочка)
  const mk = (type, f, q) => { const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true; const flt = ac.createBiquadFilter(); flt.type = type; flt.frequency.value = f; flt.Q.value = q;
    const g = ac.createGain(); g.gain.value = 0; src.connect(flt); flt.connect(g); g.connect(bus); src.start(); return { g, flt }; };
  const r = mk('bandpass', 2300, 1.4); rollG = r.g;
  const am = ac.createOscillator(), amG = ac.createGain(); am.frequency.value = 31; amG.gain.value = 0; am.connect(amG); amG.connect(rollG.gain); am.start(); S._rollAm = amG;
  const sp = mk('bandpass', 500, 0.8); spinN = sp.g; spinF = sp.flt;
  spinOsc = ac.createOscillator(); spinOsc.type = 'sawtooth'; spinOsc.frequency.value = 70; const sl = ac.createBiquadFilter(); sl.type = 'lowpass'; sl.frequency.value = 520;
  spinG = ac.createGain(); spinG.gain.value = 0; spinOsc.connect(sl); sl.connect(spinG); spinG.connect(bus); spinOsc.start();
};
S.setMuted = function(m){ S.muted = !!m; if (master) master.gain.setTargetAtTime(S.muted ? 0 : CFG.sfx.master, S.ac.currentTime, 0.02); };

// --- кирпичики ---
function osc(freq, type, t, peak, decay, dest, attack, glideTo){
  if (freq > 13000 || peak <= 0.0005) return;
  const ac = S.ac, o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + decay);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + (attack || 0.003)); g.gain.exponentialRampToValueAtTime(0.0001, t + (attack || 0.003) + decay * 3.2);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t + (attack || 0.003) + decay * 3.3 + 0.02);
}
function noise(t, dur, peak, type, f, q, dest, fTo){
  const ac = S.ac, src = ac.createBufferSource(), flt = ac.createBiquadFilter(), g = ac.createGain(); src.buffer = noiseBuf; flt.type = type; flt.frequency.setValueAtTime(f, t); flt.Q.value = q || 1;
  if (fTo) flt.frequency.exponentialRampToValueAtTime(fTo, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + Math.min(0.004, dur * 0.3)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(flt); flt.connect(g); g.connect(dest || bus); src.start(t, rnd() * 1.5); src.stop(t + dur + 0.02);
}
// Лимит звенящих голосов: если все заняты — самый старый быстро гаснет.
function claimVoice(t, dur){
  for (let i = voices.length - 1; i >= 0; i--) if (voices[i].end <= t) voices.splice(i, 1);
  while (voices.length >= CFG.sfx.maxVoices){ const v = voices.shift(); try { v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0.0001, t, 0.012); } catch (e) {} }
  const g = S.ac.createGain(); g.gain.value = 1; g.connect(bus); voices.push({ end: t + dur, g }); return g;
}
const loud = (f) => Math.min(1, Math.pow(1300 / Math.max(200, f), 0.55));      // высокие ноты тише — ухо не режет
function ring(tm, f0, t, vel, dest, long){
  for (const [ratio, amp] of tm.parts){
    const f = f0 * ratio * (ratio === 1 ? 1 : jit(CFG.sfx.timbreJitter));
    osc(f, tm.type, t, amp * tm.gain * vel * loud(f), tm.decay * (ratio === 1 ? 1 : 0.55) * (long || 1), dest);
  }
  if (tm.beat) osc(f0 + tm.beat, 'sine', t, 0.5 * tm.gain * vel * loud(f0), tm.decay * (long || 1), dest);
}

// --- события игры ---
// Звон монеты, упавшей на столбик: kind — вид металла, i — какая по счёту в слое (0…9), vel — сила.
S.clink = function(kind, i, vel, delay){
  if (!on()) return; const tm = TIMBRE[CFG.metals[kind].sound], t = S.ac.currentTime + (delay || 0), v = vel === undefined ? 1 : vel;
  const f0 = scaleHz(tm.base, ladderStep(i)) * jit(CFG.sfx.pitchJitter), out = claimVoice(t, tm.decay * 3.4);
  ring(tm, f0, t, v, out);
  noise(t, 0.022, tm.click[1] * v * 0.5, 'bandpass', tm.click[0] * jit(0.08), 1.3, out);
};
// Аккорд ролла: до-ми-соль-до металла, со сдвигом на ступень за каждый ролл серии; бумага шуршит отдельно.
S.rollChord = function(kind, combo){
  if (!on()) return; const tm = TIMBRE[CFG.metals[kind].sound], t = S.ac.currentTime, c = Math.min(combo, 9);
  const out = S.ac.createGain(); out.gain.value = 0.9; out.connect(bus);
  [0, 2, 3, 5].forEach((st, k) => ring(tm, scaleHz(Math.min(tm.base, 72), st + c), t + k * 0.028, 0.62, out, 1.5));
  osc(scaleHz(48, c), 'sine', t, 0.16, 0.16, out);                                   // тёплый низ под аккордом
  note('roll.chord', 'metal=' + CFG.metals[kind].id + ' combo=' + (combo + 1));
};
S.paper = function(dur){
  if (!on()) return; const t = S.ac.currentTime;
  for (let k = 0; k < 7; k++) noise(t + k * dur / 7 + rnd() * 0.012, 0.03 + rnd() * 0.03, 0.13 + rnd() * 0.1, 'highpass', 2600 + rnd() * 3200, 0.7);
  noise(t + dur * 0.72, 0.07, 0.2, 'bandpass', 5200, 0.8);                           // концы сминаются
  note('paper');
};
S.whoosh = function(){ if (!on()) return; noise(S.ac.currentTime, 0.22, 0.1, 'bandpass', 700, 0.9, bus, 2600); };
S.safeThud = function(strong){
  if (!on()) return; const t = S.ac.currentTime, v = strong ? 1 : 0.7;
  osc(104, 'sine', t, 0.5 * v, 0.07, bus, 0.002, 52); noise(t, 0.06, 0.3 * v, 'lowpass', 420, 0.7);
  osc(430 * jit(0.04), 'sine', t, 0.05 * v, 0.1, bus); note('safe.thud');
};
// Открылась следующая полоса — «дзинь» её металла.
S.ding = function(kind){
  if (!on()) return; const tm = TIMBRE[CFG.metals[kind].sound], t = S.ac.currentTime + 0.03, out = claimVoice(t, tm.decay * 4);
  ring(tm, scaleHz(tm.base, 5), t, 0.75, out, 1.6); note('layer.ding', CFG.metals[kind].id);
};
S.hole = function(){
  if (!on()) return; const t = S.ac.currentTime;
  noise(t, 0.2, 0.2, 'lowpass', 1400, 0.6, bus, 260); osc(hz(96), 'sine', t + 0.05, 0.07, 0.07, bus); osc(hz(103), 'sine', t + 0.12, 0.07, 0.11, bus); note('hole');
};
// Кошелёк: мягкий шлепок кожи + тихое звяканье его монет.
S.walletTap = function(kind){
  if (!on()) return; const t = S.ac.currentTime;
  osc(210, 'sine', t, 0.32, 0.04, bus, 0.002, 96); noise(t, 0.04, 0.12, 'lowpass', 900, 0.7);
  if (kind >= 0){ S.clink(kind, 2, 0.3, 0.035); S.clink(kind, 4, 0.22, 0.075); }
  note('wallet.tap');
};
S.walletPlop = function(kind){
  if (!on()) return; const t = S.ac.currentTime;
  osc(150, 'sine', t, 0.42, 0.06, bus, 0.002, 62); noise(t, 0.07, 0.2, 'lowpass', 600, 0.7);
  if (kind >= 0){ S.clink(kind, 1, 0.34, 0.02); S.clink(kind, 0, 0.26, 0.07); S.clink(kind, 3, 0.16, 0.13); }
  note('wallet.plop');
};
S.walletGone = function(){
  if (!on()) return; const t = S.ac.currentTime;
  noise(t, 0.16, 0.14, 'bandpass', 900, 0.8, bus, 3600); osc(hz(91), 'sine', t + 0.1, 0.08, 0.09, bus); osc(hz(98), 'sine', t + 0.16, 0.07, 0.12, bus); note('wallet.gone');
};
S.reject = function(){ if (!on()) return; const t = S.ac.currentTime; osc(170, 'triangle', t, 0.28, 0.035, bus, 0.002, 120); osc(140, 'triangle', t + 0.09, 0.26, 0.04, bus, 0.002, 100); note('reject'); };
S.reveal = function(kind){ if (!on()) return; const t = S.ac.currentTime; noise(t, 0.1, 0.12, 'bandpass', 1800, 1, bus, 5000); S.clink(kind, 5, 0.5, 0.05); S.clink(kind, 7, 0.4, 0.12); note('secret.reveal'); };
S.tick = function(){ if (!on()) return; const t = S.ac.currentTime; if (t - tickAt < 0.2) return; tickAt = t; osc(1900, 'square', t, 0.035, 0.008, bus, 0.001); osc(1200, 'sine', t, 0.03, 0.012, bus, 0.001); };
let uiN = 0;
S.ui = function(){ if (!on()) return; S.clink(0, 3 + (uiN++ % 3), 0.55); };                // кнопки звенят золотой монетой
// Каскад на старте уровня: монеты ссыпаются в столбики — короткая лесенка вверх.
S.cascade = function(kinds){ if (!on()) return; for (let i = 0; i < 9; i++) S.clink(kinds[i % kinds.length], i, 0.3, 0.12 + i * 0.07); note('level.cascade'); };
// Перекат монет по лотку: уровень 0…1 (сколько монет катится сейчас).
S.setRoll = function(level){ if (!S.ac || !rollG) return; const t = S.ac.currentTime, v = on() ? level * CFG.sfx.rollGain : 0; rollG.gain.setTargetAtTime(v, t, 0.04); S._rollAm.gain.setTargetAtTime(v * 0.5, t, 0.04); };
// Разгон диска: уровень 0…1 — гул поднимается по высоте и громкости.
S.setSpin = function(level){
  if (!S.ac || !spinG) return; const t = S.ac.currentTime, v = on() ? level : 0;
  spinG.gain.setTargetAtTime(v * 0.07, t, 0.12); spinN.gain.setTargetAtTime(v * 0.16, t, 0.12);
  spinOsc.frequency.setTargetAtTime(70 + 130 * level, t, 0.25); spinF.frequency.setTargetAtTime(420 + 1900 * level, t, 0.25);
};
// Монета Эйлера: дребезг учащается и гаснет (dur — длительность в реальных секундах).
S.eulerSpin = function(kind, dur){
  if (!on()) return; const tm = TIMBRE[CFG.metals[kind].sound], t0 = S.ac.currentTime, out = S.ac.createGain(); out.gain.value = 1; out.connect(bus);
  let t = 0, gap = 0.1, n = 0;
  while (t < dur && n < 90){
    const u = t / dur, f = scaleHz(tm.base, 0) * (1.6 + 1.5 * u) * jit(0.02);
    osc(f, 'sine', t0 + t, 0.12 * (1 - u * 0.75) * loud(f), 0.012 + 0.03 * (1 - u), out, 0.001);
    noise(t0 + t, 0.012, 0.07 * (1 - u * 0.6), 'bandpass', 3800, 1.2, out);
    gap = Math.max(0.011, gap * 0.93); t += gap; n++;
  }
  ring(tm, scaleHz(tm.base, 0) * 0.5, t0 + dur, 0.5, out, 0.6);                      // легла
  note('euler.spin', dur.toFixed(2));
};
S.scatter = function(kinds){ if (!on()) return; kinds.forEach((k, i) => S.clink(k, 8 - (i % 8), 0.5 + rnd() * 0.3, 0.02 + i * 0.045 + rnd() * 0.03)); osc(98, 'sawtooth', S.ac.currentTime, 0.14, 0.2, bus, 0.01, 46); note('lose.scatter'); };
// Финал: хлопок дверцы, треск диска замка, щелчки барабана счётчика, итоговый аккорд.
S.doorSlam = function(){
  if (!on()) return; const t = S.ac.currentTime;
  osc(92, 'sine', t, 0.75, 0.1, bus, 0.002, 40); noise(t, 0.09, 0.5, 'lowpass', 520, 0.7); osc(620, 'triangle', t, 0.1, 0.16, bus); osc(1474, 'sine', t, 0.05, 0.22, bus); note('safe.door');
};
S.dial = function(n, dur){ if (!on()) return; const t = S.ac.currentTime; for (let k = 0; k < n; k++){ const u = k / n, tt = t + dur * (1 - Math.pow(1 - u, 2)); noise(tt, 0.012, 0.16, 'bandpass', 2800 + 400 * (k % 3), 2.2); osc(1500, 'square', tt, 0.02, 0.006, bus, 0.001); } note('safe.dial'); };
S.drumTick = function(u){ if (!on()) return; osc(scaleHz(72, Math.floor(u * 10)), 'triangle', S.ac.currentTime, 0.07, 0.02, bus, 0.001); };
S.win = function(){
  if (!on()) return; const t = S.ac.currentTime, tm = TIMBRE.gold, out = S.ac.createGain(); out.gain.value = 1; out.connect(bus);
  [0, 2, 3, 5, 7, 8, 10].forEach((st, k) => ring(tm, scaleHz(60, st), t + k * 0.055, 0.6, out, 2.2));
  osc(hz(36), 'sine', t, 0.3, 0.3, out); note('win');
};
S.lose = function(){ if (!on()) return; const t = S.ac.currentTime; osc(hz(55), 'triangle', t, 0.2, 0.25, bus, 0.01, hz(48)); osc(hz(58), 'triangle', t + 0.02, 0.14, 0.25, bus, 0.01, hz(51)); note('lose'); };
S.voices = () => voices.length;
return S;
})();
