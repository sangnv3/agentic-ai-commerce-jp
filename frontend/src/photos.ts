/**
 * Real food photos (Wikimedia Commons, reusable licenses) served from public/images/.
 * Authors and licenses: public/photo-credits.html — keep it in sync when a photo changes.
 */
export const menuPhoto = (itemId: string) => `/images/menu/${itemId}.jpg`;

/** Each category uses the photo of one representative item. */
const CATEGORY_ITEM: Record<string, string> = {
  sushi: "itm_s13",
  tempura: "itm_t02",
  noodles: "itm_2230",
  rice: "itm_r03",
  curry: "itm_c03",
  bento: "itm_b01",
  salad: "itm_h01",
  soup: "itm_r09",
  side: "itm_n10",
  dessert: "itm_t09",
  drink: "itm_c07",
};
export const categoryPhoto = (category: string) => (CATEGORY_ITEM[category] ? menuPhoto(CATEGORY_ITEM[category]) : undefined);

export const bannerPhoto = (slideId: string) => `/images/banner/${slideId}.jpg`;
