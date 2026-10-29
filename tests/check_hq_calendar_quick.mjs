// Offline checks for the calendar quick add (French sentence -> event draft). No browser.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parse } = require("../assets/hq-calendar-quick.js");

// Thursday 29 October 2026, 10:00 local.
const NOW = new Date(2026, 9, 29, 10, 0);
const p = (text, fallback) => parse(text, NOW, fallback);
const same = (got, want, label) => {
  for (const key of Object.keys(want)) assert.deepEqual(got && got[key], want[key], `${label}: ${key} = ${JSON.stringify(got && got[key])}, wanted ${JSON.stringify(want[key])}`);
};

same(p("Dentiste demain 14h"), { title: "Dentiste", all_day: false, start: "2026-10-30T14:00", end: "2026-10-30T15:00", category: "appointment", dated: true }, "demain 14h");
same(p("Cours lundi de 8h à 11h"), { title: "Cours", start: "2026-11-02T08:00", end: "2026-11-02T11:00", category: "study" }, "range on a weekday");
same(p("Anniversaire Léa le 12 nov"), { title: "Anniversaire Léa", all_day: true, start: "2026-11-12", end: "2026-11-13", category: "personal" }, "day month, all day");
same(p("Sport 19h pendant 1h30"), { title: "Sport", start: "2026-10-29T19:00", end: "2026-10-29T20:30" }, "duration");
same(p("rdv banque à 9h30 jeudi"), { title: "Rdv banque", start: "2026-10-29T09:30", end: "2026-10-29T10:30", category: "appointment" }, "today's weekday is today");
same(p("Réunion jeudi prochain 10h"), { start: "2026-11-05T10:00" }, "weekday prochain on that weekday");
same(p("Appel maman ce soir"), { title: "Appel maman", start: "2026-10-29T19:00", end: "2026-10-29T20:00", category: "personal" }, "ce soir");
same(p("Révisions après-demain"), { title: "Révisions", all_day: true, start: "2026-10-31", category: "study" }, "après-demain");
same(p("Vidange 3/11"), { title: "Vidange", all_day: true, start: "2026-11-03", category: "maintenance" }, "d/m");
same(p("Vacances 2/1"), { start: "2027-01-02" }, "a past d/m means next year");
same(p("Déjeuner midi"), { title: "Déjeuner", start: "2026-10-29T12:00" }, "midi");
same(p("Soirée 22h-1h"), { start: "2026-10-29T22:00", end: "2026-10-30T01:00" }, "past midnight");
same(p("Lecture dans 3 jours"), { start: "2026-11-01", all_day: true }, "dans N jours");
same(p("Course toute la journée samedi"), { all_day: true, start: "2026-10-31" }, "toute la journée");
same(p("Paperasse"), { title: "Paperasse", all_day: true, start: "2026-10-29", dated: false, timed: false }, "no date: the day on screen (today)");
same(p("Paperasse", new Date(2026, 10, 20)), { start: "2026-11-20", dated: false }, "no date: the fallback day");
same(p("Top 5 films"), { title: "Top 5 films", all_day: true, start: "2026-10-29" }, "a bare number is not a date and stays in the title");
same(p("Voir le 15"), { title: "Voir", start: "2026-11-15", all_day: true }, "le N in the past rolls to next month");
same(p("Cours d'anglais 14h30"), { title: "Cours d'anglais", start: "2026-10-29T14:30", end: "2026-10-29T15:30" }, "14h30");
same(p("Réunion 9:15"), { start: "2026-10-29T09:15" }, "9:15");
assert.equal(p(""), null);
assert.equal(p("   demain 14h  "), null, "only a date: no title, nothing to create");
assert.equal(p("Café 😀 demain 9h").title, "Café 😀", "emoji and accents kept, positions aligned");
console.log("hq calendar quick add checks ok");
