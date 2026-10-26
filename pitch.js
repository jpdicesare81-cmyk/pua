// Pitch detection (YIN), microphone input, reference tones and note math.
(function () {
  "use strict";

  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const SOLFA = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];
  const FLAT_TO_SHARP = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#", Cb: "B", Fb: "E" };
  const SOLFA_TO_LETTER = { do: "C", re: "D", mi: "E", fa: "F", sol: "G", la: "A", si: "B" };

  const Notes = {
    NAMES, SOLFA,
    freqToMidi(f, a4) { return 69 + 12 * Math.log2(f / a4); },
    midiToFreq(m, a4) { return a4 * Math.pow(2, (m - 69) / 12); },
    name(m) { return NAMES[((Math.round(m) % 12) + 12) % 12]; },
    solfa(m) { return SOLFA[((Math.round(m) % 12) + 12) % 12]; },
    octave(m) { return Math.floor(Math.round(m) / 12) - 1; },
    // "E2", "Eb3", "F#4", "Mi4", "Sol#3", "sib2" -> MIDI number, or null.
    parse(str) {
      const s = String(str).trim();
      let m = s.match(/^([A-Ga-g])([#b]?)(-?\d)$/);
      let letter, acc, oct;
      if (m) { letter = m[1].toUpperCase(); acc = m[2]; oct = +m[3]; }
      else {
        m = s.match(/^(do|re|mi|fa|sol|la|si)([#b]?)(-?\d)$/i);
        if (!m) return null;
        letter = SOLFA_TO_LETTER[m[1].toLowerCase()]; acc = m[2]; oct = +m[3];
      }
      let name = letter + acc;
      if (acc === "b") name = FLAT_TO_SHARP[name] || name;
      const idx = NAMES.indexOf(name);
      if (idx < 0) return null;
      return (oct + 1) * 12 + idx;
    }
  };

  // YIN fundamental frequency estimator (de Cheveigné & Kawahara, 2002).
  // buf: Float32Array of 2*W samples. Returns {freq, clarity} or null.
  const yinScratch = { d: null };
  function yin(buf, sampleRate, minF, maxF, threshold) {
    const W = Math.floor(buf.length / 2);
    const tauMin = Math.max(2, Math.floor(sampleRate / maxF));
    const tauMax = Math.min(W - 1, Math.ceil(sampleRate / minF));
    if (!yinScratch.d || yinScratch.d.length < tauMax + 2) yinScratch.d = new Float32Array(tauMax + 2);
    const d = yinScratch.d;
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) {
        const diff = buf[j] - buf[j + tau];
        sum += diff * diff;
      }
      running += sum;
      d[tau] = running > 0 ? (sum * tau) / running : 1;
    }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < threshold) {
        while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      // No dip under the threshold: accept the global minimum only if it is reasonably clear.
      let best = tauMin;
      for (let t = tauMin + 1; t <= tauMax; t++) if (d[t] < d[best]) best = t;
      if (d[best] > 0.35) return null;
      tau = best;
    }
    // Parabolic interpolation around the dip.
    let better = tau;
    if (tau > 1 && tau < tauMax) {
      const a = d[tau - 1], b = d[tau], c = d[tau + 1];
      const denom = a + c - 2 * b;
      if (denom !== 0) better = tau + (a - c) / (2 * denom);
    }
    return { freq: sampleRate / better, clarity: 1 - d[tau] };
  }

  function rms(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  const Audio = {
    ctx: null, analyser: null, stream: null, source: null, testOsc: null,
    buf: new Float32Array(4096),
    get running() { return !!(this.ctx && (this.stream || this.testOsc)); },

    ensureContext() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this.ctx;
    },

    makeAnalyser() {
      if (this.analyser) return this.analyser;
      const a = this.ctx.createAnalyser();
      a.fftSize = 4096;
      a.smoothingTimeConstant = 0;
      this.analyser = a;
      return a;
    },

    async startMic() {
      this.ensureContext();
      if (this.stream) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Este navegador no permite usar el micrófono. Abre Púa en Safari con una dirección https.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      this.stopTest();
      this.stream = stream;
      this.source = this.ctx.createMediaStreamSource(stream);
      this.source.connect(this.makeAnalyser());
    },

    // Development aid: feed a synthetic tone instead of the microphone (Audio.startTest(110)).
    startTest(freq) {
      this.ensureContext();
      this.stopTest();
      const osc = this.ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.value = 0.3;
      osc.connect(g).connect(this.makeAnalyser());
      osc.start();
      this.testOsc = osc;
      return osc;
    },
    stopTest() {
      if (this.testOsc) { try { this.testOsc.stop(); } catch (e) {} this.testOsc = null; }
    },

    stop() {
      this.stopTest();
      if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
      if (this.source) { this.source.disconnect(); this.source = null; }
    },

    // One reading: {freq, clarity, level} with freq = 0 when silent or unclear.
    read(minF = 60, maxF = 1100) {
      if (!this.analyser) return { freq: 0, clarity: 0, level: 0 };
      this.analyser.getFloatTimeDomainData(this.buf);
      // Low notes (bass) need a longer window; use only as many recent samples as minF requires.
      const sr = this.ctx.sampleRate;
      const need = Math.min(this.buf.length, Math.max(2048, 2 * Math.ceil(sr / minF) + 64));
      const win = this.buf.subarray(this.buf.length - need);
      const level = rms(win);
      if (level < 0.008) return { freq: 0, clarity: 0, level };
      const r = yin(win, sr, minF, maxF, 0.12);
      if (!r || r.clarity < 0.75) return { freq: 0, clarity: r ? r.clarity : 0, level };
      return { freq: r.freq, clarity: r.clarity, level };
    },

    // Plucked-string style reference tone.
    playTone(freq, seconds = 1.8) {
      const ctx = this.ensureContext();
      const t = ctx.currentTime;
      const out = ctx.createGain();
      out.gain.setValueAtTime(0.0001, t);
      out.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
      out.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
      out.connect(ctx.destination);
      [[1, "triangle", 1], [2, "sine", 0.35], [3, "sine", 0.12]].forEach(([mult, type, amp]) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = freq * mult;
        const g = ctx.createGain();
        g.gain.value = amp;
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + seconds + 0.05);
      });
    }
  };

  // Median of the last few readings keeps the needle steady without lag.
  class Smoother {
    constructor(n = 5) { this.n = n; this.vals = []; }
    push(v) {
      this.vals.push(v);
      if (this.vals.length > this.n) this.vals.shift();
      const s = [...this.vals].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    }
    reset() { this.vals = []; }
  }

  window.Pua = window.Pua || {};
  Object.assign(window.Pua, { Notes, Audio, Smoother, yin });
})();
