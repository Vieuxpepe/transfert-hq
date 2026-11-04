/* Contextual adult fallback lines for Transferania (loaded before hq-companion.js). */
(function (root) {
  "use strict";
  const PROMPTS = {
    pull_light:
      "Marco effleure et commence à tirer légèrement sa poitrine / son décolleté (première tension, surprise timide puis chaude)",
    pull_medium:
      "Marco tire plus fort sur sa poitrine, l'écarte, elle respire vite, nipples durcis sous le tissu, joues roses",
    pull_deep:
      "Marco écarte sa poitrine avec insistance, étirement profond, bouche entrouverte, gémissement contenu, très excitée",
    pull_surrender:
      "Marco maintient sa poitrine tendue longtemps; elle cède, supplie sans mots, mouillée d'excitation, regard noyé",
    pull_release:
      "Marco relâche sa poitrine après l'avoir tirée; rebond, souffle cassé, tétons encore durs, honte et plaisir",
    slap_bust:
      "Marco claque sa poitrine latéralement; seins qui oscillent, sursaut, petit cri, excitation immédiate",
    slap_bust_combo:
      "Marco enchaîne plusieurs claques sur sa poitrine; elle n'en peut plus, tremble, implore, tout brûle",
    slap_bust_finisher:
      "Marco termine une rafale de claques sur sa poitrine; combo, jambes molles, voix rauque, prête à craquer",
    slap_bust_monster:
      "Marco lui assène une claque très forte sur la poitrine; choc violent, plaisir brutal, yeux révulsés un instant",
    slap_booty:
      "Marco lui donne une fessée coquine sur les fesses / bas du corps pendant qu'elle est affichée sur {view}",
    contact_flush:
      "Marco l'a tellement touchée (tirer, claquer) qu'elle rougit de partout, chaleur montante, respiration haletante",
    contact_fever:
      "Marco l'a mise dans un état de chaleur extrême par le jeu sur sa poitrine; elle frôle la limite, besoin urgent",
  };

  const POOLS = {
    pull_light: [
      "Mmh… doucement Maître… tu commences à m'ouvrir et déjà je mouille ♥",
      "Ah… ne tire pas encore si fort… ou si, continue sur {view} ♥",
      "Tu sens comme ma poitrine cède rien qu'avec ce petit tirage ? ♥",
      "Mon cœur bat… mes tétons durcissent… c'est toi sur {view} ♥",
      "J'ai à peine commencé à bander… pardon, à mouiller pour toi ♥",
      "Effleure encore… j'adore quand tu testes ma limite ♥",
      "Ma respiration accélère… tu le vois bien, mon amour ? ♥",
      "Un tout petit tirage et je suis déjà toute chaude ♥",
      "Tu m'attrapes au bon endroit… j'en ai les lèvres qui s'entrouvrent ♥",
      "Premier étirement… déjà envie de te supplier sur {view} ♥",
      "Mes aréoles frissonnent avant même que tu tires fort ♥",
      "Doucement… ou pas… je suis ta jouet depuis la première seconde ♥",
      "Je sens ta main dans ma tête autant que sur ma poitrine ♥",
      "Un tirage timide… une chatte qui répond déjà ♥",
      "Ne fais pas semblant de tester… je sais que tu vas m'ouvrir ♥",
      "J'ai les mamelons qui pointent… tu es fier, Maître ? ♥",
      "Sur {view} tout le monde voit mon visage… toi tu vois mes seins céder ♥",
      "Encore un centimètre… je suis trempée… promis ♥",
      "Tu commences à me déshabiller avec ta poigne… j'adore ♥",
    ],
    pull_medium: [
      "Ah… là tu m'écartes vraiment… j'ai les tétons qui tirent, Maître 🔥♥",
      "Mmh… oui, tire… montre à {view} à qui appartiennent mes seins ♥",
      "Je sens la peau tendue… j'en ai les cuisses qui tremblent ♥",
      "Plus… écarte-moi… je suis trempée rien qu'avec ta main ♥",
      "Tu me fais un nœud de chaleur au bas du ventre… continue ♥",
      "Ma voix va lâcher si tu tires encore comme ça 🔥♥",
      "J'adore sentir mes seins s'étirer pour toi… salaud ♥",
      "Regarde comme je m'ouvre… c'est pour toi, pas pour {view} ♥",
      "Chaque millimètre que tu tires me fait gémir dans ma tête ♥",
      "Mes mamelons frôlent le tissu… c'est insupportable… ne t'arrête pas ♥",
      "Tire vers toi… je suis accrochée à ta main comme une chienne ♥",
      "Ma poitrine s'étire… ma chatte aussi… connexion directe 🔥♥",
      "Tu veux entendre mon souffle casser ? Tire encore ♥",
      "J'ai les tétons hypersensibles… c'est ta faute sur {view} ♥",
      "Plus tu écartes… plus je bave de désir ♥",
      "Ma peau tire… mes cuisses se serrent… synchronisé Maître ♥",
      "Tu me fais sentir chaque gramme de mes seins… salaud ♥",
      "Je suis à mi-chemin entre gêne et envie de crier ♥",
      "Tension moyenne… plaisir maximum… ne relâche pas ♥",
      "Mes seins obéissent… mon corps aussi… prends-le ♥",
      "Tu m'ouvres comme un fruit… j'ai honte… j'en veux plus 🔥♥",
    ],
    pull_deep: [
      "Ah… Maître… tu me tiens ouverte… je suis à deux doigts de supplier 🔥♥",
      "Mmh… tire encore… je sens mes seins brûler, je suis trempée ♥",
      "Oh mon amour… tu m'écartes comme une petite salope docile sur {view} 🔥♥",
      "Je… je vais craquer si tu gardes cette tension… ne lâche pas ♥",
      "Mes tétons sont durs comme des pierres… c'est ta faute, Maître ♥",
      "Tu veux me voir gémir ? Tiens-moi comme ça encore dix secondes 🔥♥",
      "J'ai la chatte qui pulse rien qu'avec ta poigne sur ma poitrine ♥",
      "Oui… oui… écarte-moi… je suis ta putain de compagnon sur {view} ♥",
      "Je bave presque… tire… montre-moi qui décide 🔥♥",
      "Ma voix tremble… mes seins aussi… ne me relâche pas tout de suite ♥",
      "Tu me transformes en paquet de nerfs et de désir… continue Maître ♥",
      "Si tu tires encore je gémis à voix haute… même sur {view} 🔥♥",
      "Je suis ta salope docile… tiens-moi ouverte encore ♥",
      "Tension max… tétons en acier… chatte en flammes ♥",
      "Tu me tiens par les seins… je suis à genoux dans ma tête 🔥♥",
      "J'ai envie de te supplier… tire… ne parle pas ♥",
      "Mes mamelons vont craquer… continue… je paye en mouille ♥",
      "Profond… obscène… parfait… Maître sur {view} ♥",
      "Je sens le lait de rien… non, le désir… monter ♥",
      "Tu m'écartes jusqu'à la limite… j'ai les yeux qui roulent 🔥♥",
      "Encore… encore… je suis ta poupée tendue ♥",
      "Ma voix… mes seins… tout tremble pour ta main ♥",
      "Tu me fais bander les tétons sans les toucher… magie salope ♥",
    ],
    pull_surrender: [
      "Ah… j'abandonne… tu m'as ouverte… fais ce que tu veux ♥",
      "Mmh… je cède… mes seins sont à toi… je suis trempée Maître 🔥♥",
      "Je ne peux plus… tiens-moi comme ça… je suis à toi ♥",
      "Tu m'as eu… je suis molle… tire encore une fois pour me faire jouir des yeux ♥",
      "Mon corps dit oui… même si ma bouche bégaye… ne lâche pas 🔥♥",
      "Je suis ta chose tendue sur {view}… sers-toi de moi ♥",
      "Encore… encore… je suis au bord… juste avec ma poitrine ♥",
      "Je suis ouverte… humide… à toi… même les passants sur {view} ♥",
      "Abandon total… fais-moi jouir des yeux si tu veux 🔥♥",
      "Tu m'as eu au tirage… je ne résiste plus ♥",
      "Mes seins tremblent… ma chatte aussi… synchronisé ♥",
      "Je suis ta propriété tendue… signe-moi au feu 🔥♥",
      "Cède… cède… oui Maître… je suis finie ♥",
      "Tu me tiens au bord… un relâchement et je crie ♥",
    ],
    pull_release: [
      "Ah… elles rebondissent… je suis toute vibrante… ne me regarde pas comme ça ♥",
      "Mmh… tu lâches et j'ai encore le feu au creux du ventre… 🔥♥",
      "Mon amour… mes seins picotent… remets ta main ♥",
      "Je suis trempée… tu l'as fait en tirant… pas en me touchant là-bas ♥",
      "Rebond… souffle… je suis une loque sur {view} ♥",
      "Tu me laisses ouverte dans ma tête même après avoir lâché 🔥♥",
      "Encore une fois… tire puis relâche… j'adore ce jeu ♥",
      "Je cligne des yeux… mes tétons ne veulent pas redescendre ♥",
      "Ma chatte palpite en regardant mes seins trembler… Maître ♥",
      "Relâche encore… non, reprends… je suis folle 🔥♥",
      "Le rebond me fait cligner… je suis encore trempée ♥",
      "Tu lâches… mes seins dansent… je suis accro ♥",
      "Après le tirage… chaque respiration me fait gémir ♥",
      "Mes tétons restent durs… tu m'as marquée sur {view} 🔥♥",
      "Rebond obscène… j'ai les cuisses collées ♥",
      "Je veux que tu tires à nouveau… immédiatement ♥",
      "Souffle court… chatte pleine d'envie… ta faute ♥",
    ],
    slap_bust: [
      "Ah !… claque-moi encore… mes seins adorent ta main ♥",
      "Mmh… oui… fais-les osciller… je mouille à chaque claque 🔥♥",
      "Oh… tu aimes me voir sursauter sur {view} ? Recommence ♥",
      "Putain… ça pique et ça m'excite… encore Maître ♥",
      "Mes tétons claquent sous le choc… j'en ai les cuisses serrées ♥",
      "Une claque… deux… je suis déjà trempée 🔥♥",
      "Tu me traites comme ta catin… j'adore ♥",
      "Ah !… plus fort… montre à {view} qui me possède ♥",
      "Je sens la chaleur monter à chaque impact… salaud ♥",
      "Claque la gauche… la droite… je compte plus 🔥♥",
      "Impact… oscillation… mouille… boucle infinie ♥",
      "Tu me réveille les mamelons à chaque claque ♥",
      "Je sursaute… je mouille… je souris… salaud ♥",
      "Ta paume sur ma poitrine… meilleur que {view} ♥",
      "Claque-moi pendant que je te regarde… j'adore 🔥♥",
      "Mes seins sont rouges… ma chatte aussi… invisible ♥",
      "Encore… fais-les claquer ensemble ♥",
      "Petite claque… gros frisson… encore Maître ♥",
    ],
    slap_bust_combo: [
      "Ah ! Ah !… arrête… non continue… je vais fondre 🔥♥",
      "Mmh… ta rafale… mes seins ne suivent plus… je suis trempée ♥",
      "Je supplie… en silence… claque encore sur {view} ♥",
      "Tu me bats la poitrine comme un tambour… j'adore ♥",
      "Je n'en peux plus… mes mamelons sont en feu 🔥♥",
      "Combo… combo… je suis ta petite salope secouée ♥",
      "Chaque claque me fait claquer entre les jambes aussi ♥",
      "Ma voix casse… mes seins aussi… finis-moi 🔥♥",
      "Rafale… rafale… je suis ta percussion ♥",
      "Je compte les claques… j'oublie la honte ♥",
      "Tu me secoues la poitrine… je secoue le bassin 🔥♥",
      "Arrête… non… finis ta rafale… je t'en supplie ♥",
      "Combo en cours… je suis trempée… {view} témoin ♥",
    ],
    slap_bust_finisher: [
      "Ah… combo… je suis finie… prends-moi ♥",
      "Mmh… tu m'as claquée jusqu'à l'orgasme des nerfs… 🔥♥",
      "Mes seins brûlent… ma chatte aussi… Maître ♥",
      "Je tremble… je suis à toi… même sur {view} ♥",
      "Tu m'as punie comme il faut… merci… encore ♥",
      "Je suis molle… sauf là où tu m'as frappée 🔥♥",
      "Finisher… j'ai crié dans ma tête… entends-moi gémir ♥",
      "Quatre claques… un orgasme nerveux… merci Maître 🔥♥",
      "Je suis finie… prends ma bouche… ma chatte… ce que tu veux ♥",
      "Combo terminé… je cligne… je mouille… je t'aime ♥",
      "Tu m'as claquée jusqu'à l'abandon… parfait 🔥♥",
    ],
    slap_bust_monster: [
      "AH !… putain… j'ai vu des étoiles… claque encore ♥",
      "Mmh… si fort… mes seins vont avoir ta marque 🔥♥",
      "Tu m'assommes de plaisir… mon amour ♥",
      "Une claque de ouf… je suis trempée instantanément ♥",
      "Ma poitrine hurle… mon corps aussi… Maître 🔥♥",
      "Claque monstre… je suis trempée en une seconde ♥",
      "Tu me laisses des étoiles… et du désir ♥",
      "Impact brutal… plaisir brutal… encore 🔥♥",
      "Je sursaute comme après l'amour… sans l'amour ♥",
      "Mes seins vibrent… ma chatte aussi… connexion ♥",
    ],
    slap_booty: [
      "Ah ! 🍑… fesse-moi pendant que je regarde {view}… j'adore ♥",
      "Mmh… ta main sur mon cul… je serre les cuisses 🔥♥",
      "Encore Maître… fais-moi rougir les fesses ♥",
      "Je sursaute… je mouille… connexion directe ♥",
      "Petite fessée… grosse envie… continue mon amour ♥",
      "Tu aimes me voir bouger le booty ? Claque plus fort 🍑♥",
      "Aïe… mmmh… je mérite pire sur {view} 🔥♥",
      "Chaque claque sur mes fesses me fait bander les tétons ♥",
      "Fessée sur {view}… honte publique… plaisir privé 🔥♥",
      "Mon cul rebondit… je serre… je mouille ♥",
      "Encore… laisse ta marque sur ma peau ♥",
      "Tu me punis… je te remercie… salaud 🍑♥",
      "Claque le booty… je pense à ta bite ♥",
    ],
    contact_flush: [
      "Je… je suis cramoisie… tu me vois fondre sur {view} ? 🔥♥",
      "Ma peau brûle… c'est toi… tes mains… ta cruauté douce ♥",
      "Je suis trop chaude… touche-moi encore… ou laisse-moi respirer ♥",
      "Rouge partout… même entre les jambes… Maître ♥",
      "Tu m'as mise dans cet état rien qu'en jouant avec ma poitrine 🔥♥",
      "Je cache mal à quel point je suis excitée… échoue ♥",
      "Flush… honte… plaisir… mélange parfait ♥",
      "Je suis rouge comme mes tétons… tu vois ? 🔥♥",
      "Chaleur montante… chatte en attente… Maître ♥",
      "Tu m'as touchée partout sans me toucher partout ♥",
      "Cramoisi… haletante… ta victoire sur {view} ♥",
      "Je brûle… respire… brûle encore ♥",
    ],
    contact_fever: [
      "Ah… je vais exploser… pas encore… oui encore 🔥♥",
      "Mmh… chaleur de malade… tu m'as montée trop haut ♥",
      "Je suis à un toucher de supplier sur {view} ♥",
      "Mon corps réclame… pas des mots… ta main ♥",
      "Fièvre de désir… tu l'as allumée… éteins ou consume 🔥♥",
      "Je respire comme après l'amour… sans que tu m'aies prise ♥",
      "Fièvre… besoin… tu m'as montée trop haut 🔥♥",
      "Un doigt… une seconde… je craquerais ♥",
      "Chaleur de contact… je suis ta torche ♥",
      "Sur {view} je souris… entre mes jambes c'est la tempête ♥",
      "Consume-moi… ou laisse-moi frémir… choisis 🔥♥",
    ],
  };

  function pick(win, key, ctx) {
    ctx = ctx || {};
    const pool = POOLS[key];
    if (!pool || !pool.length) return "Mmh… ♥";
    const view = (win.document && win.document.body && win.document.body.dataset.view) || "accueil";
    const vLabel = (ctx.viewLabels && ctx.viewLabels[view]) || view;
    const candidates = pool.map((tpl) => String(tpl).replace(/\{view\}/g, vLabel));
    const last = ctx.lastLine;
    const filtered = candidates.filter((c) => c !== last);
    const set = filtered.length ? filtered : candidates;
    const chosen = set[Math.floor(Math.random() * set.length)] || candidates[0];
    const nsfw = ctx.nsfw !== false;
    return nsfw && chosen && !chosen.includes("♥") ? chosen + " ♥" : chosen;
  }

  function prompt(key) {
    const p = PROMPTS[key];
    if (!p) return "Marco la touche avec insistance; elle réagit fort, mode adulte.";
    return String(p).replace(/\{view\}/g, "l'écran");
  }

  function pool(key) {
    return POOLS[key] || [];
  }

  root.HqCompanionLewdLines = { pick, prompt, pool, PROMPTS, POOLS };
})(typeof globalThis !== "undefined" ? globalThis : this);
