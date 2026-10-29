// Púa: tuner, songbook with autoscroll, and voice/melody follower.
(function () {
  "use strict";
  const { Notes, Audio, Smoother, Songs } = window.Pua;
  const { Store } = Songs;
  const $ = (id) => document.getElementById(id);

  // ---------- preferences ----------
  const PREFS_KEY = "pua.prefs.v1";
  const prefs = Object.assign({ a4: 440, instrument: "guitar", tunings: {}, auto: true }, readJSON(PREFS_KEY));
  function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { return {}; } }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

  // Strings are listed from the lowest-pitched (thickest) to the highest, as they sit on the neck.
  const INSTRUMENTS = {
    guitar: {
      label: "Guitarra", minF: 60, maxF: 1100,
      tunings: {
        standard: { label: "Estándar (E A D G B E)", notes: ["E2", "A2", "D3", "G3", "B3", "E4"] },
        dropd: { label: "Drop D (D A D G B E)", notes: ["D2", "A2", "D3", "G3", "B3", "E4"] },
        halfdown: { label: "Medio tono abajo (Eb)", notes: ["D#2", "G#2", "C#3", "F#3", "A#3", "D#4"] },
        fulldown: { label: "Un tono abajo, en D (D G C F A D)", notes: ["D2", "G2", "C3", "F3", "A3", "D4"] },
        dropc: { label: "Drop C (C G C F A D)", notes: ["C2", "G2", "C3", "F3", "A3", "D4"] },
        opend: { label: "Open D (D A D F# A D)", notes: ["D2", "A2", "D3", "F#3", "A3", "D4"] },
        openg: { label: "Open G (D G D G B D)", notes: ["D2", "G2", "D3", "G3", "B3", "D4"] },
        opene: { label: "Open E (E B E G# B E)", notes: ["E2", "B2", "E3", "G#3", "B3", "E4"] },
        dadgad: { label: "DADGAD", notes: ["D2", "A2", "D3", "G3", "A3", "D4"] }
      }
    },
    bass: {
      label: "Bajo", minF: 28, maxF: 500,
      tunings: {
        standard: { label: "Estándar (E A D G)", notes: ["E1", "A1", "D2", "G2"] },
        dropd: { label: "Drop D (D A D G)", notes: ["D1", "A1", "D2", "G2"] },
        halfdown: { label: "Medio tono abajo (Eb)", notes: ["D#1", "G#1", "C#2", "F#2"] },
        fulldown: { label: "Un tono abajo, en D (D G C F)", notes: ["D1", "G1", "C2", "F2"] },
        five: { label: "5 cuerdas (B E A D G)", notes: ["B0", "E1", "A1", "D2", "G2"] },
        fivehigh: { label: "5 cuerdas agudo (E A D G C)", notes: ["E1", "A1", "D2", "G2", "C3"] }
      }
    },
    ukulele: {
      label: "Ukelele", minF: 120, maxF: 1100,
      tunings: {
        standard: { label: "Estándar (G C E A)", notes: ["G4", "C4", "E4", "A4"] },
        lowg: { label: "G grave (G C E A)", notes: ["G3", "C4", "E4", "A4"] },
        d: { label: "En D (A D F# B)", notes: ["A4", "D4", "F#4", "B4"] },
        halfdown: { label: "Medio tono abajo (F# B D# G#)", notes: ["F#4", "B3", "D#4", "G#4"] },
        baritone: { label: "Barítono (D G B E)", notes: ["D3", "G3", "B3", "E4"] }
      }
    }
  };
  if (!INSTRUMENTS[prefs.instrument]) prefs.instrument = "guitar";
  const instrument = () => INSTRUMENTS[prefs.instrument];
  const tuningKey = () => {
    const k = prefs.tunings[prefs.instrument];
    return instrument().tunings[k] ? k : "standard";
  };
  const currentTuning = () => instrument().tunings[tuningKey()];

  // ---------- toast ----------
  let toastTimer = 0;
  function toast(msg, ms = 2600) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- navigation ----------
  const views = { tuner: $("view-tuner"), songs: $("view-songs"), editor: $("view-editor"), song: $("view-song") };
  let currentView = "tuner";
  function show(name) {
    if (currentView === "song" && name !== "song") leaveSong();
    currentView = name;
    for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
    const tab = name === "tuner" ? "tuner" : "songs";
    document.querySelectorAll(".tab").forEach(b => {
      if (b.dataset.view === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
  }
  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.view === "songs") { renderList(); show("songs"); }
    else show("tuner");
  }));

  // ---------- microphone ----------
  async function ensureMic() {
    if (Audio.stream) return true;
    try {
      await Audio.startMic();
      $("mic-btn").textContent = "Micrófono activo";
      $("mic-btn").disabled = true;
      return true;
    } catch (err) {
      const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      toast(denied
        ? "Púa no tiene permiso para el micrófono. Actívalo en Ajustes › Safari › Micrófono."
        : (err && err.message) || "No se pudo abrir el micrófono.", 5000);
      return false;
    }
  }
  $("mic-btn").addEventListener("click", ensureMic);

  // =====================================================================
  // TUNER
  // =====================================================================
  const tuner = {
    strings: [], selected: 0, smoother: new Smoother(5), lastPitchAt: 0, okSince: 0, centsShown: 0
  };

  function buildGauge() {
    const g = $("gauge-ticks");
    const cx = 160, cy = 160;
    const ns = "http://www.w3.org/2000/svg";
    const arc = (r, a0, a1) => {
      const p = (a) => [cx + r * Math.sin(a * Math.PI / 180), cy - r * Math.cos(a * Math.PI / 180)];
      const [x0, y0] = p(a0), [x1, y1] = p(a1);
      return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    };
    const zone = document.createElementNS(ns, "path");
    zone.setAttribute("d", arc(120, -6, 6));
    zone.setAttribute("class", "zone");
    g.appendChild(zone);
    for (let c = -50; c <= 50; c += 5) {
      const a = c * 1.2 * Math.PI / 180;
      const major = c % 10 === 0;
      const r0 = major ? 106 : 112, r1 = 128;
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", (cx + r0 * Math.sin(a)).toFixed(1));
      line.setAttribute("y1", (cy - r0 * Math.cos(a)).toFixed(1));
      line.setAttribute("x2", (cx + r1 * Math.sin(a)).toFixed(1));
      line.setAttribute("y2", (cy - r1 * Math.cos(a)).toFixed(1));
      line.setAttribute("class", "tick" + (major ? " major" : "") + (c === 0 ? " zero" : ""));
      g.appendChild(line);
      if (c % 25 === 0 && c !== 0) {
        const tx = document.createElementNS(ns, "text");
        tx.setAttribute("x", (cx + 144 * Math.sin(a)).toFixed(1));
        tx.setAttribute("y", (cy - 144 * Math.cos(a) + 4).toFixed(1));
        tx.setAttribute("class", "tick-num");
        tx.textContent = (c > 0 ? "+" : "") + c;
        g.appendChild(tx);
      }
    }
  }

  function buildInstrumentPicker() {
    const wrap = $("instrument-picker");
    wrap.innerHTML = "";
    for (const [k, ins] of Object.entries(INSTRUMENTS)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "seg";
      b.textContent = ins.label;
      b.setAttribute("aria-pressed", String(k === prefs.instrument));
      b.addEventListener("click", () => {
        prefs.instrument = k;
        savePrefs();
        tuner.selected = 0;
        tuner.smoother.reset();
        buildInstrumentPicker();
        buildTuningSelect();
        buildStrings();
      });
      wrap.appendChild(b);
    }
  }

  function buildTuningSelect() {
    const sel = $("tuning-select");
    sel.innerHTML = "";
    for (const [k, t] of Object.entries(instrument().tunings)) {
      const o = document.createElement("option");
      o.value = k; o.textContent = t.label;
      sel.appendChild(o);
    }
    sel.value = tuningKey();
  }
  $("tuning-select").addEventListener("change", (e) => {
    prefs.tunings[prefs.instrument] = e.target.value;
    savePrefs();
    tuner.selected = 0;
    buildStrings();
  });

  function buildStrings() {
    const wrap = $("strings");
    wrap.innerHTML = "";
    const notes = currentTuning().notes;
    const n = notes.length;
    wrap.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    tuner.strings = notes.map((note, i) => {
      const midi = Notes.parse(note);
      const num = n - i;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "string-btn";
      b.innerHTML = `<b>${Notes.name(midi).replace("#", "♯")}</b><small>${num}ª · ${Notes.octave(midi)}</small>`;
      b.setAttribute("aria-label", `Cuerda ${num}, ${Notes.solfa(midi)}${Notes.octave(midi)}`);
      b.addEventListener("click", () => {
        tuner.selected = i;
        if (!prefs.auto) Audio.playTone(Notes.midiToFreq(midi, prefs.a4));
        markActive(i);
      });
      wrap.appendChild(b);
      return { midi, el: b };
    });
    markActive(tuner.selected);
  }
  function markActive(i) {
    tuner.strings.forEach((s, j) => s.el.dataset.active = String(j === i));
  }

  function renderRef() { $("ref-out").textContent = `La = ${prefs.a4} Hz`; }
  $("ref-down").addEventListener("click", () => { prefs.a4 = Math.max(415, prefs.a4 - 1); savePrefs(); renderRef(); });
  $("ref-up").addEventListener("click", () => { prefs.a4 = Math.min(466, prefs.a4 + 1); savePrefs(); renderRef(); });
  $("auto-string").checked = prefs.auto;
  $("auto-string").addEventListener("change", (e) => { prefs.auto = e.target.checked; savePrefs(); updateHint(); });
  function updateHint() {
    $("tuner-hint").textContent = prefs.auto
      ? "Púa reconoce qué cuerda estás tocando. Apaga «Detectar cuerda» para elegirla tú y oír su nota."
      : "Toca una cuerda de arriba para oír su nota de referencia y afinar esa cuerda.";
  }

  function tunerFrame(now, reading) {
    const needle = $("needle"), big = $("note-big"), pill = $("state-out");
    if (!reading.freq) {
      if (now - tuner.lastPitchAt > 1200) {
        pill.dataset.state = "idle";
        pill.textContent = Audio.running ? "Esperando" : "Micrófono apagado";
        big.dataset.state = "";
        needle.dataset.state = "";
        tuner.smoother.reset();
      }
      return;
    }
    tuner.lastPitchAt = now;
    const freq = tuner.smoother.push(reading.freq);
    const midi = Notes.freqToMidi(freq, prefs.a4);

    let target, stringIdx = -1;
    if (prefs.auto) {
      let best = 0, bestD = Infinity;
      tuner.strings.forEach((s, i) => { const d = Math.abs(midi - s.midi); if (d < bestD) { bestD = d; best = i; } });
      if (bestD <= 3.5) { target = tuner.strings[best].midi; stringIdx = best; }
      else target = Math.round(midi);
      if (stringIdx >= 0 && stringIdx !== tuner.selected) { tuner.selected = stringIdx; markActive(stringIdx); }
    } else {
      stringIdx = tuner.selected;
      target = tuner.strings[stringIdx].midi;
    }

    const cents = (midi - target) * 100;
    tuner.centsShown += (cents - tuner.centsShown) * 0.45;
    const shown = Math.max(-50, Math.min(50, tuner.centsShown));
    needle.style.transform = `rotate(${(shown * 1.2).toFixed(2)}deg)`;

    big.textContent = Notes.name(target).replace("#", "♯");
    $("note-solfa").textContent = Notes.solfa(target);
    $("note-octave").textContent = stringIdx >= 0 ? `· cuerda ${tuner.strings.length - stringIdx}` : `· octava ${Notes.octave(target)}`;
    $("cents-out").textContent = `${cents > 0 ? "+" : ""}${Math.round(cents)} cents`;
    $("hz-out").textContent = `${freq.toFixed(1)} Hz`;

    let state;
    if (Math.abs(cents) <= 5) state = "ok";
    else state = cents > 0 ? "sharp" : "flat";
    if (Math.abs(cents) > 300) { pill.textContent = cents > 0 ? "Muy alto · afloja" : "Muy bajo · tensa"; }
    else pill.textContent = state === "ok" ? "Afinada" : state === "sharp" ? "Alto · afloja" : "Bajo · tensa";
    pill.dataset.state = state;
    big.dataset.state = state === "ok" ? "ok" : "";
    needle.dataset.state = state === "ok" ? "ok" : "";

    if (state === "ok" && stringIdx >= 0) {
      if (!tuner.okSince) tuner.okSince = now;
      if (now - tuner.okSince > 600) tuner.strings[stringIdx].el.dataset.tuned = "true";
    } else tuner.okSince = 0;
  }

  // =====================================================================
  // SONG LIST
  // =====================================================================
  function renderList() {
    const q = $("song-search").value.trim().toLowerCase();
    const list = $("song-list");
    list.innerHTML = "";
    const items = Store.songs
      .filter(s => !q || (s.title + " " + s.artist).toLowerCase().includes(q))
      .sort((a, b) => (a.example - b.example) || a.title.localeCompare(b.title, "es"));
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = q ? "Ninguna canción coincide con la búsqueda." : "Todavía no hay canciones. Toca «Nueva» y pega una tab.";
      list.appendChild(li);
      return;
    }
    for (const s of items) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "song-item";
      const main = document.createElement("span");
      main.className = "si-main";
      const t = document.createElement("span"); t.className = "si-title"; t.textContent = s.title;
      const a = document.createElement("span"); a.className = "si-artist"; a.textContent = s.artist || "Sin artista";
      main.append(t, a);
      const tags = document.createElement("span");
      tags.className = "si-tags";
      if (s.example) tags.insertAdjacentHTML("beforeend", `<span class="tag example">ejemplo</span>`);
      if (+s.capo) tags.insertAdjacentHTML("beforeend", `<span class="tag">capo ${+s.capo}</span>`);
      if (s.key) { const k = document.createElement("span"); k.className = "tag"; k.textContent = s.key; tags.appendChild(k); }
      b.append(main, tags);
      b.addEventListener("click", () => openSong(s.id));
      li.appendChild(b);
      list.appendChild(li);
    }
  }
  $("song-search").addEventListener("input", renderList);

  $("export-btn").addEventListener("click", async () => {
    const json = Store.exportJSON();
    const name = `pua-canciones-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: "application/json" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "Canciones de Púa" });
        return;
      }
    } catch (e) { if (e && e.name === "AbortError") return; }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("Copia exportada.");
  });
  $("import-input").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const r = Store.importJSON(await f.text());
      renderList();
      toast(`Importadas: ${r.added} nuevas, ${r.updated} actualizadas.`);
    } catch (err) {
      toast("No se pudo leer el archivo. Elige una copia exportada desde Púa.", 4000);
    }
  });

  // ---------- quick import ----------
  function updateImportLinks() {
    const q = $("import-query").value.trim();
    const words = q.replace(/\s+[-–—]\s+/g, " ");
    $("imp-lacuerda").href = q ? `https://acordes.lacuerda.net/busca.php?exp=${encodeURIComponent(words)}` : "https://acordes.lacuerda.net/";
    $("imp-ug").href = q ? `https://www.ultimate-guitar.com/search.php?search_type=title&value=${encodeURIComponent(words)}` : "https://www.ultimate-guitar.com/";
    $("imp-cifra").href = q ? `https://duckduckgo.com/?q=${encodeURIComponent(words + " site:cifraclub.com")}` : "https://www.cifraclub.com/";
  }
  $("import-query").addEventListener("input", updateImportLinks);

  function importText(text) {
    if (!text || !text.trim()) { toast("No hay texto para importar. Copia la canción y vuelve a intentarlo."); return false; }
    const r = Songs.cleanImport(text, $("import-query").value);
    if (!r.body.trim()) { toast("No encontré una canción en el texto pegado.", 4000); return false; }
    const song = {
      id: Songs.newId(), title: r.title, artist: r.artist, capo: r.capo, speed: 5, key: r.key,
      body: r.body, transpose: 0, fontSize: 15, example: false
    };
    if (!Store.upsert(song)) { toast("No se pudo guardar: el almacenamiento del teléfono está lleno o bloqueado.", 5000); return false; }
    $("import-query").value = "";
    updateImportLinks();
    $("paste-area").value = "";
    $("paste-fallback").hidden = true;
    openSong(song.id);
    toast(r.stats.hasMusic
      ? "Canción importada. Si algo quedó mal, toca «Editar»."
      : "Importé el texto, pero no encontré acordes. Revísalo con «Editar».", 4000);
    return true;
  }

  $("paste-btn").addEventListener("click", async () => {
    let text = "";
    try {
      if (navigator.clipboard && navigator.clipboard.readText) text = await navigator.clipboard.readText();
    } catch (e) { text = ""; }
    if (text && text.trim()) { importText(text); return; }
    // Clipboard reading refused or empty: let the user paste into a box instead.
    $("paste-fallback").hidden = false;
    $("paste-area").focus();
  });
  $("paste-import").addEventListener("click", () => importText($("paste-area").value));
  $("paste-cancel").addEventListener("click", () => { $("paste-area").value = ""; $("paste-fallback").hidden = true; });

  // =====================================================================
  // EDITOR
  // =====================================================================
  let editingId = null, editorReturn = "songs";
  function openEditor(id) {
    const s = id ? Store.get(id) : null;
    editingId = s ? s.id : null;
    editorReturn = currentView === "song" ? "song" : "songs";
    $("editor-title").textContent = s ? "Editar canción" : "Nueva canción";
    $("ed-title").value = s ? s.title : "";
    $("ed-artist").value = s ? s.artist : "";
    $("ed-capo").value = s ? s.capo : 0;
    $("ed-speed").value = s ? s.speed : 5;
    $("ed-key").value = s ? s.key : "";
    $("ed-body").value = s ? s.body : "";
    $("delete-zone").hidden = !s;
    $("delete-confirm").hidden = true;
    $("delete-btn").hidden = false;
    updateFindLinks();
    show("editor");
    views.editor.scrollTop = 0;
    if (!s) setTimeout(() => $("ed-title").focus(), 50);
  }
  function updateFindLinks() {
    const q = [$("ed-title").value, $("ed-artist").value].join(" ").trim();
    const search = (site, extra) => `https://duckduckgo.com/?q=${encodeURIComponent(`${extra} ${q} site:${site}`.trim())}`;
    $("find-lacuerda").href = q ? search("lacuerda.net", "acordes") : "https://acordes.lacuerda.net/";
    $("find-cifra").href = q ? search("cifraclub.com", "") : "https://www.cifraclub.com/";
    $("find-ug").href = q ? search("ultimate-guitar.com", "tab") : "https://www.ultimate-guitar.com/";
  }
  $("ed-title").addEventListener("input", updateFindLinks);
  $("ed-artist").addEventListener("input", updateFindLinks);
  $("new-song-btn").addEventListener("click", () => openEditor(null));
  $("editor-cancel").addEventListener("click", () => {
    if (editorReturn === "song" && editingId) openSong(editingId); else { renderList(); show("songs"); }
  });
  $("editor-form").addEventListener("submit", (e) => { e.preventDefault(); saveEditor(); });
  $("editor-save").addEventListener("click", saveEditor);
  function saveEditor() {
    const title = $("ed-title").value.trim();
    if (!title) { toast("Ponle un título a la canción."); $("ed-title").focus(); return; }
    const old = editingId ? Store.get(editingId) : null;
    const song = Object.assign({ transpose: 0, fontSize: 15, example: false }, old || {}, {
      id: editingId || Songs.newId(),
      title,
      artist: $("ed-artist").value.trim(),
      capo: Math.max(0, Math.min(12, parseInt($("ed-capo").value, 10) || 0)),
      speed: Math.max(1, Math.min(20, parseInt($("ed-speed").value, 10) || 5)),
      key: $("ed-key").value.trim(),
      body: $("ed-body").value
    });
    if (!Store.upsert(song)) { toast("No se pudo guardar: el almacenamiento del teléfono está lleno o bloqueado.", 5000); return; }
    toast("Canción guardada.");
    openSong(song.id);
  }
  $("delete-btn").addEventListener("click", () => { $("delete-confirm").hidden = false; $("delete-btn").hidden = true; });
  $("delete-no").addEventListener("click", () => { $("delete-confirm").hidden = true; $("delete-btn").hidden = false; });
  $("delete-yes").addEventListener("click", () => {
    if (!editingId) return;
    Store.remove(editingId);
    editingId = null;
    toast("Canción borrada.");
    renderList();
    show("songs");
  });

  // =====================================================================
  // SONG VIEW
  // =====================================================================
  const song = {
    data: null, lines: [], tops: [], playing: false, pos: 0, lastSet: -1, lastFrame: 0,
    current: -1, wake: null, voice: false, follow: false, lastSoundAt: 0,
    targets: [], next: 0, holdSince: 0, history: [], lastHit: null
  };
  const scroller = $("song-scroll");

  function openSong(id) {
    const s = Store.get(id);
    if (!s) { renderList(); show("songs"); return; }
    song.data = s;
    $("song-title").textContent = s.title;
    renderSong();
    show("song");
    stopScroll();
    scroller.scrollTop = 0;
    song.pos = 0;
    measureLines();
    layoutPlayhead();
    requestWake();
  }
  function leaveSong() {
    stopScroll();
    releaseWake();
  }
  $("song-back").addEventListener("click", () => { renderList(); show("songs"); });
  $("song-edit").addEventListener("click", () => song.data && openEditor(song.data.id));

  function renderMeta() {
    const s = song.data;
    const parts = [];
    if (s.artist) parts.push(s.artist);
    if (+s.capo) parts.push(`Capo ${s.capo}`);
    if (s.key) parts.push(`Tono ${Songs.transposeChord(s.key, s.transpose || 0)}`);
    $("song-meta").textContent = parts.join(" · ");
  }

  function renderSong() {
    const s = song.data;
    const steps = s.transpose || 0;
    const { lines } = Songs.parse(s.body);
    const body = $("song-body");
    body.innerHTML = "";
    body.style.setProperty("--song-size", (s.fontSize || 15) + "px");
    song.lines = [];
    for (const item of lines) {
      if (item.notes) {
        const nr = document.createElement("div");
        nr.className = "notes-row";
        nr.setAttribute("aria-label", "Notas de la melodía");
        item.notes.forEach(n => { const sp = document.createElement("span"); sp.textContent = n.label; nr.appendChild(sp); });
        body.appendChild(nr);
      }
      const el = document.createElement("div");
      el.className = "ln";
      if (item.type === "chordpro") {
        for (const seg of Songs.chordproSegments(item.text)) {
          const w = document.createElement("span");
          w.className = "cp";
          const c = document.createElement("span"); c.className = "c"; c.textContent = seg.chord ? Songs.transposeChord(seg.chord, steps) : "";
          const t = document.createElement("span"); t.className = "t"; t.textContent = seg.text || (seg.chord ? " " : "");
          w.append(c, t);
          el.appendChild(w);
        }
      } else if (item.type === "chords") {
        el.classList.add("chords");
        el.textContent = Songs.transposeChordLine(item.text, steps);
      } else if (item.type === "tab") {
        el.classList.add("tabline");
        el.textContent = item.text;
      } else if (item.type === "section") {
        el.classList.add("section");
        el.textContent = item.text;
      } else if (item.type === "comment") {
        el.classList.add("comment");
        el.textContent = item.text;
      } else {
        el.textContent = item.text || " ";
      }
      body.appendChild(el);
      song.lines.push({ el, notes: item.notes || null, type: item.type });
    }
    $("speed-out").textContent = `Vel ${s.speed || 5}`;
    $("transpose-out").textContent = `Tono ${steps > 0 ? "+" : ""}${steps}`;
    renderMeta();
    song.current = -1;
    measureLines();
  }

  // Line positions inside the scroll content (both offsets share the song view as offsetParent).
  function measureLines() {
    const base = scroller.offsetTop;
    song.tops = song.lines.map(l => l.el.offsetTop - base);
  }
  function layoutPlayhead() {
    const pad = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
    document.querySelector(".playhead").style.top = (scroller.offsetTop + pad + 2) + "px";
  }
  window.addEventListener("resize", () => { if (currentView === "song") { measureLines(); layoutPlayhead(); } });

  // Persist per-song view settings without hammering storage.
  let saveTimer = 0;
  function saveSongSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => song.data && Store.upsert(song.data), 400);
  }

  $("speed-down").addEventListener("click", () => setSpeed((song.data.speed || 5) - 1));
  $("speed-up").addEventListener("click", () => setSpeed((song.data.speed || 5) + 1));
  function setSpeed(v) {
    song.data.speed = Math.max(1, Math.min(20, v));
    $("speed-out").textContent = `Vel ${song.data.speed}`;
    saveSongSoon();
  }
  $("transpose-down").addEventListener("click", () => setTranspose((song.data.transpose || 0) - 1));
  $("transpose-up").addEventListener("click", () => setTranspose((song.data.transpose || 0) + 1));
  function setTranspose(v) {
    song.data.transpose = Math.max(-11, Math.min(11, v));
    keepPosition(renderSong);
    saveSongSoon();
  }
  $("font-down").addEventListener("click", () => setFont((song.data.fontSize || 15) - 1));
  $("font-up").addEventListener("click", () => setFont((song.data.fontSize || 15) + 1));
  function setFont(v) {
    song.data.fontSize = Math.max(11, Math.min(26, v));
    keepPosition(() => { $("song-body").style.setProperty("--song-size", song.data.fontSize + "px"); measureLines(); });
    saveSongSoon();
  }
  // Re-render while keeping the line under the playhead in place.
  function keepPosition(fn) {
    const idx = Math.max(0, song.current);
    const before = song.tops[idx] || 0;
    const offset = scroller.scrollTop - before;
    fn();
    const after = song.tops[idx] || 0;
    scroller.scrollTop = Math.max(0, after + offset);
    song.pos = scroller.scrollTop;
  }

  // ---------- autoscroll ----------
  function pxPerSecond() { return 6 + (song.data.speed || 5) * 5; }
  function startScroll() {
    song.playing = true;
    song.pos = scroller.scrollTop;
    song.lastFrame = 0;
    $("play-btn").textContent = "❚❚";
    $("play-btn").setAttribute("aria-label", "Pausar desplazamiento");
    requestWake();
  }
  function stopScroll() {
    song.playing = false;
    $("play-btn").textContent = "▶";
    $("play-btn").setAttribute("aria-label", "Iniciar desplazamiento");
  }
  $("play-btn").addEventListener("click", () => (song.playing ? stopScroll() : startScroll()));

  // Tap the text to pause or resume; dragging just moves the text.
  let touchMoved = false, touchY = 0;
  scroller.addEventListener("pointerdown", (e) => { touchMoved = false; touchY = e.clientY; });
  scroller.addEventListener("pointermove", (e) => { if (Math.abs(e.clientY - touchY) > 8) touchMoved = true; });
  scroller.addEventListener("click", (e) => {
    if (touchMoved || e.target.closest("a,button")) return;
    song.playing ? stopScroll() : startScroll();
  });
  scroller.addEventListener("scroll", () => {
    if (Math.abs(scroller.scrollTop - song.lastSet) > 2) song.pos = scroller.scrollTop;
  }, { passive: true });

  function songFrame(now) {
    if (song.playing) {
      const dt = song.lastFrame ? Math.min(0.25, (now - song.lastFrame) / 1000) : 0;
      const sounding = !song.follow || now - song.lastSoundAt < 700;
      if (sounding) song.pos += pxPerSecond() * dt;
      const max = scroller.scrollHeight - scroller.clientHeight;
      if (song.pos >= max) { song.pos = max; stopScroll(); }
      scroller.scrollTop = song.pos;
      song.lastSet = scroller.scrollTop;
    }
    song.lastFrame = now;
    updateCurrentLine();
  }

  function updateCurrentLine() {
    if (!song.lines.length) return;
    const pad = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
    const y = scroller.scrollTop + 4;
    // Last line whose top is at or above the playhead (tops are relative to the body, which starts at `pad`).
    let lo = 0, hi = song.tops.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (song.tops[mid] - pad <= y) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx === song.current) return;
    if (song.current >= 0 && song.lines[song.current]) song.lines[song.current].el.classList.remove("current");
    song.current = idx;
    song.lines[idx].el.classList.add("current");
    setTargetsFor(idx);
  }

  // ---------- wake lock ----------
  async function requestWake() {
    try {
      if ("wakeLock" in navigator && !song.wake && document.visibilityState === "visible") {
        song.wake = await navigator.wakeLock.request("screen");
        song.wake.addEventListener("release", () => { song.wake = null; });
      }
    } catch (e) { song.wake = null; }
  }
  function releaseWake() { try { song.wake && song.wake.release(); } catch (e) {} song.wake = null; }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && currentView === "song") requestWake();
  });

  // ---------- voice & melody ----------
  $("voice-btn").addEventListener("click", async () => {
    if (!song.voice && !(await ensureMic())) return;
    song.voice = !song.voice;
    $("voice-btn").setAttribute("aria-pressed", String(song.voice));
    $("voice-panel").hidden = !song.voice;
    song.history = [];
    keepPosition(measureLines);
    if (song.voice) { sizeCanvas(); setTargetsFor(song.current); }
  });
  $("follow-btn").addEventListener("click", async () => {
    if (!song.follow && !(await ensureMic())) return;
    song.follow = !song.follow;
    $("follow-btn").setAttribute("aria-pressed", String(song.follow));
    toast(song.follow ? "El texto avanza solo mientras suena la guitarra o tu voz." : "Desplazamiento continuo.");
  });

  // Melody for the current line: its own notes, or the nearest earlier line with notes
  // when the current line is the lyric under a chord or tab line.
  function setTargetsFor(idx) {
    let notes = null;
    for (let i = idx; i >= 0 && i >= idx - 1; i--) if (song.lines[i] && song.lines[i].notes) { notes = song.lines[i].notes; break; }
    if (!notes) for (let i = idx + 1; i <= idx + 1 && i < song.lines.length; i++) if (song.lines[i].notes) { notes = song.lines[i].notes; break; }
    if (notes === song.targets) return;
    song.targets = notes || [];
    song.next = 0;
    song.holdSince = 0;
    song.lastHit = null;
    renderChips();
  }
  function renderChips() {
    const wrap = $("target-chips");
    wrap.innerHTML = "";
    if (!song.targets.length) {
      wrap.innerHTML = `<span class="muted">Esta línea no tiene notas de melodía.</span>`;
      $("line-score").textContent = "";
      return;
    }
    song.targets.forEach((n, i) => {
      const c = document.createElement("span");
      c.className = "tchip" + (i < song.next ? " hit" : i === song.next ? " next" : "");
      c.textContent = n.label;
      wrap.appendChild(c);
    });
    $("line-score").textContent = `${song.next}/${song.targets.length}`;
    const nextEl = wrap.children[Math.min(song.next, wrap.children.length - 1)];
    if (nextEl) wrap.scrollLeft = nextEl.offsetLeft - wrap.clientWidth / 2;
  }

  // Shift a detected pitch by whole octaves so it lands nearest the reference note.
  const fold = (m, ref) => m + 12 * Math.round((ref - m) / 12);

  function voiceFrame(now, reading) {
    const noteEl = $("voice-note");
    const midi = reading.freq ? Notes.freqToMidi(reading.freq, prefs.a4) : null;
    const target = song.targets[song.next];
    if (midi !== null) {
      noteEl.textContent = Notes.name(midi) + Notes.octave(midi);
      // After a hit, the same sustained note must stop or change before it can count again.
      if (song.lastHit !== null && Math.abs(fold(midi, song.lastHit) - song.lastHit) >= 0.5) song.lastHit = null;
      const ok = target && Math.abs(fold(midi, target.midi) - target.midi) < 0.5;
      noteEl.dataset.state = ok ? "ok" : "";
      if (ok && song.lastHit === null) {
        if (!song.holdSince) song.holdSince = now;
        if (now - song.holdSince > 110) { song.lastHit = target.midi; song.next++; song.holdSince = 0; renderChips(); }
      } else song.holdSince = 0;
    } else {
      noteEl.dataset.state = "";
      song.holdSince = 0;
      song.lastHit = null;
    }
    song.history.push({ t: now, m: midi });
    while (song.history.length && now - song.history[0].t > 5000) song.history.shift();
    drawVoice(now);
  }

  const canvas = $("voice-canvas");
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(90 * dpr);
  }
  window.addEventListener("resize", () => song.voice && sizeCanvas());

  function drawVoice(now) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width, H = canvas.height;
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    ctx.clearRect(0, 0, W, H);

    const tm = song.targets.map(n => n.midi);
    const ref = tm.length ? tm[Math.min(song.next, tm.length - 1)] : null;
    let lo, hi;
    if (tm.length) { lo = Math.min(...tm) - 3; hi = Math.max(...tm) + 3; }
    else {
      const recent = song.history.filter(h => h.m !== null).map(h => h.m);
      const c = recent.length ? recent[recent.length - 1] : 57;
      lo = c - 7; hi = c + 7;
    }
    const y = (m) => H - ((m - lo) / (hi - lo)) * H;

    // Target note lanes.
    ctx.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
    ctx.textBaseline = "middle";
    const seen = new Set();
    tm.forEach((m, i) => {
      if (seen.has(m) && i !== song.next) return;
      seen.add(m);
      const isNext = i === song.next;
      ctx.fillStyle = isNext ? col("--accent") : col("--line");
      ctx.globalAlpha = isNext ? 0.28 : 0.5;
      ctx.fillRect(0, y(m) - 3 * dpr, W, 6 * dpr);
      ctx.globalAlpha = 1;
      ctx.fillStyle = isNext ? col("--accent") : col("--muted");
      ctx.fillText(Notes.name(m) + Notes.octave(m), 4 * dpr, y(m) - 9 * dpr);
    });

    // Pitch trace, folded to the next target's octave.
    ctx.lineWidth = 3 * dpr;
    ctx.lineCap = "round";
    let prev = null;
    for (const h of song.history) {
      if (h.m === null) { prev = null; continue; }
      const m = ref !== null ? fold(h.m, ref) : h.m;
      const x = W - ((now - h.t) / 5000) * W;
      const yy = y(m);
      if (prev) {
        const ok = ref !== null && Math.abs(m - ref) < 0.5;
        ctx.strokeStyle = ok ? col("--ok") : col("--fg");
        ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, yy); ctx.stroke();
      }
      prev = { x, y: yy };
    }
  }

  // =====================================================================
  // MAIN LOOP
  // =====================================================================
  let lastRead = 0, reading = { freq: 0, clarity: 0, level: 0 };
  function loop(now) {
    const needAudio = Audio.running && (currentView === "tuner" || (currentView === "song" && (song.voice || song.follow)));
    const interval = currentView === "tuner" && instrument().minF < 40 ? 70 : 40;
    if (needAudio && now - lastRead > interval) {
      lastRead = now;
      reading = currentView === "tuner" ? Audio.read(instrument().minF, instrument().maxF) : Audio.read(70, 1100);
      if (reading.level > 0.02) song.lastSoundAt = now;
      if (currentView === "tuner") tunerFrame(now, reading);
      else if (song.voice) voiceFrame(now, reading);
    } else if (!Audio.running && currentView === "tuner" && now - lastRead > 400) {
      lastRead = now;
      tunerFrame(now, { freq: 0 });
    }
    if (currentView === "song") songFrame(now);
    requestAnimationFrame(loop);
  }

  // ---------- boot ----------
  Store.load();
  buildGauge();
  buildInstrumentPicker();
  buildTuningSelect();
  buildStrings();
  renderRef();
  updateHint();
  renderList();
  requestAnimationFrame(loop);

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Exposed for testing in the browser console.
  window.Pua.app = { show, openSong, song, tuner, prefs, voiceFrame, songFrame, updateCurrentLine, measureLines };
})();
