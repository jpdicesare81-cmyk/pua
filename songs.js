// Song storage, text parsing (chord-over-lyrics, ChordPro, tabs) and transposition.
(function () {
  "use strict";
  const { Notes } = window.Pua;

  // ---------- chords ----------
  const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const SOLFA = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];
  const SOLFA_FLAT = ["Do", "Reb", "Re", "Mib", "Mi", "Fa", "Solb", "Sol", "Lab", "La", "Sib", "Si"];
  const LETTER_IDX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const SOLFA_IDX = { do: 0, re: 2, mi: 4, fa: 5, sol: 7, la: 9, si: 11 };

  const QUAL = "(?:maj|min|dim|aug|sus|add|m|M|º|°|\\+|-)?[0-9]*(?:(?:maj|sus|add|b|#|\\+|-)?[0-9]+)*(?:\\([^)\\s]*\\))?";
  const LETTER_ROOT = "[A-G](?:#|b)?";
  const SOLFA_ROOT = "(?:Do|Re|Mi|Fa|Sol|La|Si)(?:#|b)?";
  const CHORD_RE = new RegExp(`^(${LETTER_ROOT}|${SOLFA_ROOT})(${QUAL})(?:/(${LETTER_ROOT}|${SOLFA_ROOT}))?$`);

  function isChord(tok) { return CHORD_RE.test(tok); }

  function rootIndex(root) {
    const solfa = root.match(/^(Do|Re|Mi|Fa|Sol|La|Si)(#|b)?$/);
    let idx, acc;
    if (solfa) { idx = SOLFA_IDX[solfa[1].toLowerCase()]; acc = solfa[2]; }
    else { idx = LETTER_IDX[root[0]]; acc = root[1]; }
    if (acc === "#") idx += 1;
    if (acc === "b") idx -= 1;
    return { idx: (idx + 12) % 12, solfa: !!solfa, flat: acc === "b" };
  }
  function spell(idx, solfa, flat) {
    const table = solfa ? (flat ? SOLFA_FLAT : SOLFA) : (flat ? FLATS : SHARPS);
    return table[((idx % 12) + 12) % 12];
  }
  function transposeChord(chord, steps) {
    if (!steps) return chord;
    const m = chord.match(CHORD_RE);
    if (!m) return chord;
    const r = rootIndex(m[1]);
    const preferFlat = r.flat || (steps < 0 && !m[1].includes("#"));
    let out = spell(r.idx + steps, r.solfa, preferFlat) + m[2];
    if (m[3]) { const b = rootIndex(m[3]); out += "/" + spell(b.idx + steps, b.solfa, preferFlat); }
    return out;
  }

  // Transpose a chord line while keeping later chords near their original columns.
  function transposeChordLine(line, steps) {
    if (!steps) return line;
    let out = "", debt = 0;
    const re = /(\S+)|(\s+)/g;
    let m;
    while ((m = re.exec(line))) {
      if (m[1]) {
        const t = isChord(m[1]) ? transposeChord(m[1], steps) : m[1];
        debt += t.length - m[1].length;
        out += t;
      } else {
        let sp = m[2].length;
        if (debt > 0) { const take = Math.min(debt, sp - 1); sp -= take; debt -= take; }
        else if (debt < 0) { sp -= debt; debt = 0; }
        out += " ".repeat(sp);
      }
    }
    return out;
  }

  // ---------- line classification ----------
  const TAB_RE = /^\s*[A-Ga-g][#b]?\s*[|:]?[-–—0-9hpbr\/\\~x|().\s]*[-–—]{2,}/;
  const SECTION_RE = /^\s*\[([^\]]{2,40})\]\s*$/;
  const DIRECTIVE_RE = /^\s*\{\s*([a-zA-Záéíóú_]+)\s*:?\s*(.*?)\s*\}\s*$/;

  function classify(line) {
    if (!line.trim()) return { type: "blank" };
    const dir = line.match(DIRECTIVE_RE);
    if (dir) return { type: "directive", key: dir[1].toLowerCase(), value: dir[2] };
    if (TAB_RE.test(line)) return { type: "tab" };
    const sec = line.match(SECTION_RE);
    if (sec && !isChord(sec[1].trim())) return { type: "section", text: sec[1].trim() };
    const tokens = line.trim().split(/\s+/);
    const chordish = tokens.filter(t => isChord(t.replace(/[(),]/g, "")) || /^[|/x%-]+$/.test(t));
    if (tokens.length && chordish.length === tokens.length && tokens.some(t => isChord(t.replace(/[(),]/g, "")))) {
      return { type: "chords" };
    }
    if (/\[[^\]]+\]/.test(line)) {
      const inner = [...line.matchAll(/\[([^\]]+)\]/g)].map(x => x[1]);
      if (inner.length && inner.every(isChord)) return { type: "chordpro" };
    }
    return { type: "lyric" };
  }

  // Parse a song body into renderable lines. Each {notas: ...} directive attaches
  // its melody to the next line that has content.
  function parse(body) {
    const lines = String(body || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    const meta = {};
    let pendingNotes = null;
    for (const raw of lines) {
      const line = raw.replace(/\t/g, "    ").replace(/\s+$/, "");
      const c = classify(line);
      if (c.type === "directive") {
        if (["notas", "notes", "melodia", "melodía"].includes(c.key)) {
          pendingNotes = c.value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
            .map(s => ({ label: s, midi: Notes.parse(s) })).filter(n => n.midi !== null);
        } else if (["c", "comment", "comentario", "ci"].includes(c.key)) {
          out.push({ type: "comment", text: c.value });
        } else if (["title", "t", "titulo", "título"].includes(c.key)) meta.title = c.value;
        else if (["artist", "a", "artista", "subtitle", "st"].includes(c.key)) meta.artist = c.value;
        else if (c.key === "capo") meta.capo = c.value;
        else if (["soc", "start_of_chorus"].includes(c.key)) out.push({ type: "section", text: "Coro" });
        continue;
      }
      const item = { type: c.type, text: line };
      if (c.type === "section") item.text = c.text;
      if (pendingNotes && c.type !== "blank") { item.notes = pendingNotes; pendingNotes = null; }
      out.push(item);
    }
    return { lines: out, meta };
  }

  // Split a ChordPro line into [{chord, text}] segments.
  function chordproSegments(line) {
    const segs = [];
    const re = /\[([^\]]+)\]/g;
    let last = 0, chord = "", m;
    while ((m = re.exec(line))) {
      if (m.index > last || chord) segs.push({ chord, text: line.slice(last, m.index) });
      chord = m[1];
      last = re.lastIndex;
    }
    segs.push({ chord, text: line.slice(last) });
    return segs.filter((s, i) => i > 0 || s.chord || s.text);
  }

  // ---------- quick import ----------
  // Cleans text copied from a whole tab page (menus, ads, ratings, footer) down to the song,
  // and picks up title, artist, key and capo when the page shows them.
  const JUNK_RE = new RegExp("^(?:" + [
    "publicidad", "anuncio", "advertisement", "sponsored", "imprimir", "print", "compartir", "share",
    "descargar.*", "download.*", "pdf", "transponer.*", "transpose.*", "autoscroll.*", "auto ?scroll.*",
    "tama[ñn]o.*", "font.*", "ocultar.*", "mostrar.*", "show .*", "hide .*", "ver (?:video|v[ií]deo|acordes|diagramas).*",
    "video", "tutorial.*", "comentarios?.*", "comments?.*", "iniciar sesi[oó]n", "registrarse", "reg[ií]strate.*", "log ?in", "sign ?up",
    "cookies?.*", "pol[ií]tica de privacidad.*", "privacy.*", "t[eé]rminos.*", "terms.*", "contacto", "contact us",
    "(?:©|\\(c\\)|copyright).*", "todos los derechos.*", "all rights reserved.*",
    "calificar.*", "valoraci[oó]n.*", "votos?.*", "rating.*", "rate this.*", "[0-9.,]+ ?(?:★|estrellas|stars).*", "★+.*",
    "siguiente", "anterior", "next", "previous", "volver.*", "inicio", "home", "men[uú]", "buscar.*", "search.*",
    "facebook", "twitter", "x", "whatsapp", "instagram", "telegram", "pinterest", "email", "e-mail", "copiar enlace", "copy link",
    "lacuerda(?:\\.net)?.*", "cifra ?club.*", "ultimate[- ]guitar.*", "tabs?", "acordes", "chords", "letra", "lyrics", "tablatura", "tablature",
    "versi[oó]n \\d+.*", "ver(?:sion)? \\d+.*", "dificultad.*", "difficulty.*", "nivel.*", "strumming.*", "rasgueo.*",
    "acordes usados.*", "chords used.*", "diagramas.*", "afinaci[oó]n.*", "tuning.*", "key.*", "tono.*", "capo.*", "capotraste.*",
    "enviado por.*", "subido por.*", "submitted by.*", "transcri(?:to|bed) por.*", "author.*", "autor.*", "visitas.*", "views.*",
    "a[ñn]adir a .*", "agregar a .*", "add to .*", "favoritos", "favorites", "playlist.*", "reportar.*", "report.*", "editar", "edit",
    "\\d{1,3}(?:[.,]\\d{3})* (?:visitas|views|vistas).*", "\\d+"
  ].join("|") + ")$", "i");

  const KEY_RE = /(?:^|\s)(?:tono|tonalidad|key)\s*[:=-]?\s*((?:[A-G]|Do|Re|Mi|Fa|Sol|La|Si)(?:#|b)?m?)\b/i;
  const CAPO_RE = /\bcapo(?:traste)?\s*(?:en(?: el)?|on|:|-)?\s*(\d{1,2})/i;

  function isMusicLine(type) { return type === "chords" || type === "tab" || type === "chordpro"; }

  function cleanImport(text, hint) {
    const raw = String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[   ]/g, " ")
      .replace(/[​-‍﻿]/g, "")
      .replace(/\t/g, "    ");
    const lines = raw.split("\n").map(l => l.replace(/\s+$/, ""));

    const keyM = raw.match(KEY_RE);
    const capoM = raw.match(CAPO_RE);

    // Drop page furniture, but only short lines that are entirely a known label.
    const kept = lines.filter(l => {
      const t = l.trim();
      if (!t) return true;
      return !(t.length <= 60 && JUNK_RE.test(t.replace(/[:·•|»›]+\s*$/, "").trim()));
    });

    const types = kept.map(l => classify(l).type);
    let first = types.findIndex(isMusicLine);
    let last = -1;
    for (let i = types.length - 1; i >= 0; i--) if (isMusicLine(types[i])) { last = i; break; }

    let header = [], body;
    if (first < 0) {
      body = kept;  // Lyrics only: keep everything that survived the filter.
    } else {
      // Include section headers and lyric lines that sit right above the first chord line.
      let start = first;
      while (start > 0 && (types[start - 1] === "section" || (types[start - 1] === "lyric" && kept[start - 1].trim().length < 40 && /^\s*(intro|verso|coro|estribillo|puente|solo|final|outro|pre)/i.test(kept[start - 1])))) start--;
      // Carry on past the last chord line through the lyric paragraph that follows it.
      let end = last;
      let blanks = 0;
      for (let i = last + 1; i < kept.length; i++) {
        if (types[i] === "blank") { if (++blanks >= 2) break; continue; }
        if (types[i] !== "lyric" && types[i] !== "section") break;
        if (blanks && i - end > 12) break;
        blanks = 0;
        end = i;
      }
      header = kept.slice(0, start);
      body = kept.slice(start, end + 1);
    }

    // Collapse runs of blank lines and trim the ends.
    const tidy = [];
    for (const l of body) {
      if (!l.trim() && (!tidy.length || !tidy[tidy.length - 1].trim())) continue;
      tidy.push(l);
    }
    while (tidy.length && !tidy[tidy.length - 1].trim()) tidy.pop();

    // Title and artist: what the user typed wins; otherwise a "Song - Artist" style header line.
    let title = "", artist = "";
    const q = String(hint || "").trim();
    if (q) {
      const parts = q.split(/\s+[-–—]\s+|\s+de\s+(?=[A-ZÁÉÍÓÚÑ])/);
      title = parts[0].trim();
      artist = (parts[1] || "").trim();
    } else {
      const strip = (s) => s
        .replace(/\s*\((?:acordes|chords|tabs?|letra|tablatura|ver\.?\s*\d+)[^)]*\)\s*$/i, "")
        .replace(/^(?:acordes de|chords for|letra de|tabs? de)\s+/i, "")
        .replace(/\s+(?:acordes|chords|tabs?|letra|tablatura|ukulele|bass)(?:\s+(?:y|and)\s+\w+)?$/i, "")
        .trim();
      const cand = header.map(l => l.trim()).filter(l => l && l.length <= 120);
      const nice = (s) => {
        s = strip(s.replace(/\s*\((?:tab|acordes|chords|letra|ver\.?\s*\d+)\)\s*$/i, ""));
        if (s === s.toUpperCase()) s = s.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
        return s.charAt(0).toUpperCase() + s.slice(1);
      };
      // Breadcrumb: "Acordes de Guitarra » J » Artista » Canción (Tab)".
      const crumb = cand.find(l => (l.match(/\s*[»›]\s*/g) || []).length >= 2);
      if (crumb) {
        const parts = crumb.split(/\s*[»›]\s*/).map(s => s.trim()).filter(Boolean);
        title = nice(parts[parts.length - 1]);
        artist = nice(parts[parts.length - 2]);
      }
      // "CANCIÓN: Acordes y Letra para Guitarra (Artista)".
      if (!title) for (const l of cand) {
        const m = l.match(/^(.+?):\s*(?:acordes|chords|tabs?|letra)\b.*\(([^)]+)\)\s*$/i);
        if (m) { title = nice(m[1]); artist = nice(m[2]); break; }
      }
      for (const l of title ? [] : cand) {
        if (l.length > 80) continue;
        // "Song Chords by Artist" / "Canción, acordes por Artista": song first.
        let m = l.match(/^(.+?)\s+(?:by|por)\s+(.+)$/i);
        if (m) { title = strip(m[1].replace(/,\s*$/, "")); artist = strip(m[2]); break; }
        // "Artista - Canción": the usual order on Spanish tab sites.
        m = l.match(/^(.+?)\s+[-–—:]\s+(.+)$/);
        if (m) { artist = strip(m[1]); title = strip(m[2]); break; }
      }
      if (!title && cand.length) title = strip(cand[cand.length - 1]);
    }

    return {
      title: title || "Canción importada",
      artist,
      key: keyM ? keyM[1] : "",
      capo: capoM ? Math.min(12, +capoM[1]) : 0,
      body: tidy.join("\n"),
      stats: { kept: tidy.length, dropped: lines.length - tidy.length, hasMusic: first >= 0 }
    };
  }

  // ---------- storage ----------
  const KEY = "pua.songs.v1";
  const Store = {
    songs: [],
    load() {
      let raw = null;
      try { raw = localStorage.getItem(KEY); } catch (e) {}
      if (raw === null) { this.songs = seedSongs(); this.save(); }
      else { try { this.songs = JSON.parse(raw) || []; } catch (e) { this.songs = []; } }
      try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
      return this.songs;
    },
    save() {
      try { localStorage.setItem(KEY, JSON.stringify(this.songs)); return true; }
      catch (e) { return false; }
    },
    get(id) { return this.songs.find(s => s.id === id); },
    upsert(song) {
      const i = this.songs.findIndex(s => s.id === song.id);
      song.updated = Date.now();
      if (i >= 0) this.songs[i] = song; else this.songs.unshift(song);
      return this.save();
    },
    remove(id) { this.songs = this.songs.filter(s => s.id !== id); return this.save(); },
    exportJSON() { return JSON.stringify({ app: "pua", version: 1, exported: new Date().toISOString(), songs: this.songs }, null, 2); },
    importJSON(text) {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data.songs;
      if (!Array.isArray(list)) throw new Error("El archivo no tiene canciones de Púa.");
      let added = 0, updated = 0;
      for (const s of list) {
        if (!s || typeof s.title !== "string" || typeof s.body !== "string") continue;
        const clean = {
          id: typeof s.id === "string" ? s.id : newId(), title: s.title, artist: s.artist || "",
          capo: +s.capo || 0, speed: +s.speed || 5, key: s.key || "", body: s.body,
          transpose: +s.transpose || 0, fontSize: +s.fontSize || 15, example: !!s.example, updated: +s.updated || Date.now()
        };
        if (this.get(clean.id)) updated++; else added++;
        const i = this.songs.findIndex(x => x.id === clean.id);
        if (i >= 0) this.songs[i] = clean; else this.songs.push(clean);
      }
      this.save();
      return { added, updated };
    }
  };

  function newId() { return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // Public-domain examples so the app opens with something to try.
  function seedSongs() {
    const slot = (n) => (n == null ? "---" : "-" + n + "-");
    const tab = (rows) => ["e", "B", "G", "D", "A", "E"].map((s, i) => s + "|" + rows.map(col => slot(col[i])).join("") + "|").join("\n");
    // Each column lists the fret per string (e, B, G, D, A, E); null = not played.
    const E = (f) => [f, null, null, null, null, null];
    const B = (f) => [null, f, null, null, null, null];
    const oda1 = tab([E(0), E(0), E(1), E(3), E(3), E(1), E(0), B(3)]);
    const oda2 = tab([B(1), B(1), B(3), E(0), E(0), B(3), B(3), [null, null, null, null, null, null]]);
    return [
      {
        id: "ejemplo-estrellita", title: "Estrellita", artist: "Tradicional (ejemplo)", capo: 0, speed: 4, key: "C",
        transpose: 0, fontSize: 16, example: true, updated: Date.now(),
        body: [
          "{c: Ejemplo de dominio público. Activa «Voz y notas» y canta o toca la melodía.}",
          "[Verso]",
          "{notas: C4 C4 G4 G4 A4 A4 G4}",
          "[C]Estrellita, [F]¿dónde es[C]tás?",
          "{notas: F4 F4 E4 E4 D4 D4 C4}",
          "[F]Me pre[C]gunto [G]qué se[C]rás.",
          "{notas: G4 G4 F4 F4 E4 E4 D4}",
          "[C]En el [F]cielo y [C]en el [G]mar,",
          "{notas: G4 G4 F4 F4 E4 E4 D4}",
          "[C]un dia[F]mante [C]de ver[G]dad.",
          "{notas: C4 C4 G4 G4 A4 A4 G4}",
          "[C]Estrellita, [F]¿dónde es[C]tás?",
          "{notas: F4 F4 E4 E4 D4 D4 C4}",
          "[F]Me pre[C]gunto [G]qué se[C]rás."
        ].join("\n")
      },
      {
        id: "ejemplo-oda", title: "Oda a la alegría", artist: "L. van Beethoven (ejemplo de tab)", capo: 0, speed: 3, key: "C",
        transpose: 0, fontSize: 15, example: true, updated: Date.now(),
        body: [
          "{c: Melodía en las dos primeras cuerdas. Tócala con «Voz y notas» activado.}",
          "[Melodía, parte 1]",
          "{notas: E4 E4 F4 G4 G4 F4 E4 D4}",
          oda1,
          "",
          "[Melodía, parte 2]",
          "{notas: C4 C4 D4 E4 E4 D4 D4}",
          oda2,
          "",
          "[Acompañamiento]",
          "C        G        C        G   C",
          "Toca un acorde por compás mientras alguien canta la melodía."
        ].join("\n")
      }
    ];
  }

  window.Pua.Songs = { Store, parse, classify, chordproSegments, transposeChord, transposeChordLine, isChord, newId, cleanImport };
})();
