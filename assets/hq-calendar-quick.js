/* Quick add for the calendar: one French sentence becomes an event draft.
   « Dentiste demain 14h », « Cours lundi de 8h à 11h », « Anniversaire Léa le 12 nov », « Sport 19h pendant 1h30 ».
   Pure and local (no network, no model). Returns null when there is no title left. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.HQCalendarQuick = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const WEEKDAYS = [["dimanche", "dim"], ["lundi", "lun"], ["mardi", "mar"], ["mercredi", "mer"], ["jeudi", "jeu"], ["vendredi", "ven"], ["samedi", "sam"]];
  const MONTHS = [["janvier", "janv", "jan"], ["fevrier", "fevr", "fev"], ["mars", "mar"], ["avril", "avr"], ["mai"], ["juin"],
    ["juillet", "juil"], ["aout"], ["septembre", "sept", "sep"], ["octobre", "oct"], ["novembre", "nov"], ["decembre", "dec"]];
  const CATEGORY_WORDS = [
    ["appointment", /\b(rdv|rendez-vous|rendez vous|dentiste|medecin|docteur|dr|coiffeur|kine|osteo|ophtalmo|banque|notaire|veterinaire|veto|entretien d'embauche)\b/],
    ["study", /\b(cours|examen|exam|partiel|revision|revisions|reviser|devoir|devoirs|td|tp|cm|lecture|bibliotheque|soutenance|memoire|these)\b/],
    ["maintenance", /\b(backup|sauvegarde|mise a jour|maj|reparer|reparation|entretien|vidange|menage|nettoyage)\b/],
    ["personal", /\b(anniversaire|anniv|maman|papa|famille|ami|amis|amie|resto|restaurant|diner|dejeuner|cine|cinema|sport|gym|course|footing|soiree|apero|fete|vacances|voyage)\b/],
  ];

  /* Lower case without accents, one UTF-16 unit for one unit, so a match position in the folded text
     is the same position in the original (titles keep their accents). */
  function fold(text) {
    return text.split("").map((ch) => ch.normalize("NFD").charAt(0).toLowerCase().charAt(0) || ch).join("");
  }

  const pad = (n) => String(n).padStart(2, "0");
  const dayKey = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const minuteKey = (d) => dayKey(d) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  const atMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  function monthIndex(word) {
    const w = word.replace(/\.$/, "");
    for (let i = 0; i < MONTHS.length; i += 1) if (MONTHS[i].includes(w)) return i;
    return -1;
  }

  function weekdayIndex(word) {
    for (let i = 0; i < WEEKDAYS.length; i += 1) if (WEEKDAYS[i].includes(word)) return i;
    return -1;
  }

  /* hh, mm from "14h", "14h30", "14:30", "14 h 30", "midi", "minuit". */
  function clock(text) {
    if (text === "midi") return [12, 0];
    if (text === "minuit") return [0, 0];
    const m = /^(\d{1,2})\s*(?:h|:)\s*(\d{2})?$/.exec(text);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = m[2] ? Number(m[2]) : 0;
    if (hh > 23 || mm > 59) return null;
    return [hh, mm];
  }

  const TIME = "(?:\\d{1,2}\\s*(?:h|:)\\s*(?:\\d{2})?|midi|minuit)";

  function parse(input, now, fallbackDay) {
    const original = String(input || "").replace(/\s+/g, " ").trim();
    if (!original) return null;
    let text = fold(original);
    const cut = []; // [start, end) ranges removed from the title
    const take = (re) => {
      const m = re.exec(text);
      if (!m) return null;
      cut.push([m.index, m.index + m[0].length]);
      text = text.slice(0, m.index) + " ".repeat(m[0].length) + text.slice(m.index + m[0].length);
      return m;
    };
    const today = atMidnight(now || new Date());
    let day = null;
    let allDay = false;
    let start = null;
    let end = null;
    let minutes = null;
    let partOfDay = null;

    if (take(/\b(toute la journee|journee entiere|toute la journee)\b/)) allDay = true;

    // Duration first ("pendant 2h" must not read as a time), then ranges, then a single time.
    let m = take(/\bpendant\s+(\d{1,2})\s*(h|min|mn)\s*(\d{2})?\b/);
    if (m) minutes = m[2] === "h" ? Number(m[1]) * 60 + (m[3] ? Number(m[3]) : 0) : Number(m[1]);
    m = take(new RegExp("\\b(?:de\\s+)?(" + TIME + ")\\s*(?:-|–|a|jusqu'a)\\s*(" + TIME + ")(?=\\s|$|[,.;])"));
    if (m) {
      start = clock(m[1].replace(/\s+/g, ""));
      end = clock(m[2].replace(/\s+/g, ""));
    } else {
      m = take(new RegExp("(?:\\b(?:a|vers|des)\\s+)?\\b(" + TIME + ")(?=\\s|$|[,.;])"));
      if (m) start = clock(m[1].replace(/\s+/g, ""));
    }

    // Part of the day (a default time when none was given).
    m = take(/\b(ce matin|ce midi|cet apres-midi|cet apres midi|ce soir|cette nuit)\b/);
    if (m) {
      partOfDay = m[1];
      day = today;
    }

    // Dates.
    if (!day && take(/\bapres-demain\b|\bapres demain\b/)) day = addDays(today, 2);
    if (!day && take(/\bdemain\b/)) day = addDays(today, 1);
    if (!day && take(/\baujourd'hui\b|\bauj\b/)) day = today;
    if (!day) {
      m = take(/\bdans\s+(\d{1,3}|un|une|deux|trois)\s+(jours?|semaines?)\b/);
      if (m) {
        const n = { un: 1, une: 1, deux: 2, trois: 3 }[m[1]] || Number(m[1]);
        day = addDays(today, m[2].startsWith("semaine") ? n * 7 : n);
      }
    }
    if (!day) {
      m = take(/\b(?:le\s+)?(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?\b/);
      if (m) {
        const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : today.getFullYear();
        day = new Date(year, Number(m[2]) - 1, Number(m[1]));
        if (!m[3] && day < today) day = new Date(year + 1, Number(m[2]) - 1, Number(m[1]));
      }
    }
    if (!day) {
      m = take(/\b(?:le\s+)?(\d{1,2})(?:er)?\s+([a-z]{3,9}\.?)(?:\s+(\d{4}))?\b/);
      if (m && monthIndex(m[2]) >= 0) {
        const year = m[3] ? Number(m[3]) : today.getFullYear();
        day = new Date(year, monthIndex(m[2]), Number(m[1]));
        if (!m[3] && day < today) day = new Date(year + 1, monthIndex(m[2]), Number(m[1]));
      } else if (m) {
        // Not a month after all: put the text back.
        const [a, b] = cut.pop();
        text = text.slice(0, a) + fold(original).slice(a, b) + text.slice(b);
      }
    }
    if (!day) {
      m = take(/\b(?:(?:ce|le)\s+)?(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(\s+prochain)?\b/);
      if (m) {
        const target = weekdayIndex(m[1]);
        let delta = (target - today.getDay() + 7) % 7;
        if (m[2] && delta === 0) delta = 7; // "lundi prochain" said on a Monday: next week
        day = addDays(today, delta);
      }
    }
    if (!day) {
      m = take(/\ble\s+(\d{1,2})(?:er)?\b/);
      if (m) {
        const n = Number(m[1]);
        day = new Date(today.getFullYear(), today.getMonth(), n);
        if (day < today) day = new Date(today.getFullYear(), today.getMonth() + 1, n);
      }
    }

    const dated = !!day;
    day = day || atMidnight(fallbackDay || today);
    if (!start && partOfDay && !allDay) {
      start = { "ce matin": [9, 0], "ce midi": [12, 0], "cet apres-midi": [14, 0], "cet apres midi": [14, 0], "ce soir": [19, 0], "cette nuit": [22, 0] }[partOfDay];
    }

    // Title: what is left, from the original text (accents kept), without stray glue words.
    const keep = original.split("").map((ch, i) => (cut.some(([a, b]) => i >= a && i < b) ? " " : ch)).join("");
    let title = keep.replace(/\s+/g, " ").trim()
      .replace(/^(?:(?:le|la|a|à|de|du|pour|avec|et)\s+)+/i, "")
      .replace(/(?:\s+(?:le|la|a|à|de|du|pour|et|,))+$/i, "")
      .replace(/\s+([,.;])/g, "$1")
      .trim();
    if (!title) return null;
    title = title.charAt(0).toUpperCase() + title.slice(1);

    const folded = fold(title);
    const category = (CATEGORY_WORDS.find(([, re]) => re.test(folded)) || ["other"])[0];

    if (allDay || !start) {
      return { title, all_day: true, start: dayKey(day), end: dayKey(addDays(day, 1)), category, dated, timed: false };
    }
    const from = new Date(day.getFullYear(), day.getMonth(), day.getDate(), start[0], start[1]);
    let to;
    if (end) {
      to = new Date(day.getFullYear(), day.getMonth(), day.getDate(), end[0], end[1]);
      if (to <= from) to = new Date(to.getTime() + 24 * 3600 * 1000); // "22h-1h" ends the next day
    } else {
      to = new Date(from.getTime() + (minutes || 60) * 60000);
    }
    return { title, all_day: false, start: minuteKey(from), end: minuteKey(to), category, dated, timed: true };
  }

  return { parse, fold };
});
