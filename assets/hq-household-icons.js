/* Transfert HQ — Household food/grocery icon resolver.
   Local SVG only. No network. Shared by Repas, grocery lists, and Inventoria.

   HqHouseholdIcons.resolveIngredient(name)
   HqHouseholdIcons.resolveMeal(mealKey)
   HqHouseholdIcons.resolveRecipe(title, ingredients?)
   HqHouseholdIcons.normalize(label)
   HqHouseholdIcons.render(doc, key, className?) -> SVGElement
   HqHouseholdIcons.pure for tests
*/
(function (root) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  /* Stroke paths, viewBox 0 0 24 24 — curated set, not a full catalog. */
  const PATHS = {
    breakfast: "M4 18h16M6 18V9a2 2 0 0 1 2-2h1v11M15 18V7h2a2 2 0 0 1 2 2v9",
    lunch: "M4 11h16v8H4zM7 11V8a5 5 0 0 1 10 0v3",
    dinner: "M8 4v16M8 8c3 0 5 2 5 5v7M16 4v7c0 3-1.5 5-4 6",
    snack: "M12 3c2.5 2 4 4.5 4 7a4 4 0 0 1-8 0c0-2.5 1.5-5 4-7zM9 18h6M10 21h4",

    vegetable: "M12 21c-4 0-7-3.2-7-7 0-5 7-11 7-11s7 6 7 11c0 3.8-3 7-7 7zM12 10v4",
    fruit: "M12 21c3.5 0 6-2.8 6-6.5S14.5 6 12 6 6 10.8 6 14.5 8.5 21 12 21zM12 6c0-2 1.2-3.5 3-4",
    dairy: "M8 7h8l1 3v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10l1-3zM9 7c0-2 1.5-3.5 3-3.5S15 5 15 7",
    egg: "M12 21c3 0 5-2.7 5-6.5S14 3 12 3s-5 7.8-5 11.5S9 21 12 21z",
    grain: "M4 18h16M6 18c0-6 3-10 6-14 3 4 6 8 6 14M9 12h6M8 15h8",
    meat: "M5 10c0-3 2.5-5 5.5-5S16 7 16 10c2.5.5 4 2.5 4 5 0 3-2.5 5-5.5 5H9c-2.5 0-4-2-4-4.5 0-1.5.7-2.8 2-3.5",
    fish: "M3 12s3-5 9-5 9 5 9 5-3 5-9 5-9-5-9-5zM17 12h1M8 10.5c.5.8.5 2.2 0 3",
    spice: "M12 3v4M9 5h6M8 9h8l-1 11H9L8 9zM10 13h4",
    oil: "M12 3s4 5 4 9a4 4 0 0 1-8 0c0-4 4-9 4-9zM10 20h4",
    beverage: "M8 4h8l-1 14a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2L8 4zM8 8h8",
    bakery: "M4 14c0-4 3.5-7 8-7s8 3 8 7v3H4v-3zM7 17v2M12 17v2M17 17v2",
    frozen: "M12 2v20M4.5 6.5 12 12l7.5-5.5M4.5 17.5 12 12l7.5 5.5",
    canned: "M8 4h8v3H8zM7 7h10v13H7zM9 11h6M9 15h6",
    cleaning: "M8 10h8v10H8zM10 10V7a2 2 0 0 1 4 0v3M9 14h6",
    other: "M7 7h10v10H7zM9 9h6v6H9z",

    tomato: "M12 8c4 0 7 3 7 7s-3 6-7 6-7-2-7-6 3-7 7-7zM12 8c-1-3 1.5-5 3.5-5M10.5 8c0-2-1-3.5-2.5-4",
    onion: "M12 4c4 2 6 5 6 9s-2.5 8-6 8-6-4-6-8 2-7 6-9zM12 8v8M9 12h6",
    garlic: "M12 4c2 0 4 2 4 5 2 1 3 3 3 5 0 3-3 5-7 5s-7-2-7-5c0-2 1-4 3-5 0-3 2-5 4-5z",
    potato: "M8 8c0-3 2-5 4-5s4 2 4 5c3 1 4 3 4 5.5S17 21 12 21 4 18 4 13.5 5 9 8 8z",
    carrot: "M12 3v6M9 5h6M12 9c-4 4-6 8-5 11 3 1 7-2 10-6-1-3-3-5-5-5z",
    leafy: "M12 21c0-8 6-12 6-12s0 6-3 9M12 21c0-8-6-12-6-12s0 6 3 9M12 21V9",
    mushroom: "M5 11c0-4 3-7 7-7s7 3 7 7H5zM10 11v8h4v-8",
    pepper: "M10 4c0-1.5 1-2.5 2-2.5S14 2.5 14 4c2 1 4 4 4 8 0 4-2.5 8-6 8s-6-4-6-8c0-4 2-7 4-8z",

    apple: "M12 8c4 0 7 3.2 7 7.5S15.5 22 12 22 5 19 5 15.5 8 8 12 8zM12 8c1-3 3-4 4-4M10 8c0-2-1-3-2.5-3.5",
    banana: "M6 7c2-3 6-4 9-2 3 2 4 6 3 10-1 3-4 5-7 5-2 0-3-1-3-1s4-3 5-7c1-3-1-5-4-5z",
    citrus: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 3v18M3.5 9.5h17M3.5 14.5h17",
    berry: "M8 14a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM16 14a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM12 19a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM12 6c0-2 1.5-3.5 3-3",

    milk: "M8 5h8l1 3v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V8l1-3zM9 10h6",
    cheese: "M4 10l8-5 8 5v9H4v-9zM8 14a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM13 16a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    butter: "M5 10h14v6H5zM7 10V8h10v2M8 13h8",
    yogurt: "M8 6h8v3H8zM7 9h10v11H7zM10 14h4",

    rice: "M5 18h14M7 18c0-5 2.5-9 5-12 2.5 3 5 7 5 12M9 12h6",
    pasta: "M4 8c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2M4 13c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2M4 18c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2",
    bread: "M4 11c0-3.5 3.5-6 8-6s8 2.5 8 6v5H4v-5zM8 16v2M12 16v2M16 16v2",
    flour: "M7 20h10l1-8H6l1 8zM8 12c0-4 2-7 4-8 2 1 4 4 4 8",

    chicken: "M8 11c0-3 2-5 4.5-5S17 8 17 11c2 0 3.5 2 3.5 4.5S18 20 15 20H9c-2.5 0-4-1.8-4-4 0-1.8 1-3.2 3-4.2M10 7l-2-3",
    beef: "M6 12c0-3.5 2.8-6 6.5-6S19 8.5 19 12c2 1 3 3 3 5 0 2.5-2 4-5 4H8c-2.8 0-5-1.8-5-4.5 0-2 1.2-3.5 3-4.5",
    pork: "M5 13c0-3.5 3-6 7-6s7 2.5 7 6c2 .4 3.5 2 3.5 4 0 2.2-2 4-5.5 4H9C5.8 21 4 19 4 16.5c0-1.8 1-3.2 3-3.8M9 8l-1.5-3",

    coffee: "M6 8h10v7a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V8zM16 10h2a2 2 0 0 1 0 4h-2M8 4c1 1 1 2 0 3M11 3c1 1 1 2 0 3",
    tea: "M7 9h9v7a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V9zM16 11h2a2 2 0 1 1 0 4h-2M10 4c1.5 1 2 2.5 1 4",
    wine: "M8 4h8l-1 7a4 4 0 0 1-3 3.8V20h3M11 20H8M9.5 11h5",
    water: "M12 3s5 6 5 10a5 5 0 0 1-10 0c0-4 5-10 5-10z",

    salt: "M12 4 8 20h8L12 4zM10 14h4",
    sugar: "M8 8h8v3l-1 9H9l-1-9V8zM10 5h4v3h-4z",

    soup: "M4 11h16v2a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6v-2zM8 9c0-2 1.5-3 2.5-3M14 8c1 0 2.5 1 2.5 3",
    salad: "M5 14c0-4 3-7 7-7s7 3 7 7H5zM8 14c1 3 3 5 4 5s3-2 4-5M12 7V5",
    dessert: "M6 14h12l-1 5H7l-1-5zM7 14c0-4 2.2-7 5-7s5 3 5 7M10 7c0-2 1-3 2-3s2 1 2 3",
    recipe: "M7 3h8l2 2v16H7V3zM9 8h6M9 12h6M9 16h4",

    grocery: "M5 6h2l1.5 9h9L20 8H9M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM17 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  };

  const CATEGORY_OF = {
    tomato: "vegetable", onion: "vegetable", garlic: "vegetable", potato: "vegetable",
    carrot: "vegetable", leafy: "vegetable", mushroom: "vegetable", pepper: "vegetable",
    apple: "fruit", banana: "fruit", citrus: "fruit", berry: "fruit",
    milk: "dairy", cheese: "dairy", butter: "dairy", yogurt: "dairy", egg: "dairy",
    rice: "grain", pasta: "grain", bread: "bakery", flour: "grain",
    chicken: "meat", beef: "meat", pork: "meat", fish: "fish",
    coffee: "beverage", tea: "beverage", wine: "beverage", water: "beverage",
    salt: "spice", sugar: "spice", oil: "oil",
    soup: "recipe", salad: "recipe", dessert: "recipe", recipe: "recipe",
    breakfast: "meal", lunch: "meal", dinner: "meal", snack: "meal",
    vegetable: "vegetable", fruit: "fruit", dairy: "dairy", grain: "grain",
    meat: "meat", spice: "spice", beverage: "beverage", bakery: "bakery",
    frozen: "frozen", canned: "canned", cleaning: "cleaning", other: "other",
    grocery: "other",
  };

  /* Folded alias -> icon key. FR + EN, common plurals as aliases. */
  const ALIASES = {
    // vegetables
    tomate: "tomato", tomato: "tomato", tomates: "tomato", tomatoes: "tomato",
    oignon: "onion", onion: "onion", oignons: "onion", onions: "onion",
    ail: "garlic", garlic: "garlic",
    "pomme de terre": "potato", potato: "potato", potatoes: "potato", patate: "potato", patates: "potato",
    carotte: "carrot", carrot: "carrot", carottes: "carrot", carrots: "carrot",
    laitue: "leafy", salade: "leafy", lettuce: "leafy", spinach: "leafy", epinard: "leafy", epinards: "leafy",
    chou: "leafy", cabbage: "leafy", kale: "leafy",
    champignon: "mushroom", champignons: "mushroom", mushroom: "mushroom", mushrooms: "mushroom",
    poivron: "pepper", poivrons: "pepper", pepper: "pepper", peppers: "pepper", "bell pepper": "pepper",
    courgette: "vegetable", zucchini: "vegetable", concombre: "vegetable", cucumber: "vegetable",
    brocoli: "vegetable", broccoli: "vegetable", celery: "vegetable", celeri: "vegetable",
    legume: "vegetable", legumes: "vegetable", vegetable: "vegetable", vegetables: "vegetable",
    // fruit
    pomme: "apple", apple: "apple", pommes: "apple", apples: "apple",
    banane: "banana", banana: "banana", bananes: "banana", bananas: "banana",
    citron: "citrus", lemon: "citrus", limon: "citrus", orange: "citrus", lime: "citrus", pamplemousse: "citrus", grapefruit: "citrus",
    fraise: "berry", strawberry: "berry", fraises: "berry", blueberries: "berry", myrtille: "berry", raspberry: "berry", framboise: "berry", berry: "berry", berries: "berry",
    fruit: "fruit", fruits: "fruit",
    // dairy / egg
    lait: "milk", milk: "milk",
    fromage: "cheese", cheese: "cheese", cheddar: "cheese", mozzarella: "cheese",
    beurre: "butter", butter: "butter",
    yogourt: "yogurt", yogurt: "yogurt", yoghurt: "yogurt", yaourt: "yogurt",
    creme: "dairy", cream: "dairy", "creme fraiche": "dairy",
    oeuf: "egg", egg: "egg", oeufs: "egg", eggs: "egg",
    dairy: "dairy", laitier: "dairy",
    // grains / bakery
    riz: "rice", rice: "rice",
    pates: "pasta", pasta: "pasta", spaghetti: "pasta", macaroni: "pasta", nouilles: "pasta", noodles: "pasta",
    pain: "bread", bread: "bread", baguette: "bread",
    farine: "flour", flour: "flour",
    avoine: "grain", oatmeal: "grain", oats: "grain", cereal: "grain", cereale: "grain",
    quinoa: "grain", ble: "grain", wheat: "grain", grain: "grain", grains: "grain",
    // meat / fish
    poulet: "chicken", chicken: "chicken", volaille: "chicken",
    boeuf: "beef", beef: "beef", steak: "beef",
    porc: "pork", pork: "pork", jambon: "pork", ham: "pork", bacon: "pork",
    viande: "meat", meat: "meat",
    poisson: "fish", fish: "fish", saumon: "fish", salmon: "fish", thon: "fish", tuna: "fish",
    crevette: "fish", shrimp: "fish", seafood: "fish", "fruits de mer": "fish",
    // beverages
    cafe: "coffee", coffee: "coffee", espresso: "coffee",
    the: "tea", tea: "tea",
    vin: "wine", wine: "wine",
    eau: "water", water: "water", jus: "beverage", juice: "beverage", soda: "beverage",
    boisson: "beverage", beverage: "beverage", drink: "beverage",
    // pantry
    sel: "salt", salt: "salt",
    sucre: "sugar", sugar: "sugar",
    huile: "oil", oil: "oil", "huile d olive": "oil", "olive oil": "oil",
    epice: "spice", epices: "spice", spice: "spice", spices: "spice", poivre: "spice",
    conserve: "canned", canned: "canned",
    surgele: "frozen", frozen: "frozen",
    // dishes / recipes
    soupe: "soup", soup: "soup", potage: "soup",
    dessert: "dessert", gateau: "dessert", cake: "dessert", cookie: "dessert", biscuit: "dessert",
    "salade composee": "salad",
    "petit dejeuner": "breakfast", breakfast: "breakfast", dejeuner: "lunch", lunch: "lunch",
    diner: "lunch", dinner: "dinner", souper: "dinner", collation: "snack", snack: "snack",
    recette: "recipe", recipe: "recipe", plat: "recipe",
    epicerie: "grocery", grocery: "grocery",
    // cleaning / household (inventoria)
    savon: "cleaning", soap: "cleaning", detergent: "cleaning", lessive: "cleaning",
  };

  const MEAL_KEYS = {
    breakfast: "breakfast",
    lunch: "lunch",
    dinner: "dinner",
    snack: "snack",
    dejeuner: "breakfast",
    diner: "lunch",
    souper: "dinner",
    collation: "snack",
  };

  const RECIPE_HINTS = [
    [/soupe|soup|potage|broth|bouillon/i, "soup"],
    [/salade|salad/i, "salad"],
    [/pate|pasta|spaghetti|nouille|noodle|lasagne/i, "pasta"],
    [/riz|rice|risotto|pilaf/i, "rice"],
    [/gateau|cake|dessert|cookie|biscuit|brownie|tarte|pie/i, "dessert"],
    [/pain|bread|brioche|toast/i, "bread"],
    [/poulet|chicken|volaille/i, "chicken"],
    [/boeuf|beef|steak/i, "beef"],
    [/porc|pork|jambon|bacon/i, "pork"],
    [/poisson|fish|saumon|salmon|thon|tuna/i, "fish"],
    [/cafe|coffee|latte/i, "coffee"],
    [/the\b|tea\b/i, "tea"],
    [/omelette|oeuf|egg/i, "egg"],
    [/smoothie|jus|juice/i, "beverage"],
  ];

  function fold(text) {
    return String(text == null ? "" : text)
      .replace(/Œ/g, "OE")
      .replace(/œ/g, "oe")
      .replace(/Æ/g, "AE")
      .replace(/æ/g, "ae")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/['’]/g, " ")
      .replace(/[^a-z0-9\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function singularize(token) {
    if (!token || token.length < 4) return token;
    if (ALIASES[token]) return token;
    if (token.endsWith("ies") && token.length > 4) return token.slice(0, -3) + "y";
    if (token.endsWith("oes") && token.length > 4) return token.slice(0, -2);
    if (token.endsWith("aux") && token.length > 4) return token.slice(0, -3) + "al";
    if (token.endsWith("eaux") && token.length > 5) return token.slice(0, -1);
    if (token.endsWith("ches") || token.endsWith("shes") || token.endsWith("sses")) return token.slice(0, -2);
    if (token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us") && !token.endsWith("is")) return token.slice(0, -1);
    if (token.endsWith("x") && !token.endsWith("ex") && !token.endsWith("ix")) return token.slice(0, -1);
    return token;
  }

  function lookupAlias(folded) {
    if (!folded) return null;
    if (ALIASES[folded]) return ALIASES[folded];
    const singular = singularize(folded);
    if (singular !== folded && ALIASES[singular]) return ALIASES[singular];
    return null;
  }

  function resolveIngredient(name) {
    const raw = String(name == null ? "" : name).trim();
    const folded = fold(raw);
    if (!folded) {
      return { key: "other", category: "other", matched: false, label: raw };
    }
    let key = lookupAlias(folded);
    if (!key) {
      const parts = folded.split(" ");
      if (parts.length > 1) {
        for (let i = 0; i < parts.length - 1 && !key; i += 1) {
          key = lookupAlias(parts.slice(i).join(" "));
        }
        for (let i = parts.length - 1; i >= 0 && !key; i -= 1) {
          key = lookupAlias(parts[i]);
        }
      }
    }
    if (!key) {
      for (let i = 0; i < RECIPE_HINTS.length; i += 1) {
        if (RECIPE_HINTS[i][0].test(raw) || RECIPE_HINTS[i][0].test(folded)) {
          key = RECIPE_HINTS[i][1];
          break;
        }
      }
    }
    if (!key) key = "other";
    if (!PATHS[key]) key = "other";
    const category = CATEGORY_OF[key] || "other";
    return {
      key: key,
      category: category,
      matched: key !== "other",
      label: raw,
    };
  }

  function resolveMeal(mealKey) {
    const folded = fold(mealKey);
    const key = MEAL_KEYS[folded] || MEAL_KEYS[String(mealKey || "").toLowerCase()] || "snack";
    return { key: key, category: "meal", matched: !!MEAL_KEYS[folded], label: String(mealKey || "") };
  }

  function resolveRecipe(title, ingredients) {
    const raw = String(title == null ? "" : title).trim();
    const folded = fold(raw);
    for (let i = 0; i < RECIPE_HINTS.length; i += 1) {
      if (RECIPE_HINTS[i][0].test(raw) || RECIPE_HINTS[i][0].test(folded)) {
        const key = RECIPE_HINTS[i][1];
        return { key: key, category: CATEGORY_OF[key] || "recipe", matched: true, label: raw };
      }
    }
    const direct = lookupAlias(folded);
    if (direct && (CATEGORY_OF[direct] === "recipe" || PATHS[direct])) {
      return { key: direct, category: CATEGORY_OF[direct] || "recipe", matched: true, label: raw };
    }
    const list = Array.isArray(ingredients) ? ingredients : [];
    const counts = Object.create(null);
    list.forEach(function (ing) {
      const name = typeof ing === "string" ? ing : (ing && ing.name);
      const resolved = resolveIngredient(name);
      if (!resolved.matched) return;
      const cat = resolved.category;
      if (cat === "other" || cat === "meal" || cat === "recipe") return;
      counts[cat] = (counts[cat] || 0) + 1;
    });
    let best = null;
    let bestN = 0;
    Object.keys(counts).forEach(function (cat) {
      if (counts[cat] > bestN) {
        best = cat;
        bestN = counts[cat];
      }
    });
    if (best === "meat") return { key: "meat", category: "meat", matched: true, label: raw };
    if (best === "fish") return { key: "fish", category: "fish", matched: true, label: raw };
    if (best === "vegetable") return { key: "vegetable", category: "vegetable", matched: true, label: raw };
    if (best === "grain") return { key: "grain", category: "grain", matched: true, label: raw };
    if (best === "dairy") return { key: "dairy", category: "dairy", matched: true, label: raw };
    return { key: "recipe", category: "recipe", matched: false, label: raw };
  }

  function render(doc, key, className) {
    const documentRef = doc || (typeof document !== "undefined" ? document : null);
    if (!documentRef || !documentRef.createElementNS) return null;
    const safeKey = PATHS[key] ? key : "other";
    const svg = documentRef.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("class", "hq-hh-ico" + (className ? " " + className : ""));
    svg.setAttribute("data-hh-icon", safeKey);
    const path = documentRef.createElementNS(SVG_NS, "path");
    path.setAttribute("d", PATHS[safeKey]);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.75");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  function badge(doc, resolution, className) {
    const documentRef = doc || (typeof document !== "undefined" ? document : null);
    if (!documentRef) return null;
    const wrap = documentRef.createElement("span");
    wrap.className = "hq-hh-ico-badge" + (className ? " " + className : "");
    wrap.setAttribute("data-hh-category", (resolution && resolution.category) || "other");
    wrap.setAttribute("data-hh-icon", (resolution && resolution.key) || "other");
    const svg = render(documentRef, resolution && resolution.key, null);
    if (svg) wrap.appendChild(svg);
    return wrap;
  }

  root.HqHouseholdIcons = {
    resolveIngredient: resolveIngredient,
    resolveMeal: resolveMeal,
    resolveRecipe: resolveRecipe,
    normalize: fold,
    render: render,
    badge: badge,
    has: function (key) { return !!PATHS[key]; },
    keys: function () { return Object.keys(PATHS); },
    pure: {
      fold: fold,
      singularize: singularize,
      lookupAlias: lookupAlias,
      resolveIngredient: resolveIngredient,
      resolveMeal: resolveMeal,
      resolveRecipe: resolveRecipe,
      PATHS: PATHS,
      ALIASES: ALIASES,
    },
  };
}(typeof globalThis !== "undefined" ? globalThis : this));
