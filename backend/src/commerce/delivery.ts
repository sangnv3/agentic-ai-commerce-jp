import { randomUUID } from "node:crypto";
import { db } from "../db/pool.js";
import { CommerceError } from "./errors.js";
import { DELIVERY_ZONES, SLOTS } from "./settings.js";

const pad = (n: number) => String(n).padStart(2, "0");
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const slotIso = (date: string, hhmm: string) => `${date}T${hhmm}:00+09:00`;
export const slotEndIso = (date: string, hhmm: string) => slotIso(date, toHHMM(toMin(hhmm) + 30));

export function zoneForPostal(postalCode: string) {
  return DELIVERY_ZONES[postalCode.replace(/\D/g, "").slice(0, 3)] ?? null;
}

export async function zoneForAddress(userId: string, addressId: string) {
  const { rows } = await db.query("SELECT * FROM addresses WHERE address_id = $1 AND user_id = $2 AND deleted_at IS NULL", [addressId, userId]);
  if (!rows[0]) throw new CommerceError("ADDRESS_NOT_FOUND", `Address ${addressId} not found`);
  const z = zoneForPostal(rows[0].postal_code);
  return { address: rows[0], zone: z };
}

function cutoffFor(date: string, hhmm: string) {
  return new Date(slotIso(date, hhmm <= "14:00" ? SLOTS.lunchCutoff : SLOTS.dinnerCutoff));
}

async function reserved(zone: string | null, date: string, hhmm: string) {
  if (!zone) return { reserved: 0, capacity: SLOTS.defaultCapacity };
  const { rows } = await db.query("SELECT capacity, reserved FROM delivery_slots WHERE zone_code = $1 AND slot_start = $2", [zone, slotIso(date, hhmm)]);
  return rows[0] ?? { reserved: 0, capacity: SLOTS.defaultCapacity };
}

/** Status of one slot: available | full | past_cutoff | insufficient_prep_time | invalid_slot. */
export async function slotStatus(date: string, hhmm: string, zone: string | null, now = new Date()) {
  if (!SLOTS.times.includes(hhmm)) return "invalid_slot";
  if (SLOTS.forcedFull.has(hhmm)) return "full";
  if (SLOTS.strictTime) {
    if (now > cutoffFor(date, hhmm)) return "past_cutoff";
    if (new Date(slotIso(date, hhmm)).getTime() - now.getTime() < SLOTS.minPrepMinutes * 60_000) return "insufficient_prep_time";
  }
  const r = await reserved(zone, date, hhmm);
  return r.reserved >= r.capacity ? "full" : "available";
}

export async function slotAvailability(userId: string, date: string, hhmm: string, addressId?: string) {
  const zone = addressId ? (await zoneForAddress(userId, addressId)).zone?.zone ?? null : null;
  const status = await slotStatus(date, hhmm, zone);
  const alternatives: string[] = [];
  for (const t of SLOTS.times) {
    if (alternatives.length >= 3) break;
    if (t !== hhmm && (await slotStatus(date, t, zone)) === "available") alternatives.push(slotIso(date, t));
  }
  const r = await reserved(zone, date, hhmm);
  return {
    status,
    alternatives,
    slot: status === "available"
      ? { start: slotIso(date, hhmm), end: slotEndIso(date, hhmm), orderCutoff: cutoffFor(date, hhmm).toISOString(), remainingCapacity: r.capacity - r.reserved }
      : null,
  };
}

/** Reserve capacity when an order is placed (inside the order transaction). */
export async function reserveSlot(c: { query: typeof db.query }, zone: string, slotStartIso: string) {
  await c.query(
    `INSERT INTO delivery_slots (zone_code, slot_start, capacity, reserved, order_cutoff)
     VALUES ($1, $2, $3, 1, $2::timestamptz - interval '90 minutes')
     ON CONFLICT (zone_code, slot_start) DO UPDATE SET reserved = delivery_slots.reserved + 1`,
    [zone, slotStartIso, SLOTS.defaultCapacity],
  );
}

export interface AddressInput {
  postal_code: string;
  prefecture?: string;
  city?: string;
  street: string;
  building?: string;
  recipient_name?: string;
  phone?: string;
}

export async function validateAddress(userId: string, args: { addressId?: string; address?: AddressInput; saveAs?: string }) {
  if (args.addressId) {
    const { address, zone } = await zoneForAddress(userId, args.addressId);
    return {
      valid: true,
      inArea: !!zone,
      zoneCode: zone?.zone ?? null,
      deliveryFee: zone?.fee ?? null,
      reason: zone ? null : "OUT_OF_SERVICE_AREA",
      normalized: { id: address.address_id, postalCode: address.postal_code.trim(), prefecture: address.prefecture, city: address.city, street: address.street, building: address.building },
    };
  }
  const a = args.address!;
  const digits = a.postal_code.replace(/\D/g, "");
  const postal = digits.length === 7 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : a.postal_code;
  const valid = /^\d{3}-\d{4}$/.test(postal) && !!a.street;
  const zone = valid ? zoneForPostal(postal) : null;
  let id: string | null = null;
  if (valid && zone && args.saveAs && args.saveAs !== "do_not_save") {
    id = `addr_${randomUUID().slice(0, 12)}`;
    await db.query(
      `INSERT INTO addresses (address_id, user_id, label, postal_code, prefecture, city, street, building, recipient_name, phone, zone_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, userId, args.saveAs, postal, a.prefecture ?? "", a.city ?? "", a.street, a.building ?? null, a.recipient_name ?? null, a.phone ?? null, zone.zone],
    );
  }
  return {
    valid,
    inArea: !!zone,
    zoneCode: zone?.zone ?? null,
    deliveryFee: zone?.fee ?? null,
    reason: !valid ? "INCOMPLETE" : zone ? null : "OUT_OF_SERVICE_AREA",
    normalized: { id, postalCode: postal, prefecture: a.prefecture ?? null, city: a.city ?? null, street: a.street, building: a.building ?? null },
    note: zone && !id ? "Address is deliverable but not saved: call validate_address again with save_as to use it for checkout." : undefined,
  };
}
