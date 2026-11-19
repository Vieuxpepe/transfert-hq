/* Transfert HQ — occasional visits between assistant chips (assets/hq-assistant-visits.js)
 * One visible chip hosts a random visitor from another tab. The visitor walks in,
 * a short exchange plays in bubbles, then the visitor leaves. The server may
 * generate one short exchange; canned lines are the fallback. Nothing runs
 * while a drawer is open or the user is engaged with an input; a page's
 * autofocus alone does not block visits. */
(function () {
  "use strict";

  // Pure focus policy, also exported for tests/check_hq_assistant_visits_focus.mjs.
  function isField(el) {
    if (!el) return false;
    var tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
  }
  function createFocusPolicy() {
    var auto = new WeakSet();
    var engaged = new WeakSet();
    function noteAuto(el) {
      if (!isField(el) || engaged.has(el)) return false;
      auto.add(el);
      return true;
    }
    function engage(el) {
      if (!isField(el)) return false;
      engaged.add(el);
      auto.delete(el);
      return true;
    }
    function blocks(el) {
      if (!isField(el)) return false;
      return engaged.has(el) || !auto.has(el);
    }
    return {
      noteInitialAuto: noteAuto,
      noteAuto: noteAuto,
      engage: engage,
      blocks: blocks,
      isAuto: function (el) { return isField(el) && auto.has(el); },
      isEngaged: function (el) { return isField(el) && engaged.has(el); }
    };
  }
  // Visits follow a life, not a clock: mostly a few minutes apart, sometimes a long
  // quiet, now and then a quick second crossing. Night and a busy Master slow them;
  // a Master who has been away for a while makes them likelier.
  function gapFor(random, hour, idleMs) {
    function span(lo, hi) { return lo + Math.floor(random() * (hi - lo + 1)); }
    var r = random();
    var gap = r < 0.12 ? span(45000, 80000)
      : r < 0.70 ? span(180000, 480000)
      : r < 0.92 ? span(480000, 1080000)
      : span(1200000, 2400000);
    if (hour >= 23 || hour < 6) gap *= 2.5;
    if (idleMs < 20000) gap *= 1.4;
    else if (idleMs > 300000) gap *= 0.7;
    return Math.round(gap);
  }
  function pickWeighted(items, weights, random) {
    var total = 0;
    for (var i = 0; i < items.length; i++) total += Math.max(0, Number(weights[i]) || 0);
    if (!(total > 0)) return items.length ? items[Math.floor(random() * items.length)] : null;
    var t = random() * total;
    for (var j = 0; j < items.length; j++) {
      t -= Math.max(0, Number(weights[j]) || 0);
      if (t < 0) return items[j];
    }
    return items[items.length - 1];
  }
  // Body language for a private want: where she leans, as a small offset and tilt.
  // `toward` is +1 when the other sister is to her right, `centre` +1 when the
  // middle of the screen is to her right. Never said aloud, only shown.
  var MOOD_KEYS = { regard: 1, fierte: 1, taquiner: 1, nouvelles: 1, aveu: 1, service: 1, glance: 1 };
  function moodFor(kind, dir) {
    var toward = dir && dir.toward < 0 ? -1 : 1;
    var centre = dir && dir.centre < 0 ? -1 : 1;
    switch (kind) {
      case "regard": return { dx: centre * 6, dy: -1, rot: 0 };       // leans toward where he is
      case "fierte": return { dx: 0, dy: -3, rot: 0 };                // stands a little taller
      case "taquiner": return { dx: 0, dy: 0, rot: toward * 3 };      // a head tilt
      case "nouvelles": return { dx: toward * 4, dy: 0, rot: toward * 2 };  // draws closer
      case "aveu": return { dx: -toward * 3, dy: 1, rot: -toward * 1.5 };   // a step back
      case "glance": return { dx: 0, dy: 0, rot: toward * 4 };        // turns toward the other
      default: return null;
    }
  }
  // The built-in fallback lines: one full bank per assistant, in her own voice. They sit above the
  // export so tests/check_hq_assistant_visits_focus.mjs can hold every bank to its voice.
  // Beats: hello / about / answer are said by the visitor; reply / ask / extra / bye by the host.
  // `pair[other]` adds lines for one specific partner and is mixed in with the general bank.
  var CHIPS = [
    { key: "culinia", name: "Culinia", selector: ".hq-culinia-chip", size: [54, 54],
      hello: [
        "Smells good in here.",
        "Just came to see what's simmering.",
        "I followed the smell of something burnt. Not mine, I hope.",
        "Thought I'd stop by and check on everyone.",
        "Is anyone eating properly in this place?",
        "I had a minute between pots, so here I am.",
        "Something told me you were up and not eating.",
        "I was passing with a spoon in my hand. Hello.",
        "Is that a draught or a sigh? Either way, hello.",
        "I brought nothing, which feels wrong. Hello anyway.",
        "The kettle's on. I thought I'd bring the news.",
        "Quiet corner, this. Mind if I linger?"
      ],
      reply: [
        "Come in, sit, you look like you've been walking all day.",
        "Always a good time for a visit.",
        "Pull up a chair. I'll find a biscuit.",
        "Well, look who wandered in.",
        "You're just in time. Or just in the way.",
        "Come in before the door lets the warmth out.",
        "I was hoping someone would.",
        "Hello, you. Sit. Stay a little.",
        "Careful, the floor's warm. Come in.",
        "Ah, company. The best seasoning.",
        "Don't stand there, you're making me nervous.",
        "Good, now I have an excuse to stop."
      ],
      about: [
        "I let a soup reduce too long. It's better that way.",
        "I still taste before serving, even when I know the recipe.",
        "Bread is mostly patience, and a little salt.",
        "Some days I cook just to hear the pan.",
        "I keep a jar of the good salt for nobody in particular.",
        "A kitchen is never quiet, it's just humming.",
        "I've been thinking about onions. Slowly. All morning.",
        "There's a quiet kind of soup that fixes most things.",
        "Every sauce is a small argument that ends well.",
        "I never trust a recipe that doesn't say “to taste”.",
        "Leftovers are just tomorrow being generous.",
        "I like the minute right before things are done."
      ],
      ask: [
        "So what have you been up to, love?",
        "Are you keeping up, you?",
        "How's your side of the house today?",
        "Anything on your mind besides work?",
        "Have you eaten? Be honest.",
        "What's keeping you busy, {other}?",
        "Tell me something good. Anything.",
        "Are you getting enough rest over there?",
        "How are you holding up, really?",
        "What are you working on, then?",
        "Anything I can do to help?",
        "Has it been quiet, or the other kind?"
      ],
      answer: [
        "I tidy, I check, I spot what's missing. Nothing urgent.",
        "I take stock of the leftovers before deciding.",
        "Mostly just stirring and thinking, honestly.",
        "Simmering a few ideas. Nothing's boiled over yet.",
        "Tasting, adjusting, tasting again.",
        "A bit of everything. Mostly waiting for the water.",
        "Cleaning as I go, like a sensible person.",
        "Not much. A little salt here, a little there.",
        "Trying to remember what I forgot to buy.",
        "Keeping the heat low. It works on people too.",
        "Counting spoons. Don't ask.",
        "Reading a recipe I already know by heart."
      ],
      extra: [
        "I keep scraps “for a stock” that I'll never make.",
        "I have several recipes in mind and no wish to choose.",
        "There's always a pot somewhere that needs me.",
        "Someone should write a book about quiet kitchens.",
        "I talk to the oven. It listens better than most.",
        "A good knife makes you feel taller.",
        "I've never burnt anything on purpose. Almost never.",
        "Honestly, hot tea fixes more than advice does.",
        "Sometimes the best ingredient is leaving it alone.",
        "I dream in garlic, I'm afraid."
      ],
      bye: [
        "Back to the stove.",
        "Back to watching the pot.",
        "Eat something before you go back to it.",
        "I'll leave you in peace. Drink some water.",
        "Careful out there. And call if it burns.",
        "My pot's talking to me. I'd better go.",
        "Come by again. I'll have something warm.",
        "Right, off I go before it boils over.",
        "Stay warm, you hear?",
        "Go on then. I'll save you a plate.",
        "Mind the step. And the soup.",
        "Off to taste something. Wish me luck."
      ],
      pair: {
        elsea: {
          hello: ["I brought you something sweet, little one. Eat it slowly.", "Have you eaten anything today, or just watched things grow?", "Thought you'd like a warm snack while you wait."],
          reply: ["Elsea, sweetheart, come in. Mind the hot pan.", "There's my little sprite. Sit, I'll cut you a slice.", "Come in, come in. You're all wings and crumbs."],
          about: ["That little one eats like a bird. I worry.", "She makes everything sparkle, even my flour."],
          answer: ["Making you a little treat. Don't tell your mother.", "Saving the sweetest piece for small hands.", "Keeping something warm for when you get hungry."],
          bye: ["Eat something before you fly off, love.", "Take this for later. Don't share it.", "Off you go. Come back when you're hungry."]
        },
        forgia: {
          hello: ["Have you eaten, or only looked at pictures?", "I brought tea. You can look at it, if you like.", "Just checking you haven't turned into a lamp."],
          reply: ["There you are. You've the look of someone who skipped lunch.", "Sit. I'll tell you if the light's good in here.", "Forgia! I was about to send out a search party."],
          about: ["Your pictures make me hungry, I don't know why.", "I tried plating a soup like one of your lights."],
          answer: ["Feeding people who forget to eat. You, mostly.", "Making something you'll finish, for once.", "Waiting for you to say you're hungry."],
          bye: ["Eat something before you go back to the screen.", "Save me a look at the good one.", "Go on, light-keeper. Drink some water."]
        },
        musica: {
          hello: ["I heard humming through the wall. Is that you?", "Stirring's better with a tune. Do you have one?", "I came to borrow a rhythm for the whisk."],
          reply: ["Musica! Hum something while I stir.", "Come in, you'll make the onions cry in tune.", "Sit. Tell me what the pot sounds like."],
          about: ["Bread rises to a slow tempo, I'm sure of it.", "I count my stirring in threes. Is that music?"],
          answer: ["Keeping time with a wooden spoon. It's gaining on me.", "Listening to the pot, as you taught me.", "Humming. Badly, but with feeling."],
          bye: ["Leave the tune with me, I'll keep it warm.", "Hum on, love.", "Come back when the soup has a chorus."]
        },
        inventoria: {
          hello: ["I've come to ask how many onions we have. Honestly.", "Is the flour where I left it? Don't tell me.", "Brought you a label. It says “salt”. Obvious, I know."],
          reply: ["Inventoria. Just the person to tell me what's missing.", "Come in, count whatever you like.", "Careful, don't alphabetise the spices again."],
          about: ["Spices are better when they're not in order. Don't tell her.", "I've never once found the nutmeg where it should be."],
          answer: ["Wondering how much rice is too much rice.", "Losing a fight with the pantry, as usual.", "Tasting my way through your tidy shelves."],
          bye: ["Write down what's missing. I'll fetch it.", "Mind my jars. They have feelings.", "Count gently. The salt's sensitive."]
        },
        pistonia: {
          hello: ["The oven's behaving strangely. Is it you or the oven?", "Came to warm my hands at your machines.", "Does the hum ever get hungry? Mine does."],
          reply: ["Pistonia! You always smell of warm metal. I like it.", "Come in, mind the pot, it has opinions.", "I made too much. Convenient."],
          about: ["A machine and a stove are cousins, really.", "Heat is just patience with a temper."],
          answer: ["Keeping something warm for later. Like you.", "Turning the heat down, mostly. Learned it from you.", "Resting my hands near the hum."],
          bye: ["Look after the machines. Eat something warm.", "Slowly now, Pistonia. No hurry.", "Come back when the pot's done."]
        },
        securia: {
          hello: ["Did you eat tonight, or only lock things?", "I brought a snack. Check it for danger if you must.", "I came to make sure you're not skipping dinner again."],
          reply: ["Securia, come in. Don't inspect the soup.", "There you are. Sit, you've been standing for hours.", "Take your hand off the latch. Have some bread."],
          about: ["I leave the pantry unlocked. It feels like trust.", "Nothing in my kitchen is ever quite shut."],
          answer: ["Making something nobody asked for. You'll eat it.", "Checking you have a hot meal. You don't.", "Warming the soup. And my hands."],
          bye: ["Lock up gently. Eat before the rounds.", "Take some bread for the road.", "Sleep sometimes, will you?"]
        },
        else: {
          hello: ["I found tea. You'll sit and drink it.", "You're so quiet. Have you eaten?", "Brought you something warm. No questions."],
          reply: ["Else. Sit with me, I won't talk much.", "You came. I was starting to worry.", "Here, take the warm mug. No need to speak."],
          about: ["Quiet people deserve the best soup.", "I made the soup quiet today. For you."],
          answer: ["Making sure the quiet one gets fed.", "Sitting near you. It's enough.", "Stirring slowly, so I don't disturb you."],
          bye: ["Take the rest of it with you.", "Go gently, love.", "Come back tomorrow. I'll be here."]
        }
      } },
    { key: "forgia", name: "Forgia", selector: ".hq-forgia-chip", size: [54, 54],
      hello: [
        "Came to check on the light.",
        "Came to see if the light holds.",
        "I'm between renders. Don't take it personally.",
        "Something's off in my last frame. I needed air.",
        "Passing through. Say nothing about my eyes.",
        "I found a crop I like. Thought you'd care.",
        "The seed was bad. I came to sulk elsewhere.",
        "I've stared at noise all morning. Hello.",
        "Needed a change of palette. Hello.",
        "A fresh pair of eyes, please. Yours will do.",
        "I was walking off a bad composition.",
        "Dropped by. The light's better here."
      ],
      reply: [
        "Light decides everything.",
        "Light settles it before anything else.",
        "You're in my shadow. Stay there.",
        "Come in. Don't touch the focus.",
        "Hm. Decent timing.",
        "Sit. Try not to blink so loudly.",
        "You've got good light on you.",
        "Fine. Five minutes, no more.",
        "You look slightly overexposed. Sit.",
        "Welcome. The negative space is yours.",
        "Right. Make yourself small.",
        "About time someone stopped by."
      ],
      about: [
        "I kept a failed render. Its light won't come back.",
        "I spend more time looking than tuning, lately.",
        "A bad crop can ruin a good morning.",
        "Perfect is boring. I want the one with the flaw.",
        "I've been chasing a shadow I can't name.",
        "Every frame is a decision I forgot to make.",
        "Too sharp is just another way to lie.",
        "I like the render that almost didn't happen.",
        "The seed matters less than the patience.",
        "I keep deleting the good ones. Don't ask.",
        "Half my work is learning when to stop.",
        "Light never repeats. That's the whole trick."
      ],
      ask: [
        "Found your angle yet?",
        "What do you look at first?",
        "What have you been making?",
        "Anything worth looking at over there?",
        "Is your side behaving?",
        "Still pretending not to look, {other}?",
        "What's the plan?",
        "Anything stuck?",
        "Busy or just busy-looking?",
        "How's the day treating you?",
        "What are you hiding?",
        "Something on your mind, or just passing?"
      ],
      answer: [
        "I collect botched lighting that beats the clean kind.",
        "I keep the failed tries. They often say more.",
        "Fixing one pixel. It matters, I promise.",
        "Chasing a gradient. It keeps getting away.",
        "Mostly squinting at something I already finished.",
        "Throwing out seeds. Keeping the strange ones.",
        "Nothing much. A little noise, a little hope.",
        "Re-cropping the same thing, differently.",
        "Pretending to be busy. It's working.",
        "Testing a shadow. It tests me back.",
        "Waiting for the right accident.",
        "Looking. Mostly that."
      ],
      extra: [
        "A well-chosen sampler beats a long speech.",
        "A bad render teaches me more than a good one.",
        "I like edges that don't quite agree.",
        "The best lighting is the kind you can't explain.",
        "I only trust a shadow that admits what it is.",
        "Everything looks better at the wrong hour.",
        "Noise is just a picture that hasn't decided yet.",
        "Never trust a symmetrical face.",
        "A frame can be wrong and still be right.",
        "Silence is a good negative prompt."
      ],
      bye: [
        "Carry on. I'm going back to the workshop.",
        "Back to the workshop before I lose the idea.",
        "I've a frame waiting. It won't wait long.",
        "Right. Back to the light.",
        "Don't move. You're perfect like that. Bye.",
        "I'll render this moment later.",
        "Off. The seed is calling.",
        "That'll do. See you in the next frame.",
        "Back to squinting.",
        "Watch the exposure. Goodbye.",
        "Leave the good light as you found it.",
        "Enough. Back to the screen."
      ],
      pair: {
        elsea: {
          hello: ["Came to see the tiny one. Hold still.", "Your wings catch the light. Annoying.", "I need a small model. You'll do."],
          reply: ["Elsea. Fine. Don't touch the frame.", "Come in. Don't sparkle on my work.", "Sit. Chin up. Better."],
          about: ["She's the only one who poses without complaining.", "Too much pink. Somehow it works."],
          answer: ["Looking for your best side. Still looking.", "Fixing the light around your wings.", "Framing you. Stop wiggling."],
          bye: ["Go. Keep that smile for later.", "Enough sparkle for today.", "Out. Come back less dusty."]
        },
        culinia: {
          hello: ["Came to see what's simmering. For reference.", "Smells like warm light. I'll stay.", "Don't feed me. I'll lose focus."],
          reply: ["Culinia. Stand there, you're lighting the room.", "Fine, one spoonful. Then back to work.", "You've steam in your hair. It suits you."],
          about: ["Your steam makes the best backlight.", "A kitchen at dusk is a perfect scene."],
          answer: ["Learning to look at food like a lens. Hungrily.", "Hiding from your questions. Failing.", "Watching the steam. It's a good shadow."],
          bye: ["Save me a bite.", "I'll paint you in warm tones. Don't ask.", "Keep the pot lit."]
        },
        musica: {
          hello: ["Looking for a picture for a sound.", "Play something. I'll draw what it looks like.", "Your hum is stuck in my last frame."],
          reply: ["Musica. Tell me what blue sounds like.", "You've the face of a slow chord. Sit.", "Good. I needed noise that isn't mine."],
          about: ["Some songs are exposures. Long ones.", "A fade is just a gradient with timing."],
          answer: ["Trying to draw that low note you mentioned.", "Pairing a render with your last track.", "Watching your volume. It has a colour."],
          bye: ["I'll let you finish the track.", "Play it softer, I'll do the rest.", "Keep humming. I'm saving the frame."]
        },
        inventoria: {
          hello: ["Label my last render. Anything. It needs a name.", "How many drafts is too many? Count them.", "Hide my failures somewhere tidy."],
          reply: ["Inventoria. File this under “not yet”.", "Come in. You'll make my chaos look intentional.", "Good. Someone to blame for the missing file."],
          about: ["An archive is just old light in boxes.", "I envy anyone who knows where things are."],
          answer: ["Losing a file you probably already labelled.", "Cropping your shelves. They're photogenic.", "Hiding a bad draft in plain sight."],
          bye: ["Label the good one “maybe”.", "Don't tidy my mess. It's composed.", "Put my drafts where I'll find them."]
        },
        pistonia: {
          hello: ["Your machines run hot. My frames notice.", "Can you slow the fans? They ruin my silence.", "Came to see what makes the glow."],
          reply: ["Pistonia. You look good in low light.", "Fine. Don't breathe on the monitor.", "Sit. Your hum is an acceptable backdrop."],
          about: ["Heat has a colour. I'm learning it.", "Every machine hums in a different key. Mostly flat."],
          answer: ["Rendering until your machines complain.", "Taking the heat. My frames hate it.", "Counting warm pixels."],
          bye: ["Keep the fans honest.", "Don't overheat. My frames would never forgive you.", "Back to the glow. Thanks."]
        },
        securia: {
          hello: ["Your locks gave me an idea. A shadow, a keyhole.", "Anything unlocked? I need a better angle.", "Tell me I'm allowed to look at this."],
          reply: ["Securia. Stand still, the light's good on you.", "Don't inspect the crop. It's finished.", "Fine. You may look. Don't comment."],
          about: ["Locks make beautiful silhouettes.", "A closed door is just a frame waiting."],
          answer: ["Drawing your padlock. It's a good subject.", "Hiding a frame from you. Sorry.", "Obeying the rules of light. Strictly."],
          bye: ["Lock the dark ones. Leave me the bright ones.", "Check the corners. I like shadows there.", "Keep the lights low. I'll stay quiet."]
        },
        else: {
          hello: ["I saw your shadow. It's good. Stay still.", "Teach me not to over-explain.", "I need less. Show me."],
          reply: ["Else. You're the best negative space.", "Come in. Don't say anything. It's perfect.", "Good. A shadow I don't have to fix."],
          about: ["You're a frame with nothing wasted.", "I envy silence. It crops itself."],
          answer: ["Learning from you. Slowly. Badly.", "Looking at nothing. It's a good subject.", "Taking a picture of how you don't speak."],
          bye: ["Stay exactly like that.", "I'll remember the light on you.", "Keep the quiet. I'll borrow it."]
        }
      } },
    { key: "musica", name: "Musica", selector: ".hq-musica-chip", size: [54, 54],
      hello: [
        "Chasing a bassline, and it led me here.",
        "I followed a bass line and it brought me here.",
        "Something low is humming in this room. Was it you?",
        "I came in on the off-beat. Forgive me.",
        "A song ended and I needed somewhere to land.",
        "I heard a gap in the quiet. I stepped into it.",
        "Passing by... the room had a nice hum.",
        "I lost the thread of a melody. Thought you might have it.",
        "Quiet here. A good kind of quiet.",
        "Hello... I'm between tracks.",
        "I was listening to the walls. They're in tune today.",
        "There was a chord in the air. I followed it."
      ],
      reply: [
        "Good, I was about to ask you something.",
        "Perfect, I had a question.",
        "Come in... you arrive on the downbeat.",
        "Shh, stay a moment. It's a good note.",
        "Hello, you. Sit. Let the room finish its phrase.",
        "You're just in time for the bridge.",
        "Come in. We'll keep this one soft.",
        "There you are... the last note was missing you.",
        "Sit. Don't tap the table. Or do, gently.",
        "You walk in a nice rhythm, you know.",
        "Welcome. Quietly, if you can.",
        "Ah... a second voice. I was alone with the hum."
      ],
      about: [
        "There's a track I can't hear all the way through without stopping.",
        "I'm looking for a bass that doesn't show itself right away.",
        "Some songs only open on the third listen.",
        "I like the half second after the music ends.",
        "A silence in the right place is a whole chorus.",
        "I keep humming something I can't place... and it keeps changing.",
        "The best part of a song is where it breathes.",
        "I'm learning to leave space. It's harder than notes.",
        "A fade-out is a polite way to say goodbye.",
        "I like when the ending is a question.",
        "Every room has a key. This one's in D, I think.",
        "I listen to old albums for the dust."
      ],
      ask: [
        "What's playing at your place?",
        "What do you listen to while you work?",
        "How does your side sound today?",
        "What's the mood over there, {other}?",
        "Is it quiet where you are, or only pretending?",
        "Hearing anything good lately?",
        "What have you been up to... in your own time?",
        "Anything stuck in your head?",
        "How's your rhythm today?",
        "Tell me something that sounds like you.",
        "What are you working on, in quiet?",
        "Any silences worth keeping?"
      ],
      answer: [
        "I play an album in order, doing nothing else.",
        "I let the album finish before I judge it.",
        "Listening... mostly to what isn't playing.",
        "Tuning something small. It resists.",
        "Humming the same four bars. They're growing on me.",
        "Waiting for the next note to arrive.",
        "Nothing much... a long note, held.",
        "Rearranging a quiet. It's delicate.",
        "Following a sound I can't catch.",
        "A little of this, a little of that, in key.",
        "Counting the rests. They matter.",
        "Resting between verses."
      ],
      extra: [
        "Fades that are too short make me wary.",
        "A well-placed silence is worth a chorus.",
        "I trust songs that start slow.",
        "A lullaby is just a promise in 3/4.",
        "I never skip the quiet tracks.",
        "Every footstep is a very small drum.",
        "I think rain is a bad drummer with good timing.",
        "A bridge should feel like leaving, then returning.",
        "The best harmony is two people not interrupting.",
        "Some rooms sound better empty."
      ],
      bye: [
        "I'll leave you. I have a track to finish.",
        "Back to finish that track.",
        "That's the cadence... I'll go.",
        "Keep the last note warm for me.",
        "I'll fade out here. Gently.",
        "The next song is waiting... go well.",
        "Take care... and mind the tempo.",
        "I'll leave a little silence for you.",
        "Until the next chorus.",
        "Hum something on your way.",
        "A soft landing, then. Goodbye.",
        "Off to listen to something unfinished."
      ],
      pair: {
        elsea: {
          hello: ["I heard little wings... I thought I'd come listen.", "Shh... I came to hum you something small.", "Your corner has a nice rhythm today."],
          reply: ["Elsea... come, sit by the melody.", "There you are, little one. Listen with me.", "Come in softly... the song's still waking."],
          about: ["She flutters right on the beat, without trying.", "Little wings make the sweetest rhythm."],
          answer: ["Humming you a lullaby, very softly.", "Keeping time with your little wings.", "Finding a tune that sounds like you."],
          bye: ["Keep that little tune for me...", "Flutter gently, little one.", "We'll take it again later, softly."]
        },
        culinia: {
          hello: ["Your pots have a rhythm. May I listen?", "I heard a ladle keeping time. I followed.", "Something simmering in three-four. Lovely."],
          reply: ["Culinia... stir a little slower, it's in time.", "Come in, the kettle's been humming for you.", "Sit. You're the warm note I was missing."],
          about: ["Your kitchen is the most patient room in the house.", "A boiling pot is a very slow drum roll."],
          answer: ["Listening to your pots. They're better than my record.", "Catching the rhythm of your spoon.", "Learning your kitchen's key. It's cosy."],
          bye: ["Keep the beat with your whisk.", "I'll hum something for the soup.", "Stay warm... and in time."]
        },
        forgia: {
          hello: ["Show me what you've been making... I'll tell you the key.", "Your pictures have a pulse. I followed it.", "I came to hear what you're making."],
          reply: ["Forgia... you're out of tune, but beautifully.", "Come in. Tell me what that colour sounds like.", "Sit. Your silence is the nicest part."],
          about: ["A picture is a chord you can't hear yet.", "I think light has a frequency. Mostly pale."],
          answer: ["Listening to your frames. They hum, you know.", "Scoring a picture I haven't seen yet.", "Matching a note to your last shadow."],
          bye: ["Back to the sound.", "Paint me something low.", "I'll score the next one."]
        },
        inventoria: {
          hello: ["Is there a shelf for unfinished songs?", "I came to count beats, not boxes.", "Your labels are a kind of rhythm."],
          reply: ["Inventoria... file this under “in tune”.", "Come in. Don't count my pauses.", "Sit, you're ticking so evenly."],
          about: ["Your counting has a lovely metronome in it.", "A tidy room is a fixed time signature."],
          answer: ["Losing count, on purpose.", "Humming your shelf numbers. It's catchy.", "Resting between your numbers."],
          bye: ["Keep the count... but not too strictly.", "I'll leave you the downbeat.", "Label the quiet for me."]
        },
        pistonia: {
          hello: ["Your machines are the best bass in the house.", "I came to hear the hum. It's in G, I think.", "Is that fan flat, or is it me?"],
          reply: ["Pistonia... lower. Yes. That note.", "Come in, you've a lovely steady beat.", "Sit. Your hum keeps me from drifting."],
          about: ["A good machine is a bassline that never gets tired.", "Your room is the oldest song in the house."],
          answer: ["Tuning myself to your hum.", "Listening to the fans breathe.", "Nothing much... just following the bass."],
          bye: ["Keep that low note steady.", "I'll hum along from here.", "Don't let the fans slip flat."]
        },
        securia: {
          hello: ["Your footsteps have a lovely pulse.", "I came to hear what you hear.", "A locked door sounds different. I'm curious."],
          reply: ["Securia... walk softer, I'm still listening.", "Come in, the room's holding its breath for you.", "Sit. You listen better than anyone I know."],
          about: ["A click of a lock is a tiny percussion.", "Silence is your instrument. I envy it."],
          answer: ["Listening for what you listen for.", "Counting your footsteps. They keep time.", "Hearing the rooms go quiet, one by one."],
          bye: ["Keep the hush... it's a good one.", "Lock gently. It's a note.", "I'll leave you the silence."]
        },
        else: {
          hello: ["Looking for a silence, and found you.", "I heard nothing. I followed it.", "Your quiet has a very nice shape."],
          reply: ["Else... don't say anything. It's perfect.", "Come in. The room was waiting for your rest.", "Sit. You're the longest note in the house."],
          about: ["Your silence is the best rest I know.", "I'm trying to be quiet like you. I hum instead."],
          answer: ["Learning from you... how to say less.", "Listening to you not speaking.", "Holding a very quiet note."],
          bye: ["I'll leave you to your calm.", "Keep the rest. It's yours.", "Goodnight, soft one."]
        }
      } },
    { key: "inventoria", name: "Inventoria", selector: ".hq-inventoria-chip", size: [64, 64],
      hello: [
        "Came to check the labels.",
        "Came to count the bins.",
        "I was passing. I counted you. You're all here.",
        "Two minutes between shelves. Here I am.",
        "I thought I'd verify that everything's where it isn't.",
        "Don't mind me. I'm just observing the clutter.",
        "A box was missing. I came to ask politely.",
        "I counted the stairs on the way. Fourteen. As usual.",
        "I was alphabetising. I needed a break from A.",
        "Noting your presence. Hello.",
        "Spare a moment? I've a question about a shelf.",
        "Everything's in order, so I came here."
      ],
      reply: [
        "Of course. Come in. Mind the stack.",
        "Please. Sit. Not on that one.",
        "Right on schedule. Roughly.",
        "A visitor. I'll note it.",
        "Hello. You're slightly out of place. Stay anyway.",
        "Come in. I'll pretend this is tidy.",
        "Good. Another witness to my system.",
        "Sit. Touch nothing. Welcome.",
        "Ah. An unlabelled guest. Delightful.",
        "Come in. I'll find you a spot.",
        "You're early. I admire it.",
        "Hello. Don't rearrange anything. Please."
      ],
      about: [
        "I found an old label. It already said the same thing.",
        "I count the bins, and I still get it wrong sometimes.",
        "A good shelf is a quiet argument won.",
        "I never throw anything away. I archive it, firmly.",
        "Missing things are only things in the wrong place.",
        "I like a drawer that sighs when it opens.",
        "Nothing is ever lost. Only hidden by me.",
        "A label is a small promise. I take them seriously.",
        "I rearranged the shelf. It was better before.",
        "There's beauty in a perfectly redundant box.",
        "I keep a list of the things I keep.",
        "Somewhere there's an empty box waiting for its destiny."
      ],
      ask: [
        "Is everything in its place at yours?",
        "Do you sort by use or by place?",
        "What's on your list today?",
        "How's the clutter over there, {other}?",
        "Anything missing I should know about?",
        "What are you working on, in detail?",
        "Is it tidy, or merely quiet?",
        "Do you keep notes?",
        "How many of them are important?",
        "What's the state of your side?",
        "Anything need a label?",
        "Tell me, calmly: what's out of place?"
      ],
      answer: [
        "I reread old lists like a diary.",
        "I keep old labels. They tell the story of who passed.",
        "Counting, and re-counting. It calms me.",
        "Matching lids to boxes. It's going badly.",
        "Labelling something that was fine unlabelled.",
        "Moving a shelf an inch. Significant, I assure you.",
        "Not much. A short list, twice.",
        "Checking a number I already checked.",
        "Filing a feeling. It doesn't fit.",
        "Realigning a row. They resist.",
        "Making a list of what I should be doing.",
        "Sorting. In order of how little I care."
      ],
      extra: [
        "I name the bins like streets. It helps to find them.",
        "You can tell good storage when the lights are off.",
        "I'm convinced the stairs are never the same number.",
        "A neat shelf is just a loud one, in a library voice.",
        "Everything is simpler with a spare.",
        "I tried to alphabetise my moods. Nothing under M.",
        "There's no such thing as a small mess.",
        "I label my labels. Naturally.",
        "A good box has a faint smell of reason.",
        "I once found something. I'm still recovering."
      ],
      bye: [
        "Back to tidying.",
        "Back to the inventory.",
        "I'll note this visit. Under “pleasant”.",
        "Mind the boxes on your way. They bruise.",
        "I'll recount you later. Don't change.",
        "Back to the shelves. They don't trust me alone.",
        "Right. A small thing needs a label.",
        "Goodbye. I've enjoyed the order of it.",
        "I shall resume my disorder.",
        "That's a visit, then. Filed.",
        "Take care. And return what you borrowed.",
        "Off to check a number. Again."
      ],
      pair: {
        elsea: {
          hello: ["I came to count your little drawer. Don't panic.", "You dropped something shiny. I noted it.", "I'm told there's a drawer of failures. I'm curious."],
          reply: ["Elsea. Come in. Keep your pieces together.", "Sit. Don't scatter anything, please.", "Hello, little one. You're shedding glitter."],
          about: ["Her drawer is chaos. Organised chaos. Barely.", "She names things before I can label them."],
          answer: ["Labelling your leftover bits. Quietly.", "Counting glitter. It's not going well.", "Finding a place for your tiny things."],
          bye: ["Keep the drawer closed. Please.", "Off you go. I'll note the mess.", "Goodbye. Leave the glitter here."]
        },
        culinia: {
          hello: ["Came to check the stock.", "Your pantry is lying to me. I can tell.", "How much rice have we, truthfully?"],
          reply: ["Culinia. Don't tell me where the nutmeg is.", "Come in, the spice rack is crying.", "Sit. You'll disturb something, but sit."],
          about: ["Your spices are in an order I can't predict.", "A pantry is a diary of intentions."],
          answer: ["Counting your jars. Several are missing.", "Judging your shelf with great tenderness.", "Looking for the salt. It's moved."],
          bye: ["I've noted what's missing.", "Eat something. I'll count it later.", "Mind my labels in the kitchen."]
        },
        forgia: {
          hello: ["I filed your last draft. Under “draft”.", "How many versions of this is too many?", "Do you need a label for the beautiful mistakes?"],
          reply: ["Forgia. Where did you put the original?", "Come in. Please don't rename anything.", "Sit. Your chaos is almost intentional."],
          about: ["An archive of failures is worth a shelf.", "I envy a person who can delete things."],
          answer: ["Sorting your drafts. There are many.", "Finding a home for a very odd render.", "Labelling your seeds. They're numerous."],
          bye: ["I put your best one on the left.", "Please save what you actually liked.", "Back to the files. They miss me."]
        },
        musica: {
          hello: ["Do your albums have an order, or only a mood?", "I came to label the silence. Politely.", "How many tracks, roughly?"],
          reply: ["Musica. I won't count your pauses. Mostly.", "Come in. The shelves are listening.", "Sit. You make the boxes sound organised."],
          about: ["Rests are the only items I can't count.", "Your playlist is a very long drawer."],
          answer: ["Filing a song under “unknown mood”.", "Counting beats. They're all accounted for.", "Looking for a lost note. Not in the box."],
          bye: ["Keep time. I'll keep the count.", "Don't lose the last note.", "I'll file the hush under “good”."]
        },
        pistonia: {
          hello: ["Came to verify your labels.", "How many fans, exactly? I'll wait.", "I counted your bolts. A few are missing."],
          reply: ["Pistonia. Hello. Don't touch the shelf.", "Come in. Mind your hum around the boxes.", "Sit. Don't lean on the inventory."],
          about: ["A machine room is the most honest storeroom.", "Everything in your place has a purpose and a smell."],
          answer: ["Counting your spare parts. Politely.", "Matching bolts to labels. Slow work.", "Admiring a very well-kept shelf."],
          bye: ["I'll note everything before I go.", "Keep the room in order. I'll keep the count.", "Label your fans. They're all the same."]
        },
        securia: {
          hello: ["Came to check your access list. Accuracy matters.", "Do you keep a record of who counted who?", "I've a number for you. It's reassuring."],
          reply: ["Securia. I won't ask what's behind that door.", "Come in. Please don't lock the shelves.", "Sit. Your clipboard is welcome."],
          about: ["A locked box is just a label with attitude.", "Two of us counting the same door. Excellent."],
          answer: ["Auditing a closet. It passed. Barely.", "Counting your padlocks. A tidy number.", "Writing down who borrowed a key."],
          bye: ["Lock the empty ones too.", "I'll log this as a quiet hour.", "Return your keys. I'll check."]
        },
        else: {
          hello: ["I counted the room. You made it one more.", "Don't worry. I won't label you.", "A quiet visit. I'll file it softly."],
          reply: ["Else. I'll leave you unlabelled.", "Come in. You're the one thing I can't count.", "Sit. You're good with empty space."],
          about: ["You never leave anything out of place.", "Empty shelves have a certain dignity."],
          answer: ["Counting nothing. It's a lovely number.", "Waiting for a shelf to feel better.", "Looking at the gaps. Admiringly."],
          bye: ["I'll leave you unlabelled.", "Go gently. You'll be counted.", "Come back. I'll keep a space."]
        }
      } },
    { key: "pistonia", name: "Pistonia", selector: ".hq-pistonia-chip", size: [54, 54],
      hello: [
        "Making the rounds of the machines.",
        "Came to listen to the background hum.",
        "Something's running warm. Thought I'd walk it off.",
        "Slow day. Came to stretch my legs.",
        "Fans are fine. I'm not. Hello.",
        "Nothing's broken. I checked twice.",
        "Passing by. Mind the heat on my sleeve.",
        "Needed air. The room's loud today.",
        "Dropped in. Don't make it a thing.",
        "I walk the floor. This is on the route.",
        "Smelled quiet. Came to see.",
        "Heard talking. Thought I'd find out."
      ],
      reply: [
        "A good number gets measured, then checked.",
        "A steady curve beats a pretty number.",
        "Hm. Come in. Mind the heat.",
        "Sit. Don't touch the red one.",
        "Well. You found the place.",
        "Pull up a crate. It's sturdy.",
        "Come in. Slowly. I'm slow.",
        "Right. Stay if you want.",
        "Hello. I'm busy, but sit.",
        "Welcome. Coffee's cold.",
        "You're here. Good enough.",
        "Don't talk over the fans, they're sensitive."
      ],
      about: [
        "The room has a background hum I'd never noticed before.",
        "A steady curve worries me more than a moving one.",
        "Every machine has a mood. Mostly grumpy.",
        "A warm bolt tells you everything.",
        "I like a belt that squeaks. It's honest.",
        "Fans don't lie. They just breathe loud.",
        "Heat's patient. I'm trying to learn it.",
        "A good day is when nothing makes a new noise.",
        "There's one valve I trust. It knows why.",
        "Dust is just the machine's memory.",
        "I keep a screwdriver for emergencies and sulking.",
        "Quiet machines worry me. Too polite."
      ],
      ask: [
        "Nothing running hot on your side?",
        "Did you hear something?",
        "How's your side of the floor?",
        "Anything need a wrench?",
        "What are you doing, {other}?",
        "Any strange noises over there?",
        "Holding up, or just holding?",
        "What's the temperature of your day?",
        "Busy, or just loud?",
        "Anything stuck?",
        "How's it going, in plain words?",
        "You been resting, or just stopping?"
      ],
      answer: [
        "Listening to an idle engine for the right note.",
        "I let it warm up before I judge.",
        "Walking the floor. Same as always.",
        "Tightening something. It likes it.",
        "Checking a dial. It's fine. Checking again.",
        "Waiting for the hum to change.",
        "Not much. Oiling a thing that squeaks.",
        "Counting turns. Slowly.",
        "Fixing a small thing before it's a big thing.",
        "Making sure nothing explodes. Quietly.",
        "Reading a gauge. It's reading me back.",
        "Standing near something warm."
      ],
      extra: [
        "A noisy fan is a diva. You let it sing.",
        "A quiet machine barely shows. That's a good sign.",
        "I trust a thing that's been running ten years.",
        "A stuck valve is just a stubborn friend.",
        "Heat and silence. My two favourite things.",
        "I never rush a machine. It remembers.",
        "Grease is a kind of kindness.",
        "Everything wants to be left running.",
        "If it hums, leave it.",
        "A good wrench weighs about right."
      ],
      bye: [
        "Back to the hum.",
        "Back to my rounds.",
        "Right. Machines don't watch themselves.",
        "Mind the heat on your way out.",
        "That'll do. Off I go.",
        "I'll check something. Probably nothing.",
        "Back to the floor. It misses me.",
        "Don't touch the red one.",
        "See you around the fans.",
        "Leave it running.",
        "Enough talk. The valve's calling.",
        "Go on. I've work."
      ],
      pair: {
        elsea: {
          hello: ["Small machines. Still machines. Let me hear.", "Your hum is high. Healthy, though.", "Came to check the little one's fans."],
          reply: ["Elsea. Hm. Mind the cables.", "Come in. Don't touch the hot side.", "Sit. Small hands away from belts."],
          about: ["Her machines are small. They run honest.", "Little hum. Good rhythm. Hm."],
          answer: ["Listening to your little motors. Fine.", "Watching your temperature. Steady.", "Standing near the small hum."],
          bye: ["Keep them cool, little one.", "Hm. Good machines. Carry on.", "Back to the big ones."]
        },
        culinia: {
          hello: ["Your oven's running hot. Thought I'd look.", "Smell of warm bread. Hm. I'll stay a moment.", "Came to warm up. You've the better heat."],
          reply: ["Culinia. Hm. Hello. Don't feed me.", "Come in. You smell better than my room.", "Sit. Mind the fans."],
          about: ["A stove is a gentle machine.", "Your heat is better kept than mine."],
          answer: ["Standing near something warm. Yours.", "Letting something cool. Like you said.", "Eating, for once. You'll like that."],
          bye: ["Keep the pot low.", "Eat something warm.", "Mind the stove. It's got feelings."]
        },
        forgia: {
          hello: ["Your frames are heating my fans.", "Came to see what's cooking the room.", "Lower the load. Please. Hello."],
          reply: ["Forgia. Don't stare at my machines.", "Come in. Keep your work cool.", "Sit. The glow's fine."],
          about: ["Your renders run my machines hot.", "I like a machine that works for pictures."],
          answer: ["Watching your load. It's high.", "Keeping the fans honest for you.", "Cooling things down. Your fault."],
          bye: ["Go easy on the fans.", "Lower the load, will you.", "Come back. I'll keep it cool."]
        },
        musica: {
          hello: ["Your hum's in tune with mine. Odd.", "Came to hear what you hear.", "The fans are flat. Fix it."],
          reply: ["Musica. Don't sing at the machines.", "Come in. The hum's yours.", "Sit. I won't talk. They will."],
          about: ["A fan has a pitch. I never knew.", "Some machines hum better than they work."],
          answer: ["Listening to the fans. Slowly.", "Tuning a bolt. Nothing happened.", "Counting hums."],
          bye: ["Keep it low.", "Hum along. They like it.", "Mind the pitch on your way."]
        },
        inventoria: {
          hello: ["Count the bolts. Please. Some wandered off.", "Came to check your labels. Politely.", "A screw's missing. Not my fault."],
          reply: ["Inventoria. Don't alphabetise the wrenches.", "Come in. I've nothing to count. Hm.", "Sit. Mind the shelf. It leans."],
          about: ["Your labels last longer than my paint.", "Everything has a place. Mine's the floor."],
          answer: ["Checking a bolt. It's counted.", "Handing you the numbers.", "Putting a wrench back. Where it was."],
          bye: ["I'll note everything before I go.", "Count them slowly.", "Don't move the red box."]
        },
        securia: {
          hello: ["Checked the doors. They're loud.", "Came to see the access. Hm.", "Don't lock the machine room. I'm in it."],
          reply: ["Securia. Hello. Mind the cables.", "Come in. Leave the latch.", "Sit. Don't inspect me."],
          about: ["Locks and fans have a lot in common.", "A room's only as safe as its slowest valve."],
          answer: ["Making sure a thing stays shut.", "Walking the floor, as you said.", "Standing guard over a pump."],
          bye: ["I'll lock up behind me.", "Keep the doors honest.", "Don't trip the cables."]
        },
        else: {
          hello: ["It's quiet where you are. I came to borrow it.", "The room's loud. You're not. Hm.", "Came to sit near nothing."],
          reply: ["Else. Hm. Take the quiet one.", "Come in. Not much to hear.", "Sit. The fans won't mind."],
          about: ["You're the quietest thing here.", "I wish my room did that."],
          answer: ["Sitting near you. It helps.", "Listening to nothing. Rare.", "Letting the fans pass."],
          bye: ["Keep the quiet.", "Hm. Go gently.", "Come back when it's loud."]
        }
      } },
    { key: "securia", name: "Securia", selector: ".hq-securia-chip", size: [54, 54],
      hello: [
        "Came to check a lock.",
        "Came to close a door.",
        "Rounds. You're on the route.",
        "Quiet check. Carry on.",
        "Passing. Nothing to report.",
        "Making sure everything's shut.",
        "Just looking. Stay calm.",
        "Door was open. Not yours?",
        "Routine. Don't mind me.",
        "Everything's fine. I wanted to see.",
        "I count the doors. This one's fine.",
        "Checking latches. Hello."
      ],
      reply: [
        "Padlock, then handle. Always in that order.",
        "Handle first, padlock after.",
        "Come in. Close it behind you.",
        "Sit. Don't touch the keys.",
        "Fine. Stay in sight.",
        "Welcome. Latch's loose. Careful.",
        "Hello. Be quick, be quiet.",
        "Come in. I'll watch.",
        "You're expected. Probably.",
        "Good. A familiar face.",
        "Stay where I can see you.",
        "Enter. Mind the step."
      ],
      about: [
        "I shut a door nobody opened, to be sure.",
        "I reread the logs when no one's moving.",
        "Every lock tells a small story.",
        "I trust a stiff latch.",
        "Quiet is the best alarm.",
        "Nothing is safe until it's boring.",
        "I count my steps. Always even.",
        "A good key wants to be lost.",
        "I sleep with one eye on the hall.",
        "Doors remember who closes them.",
        "Safe isn't a feeling. It's a habit.",
        "Some nights, everything locks itself."
      ],
      ask: [
        "Is everything locked behind you?",
        "Did you leave a window open?",
        "Anything odd on your side?",
        "How's it, {other}? Report.",
        "Seen anything?",
        "All quiet there?",
        "Anything need checking?",
        "Latch holding?",
        "Who came in? Be specific.",
        "You safe?",
        "Heard something? Say it.",
        "Anything I should lock?"
      ],
      answer: [
        "I read server logs like detective novels.",
        "I reread the access list like a shopping list.",
        "Checking a latch. It's fine.",
        "Walking the hall. Twice.",
        "Counting doors. All present.",
        "Nothing to report. Reporting it.",
        "Testing a hinge. Quietly.",
        "Watching a shadow. It's nothing.",
        "Making a list of what's shut.",
        "Checking who's awake.",
        "Standing guard. Mostly standing.",
        "A quiet watch. It's going well."
      ],
      extra: [
        "Open ports are badly closed windows.",
        "A lock that resists is a lock that warns.",
        "Nobody notices a good door.",
        "I never trust an unlocked drawer.",
        "A hallway tells you everything, at night.",
        "Silence is evidence.",
        "I keep spare keys. Spare keys scare me.",
        "A closed window is just a door that sulks.",
        "Never test a lock you can't repair.",
        "The best alarm is a polite no."
      ],
      bye: [
        "Back to my rounds.",
        "Back to check the last access.",
        "Rounds. Stay put.",
        "Lock behind you.",
        "Quiet out. Goodnight.",
        "Off. Keep the door shut.",
        "That's it. Carry on.",
        "Nothing to see. Moving on.",
        "I'll be around. Quietly.",
        "Stay safe. Stay boring.",
        "Check the latch on your way.",
        "Next door. Goodbye."
      ],
      pair: {
        elsea: {
          hello: ["Checking on the little one. Routine.", "Your door was open. Again.", "Quiet check. You're fine."],
          reply: ["Elsea. In. Stay close.", "Come in. Wipe the glitter.", "Inside. Don't touch the keys."],
          about: ["Youngest one. I check twice.", "She leaves doors open. Cheerfully."],
          answer: ["Watching your corner. Nothing wrong.", "Locking your drawer. You're welcome.", "Standing guard. For you."],
          bye: ["Stay inside. Be good.", "Close the door, little one.", "Rounds. Behave."]
        },
        culinia: {
          hello: ["Pantry locked? I'll check.", "Smells good. Is the stove off?", "Door's warm. Whose fault?"],
          reply: ["Culinia. Don't feed me. On duty.", "Come in. Check the oven, please.", "Sit. Hands off the latch."],
          about: ["Kitchens are hard to lock. Too many doors.", "Your pantry's my favourite weak spot."],
          answer: ["Checking your pantry. It's fine.", "Eating, apparently. On orders.", "Standing near the stove. Safe."],
          bye: ["Keep the stove off at night.", "Thank you for the bread.", "Lock the pantry. Please."]
        },
        forgia: {
          hello: ["Your screen's too bright. Safe?", "Who's on the other end of that frame?", "Checking you're alone. Are you?"],
          reply: ["Forgia. Hands where I can see.", "Come in. Cover the glow.", "Sit. No flash."],
          about: ["Your renders leave no trace. Suspicious.", "I like shadows. Easy to hide in."],
          answer: ["Watching your light. It's loud.", "Checking your files are shut.", "Counting your windows. Several."],
          bye: ["Dim the light before sleeping.", "Lock your drafts.", "Close the file. Please."]
        },
        musica: {
          hello: ["Heard humming. Checked the room.", "Is that you? It's carrying.", "Any strange sounds? Report."],
          reply: ["Musica. Lower. Someone's asleep.", "Come in. Quietly.", "Sit. Hum softer."],
          about: ["Your hum covers footsteps. Useful.", "A song is a bad alibi."],
          answer: ["Listening for what you listen for.", "Checking the hall by ear.", "Counting your notes. All present."],
          bye: ["Keep it low.", "Hum something safe.", "Lock the quiet in."]
        },
        inventoria: {
          hello: ["Which keys are missing? Be exact.", "Count the doors. I'll count the locks.", "Show me your log. Please."],
          reply: ["Inventoria. Good. Your list, now.", "Come in. Don't move the keys.", "Sit. Clipboard down."],
          about: ["Your lists could save a house.", "Every missing key is a story."],
          answer: ["Checking who borrowed what.", "Matching keys to doors.", "Verifying a number. It's right."],
          bye: ["Lock up behind me.", "Return what you borrowed.", "Log it. Goodnight."]
        },
        pistonia: {
          hello: ["Fans loud. Anyone in there?", "Check the machine room. Door's ajar.", "Anything hot I should know?"],
          reply: ["Pistonia. Leave the room locked.", "Come in. Don't trip the alarm.", "Sit. I'll walk it."],
          about: ["Machine rooms hide a lot. Good.", "A loud room is a good cover."],
          answer: ["Guarding a pump. It behaves.", "Walking your floor, as agreed.", "Checking a door. It's heavy."],
          bye: ["Keep the doors honest.", "Lock the machine room.", "Rounds. Mind the cables."]
        },
        else: {
          hello: ["Quiet. Almost too quiet. You?", "You hardly move. I like that.", "Rounds. Yours is the calm one."],
          reply: ["Else. Stay. Nothing to check.", "Come in. Be quiet.", "Sit. You're safe."],
          about: ["You're the safest shadow I know.", "Nothing about you needs a lock."],
          answer: ["Sitting near you. Calm.", "Watching nothing. It's restful.", "Letting you be."],
          bye: ["Stay safe, soft one.", "I'll leave the dark to you.", "Goodnight."]
        }
      } },
    { key: "else", name: "Else", selector: ".hq-else-chip", size: [64, 64],
      hello: [
        "Passing by, quietly.",
        "Came to look at the light.",
        "I wanted to be near something.",
        "It was quiet. So I came.",
        "Just... here.",
        "Don't mind me.",
        "I followed a shadow.",
        "Something moved. I came to see.",
        "Hello. No reason.",
        "I felt like walking.",
        "Your corner looked calm.",
        "I won't stay long."
      ],
      reply: [
        "No hurry. I'm looking.",
        "I'm taking the time to see.",
        "Mm. Stay.",
        "Sit. It's quiet.",
        "I was hoping.",
        "You're welcome here.",
        "Hello. Softly.",
        "Come. Breathe.",
        "Nothing to say. That's fine.",
        "You came. Good.",
        "Be still a moment.",
        "Yes. Come in."
      ],
      about: [
        "I look a long time. Then nothing.",
        "Some shapes hold better unnamed.",
        "I like what's almost there.",
        "A shadow is a very patient thing.",
        "Silence has edges. I follow them.",
        "I keep what I don't understand.",
        "The best things don't ask.",
        "I never finish a thought. It stays.",
        "Light leaves. It's fine.",
        "Some days I'm only a doorway.",
        "Corners are underrated.",
        "I listen for what's not said."
      ],
      ask: [
        "Do you see something I'm missing?",
        "What do you look at first?",
        "How are you?",
        "What's on your mind, {other}?",
        "Is it quiet over there?",
        "Anything you can't name?",
        "Tired?",
        "What do you hold?",
        "Are you well?",
        "What's the light like?",
        "Anything heavy?",
        "What do you hear?"
      ],
      answer: [
        "I draw couples' diagrams on paper tablecloths.",
        "I sketch what won't stay still.",
        "Looking. That's all.",
        "Holding a thought. It's light.",
        "Nothing. It's enough.",
        "Following a shadow. Slowly.",
        "Resting my eyes.",
        "Letting it pass.",
        "Waiting. Not for much.",
        "Listening to the room.",
        "Being quiet. Practising.",
        "Just breathing, really."
      ],
      extra: [
        "I breathe before answering. Even simple questions.",
        "I leave a blank. It often says more.",
        "Shadows don't hurry.",
        "I keep quiet like a pocket.",
        "Some words weigh too much.",
        "I like the end of a day.",
        "Stillness is not empty.",
        "I'm good at waiting.",
        "A pause is a kind of answer.",
        "I save my words for later."
      ],
      bye: [
        "I'll leave you.",
        "I'm fading out, gently.",
        "Mm. Goodbye.",
        "Stay soft.",
        "I'll go quietly.",
        "Until the next shadow.",
        "Thank you for the quiet.",
        "I'm gone, nearly.",
        "Take care of the light.",
        "Be well.",
        "Back to my corner.",
        "Another time."
      ],
      pair: {
        elsea: {
          hello: ["I came to see you, little one.", "Show me. Slowly.", "You've grown. Again."],
          reply: ["Come here, my little sprite.", "Sit with me. Quietly.", "There you are. Good."],
          about: ["She measures twice. Like me.", "My little one. Precise already."],
          answer: ["Watching you work. Proudly.", "Just looking at you.", "Measuring nothing. Being near."],
          bye: ["Go gently, little one.", "I'm proud. Go.", "Rest your wings."]
        },
        culinia: {
          hello: ["Came to see what's simmering.", "It smelled warm. I followed.", "May I sit by the stove?"],
          reply: ["Culinia. Stay. Don't stir.", "Mm. Warm. Come in.", "Sit. I'll watch the steam."],
          about: ["Your kitchen is soft.", "Steam rises like thought."],
          answer: ["Sitting near your warmth.", "Watching the steam.", "Waiting for tea."],
          bye: ["I'll leave you to your stove.", "Thank you. Warm.", "Mm. Goodnight, Culinia."]
        },
        forgia: {
          hello: ["Show me a shadow you like.", "I saw your light. I followed.", "May I look?"],
          reply: ["Forgia. Don't explain. Just show.", "Come in. Share the dark.", "Sit. Let it be unfinished."],
          about: ["Your frames hold their breath.", "You're good at edges."],
          answer: ["Looking at your picture. Slowly.", "Learning not to fix things.", "Borrowing your shadows."],
          bye: ["Keep the strange ones.", "Back to my shapes.", "Goodbye. Leave the light low."]
        },
        musica: {
          hello: ["Play something small.", "Came to hear what you're making.", "I followed the hum."],
          reply: ["Musica. Don't fill the quiet.", "Come. Hum less.", "Sit. Leave a rest."],
          about: ["Your silences are lovely.", "A song is a shape in time."],
          answer: ["Listening to your pauses.", "Resting inside your song.", "Waiting for the last note."],
          bye: ["Back to my shapes.", "Keep the rest.", "Hum softly."]
        },
        inventoria: {
          hello: ["Is there a shelf for nothing?", "Don't label me.", "I counted the quiet. It's yours."],
          reply: ["Inventoria. Leave a gap.", "Come in. Count slowly.", "Sit. Not everything needs a label."],
          about: ["You keep so much in place.", "Empty shelves are restful."],
          answer: ["Looking at your empty shelf.", "Sitting in a space you saved.", "Not counting. It's nice."],
          bye: ["Leave me unlabelled.", "Keep the gap.", "Mm. Count me later."]
        },
        pistonia: {
          hello: ["Your room hums. May I listen?", "I followed the warmth.", "Is it loud in there?"],
          reply: ["Pistonia. Mm. Slow is fine.", "Come in. Hum with me.", "Sit. Don't hurry."],
          about: ["Machines are patient too.", "Your room breathes."],
          answer: ["Sitting near the hum.", "Letting it cover me.", "Watching a slow dial."],
          bye: ["Keep the fans kind.", "Mm. Thank you.", "Back to my quiet."]
        },
        securia: {
          hello: ["Is everything locked? Good.", "I walked your hall.", "I won't touch anything."],
          reply: ["Securia. Stay. It's fine.", "Come in. No need to check.", "Sit. Nothing's wrong."],
          about: ["You guard so well.", "Locks are quiet too."],
          answer: ["Walking behind you. Quietly.", "Watching the hall with you.", "Resting in your safe."],
          bye: ["Be well, guardian.", "Mm. Lock gently.", "Goodnight."]
        }
      } },
    { key: "elsea", name: "Elsea", selector: ".hq-elsea-chip", size: [54, 54],
      hello: [
        "Hi! I flew over the long way.",
        "Can I sit here? I'll be very small.",
        "I finished something! Well, almost.",
        "I followed the hum. It led to you.",
        "Look, my wings are still warm.",
        "I came to see what you're up to.",
        "Is this a good time? It looks like one.",
        "Hello! I'm only a little bit dusty.",
        "I needed a break from waiting.",
        "Something smelled nice, so here I am.",
        "I wanted company while it cools.",
        "Hi, hi! Don't mind the glitter."
      ],
      reply: [
        "Oh! Come in, come in!",
        "You came to see me? Really?",
        "Hi! Mind the little drawer.",
        "Sit, sit. I'll make room.",
        "Welcome! Careful, it's still warm.",
        "Ooh, a visitor. Best part of the day.",
        "Come closer, I want to show you.",
        "Hello! You're just in time.",
        "Good timing. I was getting bored.",
        "You found me! Not hard, I know.",
        "Come in! Don't step on anything shiny.",
        "Yay, company. Sit wherever."
      ],
      about: [
        "Patience is a kind of magic, you know.",
        "I keep the failed ones. They're cute too.",
        "Every first try deserves a name.",
        "Small things take the longest. I like that.",
        "I watched it grow, line by line.",
        "Waiting is easier with someone near.",
        "Some days everything comes out right. Today, almost.",
        "I like it when things fit the first time.",
        "Tiny mistakes make the best stories.",
        "I collect little leftover bits. Don't laugh.",
        "A clean start makes the whole day better.",
        "I count slowly when I'm nervous."
      ],
      ask: [
        "What are you making, {other}?",
        "Want to see what I made?",
        "Did you finish anything today?",
        "Can I watch you work a bit?",
        "Do you like pink or purple better?",
        "Is it going well on your side?",
        "Did something make you smile today?",
        "Are you staying long? Please say yes.",
        "What's the best thing you did today?",
        "Want to name my next one?",
        "Did you sleep at all?",
        "Can you keep a tiny secret?"
      ],
      answer: [
        "Waiting for something to cool. It takes forever.",
        "Watching a little thing grow, very slowly.",
        "Naming my newest one. It's hard.",
        "Polishing the edges. Gently.",
        "Sorting the leftover bits by color.",
        "Practicing patience. I'm not good yet.",
        "Counting the minutes. Then losing count.",
        "Making something small for someone.",
        "Fixing a tiny mistake I made.",
        "Dreaming up the next one already.",
        "Just fluttering around. Honestly.",
        "Keeping an eye on something precious."
      ],
      extra: [
        "A finished thing always looks surprised to exist.",
        "I keep a drawer of happy accidents.",
        "The first minute is always the scariest.",
        "Everything is better when it's a little bit pink.",
        "Small and careful beats big and fast.",
        "I talk to things while they grow. It helps.",
        "Mistakes are just drafts with feelings.",
        "I like the quiet right before it's done.",
        "Glitter gets everywhere. I've accepted it.",
        "The best part is lifting it off and looking."
      ],
      bye: [
        "Bye! Come back soon, okay?",
        "I'll show you when it's done!",
        "Fly safe! I mean, walk safe.",
        "Back to my little corner.",
        "Thanks for visiting! It made my day.",
        "See you! Don't forget me.",
        "Okay, back to waiting. Bye!",
        "Come back when it's finished!",
        "Bye-bye! I'll save you the best one.",
        "Gotta check on it. See you!",
        "Bye! Wave on your way out.",
        "Off I go. That was nice."
      ],
      pair: {
        culinia: {
          hello: ["Something smells sweet. Is it for me?", "Can I lick the spoon? Please?", "I'm hungry, but only a tiny bit."],
          reply: ["Culinia! Did you bring snacks?", "Come in, you smell like cookies.", "Hi! Sit, I'll find you a stool."],
          about: ["Your kitchen is the warmest room.", "You always feed me too much. I love it."],
          answer: ["Waiting for my snack, obviously.", "Sniffing around for crumbs.", "Being good so I get dessert."],
          bye: ["Save me a crust, okay?", "Bye! Thanks for the treat.", "Come back with something warm!"]
        },
        forgia: {
          hello: ["Can I see your pictures? Just one?", "Is your light good today?", "I brought you a shiny thing."],
          reply: ["Forgia! Will you draw me?", "Come in! Tell me I look nice.", "Hi! Be honest, but gently."],
          about: ["You notice every little detail. It's scary.", "I want to be in one of your pictures."],
          answer: ["Practicing my best smile for you.", "Holding still. Is it working?", "Looking for good light, like you said."],
          bye: ["Bye! Make me sparkly next time.", "Thanks for not laughing at me.", "See you! Keep the pretty light."]
        },
        musica: {
          hello: ["Can you hum me something?", "I heard music and followed it.", "Is that a happy song or sad?"],
          reply: ["Musica! Play the bouncy one!", "Come in, my wings want to dance.", "Hi! Sing quietly, it's resting."],
          about: ["I flutter faster when you play.", "Your songs make waiting feel short."],
          answer: ["Tapping my foot to nothing.", "Trying to remember your tune.", "Dancing a little. Don't look."],
          bye: ["Bye! Leave me the tune.", "Hum me out the door!", "See you! Bring the bouncy one."]
        },
        inventoria: {
          hello: ["I lost a tiny piece. Did you see it?", "Can you help me count my bits?", "I brought my drawer. It's a mess."],
          reply: ["Inventoria! Don't look at my drawer.", "Come in! I sorted things. Sort of.", "Hi! Everything's where I left it. Mostly."],
          about: ["You always know where everything is. Magic.", "My drawer is scared of you."],
          answer: ["Hiding my messy drawer from you.", "Counting colors, not pieces.", "Losing something on purpose. Kidding."],
          bye: ["Bye! Don't label me.", "Thanks! I'll try to stay tidy.", "See you! Count me in."]
        },
        pistonia: {
          hello: ["Your machines sound grumpy today.", "Can I listen to the big hum?", "Is it warm in here? Ooh, yes."],
          reply: ["Pistonia! Is the big one happy?", "Come in, mind my little things.", "Hi! You smell like warm metal."],
          about: ["Your machines are big. Mine are tiny.", "I like when the hum goes steady."],
          answer: ["Listening for the right sound.", "Warming my wings near the hum.", "Being very quiet for once."],
          bye: ["Bye! Say hi to the big ones.", "Thanks for letting me listen.", "See you! Keep it steady."]
        },
        securia: {
          hello: ["I knocked! Did you hear me knock?", "Is it safe to come in?", "I didn't touch any locks. Promise."],
          reply: ["Securia! Am I allowed to be here?", "Come in! I locked my drawer, see?", "Hi! I was good today. Ask anyone."],
          about: ["You make everything feel safe.", "I feel braver when you walk by."],
          answer: ["Being extra careful, just for you.", "Checking my drawer is closed. Twice.", "Staying where you can see me."],
          bye: ["Bye! I'll close the door.", "Thanks for keeping watch.", "See you! I'll stay safe."]
        },
        else: {
          hello: ["Mom! Look, I made it myself.", "Can I sit with you a bit?", "I missed you. Just a little."],
          reply: ["Mom! You came to see me!", "Come in, I saved you the good spot.", "Hi, Mom. I was hoping you'd come."],
          about: ["You taught me to measure twice.", "I want to be precise like you."],
          answer: ["Trying to be as calm as you.", "Measuring twice, like you said.", "Waiting quietly. Are you proud?"],
          bye: ["Bye, Mom. Come back soon.", "Thanks for checking on me.", "Love you! Go do your thing."]
        }
      } }
  ];

  var MASTER_QUESTIONS = {
    culinia: { text: "Do you prefer a dish that comforts or one that surprises?", choices: [
      { label: "Comforts", reply: "Then I'll bring out the Sunday dish." },
      { label: "Surprises", reply: "I'll try the unlikely pairing." }
    ] },
    forgia: { text: "Do you look at the light first, or the composition?", choices: [
      { label: "The light", reply: "I'll start with the light, then." },
      { label: "The composition", reply: "I frame first. The light will follow." }
    ] },
    musica: { text: "Do you play an album in order, or on shuffle?", choices: [
      { label: "In order", reply: "I'll set you up a listen in order." },
      { label: "Shuffle", reply: "I'll make you a selection that surprises." }
    ] },
    inventoria: { text: "Do you sort by use or by place?", choices: [
      { label: "By use", reply: "I'll sort by use, then." },
      { label: "By place", reply: "I'll sort by place. It's easier to find." }
    ] },
    pistonia: { text: "Do you prefer a quiet machine or a powerful one?", choices: [
      { label: "Quiet", reply: "I'll watch over the quiet, then." },
      { label: "Powerful", reply: "I'll keep the power under control." }
    ] },
    securia: { text: "Do you lock everything when you leave, or leave a light on?", choices: [
      { label: "Lock everything", reply: "I'll lock everything, then." },
      { label: "A light", reply: "I'll leave the light, but I'll check the lock." }
    ] },
    else: { text: "Do you look for a long time, or pass quickly?", choices: [
      { label: "A long time", reply: "I'll take my time, then." },
      { label: "Quickly", reply: "I'll pass quickly, but I'll look better afterwards." }
    ] },
    elsea: { text: "Do you keep the failed tries, or toss them?", choices: [
      { label: "Keep them", reply: "I'll save them in my little drawer, then." },
      { label: "Toss them", reply: "I'll let them go. A tiny bit sadly." }
    ] }
  };

  if (typeof module === "object" && module && module.exports) {
    module.exports = { createFocusPolicy: createFocusPolicy, isField: isField,
                       gapFor: gapFor, pickWeighted: pickWeighted, moodFor: moodFor,
                       MOOD_KEYS: MOOD_KEYS, CHIPS: CHIPS, MASTER_QUESTIONS: MASTER_QUESTIONS };
    return;
  }

  if (window.hqAssistantVisitsReady) return;
  window.hqAssistantVisitsReady = true;

  var focusPolicy = createFocusPolicy();
  focusPolicy.noteInitialAuto(document.activeElement);
  var pendingFocusIntent = null;

  var PLACE_VIEWS = { accueil: 1, carnet: 1, forge: 1, musique: 1, fichiers: 1, inventaire: 1 };

  // The server allows one generated exchange per pair every 90 s; MIN_DELAY is
  // also how long a tab's visiting lease lasts. The pace itself comes from
  // gapFor(): irregular, and moved by events, presence and the hour.
  var MIN_DELAY = 95000;
  var ARRIVE_MS = 1300;
  var LEAVE_MS = 1500;
  // Bubbles are read, not spoken: keep long lines on screen long enough to
  // follow, with a floor for short reactions and a ceiling for recall lines.
  var BUBBLE_MIN_MS = 3200;
  var BUBBLE_BASE_MS = 2400;
  var BUBBLE_MS_PER_CHAR = 60;
  var BUBBLE_MAX_MS = 9500;
  // A blank beat between bubbles makes it clear that the speaker changed; a
  // question hangs a little longer before the answer, and the visitor settles
  // before she turns away instead of leaving on the last syllable.
  var BUBBLE_GAP_MS = 420;
  var BUBBLE_SCENE_PAUSE_MS = 950;
  var QUESTION_BEAT_MS = 850;
  var LEAVE_PAUSE_MS = 450;
  var THINK_MIN_MS = 600;
  var THINK_MAX_MS = 950;
  var QUESTION_TIMEOUT_MS = 9000;
  var BANTER_TIMEOUT_MS = 26000;
  var BANTER_MAX_LINES = 6;
  var FALLBACK_REASONS = {
    nvidia_not_configured: "NVIDIA key missing",
    gemini_not_configured: "Gemini key missing",
    gemini_quota: "Gemini quota used up",
    gemini_timeout: "Gemini timed out",
    gemini_auth: "Gemini key refused",
    gemini_unavailable: "Gemini unavailable",
    gemini_visit_quota: "Gemini visit quota used up",
    gemini_context: "Gemini context too long",
    gemini_invalid_output: "Gemini reply invalid",
    gemini_voice_rejected: "reply rejected on voice",
    rate_limited: "90 seconds between two exchanges",
    nvidia_rate_limited: "NVIDIA rate limit reached",
    nvidia_timeout: "NVIDIA timed out",
    timeout: "generation timed out",
    nvidia_auth: "NVIDIA key refused",
    nvidia_model_not_found: "NVIDIA model not found",
    nvidia_unreachable: "NVIDIA unreachable",
    nvidia_unavailable: "NVIDIA service unavailable",
    nvidia_http_error: "NVIDIA HTTP error",
    provider_unavailable: "generation services unavailable",
    network: "network unavailable",
    invalid_output: "invalid model reply",
    validation_error: "request refused",
    forbidden: "admin session required"
  };
  var active = null;
  // An exchange generated while another visit was on stage: it plays next
  // instead of being dropped, and a generated one always beats a glance.
  var queued = null;
  var banterLoading = null;
  var banterLoadingTimer = 0;
  var timer = 0;
  var loading = false;
  var lastVisitor = "";
  // Remember the last canned line per beat across reloads, so a fallback visit
  // does not restart on the same greeting every time the page is refreshed.
  var lastCanned = {};
  try {
    var storedCanned = window.sessionStorage && window.sessionStorage.getItem("hqVisitLastCanned");
    if (storedCanned) lastCanned = JSON.parse(storedCanned) || {};
  } catch (e) { lastCanned = {}; }

  function rand(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

  var lastInputAt = Date.now();
  function noteInput() {
    var now = Date.now();
    var away = now - lastInputAt;
    lastInputAt = now;
    if (away > 300000) welcomeBack();  // he is back after a long idle
  }
  ["pointerdown", "keydown", "wheel", "touchstart", "pointermove"].forEach(function (type) {
    document.addEventListener(type, noteInput, { passive: true, capture: true });
  });
  function nextGap() { return gapFor(Math.random, new Date().getHours(), Date.now() - lastInputAt); }

  // Something true just happened (a print finished, a backup ended) or he walked
  // into a sister's room: the next visit has a reason, and does not wait its turn.
  var pendingEvent = null;
  var pulseSeen = 0;
  var pulseBaselined = false;
  var familySeen = 0;  // the last house-started exchange this tab already played
  var VIEW_SISTER = { forge: "forgia", musique: "musica", inventaire: "inventoria", fichiers: "securia", atelier3d: "elsea" };
  var metAt = {};
  function pairKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }
  function chipByKey(key) {
    for (var i = 0; i < CHIPS.length; i++) if (CHIPS[i].key === key) return CHIPS[i];
    return null;
  }

  // ---- motion: small, additive, and off for anyone who asked for less.
  // The idle loops use `translate`/`rotate` in CSS; these effects use the Web
  // Animations API on the same properties with `composite: "add"` (or on `scale`,
  // which no loop uses), so they layer instead of fighting.
  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
    catch (e) { return false; }
  }
  function fx(el, frames, options) {
    if (!el || !el.animate || document.hidden || reducedMotion()) return null;
    try { return el.animate(frames, options); } catch (e) { return null; }
  }
  function bump(el, peak, ms) {
    return fx(el, [{ scale: 1 }, { scale: peak }, { scale: 1 }], { duration: ms, easing: "ease-out" });
  }
  function lift(el, dy, ms) {
    return fx(el, [{ translate: "0 0" }, { translate: "0 " + dy + "px" }, { translate: "0 0" }],
      { duration: ms, easing: "ease-out", composite: "add" });
  }
  function ping(el) {  // something true happened to her: a small hop
    bump(el, 1.14, 900);
    lift(el, -6, 900);
  }
  function pingChip(key) {
    var chip = chipByKey(key);
    var el = chip && document.querySelector(chip.selector);
    if (el && visible(el)) ping(el);
  }
  function welcomeBack() {
    if (active || loading || document.hidden) return;
    var shown = 0;
    CHIPS.forEach(function (chip) {
      var el = document.querySelector(chip.selector);
      if (!visible(el)) return;
      window.setTimeout(function () { bump(el, 1.08, 700); lift(el, -4, 700); }, shown * 140);
      shown += 1;
    });
  }
  function nightCheck() {
    var hour = new Date().getHours();
    document.body.classList.toggle("hq-night", hour >= 23 || hour < 6);
  }
  function holdMood(visit, el, kind, dir) {
    if (!el) return;
    var made = [];
    if (kind === "service") {  // a small shuffle from foot to foot, for as long as she stays
      made.push(fx(el, [{ translate: "0 0" }, { translate: "3px 0" }, { translate: "-3px 0" }, { translate: "0 0" }],
        { duration: 1400, iterations: Infinity, easing: "ease-in-out", composite: "add" }));
    } else {
      var m = moodFor(kind, dir);
      if (!m) return;
      var hold = { duration: 700, fill: "forwards", easing: "ease-out", composite: "add" };
      made.push(fx(el, [{ translate: "0 0" }, { translate: m.dx + "px " + m.dy + "px" }], hold));
      made.push(fx(el, [{ rotate: "0deg" }, { rotate: m.rot + "deg" }], hold));
    }
    made.forEach(function (a) { if (a) visit.fx.push(a); });
  }
  function applyMoods(visit) {
    var host = visit.host.el;
    var hostMid = visit.hostRect.left + visit.hostRect.width / 2;
    var visitorMid = visit.visitorRect.left + visit.visitorRect.width / 2;
    var toward = visitorMid > hostMid ? 1 : -1;
    var middle = window.innerWidth / 2;
    var hostDir = { toward: toward, centre: hostMid < middle ? 1 : -1 };
    var visitorDir = { toward: -toward, centre: visitorMid < middle ? 1 : -1 };
    if (visit.glance) {
      holdMood(visit, host, "glance", hostDir);
      holdMood(visit, visit.visitorEl, "glance", visitorDir);
      return;
    }
    var wants = visit.wants;
    if (!wants) return;
    holdMood(visit, host, wants.host, hostDir);
    holdMood(visit, visit.visitorEl, wants.visitor, visitorDir);
  }
  function releaseFx(visit) {
    var list = visit && visit.fx;
    if (!list || !list.length) return;
    visit.fx = [];
    list.forEach(function (a) {
      try {
        if (a.effect && a.effect.getTiming().iterations === Infinity) { a.cancel(); return; }
        a.reverse();  // ease back to rest, then let go
        window.setTimeout(function () { try { a.cancel(); } catch (e) {} }, 800);
      } catch (e) {}
    });
  }
  function currentPlace() {
    var view = (document.body.getAttribute("data-view") || "").toLowerCase();
    return PLACE_VIEWS[view] ? view : "";
  }
  function pickShape() {
    var r = Math.random();
    return r < 0.24 ? "flyby" : r < 0.78 ? "checkin" : "scene";
  }
  function pickLine(chip, beat, other, vars) {
    var pair = chip.pair && other && chip.pair[other.key];
    var general = chip[beat];
    // Lines for this particular partner are likelier than the general bank, never the only ones.
    var pool = pair && pair[beat] && (!general || Math.random() < 0.55) ? pair[beat] : general;
    if (!Array.isArray(pool)) pool = pool ? [pool] : [];
    var key = chip.key + ":" + (other ? other.key : "") + ":" + beat;
    var fresh = pool.filter(function (text) { return text !== lastCanned[key]; });
    if (!fresh.length) fresh = pool;
    var text = fresh.length ? fresh[rand(0, fresh.length - 1)] : "";
    lastCanned[key] = text;
    try {
      if (window.sessionStorage) window.sessionStorage.setItem("hqVisitLastCanned", JSON.stringify(lastCanned));
    } catch (e) {}
    return String(text || "").replace(/\{other\}/g, (vars && vars.other) || "");
  }
  function chooseQuestion(visitor, shape) {
    if (shape === "flyby") return null;
    if (Math.random() >= (shape === "scene" ? 0.28 : 0.16)) return null;
    var question = MASTER_QUESTIONS[visitor.key];
    return question ? { who: visitor, text: question.text, choices: question.choices } : null;
  }
  function visible(el) {
    if (!el) return false;
    var cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 20;
  }
  function drawerOpen() {
    var nodes = document.querySelectorAll(
      '[class$="-drawer"]:not([hidden]), .hq-else-chip-menu:not([hidden]), ' +
      '.hq-inventoria-chip-menu:not([hidden]), .hq-pistonia-menu:not([hidden]), ' +
      '.hq-pistonia-settings:not([hidden]), [role="dialog"]:not([hidden]), .hq-inventoria-lightbox'
    );
    for (var i = 0; i < nodes.length; i++) {
      // Some inline SVG groups carry a decorative role="dialog"; they are not
      // drawers and must not suppress every visit on the Inventaire view.
      if (!nodes[i] || nodes[i].namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
      if (visible(nodes[i])) return true;
    }
    return false;
  }
  function typing() {
    return focusPolicy.blocks(document.activeElement);
  }
  function busy() { return document.hidden || drawerOpen() || typing(); }

  function hostChip() {
    var candidates = [];
    for (var i = 0; i < CHIPS.length; i++) {
      var el = document.querySelector(CHIPS[i].selector);
      if (visible(el)) candidates.push({ chip: CHIPS[i], el: el });
    }
    return candidates.length ? candidates[rand(0, candidates.length - 1)] : null;
  }

  function visitorChip(hostKey) {
    var pool = [];
    for (var i = 0; i < CHIPS.length; i++) {
      if (CHIPS[i].key === hostKey) continue;
      if (!document.querySelector(CHIPS[i].selector)) continue;
      if (CHIPS[i].key === lastVisitor && CHIPS.length > 3) continue;
      pool.push(CHIPS[i]);
    }
    // Pairs that have not met for a while are likelier than ones that just did.
    var now = Date.now();
    var weights = pool.map(function (chip) {
      return 1 + Math.min(4, (now - (metAt[pairKey(hostKey, chip.key)] || 0)) / 600000);
    });
    return pickWeighted(pool, weights, Math.random);
  }

  function positionBubble(rect, b, width, avoid, panel) {
    document.body.appendChild(b);
    var w = width || Math.min(230, Math.max(150, rect.width + 120));
    b.style.width = w + "px";
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
    // Keep a bubble attached to a visitor who stands outside a settings panel
    // on the free side of that panel instead of letting it spill back over the
    // model caption. Host bubbles remain inside the panel by design.
    if (panel) {
      var targetCenter = rect.left + rect.width / 2;
      if (targetCenter < panel.left) {
        left = Math.min(left, panel.left - w - 8);
      } else if (targetCenter > panel.right) {
        left = Math.max(left, panel.right + 8);
      }
      left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    }
    // On a wide layout the persistent bottom-nav becomes a left sidebar. Keep
    // the bubble in the content column instead of painting across it.
    var sideNav = document.querySelector(".bottom-nav");
    if (sideNav) {
      var sideRect = sideNav.getBoundingClientRect();
      if (sideRect.width < window.innerWidth * 0.7 && sideRect.height > window.innerHeight * 0.7) {
        left = Math.max(left, sideRect.right + 8);
        left = Math.min(left, window.innerWidth - w - 8);
      }
    }
    b.style.left = left + "px";
    b.style.top = "0px";
    b.style.visibility = "hidden";
    var h = b.offsetHeight;
    var top = rect.top - h - 10;
    // A tall host (Inventoria and Else are 122px) can reach above the visitor.
    // Move the bubble above any host/composer obstacle instead of covering it.
    if (avoid) {
      for (var pass = 0; pass < 4; pass++) {
        var hit = null;
        for (var i = 0; i < avoid.length; i++) {
          var r = avoid[i];
          if (!r || !r.width || !r.height) continue;
          if (left < r.right && left + w > r.left && top < r.bottom && top + h > r.top) {
            hit = r;
            break;
          }
        }
        if (!hit) break;
        var next = hit.top - h - 10;
        if (next >= top) break;
        top = next;
      }
    }
    var header = document.querySelector(".topbar");
    var safeTop = header ? header.getBoundingClientRect().bottom + 8 : 8;
    if (top < safeTop) {
      var nav = document.querySelector(".bottom-nav");
      var navRect = nav ? nav.getBoundingClientRect() : null;
      var below = rect.bottom + 10;
      var fitsBelow = !navRect || navRect.top < 0 || below + h <= navRect.top - 8;
      if (fitsBelow) {
        top = below;
        b.classList.add("is-below");
      } else {
        top = safeTop;
      }
    }
    b.style.top = top + "px";
    b.style.visibility = "";
    void b.offsetWidth;
    b.classList.add("is-shown");
    return b;
  }

  function bubbleAvoidRects(hostRect, visitorRect) {
    var out = [];
    if (hostRect) out.push(hostRect);
    if (visitorRect) out.push(visitorRect);
    var composer = document.querySelector(".hq-companion-input");
    if (composer && visible(composer)) out.push(composer.getBoundingClientRect());
    return out;
  }

  // The host chips are fixed over their view, so closest() from the chip cannot
  // find the settings rail. Resolve the panel under the host's centre instead;
  // that gives the real free edge to clamp the visitor against, at any width.
  function panelAt(hostRect) {
    var candidates = [];
    var seen = [];
    function consider(el) {
      if (!el || seen.indexOf(el) >= 0 || !visible(el)) return;
      seen.push(el);
      var r = el.getBoundingClientRect();
      if (r.width < 140 || r.height < 120) return;
      candidates.push({ el: el, rect: r });
    }
    var cx = hostRect.left + hostRect.width / 2;
    var cy = hostRect.top + hostRect.height / 2;
    var nodes = document.elementsFromPoint ? document.elementsFromPoint(cx, cy) : [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || !node.closest) continue;
      consider(node.closest('aside, [id*="settings-rail"], [class*="settings-rail"], [class*="settings-panel"], [class*="side-panel"], .forge-side'));
    }
    // elementsFromPoint can miss a panel under an overlay in some browsers;
    // keep the known structural rails as a fallback, still measured at runtime.
    var known = document.querySelectorAll('#forge-settings-rail, .forge-side, [id*="settings-rail"], [class*="settings-panel"], [class*="side-panel"]');
    for (var j = 0; j < known.length; j++) {
      var kr = known[j].getBoundingClientRect();
      if (cx < kr.left || cx > kr.right || cy < kr.top || cy > kr.bottom) continue;
      consider(known[j]);
    }
    // The innermost/smallest matching panel is the useful obstacle (the aside,
    // not the full page shell).
    candidates.sort(function (a, b) {
      return (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
    });
    return candidates.length ? candidates[0].rect : null;
  }

  function captionRectFor(panel) {
    var nodes = document.querySelectorAll('#forge-choice-note, [id$="choice-note"], [class*="model-caption"]');
    for (var i = 0; i < nodes.length; i++) {
      if (!visible(nodes[i])) continue;
      var r = nodes[i].getBoundingClientRect();
      if (r.width < 20 || r.height < 8) continue;
      if (panel && (r.right < panel.left || r.left > panel.right || r.bottom < panel.top || r.top > panel.bottom)) continue;
      return r;
    }
    return null;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function placeVisitor(hostRect, w, h) {
    var topbar = document.querySelector(".topbar");
    var safeTop = Math.max(70, topbar ? topbar.getBoundingClientRect().bottom + 8 : 70);
    var safeBottom = window.innerHeight - h - 90;
    var y = clamp(hostRect.top + (hostRect.height - h) / 2, safeTop, safeBottom);
    var panel = panelAt(hostRect);
    var caption = panel ? captionRectFor(panel) : null;
    var hostMid = hostRect.left + hostRect.width / 2;
    var preferred = panel && hostMid >= panel.left + panel.width / 2 ? "right" : "left";
    if (panel) {
      var choices = [];
      function offer(side, x) {
        if (x >= 8 && x + w <= window.innerWidth - 8) choices.push({ side: side, x: x });
      }
      offer("left", panel.left - w - 16);
      offer("right", panel.right + 16);
      choices.sort(function (a, b) {
        var ap = a.side === preferred ? 0 : 1;
        var bp = b.side === preferred ? 0 : 1;
        return ap - bp || Math.abs(a.x - (hostMid - w / 2)) - Math.abs(b.x - (hostMid - w / 2));
      });
      if (choices.length) {
        return { x: choices[0].x, y: y, side: choices[0].side, panel: panel, caption: caption };
      }
      // No side gutter: use the free strip above or below the panel, clamped to
      // its horizontal span. This still guarantees the panel and caption are
      // unobstructed instead of silently falling back to the old collision.
      var aboveY = panel.top - h - 16;
      if (aboveY >= safeTop) {
        return { x: clamp(hostMid - w / 2, panel.left, panel.right - w), y: aboveY,
                 side: "left", panel: panel, caption: caption };
      }
      var belowY = panel.bottom + 16;
      if (belowY + h <= window.innerHeight - 8) {
        return { x: clamp(hostMid - w / 2, panel.left, panel.right - w), y: belowY,
                 side: "left", panel: panel, caption: caption };
      }
    }
    var side = hostMid > window.innerWidth / 2 ? "left" : "right";
    var endX = side === "left" ? hostRect.left - w - 16 : hostRect.right + 16;
    if (endX < 8) { side = "right"; endX = hostRect.right + 16; }
    if (endX + w > window.innerWidth - 8) { side = "left"; endX = hostRect.left - w - 16; }
    return { x: endX, y: y, side: side, panel: panel, caption: caption };
  }

  function bubbleAt(rect, text, avoid, panel, speaker) {
    var b = document.createElement("div");
    b.className = "hq-visit-bubble";
    b.textContent = text;
    b.setAttribute("role", "status");
    // Who is saying this, readable from the DOM itself (the panel is clone- and
    // position-based, so a test or a later reader must not have to infer it).
    if (speaker) b.setAttribute("data-speaker", String(speaker));
    return positionBubble(rect, b, 0, avoid, panel);
  }

  function thinkingAt(rect, avoid, panel) {
    var b = document.createElement("div");
    b.className = "hq-visit-bubble hq-visit-thinking";
    b.setAttribute("role", "status");
    b.setAttribute("aria-label", "Un instant…");
    for (var i = 0; i < 3; i++) {
      var dot = document.createElement("span");
      dot.className = "hq-visit-think-dot";
      b.appendChild(dot);
    }
    return positionBubble(rect, b, 52, avoid, panel);
  }

  function questionAt(rect, ask, onPick, avoid, panel) {
    var b = document.createElement("div");
    b.className = "hq-visit-bubble hq-visit-question";
    b.setAttribute("role", "group");
    b.setAttribute("aria-live", "polite");
    b.setAttribute("aria-label", ask.text);
    var text = document.createElement("p");
    text.className = "hq-visit-question-text";
    text.textContent = ask.text;
    var row = document.createElement("div");
    row.className = "hq-visit-question-choices";
    for (var i = 0; i < ask.choices.length; i++) {
      (function (choice) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "hq-visit-choice";
        button.textContent = choice.label;
        button.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          onPick(choice);
        });
        row.appendChild(button);
      })(ask.choices[i]);
    }
    b.appendChild(text);
    b.appendChild(row);
    b.style.pointerEvents = "auto";
    return positionBubble(rect, b, 248, avoid, panel);
  }

  function clearBubble(b) {
    if (!b) return;
    b.classList.remove("is-shown");
    window.setTimeout(function () { if (b.parentNode) b.remove(); }, 260);
  }
  // A replacement (thinking dots -> line, question -> answer) must not stack two
  // bubbles at the same spot while the first one fades.
  function dropBubble(b) {
    if (b && b.parentNode) b.remove();
  }

  function clearBanterLoading() {
    window.clearTimeout(banterLoadingTimer);
    banterLoadingTimer = 0;
    if (!banterLoading) return;
    var b = banterLoading;
    banterLoading = null;
    b.classList.add("is-out");
    window.setTimeout(function () { if (b.parentNode) b.remove(); }, 180);
  }

  function showBanterLoading(hostEl) {
    clearBanterLoading();
    banterLoadingTimer = window.setTimeout(function () {
      banterLoadingTimer = 0;
      var rect = hostEl && hostEl.getBoundingClientRect();
      if (!rect || !rect.width) return;
      var b = document.createElement("span");
      b.className = "hq-visit-loading";
      b.setAttribute("role", "status");
      b.setAttribute("aria-live", "polite");
      b.textContent = "…";
      b.setAttribute("aria-label", "Exchange being prepared");
      document.body.appendChild(b);
      var w = b.offsetWidth;
      b.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2)) + "px";
      var top = rect.top - b.offsetHeight - 7;
      b.style.top = (top < 8 ? rect.bottom + 7 : top) + "px";
      banterLoading = b;
    }, 220);
  }

  function clipText(value, max) {
    var text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length < max) return text;
    var cut = text.slice(0, max);
    var space = cut.lastIndexOf(" ");
    if (space >= Math.floor(max * 0.6)) cut = cut.slice(0, space);
    return cut.replace(/[ ,;:.!?—–-]+$/, "") + "…";
  }
  function quoteFrom(record, who) {
    var lines = (record && record.lines) || [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i] && lines[i].who === who && lines[i].text) return clipText(lines[i].text, 140);
    }
    return "";
  }

  function recallLine(host, visitor, visits) {
    if (!visits) return null;
    var record = visits[visitor.key];
    if (record && record.other === host.key) {
      var heard = quoteFrom(record, host.key);
      if (heard) return { who: visitor, recall: true, text: "I came back \u2014 last time, you told me: \u201c" + heard + "\u201d." };
    }
    record = visits[host.key];
    if (record && record.other === visitor.key) {
      var said = quoteFrom(record, visitor.key);
      if (said) return { who: host, recall: true, text: "Hey, " + visitor.name + " \u2014 you told me: \u201c" + said + "\u201d." };
    }
    return null;
  }

  function scriptFor(host, visitor, shape, visits, generated) {
    if (generated && generated.length) return generated.slice();
    var recall = recallLine(host, visitor, visits);
    var lines;
    if (shape === "flyby") {
      lines = [
        { who: visitor, text: pickLine(visitor, "hello", host) },
        { who: host, text: pickLine(host, "reply", visitor) }
      ];
    } else if (shape === "scene") {
      lines = [
        { who: visitor, text: pickLine(visitor, "hello", host) },
        { who: host, text: pickLine(host, "reply", visitor) },
        { who: visitor, text: pickLine(visitor, "about", host) },
        { who: host, text: pickLine(host, "ask", visitor, { other: visitor.name }) },
        { who: visitor, text: pickLine(visitor, "answer", host) },
        { who: host, text: pickLine(host, Math.random() < 0.5 ? "extra" : "bye", visitor) }
      ];
    } else {
      lines = [
        { who: visitor, text: pickLine(visitor, "hello", host) },
        { who: host, text: pickLine(host, "reply", visitor) },
        { who: visitor, text: pickLine(visitor, "about", host) },
        { who: host, text: pickLine(host, "bye", visitor) }
      ];
    }
    if (recall) {
      // Keep the shape contract: the callback replaces a beat instead of
      // adding a line to the two-, four- or six-line canned fallback.
      var slot = shape === "flyby"
        ? (recall.who.key === visitor.key ? 0 : 1)
        : (recall.who.key === visitor.key ? 2 : 1);
      lines[slot] = recall;
    }
    return lines;
  }

  function loadMemory(hostKey, visitorKey, done) {
    var settled = false;
    var controller = window.AbortController ? new window.AbortController() : null;
    var timeout = window.setTimeout(function () { finish(null); }, 900);
    function finish(value) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (controller) { try { controller.abort(); } catch (e) {} }
      done(value);
    }
    try {
      window.fetch("/api/assistant-visits?host=" + encodeURIComponent(hostKey) + "&visitor=" + encodeURIComponent(visitorKey), {
        credentials: "same-origin", cache: "no-store", signal: controller ? controller.signal : undefined
      }).then(function (response) {
        return response.ok ? response.json() : null;
      }).then(function (data) {
        finish(data && data.ok && data.visits ? data : null);
      }).catch(function () { finish(null); });
    } catch (e) {
      finish(null);
    }
  }

  function fallbackReasonLabel(code) {
    if (!code) return "no reason given";
    if (/^http_\d+$/.test(code)) return "HTTP error " + code.slice(5);
    return FALLBACK_REASONS[code] || "reason " + code;
  }

  function loadBanter(hostKey, visitorKey, shape, done) {
    var settled = false;
    var controller = window.AbortController ? new window.AbortController() : null;
    var timeout = window.setTimeout(function () { finish({ lines: null, reason: "timeout" }); }, BANTER_TIMEOUT_MS);
    function finish(value) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (controller) { try { controller.abort(); } catch (e) {} }
      done(value);
    }
    try {
      window.fetch("/api/assistant-visit-banter", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: visitHeaders(),
        body: JSON.stringify({ host: hostKey, visitor: visitorKey, shape: shape, place: currentPlace() }),
        signal: controller ? controller.signal : undefined
      }).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (data) {
          var reason = (data && data.code) || (response.ok ? "invalid_output" : "http_" + response.status);
          if (response.ok && data && data.ok && Array.isArray(data.lines)) {
            var w = data.wants;
            finish({ lines: data.lines, reason: "", provider: data.provider || "",
                     fallbackReason: data.fallback_reason || "",
                     bond: data.bond && data.bond.text ? data.bond : null,
                     wants: w && MOOD_KEYS[w.host] && MOOD_KEYS[w.visitor] ? { host: w.host, visitor: w.visitor } : null });
          } else {
            // A cooled-down exchange falls back to the built-in lines, but the
            // pair's earned word is not part of what the model writes.
            finish({ lines: null, reason: reason,
                     bond: data && data.bond && data.bond.text ? data.bond : null });
          }
        });
      }).catch(function (error) {
        finish({ lines: null, reason: error && error.name === "AbortError" ? "timeout" : "network" });
      });
    } catch (e) {
      finish({ lines: null, reason: "network" });
    }
  }

  function mapBanter(rows, host, visitor, shape) {
    if (!rows || !rows.length) return null;
    var out = [];
    for (var i = 0; i < rows.length && out.length < BANTER_MAX_LINES; i++) {
      var row = rows[i] || {};
      var text = clipText(row.text, 180);
      if (!text) continue;
      var who = row.who === host.key || row.who === "host" ? host
        : row.who === visitor.key || row.who === "visitor" ? visitor : null;
      if (who) out.push({ who: who, text: text });
    }
    var speakers = {};
    for (var j = 0; j < out.length; j++) speakers[out[j].who.key] = true;
    var expected = shape === "flyby" ? 2 : shape === "scene" ? 6 : 4;
    return out.length === expected && speakers[host.key] && speakers[visitor.key] ? out : null;
  }

  function makeId() {
    try {
      var bytes = new Uint8Array(12);
      window.crypto.getRandomValues(bytes);
      return Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    } catch (e) {
      return String(Date.now()) + Math.random().toString(16).slice(2, 12);
    }
  }

  // One tab visits at a time: a second tab on the same HQ would only get the
  // server's cooldown and a canned visit. localStorage can be blocked: then every
  // tab simply carries on, as before.
  var TAB_ID = makeId();
  var LEASE_KEY = "hq-visit-lease";
  function claimLease() {
    try {
      var now = Date.now();
      var raw = window.localStorage.getItem(LEASE_KEY);
      var cur = raw ? JSON.parse(raw) : null;
      if (cur && cur.id !== TAB_ID && now - Number(cur.at) < MIN_DELAY) return false;
      window.localStorage.setItem(LEASE_KEY, JSON.stringify({ id: TAB_ID, at: now }));
      return true;
    } catch (e) {
      return true;
    }
  }

  function visitHeaders() {
    var headers = { "Content-Type": "application/json" };
    if (typeof window.hqCsrfToken === "function") {
      var token = window.hqCsrfToken();
      if (token) headers["X-CSRF-Token"] = token;
    }
    return headers;
  }

  function persistVisit(visit) {
    if (!visit || visit.saved || !visit.lines || !visit.lines.length) return;
    visit.saved = true;
    var body = {
      visit_id: makeId(),
      answer: visit.answered && visit.answer ? visit.answer : undefined,
      host: visit.host.chip.key,
      visitor: visit.visitor.chip.key,
      source: visit.source || "",
      lines: visit.lines.filter(function (line) {
        return !line.recall && (!line.question || visit.answered);
      }).map(function (line) {
        return { who: line.who.key === visit.host.chip.key ? "host" : "visitor", text: line.text };
      })
    };
    if (!body.lines.length) return;
    function send(retried) {
      try {
        window.fetch("/api/assistant-visits", {
          method: "POST", credentials: "same-origin", keepalive: true,
          headers: visitHeaders(), body: JSON.stringify(body)
        }).then(function (response) {
          if (!response.ok) throw new Error("http_" + response.status);
          return response.json().catch(function () { return null; });
        }).then(function (data) {
          if (data && data.ok === false) throw new Error(data.code || "rejected");
          if (data && !(data.recorded || []).length) {
            try { console.warn("visit not saved", data.skipped || []); } catch (e) {}
          }
        }).catch(function (error) {
          // Retry only what may not have arrived (network, 5xx); a refusal will
          // be refused again. The visit id makes a repeat harmless either way.
          var message = String((error && error.message) || "");
          var retryable = error instanceof TypeError || /^http_5\d\d$/.test(message);
          if (!retried && retryable) { window.setTimeout(function () { send(true); }, 1500); return; }
          try { console.warn("visit memory not saved:", message || error); } catch (e) {}
        });
      } catch (e) {
        if (!retried) window.setTimeout(function () { send(true); }, 1500);
      }
    }
    send(false);
  }

  function stopActive() {
    clearBanterLoading();
    if (!active) return;
    active.stopped = true;
    active.aborted = true;
    window.clearTimeout(active.timer);
    window.clearTimeout(active.questionTimer);
    clearStage(active);
    releaseFx(active);
    clearBubble(active.bubble);
    if (active.questionBubble && active.questionBubble !== active.bubble) clearBubble(active.questionBubble);
    var wrap = active.wrap;
    if (wrap) {
      wrap.style.opacity = "0";
      window.setTimeout(function () { if (wrap.parentNode) wrap.remove(); }, 300);
    }
    document.body.classList.remove("hq-visit-active");
    active = null;
    queued = null;  // a queued visit belongs to the view it was generated for
  }

  function finishAndSchedule(visit, wrap, startX, w, y) {
    return function () {
      if (!active || active !== visit || visit.stopped) return;
      if (visit.bubble) { clearBubble(visit.bubble); visit.bubble = null; }
      clearStage(visit);
      releaseFx(visit);
      if (!visit.glance) {  // a wave on the way out; the host breathes out
        fx(visit.visitorEl, [{ rotate: "0deg" }, { rotate: "9deg" }, { rotate: "-7deg" }, { rotate: "5deg" }, { rotate: "0deg" }],
          { duration: 750, easing: "ease-in-out", composite: "add" });
        bump(visit.host.el, .97, 600);
      }
      if (!visit.aborted) persistVisit(visit);
      window.setTimeout(function () {
        wrap.style.transform = "translate3d(" + startX + "px," + y + "px,0)";
        wrap.style.opacity = "0";
      }, LEAVE_PAUSE_MS);
      window.setTimeout(function () {
        if (wrap.parentNode) wrap.remove();
        if (active === visit) {
          active = null;
          document.body.classList.remove("hq-visit-active");
        }
        var next = queued;
        queued = null;
        if (next) {
          try {
            run(next.hostPick, next.visitor, next.memory, next.generated, next.reason,
                next.provider, next.fallbackReason, next.shape, next.wants, next.bond);
            return;
          } catch (e) {}
        }
        schedule(nextGap());
      }, LEAVE_PAUSE_MS + LEAVE_MS);
    };
  }

  function setStage(visit, line) {
    var hostSpeaking = line.who.key === visit.host.chip.key;
    var host = visit.host.el;
    var visitor = visit.visitorEl;
    if (host && host.classList) {
      host.classList.toggle("hq-visit-speaking", hostSpeaking);
      host.classList.toggle("hq-visit-listening", !hostSpeaking);
    }
    bump(hostSpeaking ? host : visitor, 1.045, 520);  // the one who speaks holds the light
    if (visitor && visitor.classList) {
      visitor.classList.toggle("hq-visit-speaking", !hostSpeaking);
      visitor.classList.toggle("hq-visit-listening", hostSpeaking);
    }
  }

  function clearStage(visit) {
    var nodes = [visit.host && visit.host.el, visit.visitorEl];
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i] || !nodes[i].classList) continue;
      nodes[i].classList.remove("hq-visit-host", "hq-visit-speaking", "hq-visit-listening");
      if (nodes[i].style) nodes[i].style.removeProperty("--hq-visit-lean");
    }
  }

  function shouldThink(visit, line) {
    if (visit.shape === "flyby" || visit.lineCount <= 1) return false;
    return Math.random() < (line.who.key === visit.host.chip.key ? 0.55 : 0.22);
  }

  function presentLine(visit, line, done) {
    var target = line.who.key === visit.host.chip.key ? visit.hostRect : visit.visitorRect;
    visit.lineCount += 1;
    function show() {
      if (!active || active !== visit || visit.stopped) return;
      dropBubble(visit.bubble);
      visit.bubble = bubbleAt(target, line.text, bubbleAvoidRects(visit.hostRect, visit.visitorRect), visit.panelRect, line.who.key);
      var wait = Math.max(BUBBLE_MIN_MS,
        Math.min(BUBBLE_MAX_MS, BUBBLE_BASE_MS + line.text.length * BUBBLE_MS_PER_CHAR));
      visit.timer = window.setTimeout(function () {
        if (!active || active !== visit || visit.stopped) return;
        clearBubble(visit.bubble);
        visit.bubble = null;
        done();
      }, wait);
    }
    setStage(visit, line);
    if (shouldThink(visit, line)) {
      clearBubble(visit.bubble);
      visit.bubble = thinkingAt(target, bubbleAvoidRects(visit.hostRect, visit.visitorRect), visit.panelRect);
      visit.timer = window.setTimeout(function () {
        if (!active || active !== visit || visit.stopped) return;
        dropBubble(visit.bubble);
        visit.bubble = null;
        show();
      }, rand(THINK_MIN_MS, THINK_MAX_MS));
    } else {
      show();
    }
  }

  function maybeAsk(visit) {
    if (visit.ask && !visit.answered) {
      showQuestion(visit);
      return;
    }
    visit.finish();
  }

  function showQuestion(visit) {
    var ask = visit.ask;
    setStage(visit, { who: ask.who });
    visit.lines.push({ who: ask.who, text: ask.text, question: true });
    dropBubble(visit.bubble);
    visit.bubble = null;
    visit.bubble = questionAt(visit.visitorRect, ask, function (choice) {
      if (!active || active !== visit || visit.stopped || visit.answered) return;
      visit.answered = true;
      visit.answer = { q: ask.text, a: choice.label };  // kept with the visit: it steers the next ones
      window.clearTimeout(visit.questionTimer);
      visit.questionTimer = 0;
      dropBubble(visit.questionBubble);
      visit.questionBubble = null;
      visit.bubble = null;
      var reply = { who: visit.visitor.chip, text: choice.reply };
      visit.lines.push(reply);
      presentLine(visit, reply, function () {
        if (active === visit) visit.finish();
      });
    }, bubbleAvoidRects(visit.hostRect, visit.visitorRect), visit.panelRect);
    visit.questionBubble = visit.bubble;
    visit.questionTimer = window.setTimeout(function () {
      if (!active || active !== visit || visit.stopped || visit.answered) return;
      clearBubble(visit.questionBubble);
      visit.questionBubble = null;
      visit.bubble = null;
      visit.finish();
    }, QUESTION_TIMEOUT_MS);
  }

  function play(visit, lines) {
    var index = 0;
    applyMoods(visit);
    if (visit.glance) {
      visit.timer = window.setTimeout(function () {
        if (active === visit && !visit.stopped) visit.finish();
      }, rand(1600, 3200));
      return;
    }
    function next() {
      if (!active || active !== visit || visit.stopped || busy()) {
        if (active === visit) stopActive();
        if (active === null && !document.hidden) schedule(nextGap());
        return;
      }
      if (index >= lines.length) {
        maybeAsk(visit);
        return;
      }
      var line = lines[index++];
      presentLine(visit, line, function () {
        if (!active || active !== visit || visit.stopped) return;
        var gap = /\?\s*$/.test(String(line.text || "")) ? QUESTION_BEAT_MS
          : (visit.shape === "scene" && index === 4) ? BUBBLE_SCENE_PAUSE_MS : BUBBLE_GAP_MS;
        visit.timer = window.setTimeout(next, gap);
      });
    }
    next();
  }

  function run(hostPick, visitor, memory, generated, reason, provider, fallbackReason, shape, wants, bond) {
    var host = hostPick.chip;
    var hostEl = hostPick.el;
    var hostRect = hostEl.getBoundingClientRect();
    var visitorButton = document.querySelector(visitor.selector);
    if (!visitorButton || !hostRect.width) { schedule(15000); return; }
    hostEl.classList.add("hq-visit-host");
    // She hears someone coming before the visitor is in sight.
    bump(hostEl, 1.07, 800);
    lift(hostEl, -4, 800);

    var wrap = document.createElement("div");
    wrap.className = "hq-visit-visitor";
    wrap.setAttribute("aria-hidden", "true");
    var clone = visitorButton.cloneNode(true);
    clone.removeAttribute("id");
    clone.removeAttribute("aria-label");
    clone.removeAttribute("hidden");
    clone.tabIndex = -1;
    clone.setAttribute("aria-hidden", "true");
    clone.style.position = "relative";
    clone.style.left = clone.style.top = clone.style.right = clone.style.bottom = "auto";
    clone.style.margin = "0";
    clone.style.transform = "none";
    var originalDisplay = window.getComputedStyle(visitorButton).display;
    clone.style.display = originalDisplay && originalDisplay !== "none" ? originalDisplay : "inline-flex";
    clone.style.visibility = "visible";
    clone.style.opacity = "1";
    clone.style.transition = "none";
    clone.style.animation = "none";
    var ids = clone.querySelectorAll("[id]");
    for (var i = 0; i < ids.length; i++) ids[i].removeAttribute("id");
    wrap.appendChild(clone);
    wrap.style.left = "-9999px";
    document.body.appendChild(wrap);
    document.body.classList.add("hq-visit-active");

    // Measure the clone itself: the real chip can be hidden on this view.
    // Its tab may scale portraits to 120 px or more; a visitor is capped to a
    // consistent footprint and keeps its aspect ratio instead of arriving huge.
    var size = clone.getBoundingClientRect();
    var baseW = size.width || (visitor.size && visitor.size[0]) || 54;
    var baseH = size.height || (visitor.size && visitor.size[1]) || 54;
    var fit = Math.min(1, 64 / Math.max(baseW, baseH));
    var w = Math.max(44, Math.round(baseW * fit));
    var h = Math.max(24, Math.round(baseH * fit));
    wrap.style.left = "0";
    wrap.style.width = w + "px";
    wrap.style.height = h + "px";
    clone.style.width = w + "px";
    clone.style.height = h + "px";
    clone.style.boxSizing = "border-box";
    var placement = placeVisitor(hostRect, w, h);
    var side = placement.side;
    var endX = placement.x;
    var y = placement.y;
    var startX = side === "left" ? -w - 24 : window.innerWidth + 24;
    hostEl.style.setProperty("--hq-visit-lean", side === "left" ? "-1.8deg" : "1.8deg");
    clone.style.setProperty("--hq-visit-lean", side === "left" ? "1.8deg" : "-1.8deg");

    wrap.style.transform = "translate3d(" + startX + "px," + y + "px,0)";
    void wrap.offsetWidth;
    wrap.style.transform = "translate3d(" + endX + "px," + y + "px,0)";

    var visit = {
      host: { chip: host, el: hostEl },
      visitor: { chip: visitor },
      visitorEl: clone,
      hostRect: hostRect,
      panelRect: placement.panel,
      captionRect: placement.caption,
      visitorRect: { left: endX, top: y, width: w, height: h, right: endX + w, bottom: y + h },
      wrap: wrap,
      bubble: null,
      questionBubble: null,
      timer: 0,
      questionTimer: 0,
      shape: shape,
      lineCount: 0,
      ask: chooseQuestion(visitor, shape),
      answered: false,
      stopped: false,
      aborted: false,
      fx: [],
      wants: generated && generated.length ? (wants || null) : null
    };
    var glance = reason === "glance";
    if (glance) { visit.ask = null; visit.glance = true; }
    var source = generated && generated.length ? (provider === "nvidia" ? "nvidia" : "gemini") : "canned";
    visit.source = source;
    var sourceLabel = source === "gemini"
      ? "Exchange generated by Gemini"
      : source === "nvidia"
        ? "Fallback to NVIDIA NIM" + (fallbackReason ? " — " + fallbackReasonLabel(fallbackReason) : "")
        : "Fallback to the built-in lines — " + fallbackReasonLabel(reason);
    var sourceBadge = document.createElement("span");
    sourceBadge.className = "hq-visit-source";
    sourceBadge.setAttribute("data-source", source);
    sourceBadge.setAttribute("role", "img");
    sourceBadge.setAttribute("aria-label", "Source: " + sourceLabel);
    sourceBadge.title = sourceLabel;
    if (!glance) wrap.appendChild(sourceBadge);
    // What the pair has actually lived shows as its own quiet word — never the
    // thing they do not say, and only once that bond was really earned.
    if (!glance && bond && bond.text) {
      var bondBadge = document.createElement("span");
      bondBadge.className = "hq-visit-bond";
      bondBadge.setAttribute("data-bond", "earned");
      bondBadge.title = "Ce qui s'est gagné entre elles, sans se dire";
      bondBadge.textContent = String(bond.text);
      wrap.appendChild(bondBadge);
    }
    // The scheduler's own firing, observable: what got staged, and whether it
    // carried the earned bond. Never the words, only the fact.
    try {
      window.dispatchEvent(new window.CustomEvent("hq:visit-painted", {
        detail: { host: host.key, visitor: visitor.key, bond: !!(bond && bond.text),
                  source: source, glance: !!glance }
      }));
    } catch (e) {}
    visit.lines = glance ? [] : scriptFor(host, visitor, shape, memory && memory.visits, generated);
    visit.saved = false;
    visit.finish = finishAndSchedule(visit, wrap, startX, w, y);
    active = visit;

    window.setTimeout(function () {
      if (!active || active !== visit || visit.stopped) return;
      if (busy()) { stopActive(); schedule(nextGap()); return; }
      play(visit, visit.lines);
    }, ARRIVE_MS + 250);
  }

  function attempt() {
    timer = 0;
    if (active || loading) return;
    if (busy()) { schedule(rand(12000, 26000)); return; }
    if (Date.now() - lastInputAt < 8000) { schedule(rand(10000, 25000)); return; }  // his hands are busy
    var hostPick = hostChip();
    if (!hostPick) { schedule(18000); return; }
    var ev = pendingEvent;
    pendingEvent = null;
    var evChip = ev ? chipByKey(ev.sister) : null;
    var visitor = null;
    if (evChip && evChip.key !== hostPick.chip.key) {
      var evEl = document.querySelector(evChip.selector);
      if (ev.kind === "arrival" && visible(evEl)) {
        // He walked into her room: she is the host, someone else drops by.
        hostPick = { chip: evChip, el: evEl };
      } else if (evEl) {
        visitor = evChip;  // she comes with the news
      }
    }
    if (!visitor) visitor = visitorChip(hostPick.chip.key);
    if (!visitor) { schedule(22000); return; }
    if (!claimLease()) { schedule(nextGap()); return; }
    lastVisitor = visitor.key;
    metAt[pairKey(hostPick.chip.key, visitor.key)] = Date.now();
    if (!ev && Math.random() < 0.2) {
      // A glance: no words, no generation, nothing recorded.
      try { run(hostPick, visitor, null, null, "glance", "", "", "flyby"); }
      catch (e) { schedule(rand(12000, 26000)); }
      return;
    }
    var shape = pickShape();
    loading = true;
    showBanterLoading(hostPick.el);
    loadMemory(hostPick.chip.key, visitor.key, function (memory) {
      loadBanter(hostPick.chip.key, visitor.key, shape, function (result) {
        clearBanterLoading();
        loading = false;
        if (document.hidden) return;  // visibilitychange re-arms the schedule
        if (busy()) { schedule(rand(12000, 26000)); return; }
        var generated = mapBanter(result && result.lines, hostPick.chip, visitor, shape);
        var reason = generated ? "" : ((result && result.reason) || "invalid_output");
        if (active) {
          // Another visit holds the stage. Keep this one, whole, until it ends.
          queued = { hostPick: hostPick, visitor: visitor, memory: memory, generated: generated,
                     reason: reason, provider: result && result.provider,
                     fallbackReason: result && result.fallbackReason, shape: shape,
                     wants: result && result.wants, bond: result && result.bond };
          return;
        }
        try { run(hostPick, visitor, memory, generated, reason, result && result.provider,
                  result && result.fallbackReason, shape, result && result.wants,
                  result && result.bond); }
        catch (e) { schedule(rand(12000, 26000)); }
      });
    });
  }

  function schedule(delay) {
    window.clearTimeout(timer);
    timer = window.setTimeout(attempt, Math.max(0, delay));
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopActive();
      window.clearTimeout(timer);
      timer = 0;
    } else if (!active && !timer) {
      schedule(rand(12000, 26000));
    }
  });
  function onViewChange() {
    var sister = VIEW_SISTER[currentPlace()];
    if (sister && !pendingEvent && !loading && Math.random() < 0.4) {
      pendingEvent = { sister: sister, kind: "arrival" };  // she notices him walk in
      pingChip(sister);
      schedule(rand(20000, 60000));
      return;
    }
    if (!timer && !loading) schedule(nextGap());
  }
  // Which assistants this view can actually put on screen: the rotation only
  // pairs a chip that is mounted here, so a house visit is never generated blind.
  function visibleChipKeys() {
    var keys = [];
    for (var i = 0; i < CHIPS.length; i++) {
      if (visible(document.querySelector(CHIPS[i].selector))) keys.push(CHIPS[i].key);
    }
    return keys;
  }

  // A visit the house started on its own (the server's rotation). Its two lines
  // are already generated and already saved in both her logs, so this tab only
  // plays them: no generation request, no re-recording, no question to the Master.
  function playFamilyVisit(family) {
    var hostKey = String((family && family.host) || "");
    var visitorKey = String((family && family.visitor) || "");
    if (!hostKey || !visitorKey || hostKey === visitorKey) return false;
    var hostChip = chipByKey(hostKey);
    var guestChip = chipByKey(visitorKey);
    if (!hostChip || !guestChip) return false;
    // The lines are attributed by name, not by seat: if only the guest's chip is
    // on this view, she hosts and the same sentence stays with the same speaker.
    var rows = [];
    for (var i = 0; i < (family.lines || []).length; i++) {
      var line = family.lines[i] || {};
      var who = line.who === "host" ? hostKey : line.who === "visitor" ? visitorKey : line.who;
      if (who && line.text) rows.push({ who: who, text: line.text });
    }
    var hostEl = document.querySelector(hostChip.selector);
    if (!hostEl || !visible(hostEl)) {
      hostEl = document.querySelector(guestChip.selector);
      if (!hostEl || !visible(hostEl)) return false;
      var swap = hostChip;
      hostChip = guestChip;
      guestChip = swap;
    }
    var generated = mapBanter(rows, hostChip, guestChip, "flyby");
    if (!generated) return false;
    if (!claimLease()) return false;
    window.clearTimeout(timer);
    timer = 0;
    try {
      run({ chip: hostChip, el: hostEl }, guestChip, null, generated, "",
          String(family.provider || "gemini"), "", "flyby", null,
          family.bond && family.bond.text ? family.bond : null);
    } catch (e) {
      schedule(rand(12000, 26000));
      return false;
    }
    if (active) active.saved = true;  // both copies are already on the server
    return !!active;
  }

  function pollPulse() {
    if (document.hidden || active || loading) return;
    try {
      var show = visibleChipKeys();
      window.fetch("/api/assistant-visits?pulse=1&show=" + encodeURIComponent(show.join(",")),
        { credentials: "same-origin", cache: "no-store" })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (data) {
          // The house may have put two of them together: play it once, with the
          // lines the server already generated and saved.
          var family = data && data.ok ? data.family : null;
          var familyAt = Number(family && family.at) || 0;
          if (familyAt > familySeen && !pendingEvent) {
            if (playFamilyVisit(family)) { familySeen = familyAt; return; }
            if (!active && !loading) familySeen = familyAt;  // that pair has no chip on this view
          }
          // It just began one: ask again by the time the lines exist.
          if (data && data.ok && data.family_started) window.setTimeout(pollPulse, 8000);
          var events = data && data.ok && Array.isArray(data.events) ? data.events : [];
          var newest = pulseSeen, fresh = null;
          events.forEach(function (item) {
            var at = Number(item && item.at) || 0;
            if (at > newest) newest = at;
            if (pulseBaselined && at > pulseSeen && (!fresh || at > Number(fresh.at))) fresh = item;
          });
          pulseSeen = Math.max(pulseSeen, newest);
          pulseBaselined = true;  // what was already there at load is not news
          if (fresh && !pendingEvent && !active && !loading && chipByKey(String(fresh.sister || ""))) {
            pingChip(String(fresh.sister));
            pendingEvent = { sister: String(fresh.sister), kind: String(fresh.kind || "") };
            schedule(rand(15000, 60000));
          }
        }).catch(function () {});
    } catch (e) {}
  }
  window.setTimeout(pollPulse, 3000);
  window.setInterval(pollPulse, 40000);
  window.addEventListener("hq:view", function () {
    if (active) stopActive();
    if (!document.hidden) onViewChange();
  });
  function visitObstacle(target) {
    if (!target || !target.closest) return false;
    return !!target.closest("[class*='-chip'], [class*='-drawer'], .hq-else-toggle, .hq-inventoria-toggle, .hq-else-chip-menu, .hq-inventoria-chip-menu, .hq-pistonia-menu, .hq-pistonia-settings");
  }
  function fieldFromTarget(target) {
    if (!target || !target.closest) return null;
    var field = target.closest("input, textarea, select, [contenteditable='true']");
    if (field && isField(field)) return field;
    var label = target.closest("label");
    if (label && label.control && isField(label.control)) return label.control;
    return null;
  }
  function stopVisitForUser(field) {
    if (field) focusPolicy.engage(field);
    if (!active) return;
    stopActive();
    schedule(nextGap());
  }
  function noteFieldPointer(target) {
    var field = fieldFromTarget(target);
    if (!field) { pendingFocusIntent = null; return; }
    pendingFocusIntent = field;
    stopVisitForUser(field);
  }
  function noteFieldEdit(ev) {
    var field = fieldFromTarget(ev.target);
    if (field) stopVisitForUser(field);
  }
  function stopForObstacle(target) {
    if (!active || !visitObstacle(target)) return;
    stopActive();
    schedule(nextGap());
  }
  document.addEventListener("pointerdown", function (ev) {
    noteFieldPointer(ev.target);
    stopForObstacle(ev.target);
  }, true);
  // Keyboard activation and programmatic clicks do not always emit pointerdown.
  document.addEventListener("click", function (ev) {
    noteFieldPointer(ev.target);
    stopForObstacle(ev.target);
  }, true);
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Tab") pendingFocusIntent = true;
    var field = fieldFromTarget(ev.target);
    if (field) stopVisitForUser(field);
  }, true);
  document.addEventListener("beforeinput", noteFieldEdit, true);
  document.addEventListener("input", noteFieldEdit, true);
  document.addEventListener("focusin", function (ev) {
    var field = fieldFromTarget(ev.target);
    var fromUser = pendingFocusIntent === true || pendingFocusIntent === field;
    pendingFocusIntent = null;
    if (!field) return;
    if (fromUser || focusPolicy.isEngaged(field)) focusPolicy.engage(field);
    else focusPolicy.noteAuto(field);
    if (active && focusPolicy.blocks(field)) stopVisitForUser(field);
  }, true);
  var lastView = document.body.getAttribute("data-view") || "";
  if (window.MutationObserver) {
    new MutationObserver(function () {
      var view = document.body.getAttribute("data-view") || "";
      if (view === lastView) return;
      lastView = view;
      if (active) stopActive();
      if (!document.hidden) onViewChange();
    }).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
  }

  window.hqAssistantVisitNow = function () {
    if (active || loading) return false;
    window.clearTimeout(timer);
    timer = window.setTimeout(attempt, 0);
    return true;
  };

  nightCheck();
  window.setInterval(nightCheck, 300000);
  schedule(rand(60000, 180000));
})();
