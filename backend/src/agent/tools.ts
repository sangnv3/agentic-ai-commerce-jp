import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { UserContext } from "../auth/entra.js";
import { CommerceError } from "../commerce/errors.js";
import * as customers from "../commerce/customers.js";
import * as delivery from "../commerce/delivery.js";
import * as catalog from "../commerce/catalog.js";
import * as carts from "../commerce/cart.js";
import { buildFilters, searchAndRank, type SoftProfile } from "../search/ranker.js";
import { createConfirmationRequest, invalidateForUser } from "../checkout/confirmation.js";
import { wrapUntrusted } from "./sanitize.js";

/**
 * Tool registry. One entry = JSON Schema sent to Claude + Zod schema re-validated on the server + handler.
 * The handler receives UserContext from the verified access token — tools have NO user_id parameter.
 *
 * Only LLM_TOOLS are sent to the model. execute_payment / create_order / create_invoice / send_order_email are
 * internal (see checkout/fulfillment.ts) and are deliberately absent here — Claude cannot call them.
 */

export const ALLERGENS = [
  "shrimp", "crab", "walnut", "wheat", "buckwheat", "egg", "milk", "peanut",
  "almond", "abalone", "squid", "salmon_roe", "orange", "cashew", "kiwi", "beef", "sesame", "salmon",
  "mackerel", "soybean", "chicken", "banana", "pork", "macadamia", "peach", "yam", "apple", "gelatin",
] as const;
const MANDATORY_8 = new Set(["shrimp", "crab", "walnut", "wheat", "buckwheat", "egg", "milk", "peanut"]);

export interface ToolContext {
  user: UserContext;
  sessionId: string;
  /** Allergens added during this session (e.g. a guest's allergy) — applied on top of the saved profile. */
  sessionExtraAllergens: Set<string>;
  /** Push a structured event to the UI (item cards, cart, confirmation screen). */
  emit: (event: string, data: unknown) => void;
}

export type ToolResult = { ok: true; [k: string]: unknown } | { ok: false; error: { code: string; message: string; [k: string]: unknown } };

interface ToolDef<S extends z.ZodTypeAny> {
  definition: Anthropic.Messages.Tool;
  schema: S;
  /** true if the tool may change the cart (bumps cart_version → invalidates confirmations). */
  mutatesCart?: boolean;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}

const tool = <S extends z.ZodTypeAny>(d: ToolDef<S>) => d;

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const slotStr = z.string().regex(/^([01]\d|2[0-3]):(00|30)$/);
const deliverySchema = z.object({ date: dateStr, slot_start: slotStr, address_id: z.string().min(1) }).strict();

// ---------- shared helpers ----------
type Prefs = Awaited<ReturnType<typeof customers.getPreferences>>;

function toSoftProfile(p: Prefs, extra: { prefer?: string[]; avoid?: string[] } = {}): SoftProfile {
  return {
    likedItems: Object.fromEntries([
      ...p.soft.liked_items.map((i) => [i.item_id, i.weight] as const),
      ...p.soft.disliked_items.map((i) => [i.item_id, -i.weight] as const),
    ]),
    favoriteRestaurants: Object.fromEntries(p.soft.favorite_restaurants.map((r) => [r.restaurant_id, r.weight])),
    cuisines: p.soft.cuisines,
    taste: p.soft.taste,
    priceRange: p.soft.price_range,
    recentlyEaten: p.soft.recently_eaten,
    statedTasteLike: p.stated.taste_like,
    statedTasteAvoid: p.stated.taste_avoid,
    // The customer's own words plus Claude's menu-language versions of them (e.g. "cá hồi" → "サーモン", "鮭").
    preferKeywords: [...new Set([...p.stated.favorite_foods, ...(extra.prefer ?? [])])],
    avoidKeywords: [...new Set([...p.stated.avoid_foods, ...(extra.avoid ?? [])])],
  };
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { ok: false, error: { code, message, ...extra } };
}

// ---------- tools ----------
export const TOOLS = {
  get_user_profile: tool({
    definition: {
      name: "get_user_profile",
      description:
        "Get the signed-in user's profile: display name, locale, saved addresses (home/office), saved payment methods (masked), loyalty points, recent orders (last 10) and ordering habit. Call once at the start of a session.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    schema: z.object({}).strict(),
    async run(_input, ctx) {
      return { ok: true, profile: await customers.getProfile(ctx.user.userId) };
    },
  }),

  get_preferences: tool({
    definition: {
      name: "get_preferences",
      description:
        "Get the user's long-term food preference profile: allergens (HARD constraint), dietary restrictions (HARD), liked/disliked items and restaurants with decayed weights, taste tendencies, typical price range, and stated (favorite/avoided foods, tastes, cuisines, budget per person, note the user entered on the preferences screen). Today's explicit request overrides soft preferences, never allergens or dietary restrictions.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    schema: z.object({}).strict(),
    async run(_input, ctx) {
      const prefs = await customers.getPreferences(ctx.user.userId);
      return { ok: true, ...prefs, session_extra_allergens: [...ctx.sessionExtraAllergens] };
    },
  }),

  update_preferences: tool({
    definition: {
      name: "update_preferences",
      description:
        "Record an explicit preference the user stated in this conversation (dislikes, taste, rating, new allergy). Allergen/dietary changes are not saved directly: they become pending changes the user confirms in Settings (an added allergen is applied to this session immediately). Do not call for implicit signals.",
      input_schema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["like_item", "dislike_item", "like_restaurant", "dislike_restaurant", "taste", "cuisine", "rating", "allergen_add_request", "allergen_remove_request", "dietary_change_request", "free_note"],
          },
          item_id: { type: "string" },
          restaurant_id: { type: "string" },
          dimension: { type: "string", enum: ["spicy", "oily", "saltiness", "sweetness", "portion"] },
          direction: { type: "string", enum: ["+", "-"] },
          stars: { type: "integer", minimum: 1, maximum: 5 },
          allergen: { type: "string", enum: [...ALLERGENS] },
          dietary: { type: "string", enum: ["vegetarian", "vegan", "halal", "low_carb", "gluten_free", "none"] },
          note: { type: "string", maxLength: 200 },
          user_quote: { type: "string", maxLength: 200, description: "The user's exact words that justify this update." },
        },
        required: ["kind", "user_quote"],
        additionalProperties: false,
      },
    },
    schema: z
      .object({
        kind: z.enum(["like_item", "dislike_item", "like_restaurant", "dislike_restaurant", "taste", "cuisine", "rating", "allergen_add_request", "allergen_remove_request", "dietary_change_request", "free_note"]),
        item_id: z.string().optional(),
        restaurant_id: z.string().optional(),
        dimension: z.enum(["spicy", "oily", "saltiness", "sweetness", "portion"]).optional(),
        direction: z.enum(["+", "-"]).optional(),
        stars: z.number().int().min(1).max(5).optional(),
        allergen: z.enum(ALLERGENS).optional(),
        dietary: z.enum(["vegetarian", "vegan", "halal", "low_carb", "gluten_free", "none"]).optional(),
        note: z.string().max(200).optional(),
        user_quote: z.string().min(1).max(200),
      })
      .strict(),
    async run(input, ctx) {
      // Safety: an added allergen protects the user right away, in this session.
      if (input.kind === "allergen_add_request" && input.allergen) ctx.sessionExtraAllergens.add(input.allergen);
      const res = await customers.recordPreference(ctx.user.userId, input);
      return { ok: true, status: res.status, preference_event_id: res.id };
    },
  }),

  check_delivery_slot: tool({
    definition: {
      name: "check_delivery_slot",
      description:
        "Check whether a delivery slot (30 min, Asia/Tokyo) is orderable for a date and address: capacity, order cutoff, minimum preparation time. Returns alternatives when unavailable.",
      input_schema: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD (JST)" },
          slot_start: { type: "string", description: "HH:MM, :00 or :30" },
          address_id: { type: "string" },
          restaurant_id: { type: "string" },
        },
        required: ["date", "slot_start"],
        additionalProperties: false,
      },
    },
    schema: z.object({ date: dateStr, slot_start: slotStr, address_id: z.string().optional(), restaurant_id: z.string().optional() }).strict(),
    async run(input, ctx) {
      const a = await delivery.slotAvailability(ctx.user.userId, input.date, input.slot_start, input.address_id);
      if (a.status !== "available") {
        ctx.emit("quick_replies", { options: a.alternatives.map((t) => ({ id: `slot_${t}`, label: t.slice(11, 16) })) });
        return fail(a.status.toUpperCase(), "Slot not available", { alternatives: a.alternatives });
      }
      return { ok: true, ...a };
    },
  }),

  validate_address: tool({
    definition: {
      name: "validate_address",
      description:
        "Validate and normalize a Japanese delivery address and check it is inside the delivery area. Use address_id for a saved address, or address for a new one (〒postal code, prefecture, city, street, building).",
      input_schema: {
        type: "object",
        properties: {
          address_id: { type: "string" },
          address: {
            type: "object",
            properties: {
              postal_code: { type: "string", pattern: "^\\d{3}-?\\d{4}$" },
              prefecture: { type: "string" },
              city: { type: "string" },
              street: { type: "string" },
              building: { type: "string" },
              recipient_name: { type: "string" },
              phone: { type: "string" },
            },
            required: ["postal_code", "street"],
            additionalProperties: false,
          },
          save_as: { type: "string", enum: ["home", "office", "other", "do_not_save"] },
        },
        additionalProperties: false,
      },
    },
    schema: z
      .object({
        address_id: z.string().optional(),
        address: z
          .object({
            postal_code: z.string().regex(/^\d{3}-?\d{4}$/),
            prefecture: z.string().optional(),
            city: z.string().optional(),
            street: z.string().min(1),
            building: z.string().optional(),
            recipient_name: z.string().optional(),
            phone: z.string().optional(),
          })
          .strict()
          .optional(),
        save_as: z.enum(["home", "office", "other", "do_not_save"]).optional(),
      })
      .strict()
      .refine((v) => Boolean(v.address_id) !== Boolean(v.address), "Provide exactly one of address_id or address"),
    async run(input, ctx) {
      const v = await delivery.validateAddress(ctx.user.userId, { addressId: input.address_id, address: input.address, saveAs: input.save_as });
      if (!v.valid || !v.inArea) return fail(v.reason ?? "OUT_OF_SERVICE_AREA", "Address not deliverable", { result: v });
      return { ok: true, ...v };
    },
  }),

  search_menu: tool({
    definition: {
      name: "search_menu",
      description:
        "Search the menu (Algolia) and return personalized, ranked candidates with match reasons. Results with query_match=false only satisfy the filters, not the requested dish — do not present them as matches. Translate the user's need into a short keyword query (Japanese preferred) plus filters. The server ALWAYS adds the user's allergen/dietary exclusions, slot availability and delivery area.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 100 },
          filters: {
            type: "object",
            properties: {
              max_price: { type: "integer", minimum: 0 },
              min_price: { type: "integer", minimum: 0 },
              category: { type: "string", enum: ["sushi", "tempura", "noodles", "rice", "curry", "bento", "salad", "soup", "side", "drink", "dessert"], description: "rice = donburi and teishoku" },
              cuisine: { type: "string", enum: ["japanese", "chinese", "korean", "western", "italian", "ethnic", "other"] },
              serving_temp: { type: "string", enum: ["hot", "cold", "any"] },
              taste_tags_any: {
                type: "array",
                items: { type: "string", enum: ["light", "low_oil", "hearty", "spicy", "mild", "high_protein", "low_calorie", "low_carb", "vegetable_rich"] },
              },
              exclude_allergens: { type: "array", items: { type: "string", enum: [...ALLERGENS] } },
              dietary: { type: "array", items: { type: "string", enum: ["vegetarian", "vegan", "halal", "low_carb", "gluten_free"] } },
              restaurant_id: { type: "string" },
              max_calories: { type: "integer" },
            },
            additionalProperties: false,
          },
          delivery: {
            type: "object",
            properties: { date: { type: "string" }, slot_start: { type: "string" }, address_id: { type: "string" } },
            required: ["date", "slot_start", "address_id"],
            additionalProperties: false,
          },
          party_size: { type: "integer", minimum: 1, maximum: 30 },
          limit: { type: "integer", minimum: 1, maximum: 10 },
          prefer_keywords: {
            type: "array",
            maxItems: 10,
            items: { type: "string", maxLength: 30 },
            description: "Japanese menu words for the customer's stated favorite foods (customer_context.preferences.stated.favorite_foods), e.g. cá hồi/salmon → サーモン, 鮭. Matching dishes are ranked higher. The stated words themselves are always used too.",
          },
          avoid_keywords: {
            type: "array",
            maxItems: 10,
            items: { type: "string", maxLength: 30 },
            description: "Japanese menu words for the customer's stated avoid_foods, e.g. wasabi → わさび, 山葵. Matching dishes are demoted and reported in preference_conflicts.",
          },
        },
        required: ["query", "delivery"],
        additionalProperties: false,
      },
    },
    schema: z
      .object({
        query: z.string().max(100),
        filters: z
          .object({
            max_price: z.number().int().min(0).optional(),
            min_price: z.number().int().min(0).optional(),
            category: z.string().optional(),
            cuisine: z.string().optional(),
            serving_temp: z.enum(["hot", "cold", "any"]).optional(),
            taste_tags_any: z.array(z.string()).max(5).optional(),
            exclude_allergens: z.array(z.enum(ALLERGENS)).optional(),
            dietary: z.array(z.enum(["vegetarian", "vegan", "halal", "low_carb", "gluten_free"])).optional(),
            restaurant_id: z.string().optional(),
            max_calories: z.number().int().optional(),
          })
          .strict()
          .default({}),
        delivery: deliverySchema,
        party_size: z.number().int().min(1).max(30).optional(),
        limit: z.number().int().min(1).max(10).default(5),
        prefer_keywords: z.array(z.string().max(30)).max(10).optional(),
        avoid_keywords: z.array(z.string().max(30)).max(10).optional(),
      })
      .strict(),
    async run(input, ctx) {
      const prefs = await customers.getPreferences(ctx.user.userId);
      const { zone } = await delivery.zoneForAddress(ctx.user.userId, input.delivery.address_id);
      if (!zone) return fail("OUT_OF_SERVICE_AREA", "Delivery address is outside the area");

      // HARD constraints: saved profile ∪ session extras ∪ LLM-requested extras. Never fewer.
      const allergens = [...new Set([...prefs.hard_constraints.allergens, ...ctx.sessionExtraAllergens, ...(input.filters.exclude_allergens ?? [])])];
      const dietary = [...new Set([...prefs.hard_constraints.dietary, ...(input.filters.dietary ?? [])])];
      const requireComplete = allergens.some((a) => !MANDATORY_8.has(a));

      const filters = buildFilters(
        {
          allergens,
          dietary,
          zone: zone.zone,
          slotMinutes: Number(input.delivery.slot_start.slice(0, 2)) * 60 + Number(input.delivery.slot_start.slice(3, 5)),
          maxPrice: input.filters.max_price,
          requireCompleteAllergenData: requireComplete,
        },
        {
          category: input.filters.category,
          cuisine: input.filters.cuisine,
          restaurantId: input.filters.restaurant_id,
          minPrice: input.filters.min_price,
          maxCalories: input.filters.max_calories,
        },
      );

      const { results, dropped } = await searchAndRank({
        locale: ctx.user.locale,
        query: input.query,
        filters,
        soft: toSoftProfile(prefs, { prefer: input.prefer_keywords, avoid: input.avoid_keywords }),
        today: { tasteTagsAny: input.filters.taste_tags_any ?? [], category: input.filters.category, servingTemp: input.filters.serving_temp },
        limit: input.limit,
        forbiddenAllergens: allergens,
        verifyAllergens: (ids) => catalog.allergensOf(ids),
      });

      // The UI renders cards from this structured data, not from the model's text.
      // Cards only for items that actually match what was asked (not filler returned after dropping query words).
      const relevant = results.filter((r) => r.query_match);
      if (relevant.length) ctx.emit("item_cards", { items: relevant.slice(0, 3) });
      return {
        ok: true,
        applied_hard_filters: filters.split(" AND "),
        results,
        excluded_after_db_check: dropped,
      };
    },
  }),

  get_item_detail: tool({
    definition: {
      name: "get_item_detail",
      description: "Get full details for one menu item: option groups with price deltas, full allergen list (28 items) and completeness, nutrition, availability.",
      input_schema: { type: "object", properties: { item_id: { type: "string" } }, required: ["item_id"], additionalProperties: false },
    },
    schema: z.object({ item_id: z.string().min(1) }).strict(),
    async run(input) {
      const m = await catalog.getMenuItem(input.item_id);
      return {
        ok: true,
        item: {
          id: m.itemId, name: wrapUntrusted(m.name, 80), restaurant: wrapUntrusted(m.restaurantName, 60), description: wrapUntrusted(m.description, 400),
          price_incl_tax: m.priceInclTax, tax_category: m.taxCategory, allergens: m.allergens, allergen_data_complete: m.allergenDataComplete,
          may_contain: m.mayContain, dietary: m.dietary, taste_tags: m.tasteTags, calories: m.calories, is_sold_out: m.isSoldOut,
          option_groups: m.optionGroups,
        },
      };
    },
  }),

  check_inventory: tool({
    definition: {
      name: "check_inventory",
      description:
        "Check real-time stock for specific items for a delivery slot (search results can lag behind). Use before adding an item the customer asked for by name, when re-planning after ITEM_SOLD_OUT, or for quantities above 1 (party orders). Returns remaining servings per item.",
      input_schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "object",
              properties: { item_id: { type: "string" }, quantity: { type: "integer", minimum: 1, maximum: 50 } },
              required: ["item_id", "quantity"],
              additionalProperties: false,
            },
          },
          date: { type: "string", description: "YYYY-MM-DD (JST)" },
          slot_start: { type: "string", description: "HH:MM" },
        },
        required: ["items", "date", "slot_start"],
        additionalProperties: false,
      },
    },
    schema: z
      .object({
        items: z.array(z.object({ item_id: z.string().min(1), quantity: z.number().int().min(1).max(50) }).strict()).min(1).max(10),
        date: dateStr,
        slot_start: slotStr,
      })
      .strict(),
    async run(input) {
      const inv = await catalog.inventory(input.items.map((i) => ({ itemId: i.item_id, quantity: i.quantity })));
      return { ok: true, items: inv.map((i) => ({ item_id: i.itemId, available: i.available, remaining: i.remaining, reason: i.reason })) };
    },
  }),

  add_to_cart: tool({
    mutatesCart: true,
    definition: {
      name: "add_to_cart",
      description:
        "Add a menu item with selected options to the user's active cart. The server re-checks allergens (including option-added ones), dietary restrictions, stock and the one-restaurant-per-order rule.",
      input_schema: {
        type: "object",
        properties: {
          item_id: { type: "string" },
          quantity: { type: "integer", minimum: 1, maximum: 20 },
          options: { type: "object", additionalProperties: { type: "string" }, description: "option_group_id -> option_id" },
          note: { type: "string", maxLength: 100 },
        },
        required: ["item_id", "quantity"],
        additionalProperties: false,
      },
    },
    schema: z
      .object({
        item_id: z.string().min(1),
        quantity: z.number().int().min(1).max(20),
        options: z.record(z.string()).optional(),
        note: z.string().max(100).optional(),
      })
      .strict(),
    async run(input, ctx) {
      // The cart module re-checks allergens/dietary against the DB, plus allergens mentioned in this session.
      const cart = await carts.addToCart(
        ctx.user.userId,
        { itemId: input.item_id, quantity: input.quantity, options: input.options, note: input.note, addedBy: "agent" },
        [...ctx.sessionExtraAllergens],
      );
      ctx.emit("cart_updated", cart);
      return { ok: true, cart };
    },
  }),

  update_cart: tool({
    mutatesCart: true,
    definition: {
      name: "update_cart",
      description:
        "Modify the active cart: set quantity, set options, remove a line, or replace a line with another item. Use for 'another dish', 'remove the drink', 'one more'. Invalidates pending payment confirmations.",
      input_schema: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["set_quantity", "set_options", "remove", "replace"] },
                cart_line_id: { type: "string" },
                quantity: { type: "integer", minimum: 1, maximum: 20 },
                options: { type: "object", additionalProperties: { type: "string" } },
                new_item_id: { type: "string" },
              },
              required: ["op", "cart_line_id"],
              additionalProperties: false,
            },
          },
          expected_cart_version: { type: "integer" },
        },
        required: ["operations", "expected_cart_version"],
        additionalProperties: false,
      },
    },
    schema: z
      .object({
        operations: z
          .array(
            z
              .object({
                op: z.enum(["set_quantity", "set_options", "remove", "replace"]),
                cart_line_id: z.string(),
                quantity: z.number().int().min(1).max(20).optional(),
                options: z.record(z.string()).optional(),
                new_item_id: z.string().optional(),
              })
              .strict(),
          )
          .min(1)
          .max(10),
        expected_cart_version: z.number().int(),
      })
      .strict(),
    async run(input, ctx) {
      const cart = await carts.updateCart(
        ctx.user.userId,
        input.operations.map((o) => ({ op: o.op, lineId: o.cart_line_id, quantity: o.quantity, options: o.options, newItemId: o.new_item_id })),
        input.expected_cart_version,
        [...ctx.sessionExtraAllergens],
      );
      ctx.emit("cart_updated", cart);
      return { ok: true, cart };
    },
  }),

  get_cart: tool({
    definition: {
      name: "get_cart",
      description: "Get the user's active cart (also used to resume an abandoned cart), with cart_version and staleness warnings (price changed, sold out, slot passed).",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    schema: z.object({}).strict(),
    async run(_input, ctx) {
      return { ok: true, cart: await carts.getCart(ctx.user.userId) };
    },
  }),

  apply_coupon: tool({
    mutatesCart: true,
    definition: {
      name: "apply_coupon",
      description: "Apply a coupon code or loyalty points to the cart. With auto=true the server picks the best eligible coupon. Never invent coupon codes.",
      input_schema: {
        type: "object",
        properties: { code: { type: "string", maxLength: 32 }, auto: { type: "boolean" }, use_points: { type: "integer", minimum: 0 } },
        additionalProperties: false,
      },
    },
    schema: z.object({ code: z.string().max(32).optional(), auto: z.boolean().optional(), use_points: z.number().int().min(0).optional() }).strict(),
    async run(input, ctx) {
      const res = await carts.applyCoupon(ctx.user.userId, { code: input.code, auto: input.auto });
      const cart = await carts.getCart(ctx.user.userId);
      if (cart) ctx.emit("cart_updated", cart);
      return { ok: true, ...res };
    },
  }),

  prepare_checkout: tool({
    mutatesCart: true,
    definition: {
      name: "prepare_checkout",
      description:
        "Compute the authoritative checkout summary: lines, discounts, delivery fee, consumption tax per rate (8% reduced / 10% standard), total, slot, address, payment method (default saved method unless given). Places a 10-minute slot hold. Does NOT charge.",
      input_schema: {
        type: "object",
        properties: {
          delivery: {
            type: "object",
            properties: { date: { type: "string" }, slot_start: { type: "string" }, address_id: { type: "string" } },
            required: ["date", "slot_start", "address_id"],
            additionalProperties: false,
          },
          payment_method_id: { type: "string" },
          invoice_recipient: { type: "string", maxLength: 100 },
        },
        additionalProperties: false,
      },
    },
    schema: z
      .object({ delivery: deliverySchema.optional(), payment_method_id: z.string().optional(), invoice_recipient: z.string().max(100).optional() })
      .strict(),
    async run(input, ctx) {
      const summary = await carts.prepareCheckout(ctx.user.userId, {
        delivery: input.delivery && { date: input.delivery.date, slotStart: input.delivery.slot_start, addressId: input.delivery.address_id },
        paymentMethodId: input.payment_method_id,
        recipient: input.invoice_recipient,
      });
      return { ok: true, summary };
    },
  }),

  request_payment_confirmation: tool({
    definition: {
      name: "request_payment_confirmation",
      description:
        "Show the payment confirmation screen for the current prepared checkout. This is the LAST step you can perform: the user must press the on-screen Confirm & Pay button themselves. You cannot pay and will be notified of the result.",
      input_schema: {
        type: "object",
        properties: { cart_version: { type: "integer" }, checkout_hash: { type: "string" } },
        required: ["cart_version", "checkout_hash"],
        additionalProperties: false,
      },
    },
    schema: z.object({ cart_version: z.number().int(), checkout_hash: z.string().min(1) }).strict(),
    async run(input, ctx) {
      // Re-compute server-side; never trust the numbers the model passes in.
      const current = await carts.prepareCheckout(ctx.user.userId);
      if (current.cart_version !== input.cart_version || current.checkout_hash !== input.checkout_hash) {
        return fail("CONFIRMATION_STALE", "Checkout changed since prepare_checkout. Call prepare_checkout again.");
      }
      const req = await createConfirmationRequest(ctx.user.userId, ctx.sessionId, current);
      // UI fetches the full summary from GET /api/checkout/confirmation-requests/:id — not from model text.
      ctx.emit("confirmation_required", { confirmation_request_id: req.id, expires_at: new Date(req.expiresAt).toISOString() });
      return { ok: true, confirmation_request_id: req.id, status: "awaiting_user", expires_at: new Date(req.expiresAt).toISOString() };
    },
  }),
} as const;

export type ToolName = keyof typeof TOOLS;

/** The ONLY tools the model ever sees. */
export const LLM_TOOLS: Anthropic.Messages.Tool[] = Object.values(TOOLS).map((t) => t.definition);

/**
 * Execute one model-requested tool: allowlist → validate → run with the user's identity.
 * Errors become structured tool results (is_error) so the model can recover.
 */
export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<{ result: ToolResult; mutatesCart: boolean }> {
  // Accept a name that differs only in letter case; anything else is rejected with the list of valid names.
  const resolved = (Object.keys(TOOLS) as ToolName[]).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!resolved) {
    return { result: fail("UNKNOWN_TOOL", `Tool ${name} is not available. Valid tools: ${Object.keys(TOOLS).join(", ")}`), mutatesCart: false };
  }
  const def = TOOLS[resolved] as unknown as ToolDef<z.ZodTypeAny>;
  const parsed = def.schema.safeParse(rawInput);
  if (!parsed.success) {
    return { result: fail("INVALID_INPUT", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")), mutatesCart: false };
  }
  try {
    const result = await def.run(parsed.data, ctx);
    if (def.mutatesCart && result.ok) {
      const stale = await invalidateForUser(ctx.user.userId);
      if (stale) ctx.emit("confirmation_invalidated", { confirmation_request_id: stale, reason: "CART_CHANGED" });
    }
    return { result, mutatesCart: Boolean(def.mutatesCart) };
  } catch (e) {
    if (e instanceof CommerceError) return { result: fail(e.code, e.message, e.details ?? {}), mutatesCart: false };
    return { result: fail("INTERNAL_ERROR", "Temporary error, try again or use another option"), mutatesCart: false };
  }
}

export function makeToolContext(user: UserContext, sessionId: string, sessionExtraAllergens: Set<string>, emit: ToolContext["emit"]): ToolContext {
  return { user, sessionId, sessionExtraAllergens, emit };
}
