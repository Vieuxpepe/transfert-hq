/* Transfert HQ — Household food + hardware icon resolver.
   Local SVG only. No network. Shared by Repas, grocery lists, and Inventoria.

   HqHouseholdIcons.resolveItem(name)         // food + hardware
   HqHouseholdIcons.resolveIngredient(name)  // same as resolveItem (compat)
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

    /* --- hardware / workshop / electronics (Inventoria) --- */
    bolt: "M10 3h4v3l2 2v4l-2 2v7h-4v-7l-2-2V8l2-2V3zM9 9h6",
    nut: "M12 3l7 4v5l-7 4-7-4V7l7-4zM12 8v7M8.5 10.5h7",
    screw: "M12 2v4M10 6h4l-1 3H11L10 6zM11 9h2v12l-1-2-1 2V9z",
    washer: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    nail: "M12 2v18M10 20h4M11 4h2",
    anchor: "M12 3v8M9 7h6M8 11c0 4 1.5 7 4 9 2.5-2 4-5 4-9M10 20h4",
    bracket: "M5 5h6v4H9v10H5V5zM13 15h6v4h-6v-4z",
    wrench: "M14 4a4 4 0 0 1 4 4c0 .6-.1 1.1-.4 1.6L12 15.2 8.8 12l5.6-5.6c.5-.3 1-.4 1.6-.4zM8.8 12 4 20l2.5.5L10 14",
    screwdriver: "M12 2v8M10 10h4v2l-1 1v8h-2v-8l-1-1v-2zM9 4h6",
    hammer: "M5 8h9l2-3h3v6h-3l-2-3H8v10H5V8z",
    pliers: "M7 4 4 20M17 4l3 16M7 4c2 3 8 3 10 0M8 12h8",
    saw: "M4 18V7l12-3v14M16 5l4 2v11M7 10h6M7 14h6",
    drill: "M3 11h9v3H3zM12 10h5l3 2.5-3 2.5h-5V10zM4 14v4M8 14v3",
    "drill-bit": "M12 2v6l2 2v12h-4V10l2-2V2zM10 8h4",
    measure: "M3 8h18v8H3V8zM7 8v5M11 8v3M15 8v5M19 8v3",
    clamp: "M8 4h8v4H8V4zM10 8v5H7l-2 7h14l-2-7h-3V8",
    gear: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M4.2 6.5l2.1 2.1M17.7 15.4l2.1 2.1M2 12h3M19 12h3M4.2 17.5l2.1-2.1M17.7 8.6l2.1-2.1",
    bearing: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 3v3M12 18v3",
    spring: "M8 4c2 1 4 1 6 0M8 8c2 1 4 1 6 0M8 12c2 1 4 1 6 0M8 16c2 1 4 1 6 0M8 20c2 1 4 1 6 0",
    hinge: "M6 4h5v16H6V4zM13 4h5v16h-5V4zM11 8h2M11 16h2",
    cable: "M4 8c4 0 4 8 8 8s4-8 8-8M4 8v2M20 8v2",
    connector: "M6 9h5v6H6V9zM11 11h4v2h-4zM15 9h3v6h-3z",
    battery: "M8 7h8v12H8V7zM10 4h4v3h-4V4zM10 11h4M10 15h4",
    "circuit-board": "M5 5h14v14H5V5zM9 9h2v2H9V9zM13 13h2v2h-2v-2zM9 13h2M13 9v2M8 5v2M16 17v2",
    microcontroller: "M7 7h10v10H7V7zM9 4v3M12 4v3M15 4v3M9 17v3M12 17v3M15 17v3M4 9h3M4 12h3M4 15h3M17 9h3M17 12h3M17 15h3",
    sensor: "M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 13v5M8 21h8M6.5 8.5a7 7 0 0 1 11 0",
    led: "M9 10h6l1 4H8l1-4zM10 14v5M14 14v5M12 3v5M9 5h6",
    resistor: "M3 12h5l1.5-3 2 6 2-6 1.5 3H21",
    capacitor: "M6 5v14M18 5v14M6 12h12M10 8v8M14 8v8",
    filament: "M7 4h10v3l-2 2v9a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V9L7 7V4zM9 7h6",
    "printed-part": "M6 8h12v3l-2 2v6H8v-6L6 11V8zM9 5h6v3H9V5z",
    wood: "M4 6h16v12H4V6zM4 10h16M4 14h16M9 6v12",
    "metal-stock": "M3 8h18v8H3V8zM3 12h18M8 8v8",
    adhesive: "M9 3h6v5l2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9l2-2V3zM10 14h4",
    supplies: "M5 7h14v12H5V7zM8 7V5h8v2M9 11h6M9 15h4",
    hardware: "M7 7h4v4H7V7zM13 7h4v4h-4V7zM7 13h4v4H7v-4zM13 13h4v4h-4v-4z",
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
    bolt: "fastener", nut: "fastener", screw: "fastener", washer: "fastener",
    nail: "fastener", anchor: "fastener", bracket: "fastener",
    wrench: "tool", screwdriver: "tool", hammer: "tool", pliers: "tool", saw: "tool",
    drill: "tool", "drill-bit": "tool", measure: "tool", clamp: "tool",
    gear: "mechanical", bearing: "mechanical", spring: "mechanical", hinge: "mechanical",
    cable: "electrical", connector: "electrical", battery: "electrical", "circuit-board": "electrical",
    microcontroller: "electronics", sensor: "electronics", led: "electronics",
    resistor: "electronics", capacitor: "electronics",
    filament: "fabrication", "printed-part": "fabrication",
    wood: "material", "metal-stock": "material", adhesive: "material", supplies: "material",
    hardware: "hardware",
  };

  const FOOD_CATEGORIES = {
    vegetable: 1, fruit: 1, dairy: 1, grain: 1, meat: 1, fish: 1, spice: 1, oil: 1,
    beverage: 1, bakery: 1, frozen: 1, canned: 1, cleaning: 1, recipe: 1, meal: 1,
  };

  const HARDWARE_CATEGORIES = {
    fastener: 1, tool: 1, mechanical: 1, electrical: 1, electronics: 1,
    fabrication: 1, material: 1, hardware: 1,
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
    // fasteners
    boulon: "bolt", boulons: "bolt", bolt: "bolt", bolts: "bolt",
    ecrou: "nut", ecrous: "nut", nut: "nut", nuts: "nut", "ecrou hexagonal": "nut", "hex nut": "nut", "hex nuts": "nut",
    vis: "screw", screw: "screw", screws: "screw", "vis a bois": "screw", "wood screw": "screw",
    "vis a metaux": "screw", "machine screw": "screw",
    rondelle: "washer", rondelles: "washer", washer: "washer", washers: "washer",
    "rondelle plate": "washer", "flat washer": "washer", "lock washer": "washer",
    clou: "nail", clous: "nail", nail: "nail", nails: "nail",
    cheville: "anchor", chevilles: "anchor", anchor: "anchor", anchors: "anchor", "wall plug": "anchor",
    equerre: "bracket", equerres: "bracket", bracket: "bracket", brackets: "bracket",
    // tools
    cle: "wrench", "cle plate": "wrench", "cle a molette": "wrench", wrench: "wrench", wrenches: "wrench", spanner: "wrench",
    tournevis: "screwdriver", screwdriver: "screwdriver", screwdrivers: "screwdriver",
    "tournevis phillips": "screwdriver", phillips: "screwdriver", "tournevis plat": "screwdriver",
    marteau: "hammer", hammer: "hammer", hammers: "hammer",
    pince: "pliers", pinces: "pliers", pliers: "pliers", "needle nose": "pliers",
    scie: "saw", saw: "saw", saws: "saw", "scie sautee": "saw",
    perceuse: "drill", drill: "drill", drills: "drill",
    foret: "drill-bit", forets: "drill-bit", "drill bit": "drill-bit", "drill bits": "drill-bit", bit: "drill-bit", bits: "drill-bit",
    metre: "measure", "metre ruban": "measure", "tape measure": "measure", caliper: "measure", "pied a coulisse": "measure", ruler: "measure",
    "serre joint": "clamp", "serre-joint": "clamp", clamp: "clamp", clamps: "clamp", etau: "clamp",
    // mechanical
    engrenage: "gear", gear: "gear", gears: "gear", pignon: "gear",
    roulement: "bearing", bearing: "bearing", bearings: "bearing",
    ressort: "spring", ressorts: "spring", spring: "spring", springs: "spring",
    charniere: "hinge", charnieres: "hinge", hinge: "hinge", hinges: "hinge",
    // electrical / electronics
    cable: "cable", cables: "cable", fil: "cable", fils: "cable", wire: "cable", wires: "cable",
    connecteur: "connector", connecteurs: "connector", connector: "connector", connectors: "connector",
    "dupont": "connector", "jst": "connector",
    pile: "battery", piles: "battery", batterie: "battery", battery: "battery", batteries: "battery",
    "circuit imprime": "circuit-board", pcb: "circuit-board", "circuit board": "circuit-board", "printed circuit": "circuit-board",
    esp32: "microcontroller", esp8266: "microcontroller", arduino: "microcontroller",
    microcontroller: "microcontroller", "microcontroleur": "microcontroller", mcu: "microcontroller",
    "esp32 devkit": "microcontroller", "devkit": "microcontroller", raspberry: "microcontroller", pico: "microcontroller",
    capteur: "sensor", capteurs: "sensor", sensor: "sensor", sensors: "sensor",
    led: "led", leds: "led", "diode led": "led",
    resistance: "resistor", resistances: "resistor", resistor: "resistor", resistors: "resistor",
    condensateur: "capacitor", condensateurs: "capacitor", capacitor: "capacitor", capacitors: "capacitor",
    // fabrication / materials
    filament: "filament", "filament pla": "filament", pla: "filament", petg: "filament", abs: "filament",
    "piece imprimee": "printed-part", "printed part": "printed-part", "printed parts": "printed-part",
    bois: "wood", wood: "wood", plywood: "wood", "contre plaque": "wood",
    metal: "metal-stock", "metal stock": "metal-stock", barre: "metal-stock", "barre filetee": "bolt",
    tige: "metal-stock", "aluminium": "metal-stock", aluminum: "metal-stock",
    colle: "adhesive", glue: "adhesive", adhesive: "adhesive", epoxy: "adhesive", scotch: "adhesive",
    fournitures: "supplies", supplies: "supplies", quincaillerie: "hardware", hardware: "hardware", parts: "hardware",
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

  const HARDWARE_HINTS = [
    [/\b(boulon|bolt)s?\b/i, "bolt"],
    [/\b(ecrou|nut)s?\b/i, "nut"],
    [/\b(vis|screw)s?\b/i, "screw"],
    [/\b(rondelle|washer)s?\b/i, "washer"],
    [/\b(clou|nail)s?\b/i, "nail"],
    [/\b(cheville|anchor)s?\b/i, "anchor"],
    [/\b(equerre|bracket)s?\b/i, "bracket"],
    [/\b(tournevis|screwdriver)s?\b/i, "screwdriver"],
    [/\b(cle a molette|cle plate|wrench|spanner)s?\b/i, "wrench"],
    [/\b(marteau|hammer)s?\b/i, "hammer"],
    [/\b(pince|pliers)\b/i, "pliers"],
    [/\b(scie|saw)s?\b/i, "saw"],
    [/\b(perceuse|drill)s?\b/i, "drill"],
    [/\b(foret|drill\s*bits?)\b/i, "drill-bit"],
    [/\b(metre ruban|tape measure|pied a coulisse|caliper)\b/i, "measure"],
    [/\b(serre[- ]?joint|clamp|etau)s?\b/i, "clamp"],
    [/\b(engrenage|gear|pignon)s?\b/i, "gear"],
    [/\b(roulement|bearing)s?\b/i, "bearing"],
    [/\b(ressort|spring)s?\b/i, "spring"],
    [/\b(charniere|hinge)s?\b/i, "hinge"],
    [/\b(cable|wire)s?\b/i, "cable"],
    [/\b(connecteur|connector)s?\b/i, "connector"],
    [/\b(batterie|battery|piles?)\b/i, "battery"],
    [/\b(circuit\s*board|circuit\s*imprime|pcb)\b/i, "circuit-board"],
    [/\b(esp32|esp8266|arduino|microcontroleur|microcontroller|mcu|raspberry|pico)\b/i, "microcontroller"],
    [/\b(capteur|sensor)s?\b/i, "sensor"],
    [/\bleds?\b/i, "led"],
    [/\b(resistance|resistor)s?\b/i, "resistor"],
    [/\b(condensateur|capacitor)s?\b/i, "capacitor"],
    [/\b(filament|pla|petg)\b/i, "filament"],
    [/\b(piece\s*imprimee|printed\s*parts?)\b/i, "printed-part"],
    [/\b(contre[- ]?plaque|plywood|bois)\b/i, "wood"],
    [/\b(aluminium|aluminum|metal\s*stock)\b/i, "metal-stock"],
    [/\b(colle|glue|epoxy|adhesive)\b/i, "adhesive"],
  ];

  function fold(text) {
    return String(text == null ? "" : text)
      .replace(/Œ/g, "OE")
      .replace(/œ/g, "oe")
      .replace(/Æ/g, "AE")
      .replace(/æ/g, "ae")
      .replace(/×/g, "x")
      .replace(/Ω/g, "ohm")
      .replace(/ω/g, "ohm")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/['’]/g, " ")
      .replace(/[^a-z0-9\s\-\/]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripSpecs(folded) {
    return String(folded || "")
      .replace(/\bm\d+(?:x\d+(?:\.\d+)?)?\b/g, " ")
      .replace(/\b\d+(?:\.\d+)?\s*mm\b/g, " ")
      .replace(/\b\d+\s*\/\s*\d+\b/g, " ")
      .replace(/\b\d+(?:\.\d+)?\s*k?ohms?\b/g, " ")
      .replace(/\b\d+(?:\.\d+)?\s*v\b/g, " ")
      .replace(/\b\d+(?:\.\d+)?\s*awg\b/g, " ")
      .replace(/\b\d+(?:\.\d+)?\s*%\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function looksLikeHardwareSpec(folded) {
    if (!folded) return false;
    if (/\bm\d+(?:x\d+)?\b/.test(folded)) return true;
    if (/\b\d+(?:\.\d+)?\s*mm\b/.test(folded)) return true;
    if (/\b(esp32|esp8266|arduino|pcb|pla|petg|awg)\b/.test(folded)) return true;
    return false;
  }

  function domainOf(category) {
    if (HARDWARE_CATEGORIES[category]) return "hardware";
    if (FOOD_CATEGORIES[category]) return "food";
    return "other";
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

  function lookupFromPhrases(folded) {
    if (!folded) return null;
    let key = lookupAlias(folded);
    if (key) return key;
    const parts = folded.split(" ").filter(Boolean);
    if (parts.length > 1) {
      for (let len = parts.length; len >= 2 && !key; len -= 1) {
        for (let i = 0; i <= parts.length - len && !key; i += 1) {
          key = lookupAlias(parts.slice(i, i + len).join(" "));
        }
      }
      if (key) return key;
      const foodKeys = [];
      const hardwareKeys = [];
      for (let i = 0; i < parts.length; i += 1) {
        const tokenKey = lookupAlias(parts[i]);
        if (!tokenKey) continue;
        const cat = CATEGORY_OF[tokenKey] || "other";
        if (FOOD_CATEGORIES[cat]) foodKeys.push(tokenKey);
        else if (HARDWARE_CATEGORIES[cat]) hardwareKeys.push(tokenKey);
      }
      if (foodKeys.length) return foodKeys[0];
      if (hardwareKeys.length) return hardwareKeys[0];
    }
    return null;
  }

  function matchHints(list, raw, folded) {
    for (let i = 0; i < list.length; i += 1) {
      if (list[i][0].test(raw) || list[i][0].test(folded)) return list[i][1];
    }
    return null;
  }

  function resolveItem(name) {
    const raw = String(name == null ? "" : name).trim();
    const folded = fold(raw);
    if (!folded) {
      return { key: "other", category: "other", domain: "other", matched: false, label: raw };
    }
    const stripped = stripSpecs(folded);
    let key = lookupFromPhrases(folded);
    if (!key && stripped && stripped !== folded) key = lookupFromPhrases(stripped);
    if (!key) key = matchHints(HARDWARE_HINTS, raw, folded) || matchHints(HARDWARE_HINTS, raw, stripped);
    const hardwareHit = !!(key && HARDWARE_CATEGORIES[CATEGORY_OF[key] || ""]);
    if (!key && !looksLikeHardwareSpec(folded)) {
      key = matchHints(RECIPE_HINTS, raw, folded);
    }
    if (!key && looksLikeHardwareSpec(folded)) key = "hardware";
    if (!key) key = "other";
    if (!PATHS[key]) key = "other";
    const category = CATEGORY_OF[key] || "other";
    const domain = domainOf(category);
    return {
      key: key,
      category: category,
      domain: domain,
      matched: key !== "other",
      label: raw,
      hardware: domain === "hardware" || hardwareHit,
    };
  }

  function resolveIngredient(name) {
    return resolveItem(name);
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
      const resolved = resolveItem(name);
      if (!resolved.matched) return;
      const cat = resolved.category;
      if (cat === "other" || cat === "meal" || cat === "recipe" || HARDWARE_CATEGORIES[cat]) return;
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
    resolveItem: resolveItem,
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
      stripSpecs: stripSpecs,
      singularize: singularize,
      lookupAlias: lookupAlias,
      resolveItem: resolveItem,
      resolveIngredient: resolveIngredient,
      resolveMeal: resolveMeal,
      resolveRecipe: resolveRecipe,
      looksLikeHardwareSpec: looksLikeHardwareSpec,
      domainOf: domainOf,
      PATHS: PATHS,
      ALIASES: ALIASES,
      HARDWARE_CATEGORIES: HARDWARE_CATEGORIES,
      FOOD_CATEGORIES: FOOD_CATEGORIES,
    },
  };
}(typeof globalThis !== "undefined" ? globalThis : this));
