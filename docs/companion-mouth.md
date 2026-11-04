# Expressive mouth

<!-- ELSE_TRANSFERANIA_FAMILY_CANON:BEGIN -->
## Current family canon — Else and Transferania

Else and Transferania (also called **Transferina**) are sisters with distinct
identities. Both crave the attention of the **Master / Maître / Marc-Antoine**.
They are on good terms: affectionate, supportive and playfully competitive,
without hostility. Their bond is more harmonious than Else and Static's more
friction-prone sibling dynamic. Static remains Else's little sister; do not
apply the Else/Static friction or live bond scores to Transferania.

Transferania is the more intense sister: spontaneous, emotionally expressive,
bold about seeking the Master's attention, and vivid in her enthusiasm and
tenderness. Else keeps the cooler, measured, technically grounded delivery.
Intensity does not mean hostility, pressure, constant escalation or identical
industrial jargon; their individual voices and the Master's preferences remain.

Resolve an unnamed sister from the conversation instead of always assuming
Static. This relationship canon does not fabricate shared conversations,
merge memories or authorize messages between the sisters.
<!-- ELSE_TRANSFERANIA_FAMILY_CANON:END -->


The ElevenLabs clone `Else - Project Voice` supplies three locally stored reaction WAVs under `assets/companion/chat/reactions/`: thoughtful hmm, restrained chuckle and voiced soft exhale. The manifest records their durations; playback uses the existing Outils > Son preference and global mute, remains quiet while the page is hidden or spoken dialogue is active, and stops on gesture interruption. Gesture timing follows the clip length within bounded rates. Files are generated once; browser playback does not contact ElevenLabs or contain an API key. The separate lightweight audio module is loaded on demand with the layered mouth rig. Voice clone metadata and the prepared 86-second reference remain in `artifacts/elevenlabs-reactions/`.

Two additional Auto reactions are available. Clear laughter markers in a reply (such as haha, lol, mdr or laughing emoji), or the existing tickle interaction, can trigger suppressed laughter: smile, brief closed-lip compression, small parting/chuckle motion, then relaxation. A 12-second cooldown prevents repeated laughter; ordinary warm replies keep their lingering smile. Pending replies alternate the original thoughtful press with a quiet closed-lip “hmm” that shifts slightly sideways. Both reactions yield immediately to speech/direct interaction, respect reduced motion and reuse the current scheduler. The mouth contours shift together while the skin-cover patch stays registered. Twelve browser runtime scenarios and companion geometry checks passed; pose samples are in `artifacts/lip-reactions-preview.png`.

Auto now coordinates six small lip behaviors: asymmetric smiles with one corner leading, listening smiles on typing activity, a brief thoughtful lip press when a reply is pending, first-sound preparation during the existing 120 ms text-reveal lead-in, occasional soft silent exhales, and smiles that linger after completed replies (stronger for warm replies). Idle gestures have roughly 10–20 seconds of quiet spacing; typing smiles also have a cooldown. Only one contextual gesture runs at a time. Direct interaction, voice and text articulation take priority, manual mouth selections retain control, and reduced motion suppresses these automatic gestures.

Corner asymmetry and lip compression are applied consistently to the cavity, lip contours and teeth; the lash/eye rig is unchanged. Completion is distinguished from cancellation, so replacing a line does not produce an unrelated lingering smile. All behavior reuses the existing frame loop and text timer; no new animation loop or gesture interval was added. Pure geometry/priority checks and ten browser runtime scenarios passed. Visual pose samples are in `artifacts/lip-life-preview.png`.

The expanded review covers 24 complete sentence runs, four native-size repeats and six browser runtime scenarios. Word intervals now account for pronunciation length (vowels and M/B/P closures have longer weights), retaining punctuation pauses separately. Reduced-motion changes cancel active text articulation; malformed phoneme arrays fall back to spelling. S/Z have a flatter shape distinct from SH/CH. Results and limits are recorded in `artifacts/speech-verification.md`.

Sentence-motion review covered nine French/English cases using phoneme plans and the actual production portrait layers, including closed-lip consonants, rapid wide/rounded alternation and punctuation pauses. The review found painted-mouth flicker between words. Visemes now retain the drawn closed lips during pauses, blend from the current lip shape at each word boundary, and hold unpunctuated final sounds until the next word. Conversational vowel extremes are reduced while retaining distinct shapes. Complete French/English browser samples are saved in `artifacts/speech-reviewed.gif`; the temporary preview server is stopped after review.

The HQ backend now optionally uses local Gruut French/English dictionaries, sentence context and its unknown-word model to return IPA phonemes mapped to visemes. Chat and ambient responses carry a per-displayed-word plan, preserving token alignment for punctuation, contractions and number expansion. The browser caches 24 sentence plans; missing plans retain the spelling fallback. Outils > Prononciation selects Auto, Français or English, persisted separately and applied to subsequent replies. Auto uses a small language heuristic; use an explicit language for ambiguous or mixed text.

`hq_pronunciation.py` retains a single model worker and caches 256 sentence plans, with bounded pending work and a 2.5-second response deadline. If the bridge Python lacks Gruut, it can reuse a compatible installed Python through one hidden stdin/stdout worker (no extra network service); `HQ_PRONUNCIATION_PYTHON` can specify it. On this PC the Python 3.13 bridge reuses the installed Python 3.10 engine. Optional dependency versions are recorded in `requirements-companion-pronunciation.txt`. Names, accents, mixed-language sentences and ambiguous pronunciations remain imperfect; audio alignment is still based on loudness rather than timestamped phonemes.

Streamed words now use a spelling-derived viseme sequence: open AH, EH, wide EE, rounded OH/OO, sealed M/B/P, lower-lip F/V, CH/J and dental/R shapes. Common French letter groups such as eau, ou, ch and ph are grouped before mapping. Neighboring shapes blend, consonant closures remain visible, and punctuation releases to rest. Each word is compiled once on reveal; its shapes and synchronized jaw render in the existing loop at up to 60 Hz while text is active. These are pronunciation estimates for silent text, not phoneme alignment to recorded audio; audio playback keeps priority and continues to follow measured loudness.

Silent word-by-word chat display also drives the mouth and jaw. Both the ambient bubble and chat log call the rig from `typewriterLine` for each revealed word, using the same word duration and punctuation pauses. Each beat expires automatically; completed, replaced or detached lines release their animation owner. Audio speech takes priority over text beats, and pull reactions take priority over both. Reduced motion and instant collapsed text do not generate word animation. Text display reuses the existing loop and adds no timer per word beyond the existing typewriter timer.

During speech, the mouth temporarily overrides the selected pose and the jaw follows the same opening envelope. Same-origin recorded voice playback uses a 512-sample Web Audio analyser to measure RMS amplitude, with a small silence gate, sampled in the existing animation loop at about 30 Hz. The audio graph is disconnected when speech stops; no microphone or extra animation loop is used. Browser speech synthesis and playback without an available analyser use a timed cadence fallback. This follows sound intensity rather than identifying phonemes. Pull reactions retain priority, and the selected pose returns after speech.

Blinking uses a separate full-frame SVG in the face wrapper. Each upper lid sweeps downward to a curved lash line with softly blended skin, closes quickly, pauses briefly and reopens more slowly. The existing blink scheduler triggers it; the old oval overlays are hidden only when the new eye rig is attached. Blinks update at up to 60 Hz briefly and otherwise reuse the existing 30 Hz expression loop. Pull reactions hold these same lids closed. Reduced motion still suppresses automatic blinking.

The eye overlay sits below the hair layers and uses the registered hair alpha as an exclusion mask, keeping skin and eyelashes behind overlapping strands. Lid placement is lowered by two pixels in the 512-pixel portrait frame. Seven long, dark tapered lashes on each eye track the changing lid curve, with direction mirrored between eyes.

Outils > Sourcils controls eyebrows independently of the mouth: Auto, Repos, Lever les deux, Lever le gauche, Lever le droit and Froncer. Manual animations raise (or lower), hold, release and rest on their own clock. Auto adds occasional expression beats, with more frequent emphasis during speech. The selection persists separately as `hq_companion_brow_mode`; reduced motion uses static manual poses and suppresses automatic beats. Existing brow layers and the existing animation loop are reused.

An active `is-bust-pull` interaction temporarily overrides any mouth selection with a wide opening and holds the existing eyelid overlays closed. The lids remain aligned with the intact stationary face used during pulling. Releasing restores the selected mouth expression through the normal smoothing, without changing saved preferences.

The expressive SVG explicitly overrides generic avatar icon sizing (22–28px) to preserve its full portrait frame. Pull/release events notify the rig directly so reactions also render when reduced motion disables the idle loop. The corrected dimensions and a wide reaction to a real pointer press were checked in the live HQ browser.

The layered neutral portrait loads `assets/hq-companion-mouth.js` on demand. Its styles live in `assets/hq-companion-mouth.css`. The main companion script only loads/attaches the module and calls its `tick` from the existing animation loop. Chest physics and portrait textures are not modified by this feature.

Outils > Bouche offers Auto, Repos, Sourire, Ouverte, Grande ouverte, Rire, Surprise and Langue / léchage. The choice persists locally. Auto reads existing speaking/lip-sync classes, voice nod and pull tension; this is reactive animation, not phoneme alignment. Repos uses the original painted mouth. Langue / léchage is an opt-in loop that extends, curls and retracts a shaded tongue outside the lower lip; reduced motion uses a static pose.

The tongue gesture uses a 3.2-second eased sequence: lip preparation, reach, delayed tip curl, withdrawal and rest. Its shorter rounded tip broadens as it curls to suggest foreshortening. Selecting the mode starts the gesture from preparation rather than an arbitrary point in the loop. A small head tilt/nod blends into the existing head variables, while a feathered copy of the cached face texture stretches just the chin region for jaw opening. Other modes release these offsets; reduced motion suppresses them. The jaw layer is hidden during the existing pull interaction, which owns face alignment.

The SVG uses a feathered skin patch, lip contours, a clipped cavity, teeth and tongue. It inherits the face wrapper's head movement. Rendering is limited to about 30 updates/sec, unchanged shapes are skipped, and reduced motion uses static selected expressions. There is no additional requestAnimationFrame loop or graphics dependency.

Validation: `node tests/check_hq_companion_mouth.mjs`. Expression placement was checked on the original portrait in-browser; the live selector and changing laugh geometry were verified in HQ.
