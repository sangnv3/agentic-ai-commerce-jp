/**
 * English names and descriptions for the sample menu (sampleData.ts). Seeded into the *_en columns; the Japanese
 * columns stay the source of truth (search, invoices). Missing entries fall back to Japanese.
 */
export const RESTAURANT_EN: Record<string, string> = {
  rst_healthy_shibuya: "Healthy Kitchen Shibuya",
  rst_wagohan_yui: "Wagohan Yui",
  rst_chuka_ryu: "Chuka Ryu (Chinese)",
  rst_menya_kaze: "Menya Kaze (Noodles)",
  rst_sushi_takumi: "Sushi Takumi",
  rst_tempura_yama: "Tempura Yama",
  rst_donburi_isshin: "Donburi Isshin",
  rst_curry_kobo: "Curry Kobo",
};

/** item_id → [name, description] */
export const ITEM_EN: Record<string, [string, string]> = {
  itm_1021: ["Steamed Chicken Breast & Warm Vegetable Set", "Steamed chicken breast with seasonal warm vegetables. A light, low-oil set meal."],
  itm_1033: ["Steamed Chicken & Broccoli Multigrain Rice Plate", "Steamed chicken and broccoli with multigrain rice."],
  itm_1040: ["Tofu & Mushroom Ankake Rice Bowl", "Tofu and mushrooms in a gentle savory sauce over rice."],
  itm_0877: ["Salt-Grilled Salmon & Five-Grain Rice Bento", "Salt-grilled salmon with five-grain rice. A light Japanese bento."],
  itm_0901: ["Shrimp Tempura Rice Bowl (Ebi Tendon)", "A hearty rice bowl topped with large shrimp tempura."],
  itm_0450: ["Mapo Tofu Set Meal", "Spicy Sichuan-style mapo tofu with rice and soup."],
  itm_2210: ["Hot Udon with Chicken & Kujo Green Onion", "Hot udon noodles with chicken and Kyoto Kujo green onion."],
  itm_2215: ["Shrimp Tempura Soba", "Hot buckwheat soba topped with shrimp tempura."],
  itm_2230: ["Shoyu Ramen with Chashu Pork", "Soy sauce ramen topped with sliced chashu pork."],
  itm_3001: ["Zaru Soba (Cold Buckwheat Noodles)", "Chilled buckwheat soba on a bamboo tray with dipping sauce."],

  itm_s01: ["Salmon Nigiri (2 pcs)", "Rich, fatty Norwegian salmon nigiri."],
  itm_s02: ["Salmon & Salmon Roe Nigiri (8 pcs)", "A generous set of salmon and salmon roe (ikura) nigiri."],
  itm_s03: ["Salmon Lover's Nigiri (10 pcs)", "Five kinds of salmon nigiri: seared, marinated, with onion and more."],
  itm_s04: ["Premium Nigiri Set (12 pcs)", "Premium set with tuna, salmon, shrimp, squid, salmon roe, crab and tamago."],
  itm_s05: ["Tuna Roll (Tekkamaki, 6 pcs)", "A simple thin roll with lean tuna."],
  itm_s06: ["Salmon Avocado Roll (8 pcs)", "Inside-out roll with salmon, avocado and mayonnaise."],
  itm_s07: ["Shrimp Tempura Roll (8 pcs)", "Inside-out roll with shrimp tempura and lettuce."],
  itm_s08: ["Cucumber Roll (Kappamaki, 6 pcs)", "Refreshing thin roll with cucumber and sesame."],
  itm_s09: ["Inari Sushi (4 pcs)", "Sushi rice in sweet simmered fried tofu pouches."],
  itm_s10: ["Chirashi Sushi", "Colorful scattered sushi with salmon, salmon roe, shrimp and tamago."],
  itm_s11: ["Salmon Hand Roll Set (4 rolls)", "Four hand rolls with salmon, green onion and sesame."],
  itm_s12: ["Party Platter (40 pcs, serves 3–4)", "A large platter of nigiri and rolls. Contains shrimp, squid and crab."],
  itm_s13: ["Salmon & Tuna Nigiri (6 pcs)", "Three pieces each of popular salmon and tuna."],
  itm_s20: ["Clam Miso Soup", "Miso soup full of the flavor of asari clams."],
  itm_s21: ["Chawanmushi (Savory Egg Custard)", "Silky steamed egg custard with shrimp and chicken."],
  itm_s22: ["Matcha Ice Cream", "Ice cream made with Uji matcha green tea."],
  itm_s23: ["Green Tea (Bottle)", "Japanese green tea, 500 ml bottle."],

  itm_t01: ["Tempura Rice Bowl (2 Shrimp & Vegetables)", "Two shrimp and seasonal vegetable tempura with a sweet-savory sauce."],
  itm_t02: ["Vegetable Tempura Platter", "Seven kinds of vegetables, including pumpkin, eggplant and shishito pepper."],
  itm_t03: ["Premium Tempura Set Meal", "Shrimp, squid, white fish and vegetable tempura with rice and miso soup."],
  itm_t04: ["Kakiage Rice Bowl", "Crispy fritter of small shrimp and onion over rice."],
  itm_t05: ["Chicken Tempura Set (Toriten)", "Oita-style chicken tempura, served with refreshing ponzu."],
  itm_t06: ["Shrimp Tempura Udon", "Hot udon topped with two large shrimp tempura."],
  itm_t07: ["Whiting & Vegetable Tempura Set", "Kisu (Japanese whiting) and vegetable tempura. No shrimp."],
  itm_t08: ["Sweet Potato Tempura (3 pcs)", "Fluffy sweet potato tempura."],
  itm_t09: ["Warabi Mochi", "Bracken-starch mochi with kinako soybean flour and black sugar syrup."],

  itm_n01: ["Zaru Udon (Cold Udon)", "Firm Sanuki udon served with chilled dipping sauce."],
  itm_n02: ["Kitsune Udon", "Kansai-style udon topped with sweet simmered fried tofu."],
  itm_n03: ["Tororo Soba (Cold, with Grated Yam)", "Chilled soba topped with grated mountain yam."],
  itm_n04: ["Duck & Leek Soba (Kamo Nanban)", "Hot soba with duck and leeks."],
  itm_n05: ["Miso Ramen", "Rich miso broth with bean sprouts and chashu pork."],
  itm_n06: ["Tantanmen (Spicy Sesame Ramen)", "Spicy broth with sesame and Sichuan pepper."],
  itm_n07: ["Hiyashi Chuka (Cold Ramen Salad)", "Chilled noodles with egg strips, ham and cucumber."],
  itm_n08: ["Creamy Chicken Broth Salt Ramen", "Mellow, creamy broth slow-cooked from chicken bones."],
  itm_n09: ["Yakisoba (Fried Noodles)", "Stir-fried noodles with pork, cabbage and savory sauce."],
  itm_n10: ["Pan-Fried Gyoza (6 pcs)", "Juicy pan-fried pork dumplings."],

  itm_r01: ["Salmon & Salmon Roe Rice Bowl", "A seafood bowl piled with salmon and salmon roe."],
  itm_r02: ["Seafood Rice Bowl (Kaisendon)", "A luxurious bowl with salmon, salmon roe, shrimp, squid and crab."],
  itm_r03: ["Chicken & Egg Rice Bowl (Oyakodon)", "Chicken thigh simmered with soft, fluffy egg over rice."],
  itm_r04: ["Beef Rice Bowl (Gyudon)", "Sweet-savory simmered beef and onion over rice."],
  itm_r05: ["Pork Cutlet Rice Bowl (Katsudon)", "Thick pork loin cutlet simmered with egg over rice."],
  itm_r06: ["Minced Tuna Rice Bowl (Negitoro Don)", "Minced tuna and green onion over rice."],
  itm_r07: ["Bibimbap Bowl", "Seasoned vegetables and minced beef with gochujang."],
  itm_r08: ["Tofu Hamburg Steak Rice Bowl", "Soft tofu hamburg steak with grated daikon sauce."],
  itm_r09: ["Pork Miso Soup (Tonjiru)", "Hearty miso soup with pork and vegetables."],

  itm_c01: ["Chicken Curry", "Fragrant, spiced chicken curry."],
  itm_c02: ["Vegetable Curry (Vegan)", "Dairy-free curry with ten kinds of vegetables."],
  itm_c03: ["Pork Cutlet Curry (Katsu Curry)", "Curry topped with a crispy pork loin cutlet."],
  itm_c04: ["Green Curry", "Thai-style curry with coconut and herbs (contains shrimp paste)."],
  itm_c05: ["Butter Chicken Curry", "Mild, creamy curry with tomato and butter."],
  itm_c06: ["Plain Naan", "Oven-baked naan bread."],
  itm_c07: ["Mango Lassi", "A mango and yogurt drink."],

  itm_h01: ["Salmon Avocado Poke Bowl", "Salmon, avocado and brown rice poke bowl."],
  itm_h02: ["Tofu & Seaweed Salad", "With Japanese sesame dressing."],
  itm_h03: ["Steamed Chicken Caesar Salad", "Steamed chicken, romaine lettuce and parmesan."],
  itm_h04: ["Quinoa & Warm Vegetable Bowl", "Quinoa, broccoli and chickpeas."],
  itm_h05: ["Minestrone", "Tomato and vegetable soup."],
  itm_h06: ["Soy Milk Pudding", "Soy milk pudding with black sugar syrup."],
  itm_h07: ["Fruit Yogurt", "Yogurt with peach, apple and banana."],

  itm_b01: ["Makunouchi Bento", "Classic bento with grilled salmon, tamagoyaki, simmered vegetables and fried shrimp."],
  itm_b02: ["Karaage Fried Chicken Bento", "Five pieces of ginger-soy fried chicken."],
  itm_b03: ["Miso-Simmered Mackerel Bento", "Tender mackerel simmered in miso."],
  itm_b04: ["Yakiniku Grilled Beef Bento", "Grilled beef in a sweet-savory sauce."],
  itm_b05: ["Salmon Onigiri Set (2 pcs & Miso Soup)", "Two grilled-salmon rice balls with wakame miso soup."],
  itm_b06: ["Hojicha Roasted Green Tea (Bottle)", "Toasty roasted green tea, 500 ml bottle."],
};

/** Option group names and choice names ("group" and "group.choice"). */
export const OPTION_EN: Record<string, string> = {
  rice: "Rice amount", "rice.normal": "Regular", "rice.less": "Less", "rice.large": "Large",
  drink: "Drink", "drink.none": "None", "drink.green_tea": "Green tea",
  wasabi: "Wasabi", "wasabi.with": "With wasabi", "wasabi.without": "No wasabi",
  spice: "Spice level", "spice.mild": "Mild", "spice.medium": "Medium", "spice.hot": "Hot",
  size: "Noodle amount", "size.normal": "Regular", "size.large": "Large",
};
