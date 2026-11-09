/** Display labels shared by the home page and the chat. */
export const ALLERGEN_JA: Record<string, string> = {
  shrimp: "えび", crab: "かに", walnut: "くるみ", wheat: "小麦", buckwheat: "そば", egg: "卵", milk: "乳", peanut: "落花生",
  almond: "アーモンド", abalone: "あわび", squid: "いか", salmon_roe: "いくら", orange: "オレンジ", cashew: "カシューナッツ",
  kiwi: "キウイ", beef: "牛肉", sesame: "ごま", salmon: "さけ", mackerel: "さば", soybean: "大豆", chicken: "鶏肉",
  banana: "バナナ", pork: "豚肉", macadamia: "マカダミア", peach: "もも", yam: "やまいも", apple: "りんご", gelatin: "ゼラチン",
};
export const ALLERGEN_EN: Record<string, string> = {
  shrimp: "Shrimp", crab: "Crab", walnut: "Walnut", wheat: "Wheat", buckwheat: "Buckwheat", egg: "Egg", milk: "Milk", peanut: "Peanut",
  almond: "Almond", abalone: "Abalone", squid: "Squid", salmon_roe: "Salmon roe", orange: "Orange", cashew: "Cashew",
  kiwi: "Kiwi", beef: "Beef", sesame: "Sesame", salmon: "Salmon", mackerel: "Mackerel", soybean: "Soy", chicken: "Chicken",
  banana: "Banana", pork: "Pork", macadamia: "Macadamia", peach: "Peach", yam: "Yam", apple: "Apple", gelatin: "Gelatin",
};
export const allergenLabel = (a: string, locale: "ja" | "en") => (locale === "ja" ? ALLERGEN_JA[a] : ALLERGEN_EN[a]) ?? a.replace(/_/g, " ");

export const DIETARY: Record<string, { ja: string; en: string }> = {
  vegetarian: { ja: "ベジタリアン", en: "Vegetarian" }, vegan: { ja: "ヴィーガン", en: "Vegan" }, halal: { ja: "ハラール", en: "Halal" },
  low_carb: { ja: "低糖質", en: "Low carb" }, gluten_free: { ja: "グルテンフリー", en: "Gluten free" },
};
export const dietaryLabel = (d: string, locale: "ja" | "en") => DIETARY[d]?.[locale] ?? d.replace(/_/g, " ");

/** 特定原材料 (mandatory labelling) — shown in bold. */
export const MANDATORY_ALLERGENS = new Set(["shrimp", "crab", "walnut", "wheat", "buckwheat", "egg", "milk", "peanut"]);

export const CATEGORIES: Record<string, { emoji: string; ja: string; en: string; tint: string }> = {
  sushi: { emoji: "🍣", ja: "寿司", en: "Sushi", tint: "#fde2e4" },
  tempura: { emoji: "🍤", ja: "天ぷら", en: "Tempura", tint: "#fef3c7" },
  noodles: { emoji: "🍜", ja: "麺類", en: "Noodles", tint: "#fde68a" },
  rice: { emoji: "🍚", ja: "丼・定食", en: "Rice bowls & sets", tint: "#e0f2fe" },
  curry: { emoji: "🍛", ja: "カレー", en: "Curry", tint: "#fed7aa" },
  bento: { emoji: "🍱", ja: "弁当", en: "Bento", tint: "#dcfce7" },
  salad: { emoji: "🥗", ja: "サラダ・ボウル", en: "Salads & bowls", tint: "#d9f99d" },
  soup: { emoji: "🥣", ja: "汁物", en: "Soups", tint: "#e9d5ff" },
  side: { emoji: "🥟", ja: "サイド", en: "Sides", tint: "#fce7f3" },
  dessert: { emoji: "🍡", ja: "デザート", en: "Desserts", tint: "#ffe4e6" },
  drink: { emoji: "🍵", ja: "ドリンク", en: "Drinks", tint: "#ccfbf1" },
};

export const TAGS: Record<string, { ja: string; en: string }> = {
  light: { ja: "あっさり", en: "Light" }, low_oil: { ja: "油控えめ", en: "Low oil" }, hearty: { ja: "がっつり", en: "Hearty" },
  spicy: { ja: "辛い", en: "Spicy" }, mild: { ja: "まろやか", en: "Mild" }, high_protein: { ja: "高たんぱく", en: "High protein" },
  low_calorie: { ja: "低カロリー", en: "Low calorie" }, low_carb: { ja: "低糖質", en: "Low carb" }, vegetable_rich: { ja: "野菜たっぷり", en: "Veggie-rich" },
};
